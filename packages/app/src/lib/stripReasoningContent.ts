/**
 * stripReasoningContent — drop stale reasoning from all but the most recent
 * assistant turn before sending a history back to the model.
 *
 * Reasoning models (DeepSeek-R1, Qwen3-thinking, OpenAI o-series via OpenRouter,
 * Ollama / vLLM-hosted thinking variants) emit a separate reasoning channel
 * alongside the user-visible answer. Two shapes exist in the wild:
 *
 *   1. AI SDK normalized: a `{ type: 'reasoning', text }` or
 *      `{ type: 'redacted-reasoning', data }` part inside `content[]`.
 *   2. Provider-raw: a top-level `reasoning` (OpenAI o-series convention) or
 *      `reasoning_content` (Ollama / vLLM convention) field on the assistant
 *      message object, attached as a non-standard sibling to `content`.
 *
 * Some chat templates re-inject prior `<think>` blocks on the next turn,
 * which accumulates thousands of stale tokens per round. The Odysseus pattern
 * (cf. agent_loop._append_tool_results) keeps reasoning only on the LAST
 * assistant turn — in-flight tool calls in that turn may reference it — and
 * strips it from every earlier assistant turn.
 *
 * Composes after `sanitizeMessages`: sanitize first to settle the message
 * shape (drop orphan tools, merge users), then strip reasoning from the
 * resulting structure. Safe and idempotent on non-reasoning models (no-op).
 */

import type { CoreMessage } from 'ai';

function isReasoningPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return type === 'reasoning' || type === 'redacted-reasoning';
}

/**
 * Index of the last `role: 'assistant'` message, or -1 if none.
 */
function lastAssistantIndex(messages: readonly CoreMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'assistant') return i;
  }
  return -1;
}

/**
 * Return a copy of `msg` with reasoning removed. Touches:
 *   - array-content reasoning / redacted-reasoning parts
 *   - top-level non-standard `reasoning` / `reasoning_content` fields
 *
 * Never mutates input. Returns the original reference when nothing changed
 * so callers can detect no-ops cheaply.
 */
function stripReasoningFromAssistant(msg: CoreMessage): CoreMessage {
  if (msg.role !== 'assistant') return msg;

  // The CoreMessage type does not declare reasoning/reasoning_content at the
  // top level, but some providers attach them on the deserialized history
  // (e.g. when an app round-trips raw provider JSON). Strip defensively via
  // a typed rest-spread; never mutate.
  const raw = msg as CoreMessage & {
    reasoning?: unknown;
    reasoning_content?: unknown;
  };
  const hasTopLevelReasoning =
    'reasoning' in raw || 'reasoning_content' in raw;

  let nextContent: CoreMessage['content'] = msg.content;
  if (Array.isArray(msg.content)) {
    const filtered = msg.content.filter((part) => !isReasoningPart(part));
    if (filtered.length !== msg.content.length) {
      nextContent = filtered as CoreMessage['content'];
    }
  }

  if (!hasTopLevelReasoning && nextContent === msg.content) {
    return msg;
  }

  // Rebuild without the top-level reasoning fields. We can't simply destructure
  // because CoreMessage is a discriminated union — copy known fields instead.
  const { reasoning: _r, reasoning_content: _rc, ...rest } = raw;
  return { ...rest, content: nextContent } as CoreMessage;
}

/**
 * Strip reasoning content from every assistant message except the last.
 * Returns a NEW array; input is not mutated. O(n) over the message list.
 *
 * No-op when there are zero or one assistant messages, or when no assistant
 * message carries any reasoning shape (non-reasoning models).
 */
export function stripReasoningContent(
  messages: readonly CoreMessage[],
): CoreMessage[] {
  const lastIdx = lastAssistantIndex(messages);
  const out: CoreMessage[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && i !== lastIdx) {
      out[i] = stripReasoningFromAssistant(msg);
    } else {
      out[i] = msg;
    }
  }
  return out;
}
