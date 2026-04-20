/**
 * User-input parsers for @agent / @path mentions.
 *
 * Two entry points:
 *   - `parseAgentMention(input, registry)` — legacy, first-token-only; kept
 *     while ChatScreen migrates to the payload-based flow below.
 *   - `extractMentions(input, registry, projectDir)` — scans the entire input
 *     for `@agent-name` tokens (routing) and `@./file`/`@../file`/`@~/file`/
 *     `@/abs/file` tokens (local file attachments read directly off disk).
 *
 * Attachments are read via `node:fs` — no MCP, no allowlist. Binary content
 * is detected by null-byte sniff and omitted. Oversized files are truncated.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AgentDef, IAgentRegistry } from './types.js';

// ─── Legacy: first-token mention ─────────────────────────────────────────────

const AGENT_MENTION_RE = /^@([a-z][a-z0-9-]*)\s+([\s\S]+)/;

export function parseAgentMention(
  input: string,
  registry: IAgentRegistry,
): { agent: AgentDef; prompt: string } | null {
  const trimmed = input.trim();
  const match = AGENT_MENTION_RE.exec(trimmed);
  if (match === null) return null;

  const [, name, prompt] = match;
  if (name === undefined || prompt === undefined) return null;

  const agent = registry.get(name);
  if (agent === undefined) return null;

  return { agent, prompt: prompt.trim() };
}

// ─── New: structured payload extraction ──────────────────────────────────────

export interface FileAttachment {
  /** Original token as it appeared in the user text (e.g. '@../src/foo.ts'). */
  token: string;
  /** Absolute resolved path. */
  absPath: string;
  /** Path relative to `projectDir`, for compact display/injection. */
  relPath: string;
  /** File contents; null when unreadable or detected binary. */
  content: string | null;
  /** Byte size on disk (0 if stat failed). */
  bytes: number;
  /** True when contents were truncated to respect `maxFileBytes`. */
  truncated: boolean;
  /** Human-readable reason when content is null. */
  error?: string;
}

export interface SubmitPayload {
  /** Verbatim user text — unchanged. */
  text: string;
  /** Resolved agent names, in order of appearance, deduped. Unknown names are dropped. */
  addressees: string[];
  /** Resolved file attachments, in order, deduped by absPath. */
  attachments: FileAttachment[];
}

export interface ExtractOptions {
  /** Per-file byte cap. Default 256 KiB. */
  maxFileBytes?: number;
  /** Max attachments per submit. Default 8. */
  maxAttachments?: number;
}

// Path tokens: require leading ./, ../, ~/, or /. Avoids grabbing email
// addresses like `foo@bar.com`. The charset is intentionally permissive to
// accept hyphens, dots, underscores, etc. within the path.
const PATH_MENTION_RE = /(^|\s)@((?:\.{1,2}\/|~\/|\/)[^\s@]+)/g;

// Agent tokens: kebab identifier after `@`, bounded. Excludes paths
// (anything starting with . / ~) via the first class.
const AGENT_TOKEN_RE = /(^|\s)@([a-z][a-z0-9_-]*)(?=\b|\s|$)/g;

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 8;
const BINARY_SNIFF_BYTES = 512;

function resolveAttachmentPath(token: string, projectDir: string): string {
  // token always begins with @ — strip it
  const raw = token.startsWith('@') ? token.slice(1) : token;
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(projectDir, raw);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function readAttachment(
  token: string,
  projectDir: string,
  maxFileBytes: number,
): FileAttachment {
  const absPath = resolveAttachmentPath(token, projectDir);
  const base: Omit<FileAttachment, 'content' | 'bytes' | 'truncated' | 'error'> = {
    token,
    absPath,
    relPath: relative(projectDir, absPath) || absPath,
  };
  try {
    const st = statSync(absPath);
    if (!st.isFile()) {
      return {
        ...base,
        content: null,
        bytes: 0,
        truncated: false,
        error: 'not a regular file',
      };
    }
    const bytes = st.size;
    const readBytes = Math.min(bytes, maxFileBytes);
    const buf = Buffer.alloc(readBytes);
    // Use readFileSync with encoding=null then slice — simpler than fd dance.
    const full = readFileSync(absPath);
    full.copy(buf, 0, 0, readBytes);
    if (looksBinary(buf)) {
      return {
        ...base,
        content: null,
        bytes,
        truncated: false,
        error: 'binary file skipped',
      };
    }
    return {
      ...base,
      content: buf.toString('utf-8'),
      bytes,
      truncated: bytes > readBytes,
    };
  } catch (err) {
    return {
      ...base,
      content: null,
      bytes: 0,
      truncated: false,
      error: (err as NodeJS.ErrnoException).code ?? 'read failed',
    };
  }
}

/**
 * Extract agent addressees and file attachments from the user's input text.
 *
 * Behaviour:
 *   - An `@agent-name` token is an addressee only if the registry resolves it.
 *     Unknown names are silently left as inline text (no side effect on the
 *     payload beyond being part of `text`).
 *   - Path tokens (`@./x`, `@../x`, `@~/x`, `@/abs/x`) are always treated as
 *     file attachments, even if they don't exist — in that case the attachment
 *     is included with `content: null` and an `error` so the UI can render a
 *     strikethrough / warning.
 *   - The input `text` is returned verbatim; callers decide whether to strip
 *     tokens before handing to the LLM.
 *   - Dedup: first occurrence of an addressee wins; attachments dedup by absPath.
 */
export function extractMentions(
  input: string,
  registry: IAgentRegistry,
  projectDir: string,
  opts: ExtractOptions = {},
): SubmitPayload {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxAttachments = opts.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;

  const addressees: string[] = [];
  const seenAddressee = new Set<string>();
  const attachments: FileAttachment[] = [];
  const seenAttachment = new Set<string>();

  // Paths first — their regex doesn't overlap the agent regex (paths require
  // / . or ~), but we run them independently either way.
  PATH_MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_MENTION_RE.exec(input)) !== null) {
    if (attachments.length >= maxAttachments) break;
    const raw = m[2];
    if (raw === undefined) continue;
    const token = `@${raw}`;
    const absPath = resolveAttachmentPath(token, projectDir);
    if (seenAttachment.has(absPath)) continue;
    seenAttachment.add(absPath);
    attachments.push(readAttachment(token, projectDir, maxFileBytes));
  }

  AGENT_TOKEN_RE.lastIndex = 0;
  while ((m = AGENT_TOKEN_RE.exec(input)) !== null) {
    const name = m[2];
    if (name === undefined) continue;
    if (seenAddressee.has(name)) continue;
    const agent = registry.get(name);
    if (agent === undefined) continue;
    seenAddressee.add(name);
    addressees.push(name);
  }

  return { text: input, addressees, attachments };
}

/**
 * Render an attachment block suitable for injection into the model's context.
 * Uses fenced blocks; truncated files get a trailing note. Returns empty
 * string when `attachments` is empty so callers can unconditionally concat.
 */
export function formatAttachmentsForContext(
  attachments: readonly FileAttachment[],
): string {
  if (attachments.length === 0) return '';
  const parts: string[] = ['<attachments>'];
  for (const a of attachments) {
    parts.push(`<file path="${a.relPath}" bytes="${a.bytes}">`);
    if (a.content !== null) {
      parts.push('```');
      parts.push(a.content);
      if (a.truncated) {
        parts.push(
          `… [truncated: ${a.bytes - a.content.length} bytes not shown]`,
        );
      }
      parts.push('```');
    } else {
      parts.push(`[unavailable: ${a.error ?? 'unknown'}]`);
    }
    parts.push('</file>');
  }
  parts.push('</attachments>');
  return parts.join('\n');
}
