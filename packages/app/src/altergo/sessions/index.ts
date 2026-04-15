import { scanClaudeCodeSessions } from './claudeCodeScanner.js';
import { scanGeminiSessions } from './geminiScanner.js';

export type AltergoProvider = 'claude-code' | 'gemini' | 'codex' | 'copilot';

export interface UnifiedSession {
  id: string;
  account: string;
  provider: AltergoProvider;
  title: string;
  messageCount: number;
  lastActivity: Date;
  sourcePath: string;
}

/**
 * Scan all accounts for all supported providers and return a single unified
 * list, sorted by lastActivity descending.
 *
 * This is intentionally additive — new providers can be wired in here without
 * touching calling code. Currently supports claude-code and gemini; codex and
 * copilot fall back to empty lists until scanners are implemented.
 */
export function getAllSessions(
  altergoHome: string,
  accountNames: string[],
): UnifiedSession[] {
  const unified: UnifiedSession[] = [];

  for (const account of accountNames) {
    // Claude Code
    try {
      const claudeSessions = scanClaudeCodeSessions(altergoHome, account);
      for (const s of claudeSessions) {
        unified.push({
          id: s.id,
          account: s.account,
          provider: 'claude-code',
          title: s.title,
          messageCount: s.messageCount,
          lastActivity: s.lastActivity,
          sourcePath: s.path,
        });
      }
    } catch {
      // Per-account, per-provider scan failure must not abort the rest
    }

    // Gemini CLI
    try {
      const geminiSessions = scanGeminiSessions(altergoHome, account);
      for (const s of geminiSessions) {
        unified.push({
          id: s.id,
          account: s.account,
          provider: 'gemini',
          title: s.title,
          messageCount: s.messageCount,
          lastActivity: s.lastActivity,
          sourcePath: s.path,
        });
      }
    } catch {
      // Per-account, per-provider scan failure must not abort the rest
    }

    // Codex and Copilot: scanners not yet implemented — no-op
  }

  return unified.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
}
