import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export interface ClaudeSession {
  /** Folder name (used as the session id) */
  id: string;
  /** Full path to the session directory */
  path: string;
  /** Altergo account name this session belongs to */
  account: string;
  /** Human-readable title — derived from session metadata or folder name */
  title: string;
  messageCount: number;
  lastActivity: Date;
  messages: ClaudeMessage[];
}

/**
 * Parse a single Claude Code JSONL session file into messages.
 *
 * Claude Code writes one JSON object per line. Each object should have a
 * `type` field; we care about `user` and `assistant` message types. The
 * schema has changed across Claude Code versions, so we handle several
 * formats gracefully:
 *
 *   - { type: 'user'|'assistant', message: { role, content } }
 *   - { role: 'user'|'assistant', content: string }
 *   - { type: 'user'|'assistant', content: string }  (older format)
 *
 * Malformed lines are silently skipped. This function never throws.
 */
export function parseClaudeSessionFile(filePath: string): ClaudeMessage[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const messages: ClaudeMessage[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Skip malformed JSON lines — common in truncated session files
      continue;
    }

    if (obj === null || typeof obj !== 'object') continue;
    const record = obj as Record<string, unknown>;

    // Try the nested format: { type, message: { role, content } }
    if (record['message'] !== null && typeof record['message'] === 'object') {
      const inner = record['message'] as Record<string, unknown>;
      const role = inner['role'];
      if (role === 'user' || role === 'assistant') {
        const content = extractContent(inner['content']);
        if (content !== null) {
          const ts = typeof record['timestamp'] === 'string' ? record['timestamp'] : undefined;
          messages.push(ts !== undefined ? { role, content, createdAt: ts } : { role, content });
          continue;
        }
      }
    }

    // Flat format: { role, content } or { type, content }
    const roleCandidate = record['role'] ?? record['type'];
    if (roleCandidate === 'user' || roleCandidate === 'assistant') {
      const content = extractContent(record['content']);
      if (content !== null) {
        const ts = typeof record['timestamp'] === 'string' ? record['timestamp'] : undefined;
        messages.push(ts !== undefined ? { role: roleCandidate, content, createdAt: ts } : { role: roleCandidate, content });
      }
    }
  }

  return messages;
}

/**
 * Extract a plain-text string from a `content` value that may be:
 *   - a plain string
 *   - an array of content blocks: [{ type: 'text', text: string }, ...]
 *
 * Returns null when the content is absent or unrecognisable.
 */
function extractContent(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) return null;

  const parts: string[] = [];
  for (const block of raw) {
    if (block !== null && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        parts.push(b['text']);
      } else if (typeof b['text'] === 'string') {
        parts.push(b['text']);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}

/**
 * Scan all Claude Code sessions for a given altergo account.
 *
 * Sessions live in `~/.altergo/accounts/<account>/.claude/projects/`, one
 * sub-directory per session. Each sub-directory contains one or more JSONL
 * files. We read all JSONL files in the folder and concatenate their messages.
 *
 * Returns sessions sorted by lastActivity descending (most recent first).
 * Never throws; unreadable directories are silently skipped.
 */
export function scanClaudeCodeSessions(
  altergoHome: string,
  accountName: string,
): ClaudeSession[] {
  const projectsDir = join(altergoHome, 'accounts', accountName, '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  let sessionFolders: string[];
  try {
    sessionFolders = readdirSync(projectsDir);
  } catch {
    return [];
  }

  const sessions: ClaudeSession[] = [];

  for (const folderName of sessionFolders) {
    const sessionDir = join(projectsDir, folderName);
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }

    let jsonlFiles: string[];
    try {
      jsonlFiles = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    if (jsonlFiles.length === 0) continue;

    const allMessages: ClaudeMessage[] = [];
    let lastModified = 0;

    for (const jsonlFile of jsonlFiles) {
      const filePath = join(sessionDir, jsonlFile);
      try {
        const st = statSync(filePath);
        if (st.mtimeMs > lastModified) lastModified = st.mtimeMs;
      } catch {
        // ignore stat failures — file may have been deleted between readdir and stat
      }
      const msgs = parseClaudeSessionFile(filePath);
      allMessages.push(...msgs);
    }

    // Derive a title from the first user message, falling back to the folder name
    const firstUserMsg = allMessages.find((m) => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ')
      : folderName;

    sessions.push({
      id: folderName,
      path: sessionDir,
      account: accountName,
      title,
      messageCount: allMessages.length,
      lastActivity: new Date(lastModified > 0 ? lastModified : Date.now()),
      messages: allMessages,
    });
  }

  // Most recent first
  return sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}
