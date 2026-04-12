import { streamText } from 'ai';
import type { CoreMessage } from 'ai';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import type { RelayPlan } from './planSchema.js';
import { RelayError } from './errors.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type EngineEvent =
  | { type: 'scout:start' }
  | { type: 'scout:delta'; text: string }
  | { type: 'scout:end'; fullText: string; usage: TokenUsage }
  | { type: 'anchor:start' }
  | { type: 'anchor:delta'; text: string }
  | { type: 'anchor:end'; fullText: string; usage: TokenUsage }
  | { type: 'error'; error: RelayError };

export interface RunRelayOptions {
  plan: RelayPlan;
  scoutModel: LanguageModelV1;
  anchorModel: LanguageModelV1;
  userInput: string;
  signal: AbortSignal;
  tools?: Record<string, unknown>; // MCP tools for anchor phase (optional)
}

export async function* runRelay(opts: RunRelayOptions): AsyncGenerator<EngineEvent> {
  // ── Phase 1: Scout ─────────────────────────────────────────────────────────
  yield { type: 'scout:start' };

  let scoutText = '';

  try {
    const scoutStream = streamText({
      model: opts.scoutModel,
      messages: [
        {
          role: 'system',
          content:
            opts.plan.scout.systemPrompt ||
            'You are a scout model. Analyze the task and produce a focused, structured brief. Be concise.',
        },
        { role: 'user', content: opts.userInput },
      ],
      temperature: opts.plan.scout.temperature ?? 0.4,
      maxTokens: opts.plan.scout.maxOutputTokens ?? 1500,
      abortSignal: opts.signal,
    });

    for await (const chunk of scoutStream.textStream) {
      if (opts.signal.aborted) {
        yield { type: 'error', error: new RelayError('RELAY_ABORTED', 'Relay cancelled by user') };
        return;
      }
      scoutText += chunk;
      yield { type: 'scout:delta', text: chunk };
    }

    const scoutUsage = await scoutStream.usage;
    yield {
      type: 'scout:end',
      fullText: scoutText,
      usage: {
        inputTokens: scoutUsage?.promptTokens ?? 0,
        outputTokens: scoutUsage?.completionTokens ?? 0,
      },
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      yield { type: 'error', error: new RelayError('RELAY_ABORTED', 'Relay cancelled') };
      return;
    }
    yield {
      type: 'error',
      error: new RelayError('RELAY_SCOUT_FAILED', (err as Error).message, 'scout'),
    };
    return;
  }

  if (!scoutText.trim()) {
    yield {
      type: 'error',
      error: new RelayError('RELAY_SCOUT_FAILED', 'Scout produced no output', 'scout'),
    };
    return;
  }

  // ── Phase 2: Anchor ────────────────────────────────────────────────────────
  yield { type: 'anchor:start' };

  try {
    const anchorMessages = buildAnchorMessages(opts.plan, opts.userInput, scoutText);

    const anchorStream = streamText({
      model: opts.anchorModel,
      messages: anchorMessages,
      temperature: opts.plan.anchor.temperature ?? 0.7,
      ...(opts.plan.anchor.maxOutputTokens !== undefined ? { maxTokens: opts.plan.anchor.maxOutputTokens } : {}),
      ...(opts.tools !== undefined ? { tools: opts.tools as Record<string, never> } : {}),
      abortSignal: opts.signal,
      maxSteps: opts.tools !== undefined ? 5 : 1,
    });

    let anchorText = '';
    for await (const chunk of anchorStream.textStream) {
      if (opts.signal.aborted) {
        yield { type: 'error', error: new RelayError('RELAY_ABORTED', 'Relay cancelled by user') };
        return;
      }
      anchorText += chunk;
      yield { type: 'anchor:delta', text: chunk };
    }

    if (!anchorText.trim()) {
      yield { type: 'error', error: new RelayError('RELAY_ANCHOR_FAILED', 'Anchor produced no output', 'anchor') };
      return;
    }

    const anchorUsage = await anchorStream.usage;
    yield {
      type: 'anchor:end',
      fullText: anchorText,
      usage: {
        inputTokens: anchorUsage?.promptTokens ?? 0,
        outputTokens: anchorUsage?.completionTokens ?? 0,
      },
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      yield { type: 'error', error: new RelayError('RELAY_ABORTED', 'Relay cancelled') };
      return;
    }
    yield {
      type: 'error',
      error: new RelayError('RELAY_ANCHOR_FAILED', (err as Error).message, 'anchor'),
    };
  }
}

// Build the anchor's messages array.
// The scout's output is delivered inside XML tags in the user turn so the
// anchor can clearly separate the original request from the scout's analysis.
function buildAnchorMessages(
  plan: RelayPlan,
  userInput: string,
  scoutOutput: string,
): CoreMessage[] {
  return [
    {
      role: 'system' as const,
      content:
        plan.anchor.systemPrompt ||
        'You are given an analysis prepared by a Scout model. Use it as your plan and execute the task completely.',
    },
    {
      role: 'user' as const,
      content:
        `<user_request>\n${userInput}\n</user_request>\n\n` +
        `<scout_analysis>\n${scoutOutput}\n</scout_analysis>\n\n` +
        `Execute the task based on the analysis above.`,
    },
  ];
}
