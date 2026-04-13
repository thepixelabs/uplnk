/**
 * telemetry.ts — Anonymous opt-in usage telemetry for uplnk.
 *
 * Privacy guarantees enforced here:
 *   - NEVER collects message content, file paths, user identity, or API keys.
 *   - All collection is gated on `config.telemetry.enabled === true`.
 *   - Default is disabled; the user must explicitly opt in on first run.
 *
 * This module is a typed no-op stub. The actual HTTP transport, batching, and
 * flush logic ship in a follow-up PR once the CF Worker ingestion endpoint is
 * live. Call sites can be wired today — they will silently do nothing until
 * the transport is activated.
 */

import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';

// ─── Event Names ─────────────────────────────────────────────────────────────

export type TelemetryEventName =
  | 'app_start'
  | 'provider_connected'
  | 'message_sent'
  | 'message_received'
  | 'code_block_copied'
  | 'mcp_tool_called'
  | 'session_end';

// ─── Per-Event Property Shapes ────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppStartProperties {
  // No additional properties — the envelope carries all needed signal.
}

export interface ProviderConnectedProperties {
  /** "ollama" | "vllm" | "lmstudio" | "localai" | "custom" */
  provider_type: string;
}

export interface MessageSentProperties {
  /** 0-based index of this message in the conversation (0 = first/setup-completion signal). */
  conversation_message_index: number;
  /** Whether MCP tools were available in this session. */
  has_mcp_tools: boolean;
}

export interface MessageReceivedProperties {
  /** Wall-clock milliseconds from send() invocation to status === 'done'. */
  stream_duration_ms: number;
  /** Whether the response included any MCP tool calls. */
  had_tool_calls: boolean;
}

export interface CodeBlockCopiedProperties {
  /**
   * Detected language tag from the fenced code block, e.g. "typescript",
   * "python", "bash". "unknown" when no language is specified.
   */
  language: string;
  /** Index of the assistant message that contained the code block. */
  conversation_message_index: number;
}

export interface McpToolCalledProperties {
  /** Tool name, e.g. "read_file" | "list_directory" | "exec_command". */
  tool_name: string;
  /** Whether the user approved the tool call in the approval dialog. */
  approved: boolean;
}

export interface SessionEndProperties {
  /** Wall-clock milliseconds from process start to session_end event. */
  session_duration_ms: number;
  /** Total user messages sent in this session. */
  messages_sent_count: number;
  /** Total assistant responses received in this session. */
  messages_received_count: number;
  exit_reason: 'clean' | 'sigterm' | 'sighup';
}

// ─── Discriminated Union ─────────────────────────────────────────────────────

export type TelemetryEvent =
  | { event: 'app_start'; properties: AppStartProperties }
  | { event: 'provider_connected'; properties: ProviderConnectedProperties }
  | { event: 'message_sent'; properties: MessageSentProperties }
  | { event: 'message_received'; properties: MessageReceivedProperties }
  | { event: 'code_block_copied'; properties: CodeBlockCopiedProperties }
  | { event: 'mcp_tool_called'; properties: McpToolCalledProperties }
  | { event: 'session_end'; properties: SessionEndProperties };

// ─── Internal Envelope ───────────────────────────────────────────────────────
// Populated at flush time, not at track time, to avoid repeated lookups.

export interface TelemetryEnvelope {
  event: TelemetryEventName;
  timestamp: string;       // ISO 8601 UTC
  session_id: string;      // random UUID v4, fresh per process start, never persisted
  uplnk_version: string;   // semver from package.json
  os_platform: string;     // process.platform — "darwin" | "linux"
  node_version: string;    // process.versions.node
  model_name: string;      // normalized
  properties: Record<string, unknown>;
}

// ─── Module State ─────────────────────────────────────────────────────────────

let _enabled = false;
let _startMs = 0;

// Envelope fields populated at init time. Bundled into a single object so that
// the transport (future PR) can spread them into each outbound event record
// without pulling from individual module-level variables.
const _meta: {
  session_id: string;
  uplnk_version: string;
  model_name: string;
} = {
  session_id: '',
  uplnk_version: '',
  model_name: '',
};

// Event buffer — flushed every 5 minutes or on session_end.
const _buffer: TelemetryEvent[] = [];

// ─── Normalise Model Name ─────────────────────────────────────────────────────
// Strip private quantization suffixes while keeping public ones.

const KNOWN_SUFFIXES = new Set([
  '8b', '13b', '70b', '7b', '3b', '1b', 'latest',
  'q4_0', 'q4_k_m', 'q8_0', 'fp16', 'v2', 'v3',
]);

export function normalizeModelName(raw: string): string {
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx === -1) return raw;
  const base = raw.slice(0, colonIdx);
  const tag = raw.slice(colonIdx + 1).toLowerCase();
  if (KNOWN_SUFFIXES.has(tag)) return raw;
  return `${base}:unknown`;
}

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Call once, before any trackEvent calls. Reads telemetry.enabled from config.
 * If disabled, all subsequent trackEvent calls are cheap no-ops.
 */
export function initTelemetry(config: Config, uplnkVersion: string, modelName: string): void {
  _enabled = config.telemetry?.enabled === true;
  if (!_enabled) return;

  _meta.session_id = randomUUID();
  _meta.uplnk_version = uplnkVersion;
  _meta.model_name = normalizeModelName(modelName);
  _startMs = Date.now();
}

// ─── Track ───────────────────────────────────────────────────────────────────

/**
 * Buffer a telemetry event. No-ops silently when:
 *   - telemetry is disabled (config.telemetry.enabled !== true)
 *   - initTelemetry has not been called
 *
 * The call is synchronous and cheap — it only pushes to an in-memory array.
 * Actual network I/O happens in the flush path (future PR).
 */
export function trackEvent(event: TelemetryEvent): void {
  if (!_enabled) return;
  _buffer.push(event);
  // Buffer cap: prevent unbounded growth in long-running sessions.
  if (_buffer.length >= 50) {
    flushEvents();
  }
}

// ─── Flush ───────────────────────────────────────────────────────────────────

/**
 * Drain the event buffer. Currently a no-op stub — the HTTP transport
 * ships in the follow-up PR that wires the CF Worker endpoint.
 *
 * This function is exported so the flush timer and session_end handler
 * in bin/pylon.ts can call it, giving them a stable surface to wire
 * against today.
 */
export function flushEvents(): void {
  if (!_enabled || _buffer.length === 0) return;

  // Drain buffer into a local snapshot.
  const batch = _buffer.splice(0, _buffer.length);

  // TODO(telemetry-transport): Build envelopes and POST to
  // https://telemetry.uplnk.pixelabs.net/v1/events. Wrap in try/catch — a telemetry
  // failure must never surface to the user or affect app behavior.
  //
  // Envelope shape (per event):
  //   {
  //     event: evt.event,
  //     timestamp: new Date().toISOString(),
  //     ..._meta,                    // session_id, pylon_version, model_name
  //     os_platform: process.platform,
  //     node_version: process.versions.node,
  //     properties: evt.properties,
  //   }
  void batch; // suppress unused-variable warning until transport is wired
}

// ─── Session Helpers ─────────────────────────────────────────────────────────

/** Returns milliseconds elapsed since initTelemetry was called. */
export function getSessionDurationMs(): number {
  if (_startMs === 0) return 0;
  return Date.now() - _startMs;
}

/** Exposed for testing — resets all module state. */
export function _resetTelemetryForTest(): void {
  _enabled = false;
  _meta.session_id = '';
  _meta.uplnk_version = '';
  _meta.model_name = '';
  _startMs = 0;
  _buffer.length = 0;
}
