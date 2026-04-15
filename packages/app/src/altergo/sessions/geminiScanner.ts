import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GeminiMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export interface GeminiSession {
  id: string;
  path: string;
  account: string;
  title: string;
  messageCount: number;
  lastActivity: Date;
  messages: GeminiMessage[];
}

/**
 * Parse a Gemini CLI session file.
 *
 * Gemini CLI stores sessions as JSON files (not JSONL). The structure looks
 * like:
 *   { "messages": [{ "role": "user"|"model", "parts": [{ "text": "..." }] }] }
 *
 * Older versions may use flat `content` fields or a flat messages array with
 * `role` and `content`. We handle both formats. Malformed files return [].
 */
export function parseGeminiSessionFile(filePath: string): GeminiMessage[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Gemini may also write JSONL — fall through to line-by-line parsing
    return parseGeminiSessionFileAsJsonl(raw);
  }

  if (parsed === null || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  const rawMessages = obj['messages'] ?? obj['history'] ?? obj['conversation'];
  if (!Array.isArray(rawMessages)) return [];

  const messages: GeminiMessage[] = [];
  for (const item of rawMessages) {
    if (item === null || typeof item !== 'object') continue;
    const msg = item as Record<string, unknown>;

    // Gemini uses 'model' for the assistant role
    const rawRole = msg['role'];
    const role: 'user' | 'assistant' | null =
      rawRole === 'user' ? 'user' :
      rawRole === 'model' || rawRole === 'assistant' ? 'assistant' :
      null;
    if (role === null) continue;

    const content = extractGeminiContent(msg);
    if (content === null) continue;

    const ts = typeof msg['timestamp'] === 'string' ? msg['timestamp'] : undefined;
    messages.push(ts !== undefined ? { role, content, createdAt: ts } : { role, content });
  }

  return messages;
}

/** Fall-back parser: treat each non-empty line as a JSON object (JSONL). */
function parseGeminiSessionFileAsJsonl(raw: string): GeminiMessage[] {
  const messages: GeminiMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') continue;
    const msg = obj as Record<string, unknown>;
    const rawRole = msg['role'];
    const role: 'user' | 'assistant' | null =
      rawRole === 'user' ? 'user' :
      rawRole === 'model' || rawRole === 'assistant' ? 'assistant' :
      null;
    if (role === null) continue;
    const content = extractGeminiContent(msg);
    if (content !== null) messages.push({ role, content });
  }
  return messages;
}

/**
 * Extract text from a Gemini message, which may use `parts`, `content`, or
 * `text` depending on the version of the CLI.
 */
function extractGeminiContent(msg: Record<string, unknown>): string | null {
  // Format 1: { parts: [{ text: string }] }
  if (Array.isArray(msg['parts'])) {
    const texts: string[] = [];
    for (const part of msg['parts'] as unknown[]) {
      if (part !== null && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (typeof p['text'] === 'string') texts.push(p['text']);
      }
    }
    if (texts.length > 0) return texts.join('');
  }

  // Format 2: { content: string }
  if (typeof msg['content'] === 'string') return msg['content'];

  // Format 3: { text: string }
  if (typeof msg['text'] === 'string') return msg['text'];

  return null;
}

/**
 * Scan Gemini CLI sessions for a given altergo account.
 *
 * Gemini sessions live in `~/.altergo/accounts/<account>/.gemini/tmp/`. Each
 * file in that directory is a session (JSON or JSONL). Subdirectories are
 * also checked one level deep.
 *
 * Returns sessions sorted by lastActivity descending. Never throws.
 */
export function scanGeminiSessions(
  altergoHome: string,
  accountName: string,
): GeminiSession[] {
  const geminiDir = join(altergoHome, 'accounts', accountName, '.gemini', 'tmp');
  if (!existsSync(geminiDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(geminiDir);
  } catch {
    return [];
  }

  const sessions: GeminiSession[] = [];

  for (const entry of entries) {
    const entryPath = join(geminiDir, entry);
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }

    const filesToParse: string[] = [];
    if (stat.isFile() && (entry.endsWith('.json') || entry.endsWith('.jsonl'))) {
      filesToParse.push(entryPath);
    } else if (stat.isDirectory()) {
      // One level deep: session folder containing JSON files
      try {
        const subEntries = readdirSync(entryPath);
        for (const sub of subEntries) {
          if (sub.endsWith('.json') || sub.endsWith('.jsonl')) {
            filesToParse.push(join(entryPath, sub));
          }
        }
      } catch {
        continue;
      }
    }

    if (filesToParse.length === 0) continue;

    const allMessages: GeminiMessage[] = [];
    let lastModified = stat.mtimeMs;

    for (const f of filesToParse) {
      try {
        const fStat = statSync(f);
        if (fStat.mtimeMs > lastModified) lastModified = fStat.mtimeMs;
      } catch {
        // ignore
      }
      const msgs = parseGeminiSessionFile(f);
      allMessages.push(...msgs);
    }

    if (allMessages.length === 0) continue;

    const firstUserMsg = allMessages.find((m) => m.role === 'user');
    const title = firstUserMsg
      ? firstUserMsg.content.slice(0, 60).replace(/\n/g, ' ')
      : entry.replace(/\.(json|jsonl)$/, '');

    sessions.push({
      id: entry,
      path: entryPath,
      account: accountName,
      title,
      messageCount: allMessages.length,
      lastActivity: new Date(lastModified),
      messages: allMessages,
    });
  }

  return sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}
