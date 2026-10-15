/**
 * generateStructured — schema-validated LLM output for every JSON boundary.
 *
 * Replaces the regex-parse-JSON-out-of-text pattern with one validated,
 * retried entry point. Strategy (in order):
 *
 *   1. Primary: AI SDK `generateObject` in JSON mode. Every uplnk provider is
 *      OpenAI-compatible via `createOpenAICompatible` (languageModelFactory),
 *      and local models (Ollama, LM Studio, vLLM) are far more reliable with
 *      JSON mode than tool mode — so we pin `mode: 'json'`.
 *   2. On schema-validation failure (NoObjectGeneratedError), retry up to
 *      `maxRetries` times, appending a corrective user message that quotes
 *      the validation error and the invalid output.
 *   3. Final fallback: `generateText` + the tolerant `parseLlmJson` cleaner
 *      (fence stripping, prose trimming, trailing commas) + `schema.safeParse`.
 *      Catches endpoints that reject `response_format` outright.
 *   4. If the fallback fails too, throw StructuredOutputError — an Error that
 *      also satisfies the @uplnk/shared `UplnkError` shape (code/message/hint)
 *      so `isUplnkError()` consumers classify it without a `toUplnkError` pass.
 *
 * Aborts always propagate: an AbortSignal firing mid-attempt is never
 * converted into a retry or a fallback. Provider/network errors thrown by the
 * fallback call also propagate unchanged so the existing error taxonomy
 * (lib/errors.ts) can classify them.
 */

import { generateObject, generateText, NoObjectGeneratedError } from 'ai';
import type { CoreMessage, LanguageModel, LanguageModelUsage } from 'ai';
import type { z } from 'zod';
import type { UplnkError, UplnkErrorCode } from '@uplnk/shared';
import { parseLlmJson, LlmJsonParseError } from './deepResearch/jsonParse.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GenerateStructuredOptions<T> {
  model: LanguageModel;
  /** Zod schema the output must satisfy. Validation happens on every path. */
  schema: z.ZodType<T>;
  /** Single-turn convenience. Ignored when `messages` is provided. */
  prompt?: string;
  messages?: CoreMessage[];
  system?: string;
  temperature?: number;
  /** Max completion tokens per attempt — passed through to the SDK. */
  maxTokens?: number;
  /** Schema-validation retries on the generateObject path (default 2). */
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

export interface GenerateStructuredResult<T> {
  object: T;
  /** Token usage accumulated across ALL attempts (retries + fallback). */
  usage: LanguageModelUsage;
}

/**
 * Thrown when every path (structured attempts + text fallback) failed to
 * produce schema-valid output. Implements the UplnkError shape so it flows
 * through `isUplnkError` / the ErrorBanner without wrapping.
 */
export class StructuredOutputError extends Error implements UplnkError {
  readonly code: UplnkErrorCode = 'STREAM_INVALID_RESPONSE';
  readonly hint =
    'The model could not produce output matching the expected schema. ' +
    'Try a larger model or a lower temperature.';

  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'StructuredOutputError';
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RAW_PREVIEW_CHARS = 300;

function preview(raw: string): string {
  return raw.length > RAW_PREVIEW_CHARS ? `${raw.slice(0, RAW_PREVIEW_CHARS)}…` : raw;
}

/**
 * Corrective turn appended after a validation failure. Quotes both the
 * invalid output and the validation error so the model can self-repair
 * instead of re-rolling blind.
 */
function correctiveUserMessage(err: NoObjectGeneratedError): CoreMessage {
  const invalidOutput =
    err.text !== undefined && err.text.trim() !== '' ? err.text : '(empty response)';
  const validationError = err.cause instanceof Error ? err.cause.message : err.message;
  return {
    role: 'user',
    content:
      'Your previous response was not valid for the required JSON schema.\n\n' +
      `Invalid response:\n${invalidOutput}\n\n` +
      `Validation error:\n${validationError}\n\n` +
      'Respond again with ONLY a corrected JSON object that satisfies the schema — ' +
      'no prose, no code fences.',
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>,
): Promise<GenerateStructuredResult<T>> {
  const { model, schema, prompt, system, temperature, maxTokens, abortSignal } = opts;
  const maxRetries = opts.maxRetries ?? 2;

  const baseMessages: CoreMessage[] =
    opts.messages ?? (prompt !== undefined ? [{ role: 'user', content: prompt }] : []);
  if (baseMessages.length === 0) {
    throw new Error('generateStructured requires either `prompt` or a non-empty `messages` array.');
  }

  const usage: LanguageModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const addUsage = (u: LanguageModelUsage | undefined): void => {
    if (u === undefined) return;
    if (Number.isFinite(u.promptTokens)) usage.promptTokens += u.promptTokens;
    if (Number.isFinite(u.completionTokens)) usage.completionTokens += u.completionTokens;
    if (Number.isFinite(u.totalTokens)) usage.totalTokens += u.totalTokens;
  };

  const shared = {
    model,
    ...(system !== undefined ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  };

  // ── Primary path: generateObject (JSON mode) with corrective retries ────────
  let messages = baseMessages;
  let lastValidationError: NoObjectGeneratedError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await generateObject({ ...shared, schema, mode: 'json', messages });
      addUsage(result.usage);
      return { object: result.object, usage };
    } catch (err) {
      // Aborts propagate immediately — never retried, never falls back.
      if (abortSignal?.aborted === true) throw err;
      if (!NoObjectGeneratedError.isInstance(err)) {
        // Structural failure (e.g. the endpoint rejects JSON mode outright).
        // Re-asking the same endpoint the same way cannot help — go straight
        // to the plain-text fallback.
        break;
      }
      addUsage(err.usage);
      lastValidationError = err;
      if (attempt < maxRetries) {
        messages = [...messages, correctiveUserMessage(err)];
      }
    }
  }

  // ── Fallback: plain text + tolerant JSON extraction + safeParse ─────────────
  // Provider/network errors thrown here propagate unchanged (classifiable by
  // lib/errors.ts); only parse/validation failures become StructuredOutputError.
  const textResult = await generateText({ ...shared, messages: baseMessages });
  addUsage(textResult.usage);

  let parsedJson: unknown;
  try {
    parsedJson = parseLlmJson(textResult.text);
  } catch (err) {
    const raw = err instanceof LlmJsonParseError ? err.raw : textResult.text;
    const reason = err instanceof Error ? err.message : String(err);
    throw new StructuredOutputError(
      `LLM output is not parseable JSON after ${maxRetries + 1} structured attempt(s) ` +
        `and a text fallback: ${reason} (raw: ${preview(raw)})`,
      { cause: lastValidationError ?? err },
    );
  }

  const validated = schema.safeParse(parsedJson);
  if (validated.success) {
    return { object: validated.data, usage };
  }
  throw new StructuredOutputError(
    `LLM output failed schema validation after ${maxRetries + 1} structured attempt(s) ` +
      `and a text fallback: ${validated.error.message}`,
    { cause: validated.error },
  );
}
