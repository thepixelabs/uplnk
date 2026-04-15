/**
 * headless ask command — single-turn, prompt-from-argument.
 *
 * Resolution order for provider:
 *   1. --provider CLI flag
 *   2. config.headless.defaultProvider
 *   3. DB default provider (set via TUI or config seeding)
 *
 * Resolution order for model:
 *   1. --model CLI flag
 *   2. config.headless.defaultModel
 *   3. provider row's defaultModel column
 *
 * When config.headless.persist === true the exchange is written to SQLite
 * as a new conversation with source='cli'.
 */

import { randomUUID } from 'node:crypto';
import { streamText } from 'ai';
import type { CoreMessage } from 'ai';
import { db, getDefaultProvider, getProviderById, createConversation, insertMessage } from '@uplnk/db';
import { getOrCreateConfig } from '../../lib/config.js';
import { createLanguageModel } from '../../lib/languageModelFactory.js';
import { resolveSecret } from '../../lib/secrets.js';
import { toUplnkError } from '../../lib/errors.js';
import { StdoutRenderer } from '../io/stdoutRenderer.js';
import type { OutputFormat } from '../io/stdoutRenderer.js';

export interface AskOptions {
  prompt: string;
  provider?: string | undefined;
  model?: string | undefined;
  format?: OutputFormat | undefined;
  quiet?: boolean | undefined;
}

export async function runAsk(options: AskOptions): Promise<void> {
  // ── Config ────────────────────────────────────────────────────────────────
  const configResult = getOrCreateConfig();
  if (!configResult.ok) {
    process.stderr.write(`uplnk ask: config error — ${configResult.error}\n`);
    process.exit(1);
  }
  const config = configResult.config;

  // ── Provider resolution ───────────────────────────────────────────────────
  const providerId = options.provider ?? config.headless.defaultProvider;
  const providerRow = providerId !== undefined
    ? getProviderById(db, providerId)
    : getDefaultProvider(db);

  if (providerRow === undefined) {
    process.stderr.write(
      'uplnk ask: no provider configured. Add one via `uplnk` TUI or config.json.\n',
    );
    process.exit(1);
  }

  // ── Model resolution ──────────────────────────────────────────────────────
  const modelId =
    options.model ??
    config.headless.defaultModel ??
    providerRow.defaultModel ??
    'qwen2.5:7b';

  // ── Language model construction ───────────────────────────────────────────
  const apiKey = resolveSecret(providerRow.apiKey) ?? 'ollama';
  const languageModel = createLanguageModel({
    providerType: providerRow.providerType,
    baseURL: providerRow.baseUrl,
    apiKey,
    modelId,
  });

  // ── Renderer ──────────────────────────────────────────────────────────────
  const renderer = new StdoutRenderer({
    format: options.format ?? 'plain',
    quiet: options.quiet ?? false,
  });

  // ── Stream ────────────────────────────────────────────────────────────────
  const messages: CoreMessage[] = [{ role: 'user', content: options.prompt }];

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const controller = new AbortController();

  // Handle broken-pipe gracefully (e.g. `uplnk ask "..." | head -1`).
  // Node emits EPIPE as an 'error' event on the stdout stream rather than
  // SIGPIPE, so we listen there. SIGPIPE is also wired up as a belt-and-braces
  // measure — on some platforms (and when stdout is redirected to a FIFO)
  // the signal fires before the error event.
  const onBrokenPipe = (): void => controller.abort();
  const onStdoutError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') onBrokenPipe();
  };
  process.stdout.on('error', onStdoutError);
  process.once('SIGPIPE', onBrokenPipe);

  try {
    const { fullStream } = streamText({
      model: languageModel,
      messages,
      abortSignal: controller.signal,
    });

    for await (const event of fullStream) {
      switch (event.type) {
        case 'text-delta':
          fullText += event.textDelta;
          renderer.onDelta(event.textDelta);
          break;

        case 'finish': {
          const u = (event as { usage?: { promptTokens?: number; completionTokens?: number } }).usage;
          inputTokens = u?.promptTokens ?? 0;
          outputTokens = u?.completionTokens ?? 0;
          break;
        }

        case 'error':
          throw event.error instanceof Error
            ? event.error
            : new Error(String(event.error));

        default:
          break;
      }
    }

    renderer.onDone({ inputTokens, outputTokens });
  } catch (err) {
    // EPIPE / AbortError — broken pipe, exit cleanly without printing noise.
    if (
      controller.signal.aborted ||
      (err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'EPIPE'))
    ) {
      process.exitCode = 0;
      return;
    }
    const uplnkErr = toUplnkError(err);
    renderer.onError(new Error(uplnkErr.message));
    process.exit(1);
  } finally {
    process.removeListener('SIGPIPE', onBrokenPipe);
    process.stdout.off('error', onStdoutError);
  }

  // ── Persistence (optional) ────────────────────────────────────────────────
  if (config.headless.persist) {
    try {
      const convId = randomUUID();
      const now = new Date().toISOString();
      // Derive a title from the first ~60 chars of the prompt.
      const title = options.prompt.slice(0, 60) + (options.prompt.length > 60 ? '…' : '');

      createConversation(db, {
        id: convId,
        title,
        providerId: providerRow.id,
        modelId,
        source: 'cli',
        createdAt: now,
        updatedAt: now,
      });

      insertMessage(db, {
        id: randomUUID(),
        conversationId: convId,
        role: 'user',
        content: options.prompt,
        createdAt: now,
      });

      insertMessage(db, {
        id: randomUUID(),
        conversationId: convId,
        role: 'assistant',
        content: fullText,
        inputTokens,
        outputTokens,
        createdAt: now,
      });
    } catch (persistErr) {
      // Persistence failure is non-fatal — the user already got the response.
      process.stderr.write(
        `uplnk ask: warning — failed to persist conversation: ${String(persistErr)}\n`,
      );
    }
  }
}
