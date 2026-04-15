import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { db } from '@uplnk/db';
import { conversations, messages, altergoImports } from '@uplnk/db';
import { eq } from 'drizzle-orm';
import type { UnifiedSession } from './sessions/index.js';
import { scanClaudeCodeSessions, parseClaudeSessionFile } from './sessions/claudeCodeScanner.js';
import { scanGeminiSessions, parseGeminiSessionFile } from './sessions/geminiScanner.js';

export interface ImportResult {
  conversationId: string;
  messageCount: number;
  /** false when the session was already imported and the source hash matches */
  imported: boolean;
}

/**
 * Compute a stable hash over the source directory or file so we can detect
 * whether a session has changed since the last import. We hash the
 * concatenation of file modification times and sizes — fast and good enough
 * for change detection without reading all content twice.
 */
function hashSourcePath(sourcePath: string): string {
  const h = createHash('sha256');

  try {
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = readdirSync(sourcePath).sort();
      } catch {
        // unreadable directory — hash what we can
      }
      for (const entry of entries) {
        try {
          const childPath = join(sourcePath, entry);
          const childStat = statSync(childPath);
          h.update(`${entry}:${String(childStat.mtimeMs)}:${String(childStat.size)}\n`);
        } catch {
          // skip unreadable entries
        }
      }
    } else {
      h.update(`${String(stat.mtimeMs)}:${String(stat.size)}`);
    }
  } catch {
    // If we can't stat at all, use a timestamp so the import runs rather than skipping
    h.update(String(Date.now()));
  }

  return h.digest('hex');
}

/**
 * Verify that a path, after resolving all symlinks, stays within the permitted
 * root directories. We allow anything under ~/.altergo or the user's $HOME to
 * accommodate primary-home session symlinks that altergo creates.
 *
 * Returns the resolved real path on success, or throws if the path escapes.
 * This is defence-in-depth — we never write to altergo directories, but we
 * don't want to accidentally follow a symlink pointing at /etc either.
 */
function safeRealpath(targetPath: string): string {
  const home = homedir();
  const altergoHome = join(home, '.altergo');

  let real: string;
  try {
    real = realpathSync(targetPath);
  } catch {
    // If realpath fails (broken symlink, etc.) just use the resolved path
    real = resolve(targetPath);
  }

  if (!real.startsWith(altergoHome) && !real.startsWith(home)) {
    throw new Error(
      `Security: path ${real} is outside the permitted root (${home}). Import aborted.`,
    );
  }

  return real;
}

/**
 * Import a single unified session into the uplnk SQLite database.
 *
 * The import is idempotent: if the source path was previously imported with
 * the same content hash the function returns early with imported:false.
 *
 * READ-ONLY contract: this function never writes to ~/.altergo/. It only
 * reads from the source path and writes to the uplnk database.
 */
export async function importSession(session: UnifiedSession): Promise<ImportResult> {
  // Validate symlinks before doing any work
  safeRealpath(session.sourcePath);

  const sourceHash = hashSourcePath(session.sourcePath);

  // Check for an existing import with matching hash — skip if unchanged
  const existing = db
    .select()
    .from(altergoImports)
    .where(eq(altergoImports.sourcePath, session.sourcePath))
    .limit(1)
    .all();

  if (existing.length > 0 && existing[0]!.sourceHash === sourceHash) {
    return {
      conversationId: existing[0]!.conversationId,
      messageCount: existing[0]!.messageCount,
      imported: false,
    };
  }

  // Load the full messages from the source files
  const rawMessages = loadSessionMessages(session);

  const conversationId = existing.length > 0 ? existing[0]!.conversationId : randomUUID();
  const importedFrom = `altergo:${session.provider}:${session.account}`;

  db.transaction(() => {
    // Upsert the conversation row
    db.insert(conversations)
      .values({
        id: conversationId,
        title: session.title.slice(0, 200),
        source: 'altergo',
        importedFrom,
      })
      .onConflictDoUpdate({
        target: conversations.id,
        set: {
          title: session.title.slice(0, 200),
          updatedAt: new Date().toISOString(),
        },
      })
      .run();

    // Delete existing messages so we can re-insert on re-import
    if (existing.length > 0) {
      db.delete(messages).where(eq(messages.conversationId, conversationId)).run();
    }

    // Insert messages
    for (const msg of rawMessages) {
      db.insert(messages)
        .values({
          id: randomUUID(),
          conversationId,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt ?? new Date().toISOString(),
        })
        .run();
    }

    // Upsert the altergo_imports tracking row
    db.insert(altergoImports)
      .values({
        id: existing.length > 0 ? existing[0]!.id : randomUUID(),
        account: session.account,
        provider: session.provider,
        sourcePath: session.sourcePath,
        sourceHash,
        conversationId,
        messageCount: rawMessages.length,
        importedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: altergoImports.sourcePath,
        set: {
          sourceHash,
          messageCount: rawMessages.length,
          importedAt: new Date().toISOString(),
        },
      })
      .run();
  });

  return { conversationId, messageCount: rawMessages.length, imported: true };
}

/**
 * Import all sessions for the given accounts.
 * Returns counts of imported, skipped (unchanged), and errored sessions.
 */
export async function importAllSessions(
  altergoHome: string,
  accountNames: string[],
): Promise<{ imported: number; skipped: number; errors: number }> {
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const account of accountNames) {
    const claudeSessions = (() => {
      try { return scanClaudeCodeSessions(altergoHome, account); }
      catch { return []; }
    })();

    const geminiSessions = (() => {
      try { return scanGeminiSessions(altergoHome, account); }
      catch { return []; }
    })();

    for (const s of claudeSessions) {
      const unified: UnifiedSession = {
        id: s.id,
        account: s.account,
        provider: 'claude-code',
        title: s.title,
        messageCount: s.messageCount,
        lastActivity: s.lastActivity,
        sourcePath: s.path,
      };
      try {
        const result = await importSession(unified);
        if (result.imported) imported++; else skipped++;
      } catch {
        errors++;
      }
    }

    for (const s of geminiSessions) {
      const unified: UnifiedSession = {
        id: s.id,
        account: s.account,
        provider: 'gemini',
        title: s.title,
        messageCount: s.messageCount,
        lastActivity: s.lastActivity,
        sourcePath: s.path,
      };
      try {
        const result = await importSession(unified);
        if (result.imported) imported++; else skipped++;
      } catch {
        errors++;
      }
    }
  }

  return { imported, skipped, errors };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface NormalisedMessage {
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

/**
 * Load the full message list for a session. We re-read from disk here (not
 * from the UnifiedSession.messageCount which is just a count) because the
 * UnifiedSession is a lightweight summary that may not carry the message bodies.
 */
function loadSessionMessages(session: UnifiedSession): NormalisedMessage[] {
  switch (session.provider) {
    case 'claude-code':
      return loadClaudeMessages(session.sourcePath);
    case 'gemini':
      return loadGeminiMessages(session.sourcePath);
    default:
      return [];
  }
}

function loadClaudeMessages(sourcePath: string): NormalisedMessage[] {
  try {
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      const files = readdirSync(sourcePath).filter((f) => f.endsWith('.jsonl'));
      const all: NormalisedMessage[] = [];
      for (const f of files) {
        all.push(...parseClaudeSessionFile(join(sourcePath, f)));
      }
      return all;
    } else {
      return parseClaudeSessionFile(sourcePath);
    }
  } catch {
    return [];
  }
}

function loadGeminiMessages(sourcePath: string): NormalisedMessage[] {
  try {
    const stat = statSync(sourcePath);
    if (stat.isDirectory()) {
      const files = readdirSync(sourcePath).filter(
        (f) => f.endsWith('.json') || f.endsWith('.jsonl'),
      );
      const all: NormalisedMessage[] = [];
      for (const f of files) {
        all.push(...parseGeminiSessionFile(join(sourcePath, f)));
      }
      return all;
    } else {
      return parseGeminiSessionFile(sourcePath);
    }
  } catch {
    return [];
  }
}
