/**
 * sanitizeMessages — defensive pre-send pass over a CoreMessage[] history.
 *
 * After context compaction, retries, partial aborts, or multi-step tool runs,
 * the message history can become structurally malformed in ways that providers
 * reject silently or noisily:
 *
 *   - A `role: 'tool'` message whose preceding assistant turn no longer
 *     contains the matching `tool_calls` entry (orphan tool result).
 *   - An assistant turn that contains a `tool-call` block followed by no
 *     matching `tool` result (unanswered tool call).
 *   - Two `role: 'user'` messages in a row (often from injecting an untrusted-
 *     context wrapper or a system-style nudge as `user`).
 *
 * Some providers — OpenAI in particular — return a 400 on (a) and (b).
 * Others (Anthropic, some Ollama paths) silently misinterpret them. None
 * of them benefit from receiving these shapes.
 *
 * We run this defensively just before every `streamText()` call. The function
 * is total: it returns a NEW array, never mutates input, and never throws.
 *
 * Approach (each pass is independent and idempotent):
 *   1. Drop `tool` messages whose toolCallId has no matching assistant
 *      `tool-call` part in the preceding assistant message.
 *   2. Drop assistant `tool-call` parts whose toolCallId has no matching
 *      `tool` message immediately following. If an assistant message becomes
 *      empty of all content after this, drop the assistant message too.
 *   3. Merge consecutive `user` messages (concatenate their string content with
 *      a blank line separator, keep the first message's content for arrays).
 *
 * Out of scope (Phase A): provider-specific quirks like Anthropic's
 * tool_use/tool_result block ordering. Those live in the provider layer.
 */

import type { CoreMessage } from 'ai';

interface AssistantToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

function isAssistantToolCallPart(part: unknown): part is AssistantToolCallPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: string }).type === 'tool-call' &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

function getToolCallIdsFromAssistant(msg: CoreMessage): Set<string> {
  if (msg.role !== 'assistant') return new Set();
  const content = msg.content;
  if (typeof content === 'string') return new Set();
  if (!Array.isArray(content)) return new Set();
  const ids = new Set<string>();
  for (const part of content) {
    if (isAssistantToolCallPart(part)) {
      ids.add(part.toolCallId);
    }
  }
  return ids;
}

function getToolResultId(msg: CoreMessage): string | null {
  if (msg.role !== 'tool') return null;
  const content = msg.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: string }).type === 'tool-result' &&
      typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
    ) {
      return (part as { toolCallId: string }).toolCallId;
    }
  }
  return null;
}

/**
 * Pass 1 — drop orphan tool messages.
 */
function dropOrphanToolMessages(messages: CoreMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  let lastAssistantCallIds: Set<string> = new Set();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      lastAssistantCallIds = getToolCallIdsFromAssistant(msg);
      out.push(msg);
    } else if (msg.role === 'tool') {
      const resultId = getToolResultId(msg);
      if (resultId !== null && lastAssistantCallIds.has(resultId)) {
        out.push(msg);
      }
      // else: orphan — drop silently
    } else {
      // user / system — flush the active tool-call expectation
      lastAssistantCallIds = new Set();
      out.push(msg);
    }
  }
  return out;
}

/**
 * Pass 2 — drop assistant tool-call parts that have no following tool result.
 * If an assistant message loses all its parts to this filter and had no text,
 * drop the message entirely.
 */
function dropUnansweredToolCalls(messages: CoreMessage[]): CoreMessage[] {
  // Collect resolved tool-call ids: each tool result message satisfies one id.
  const out: CoreMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || typeof msg.content === 'string' || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    // Find the set of tool-call ids that have a matching tool result in the
    // remaining message stream — but ONLY if the tool result appears before the
    // next assistant message (otherwise the conversation has already moved on).
    const resolvedIds = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === 'tool') {
        const id = getToolResultId(next);
        if (id !== null) resolvedIds.add(id);
      } else if (next.role === 'assistant') {
        break;
      }
    }

    const filteredParts = msg.content.filter((part) => {
      if (!isAssistantToolCallPart(part)) return true;
      return resolvedIds.has(part.toolCallId);
    });

    // If filtering dropped everything (only tool-call parts existed and none resolved),
    // drop the whole assistant message.
    if (filteredParts.length === 0) continue;

    if (filteredParts.length !== msg.content.length) {
      out.push({ ...msg, content: filteredParts } as CoreMessage);
    } else {
      out.push(msg);
    }
  }
  return out;
}

/**
 * Pass 3 — merge consecutive user messages.
 */
function mergeConsecutiveUser(messages: CoreMessage[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.role === 'user' &&
      msg.role === 'user' &&
      typeof prev.content === 'string' &&
      typeof msg.content === 'string'
    ) {
      out[out.length - 1] = {
        role: 'user',
        content: `${prev.content}\n\n${msg.content}`,
      };
    } else {
      out.push(msg);
    }
  }
  return out;
}

/**
 * Run all sanitization passes. Returns a NEW array; input is not mutated.
 *
 * Cheap: O(n) over the message list. Safe to call before every `streamText`.
 */
export function sanitizeMessages(messages: readonly CoreMessage[]): CoreMessage[] {
  const a = dropOrphanToolMessages([...messages]);
  const b = dropUnansweredToolCalls(a);
  const c = mergeConsecutiveUser(b);
  return c;
}
