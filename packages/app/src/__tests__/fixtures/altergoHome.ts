import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface FakeAltergoHome {
  home: string;        // path to fake ~/.altergo
  accountsDir: string; // ~/.altergo/accounts/

  /** Create an account directory with the given providers */
  addAccount(name: string, providers: string[]): string;

  /** Add a Claude Code session JSONL file to an account */
  addClaudeSession(account: string, sessionFolder: string, jsonlLines: object[]): string;

  /** Add a Gemini session JSON file to an account */
  addGeminiSession(account: string, sessionName: string, obj: object): string;

  /** Write a state.json for active account tracking */
  setActiveAccount(provider: string, account: string): void;

  cleanup(): void;
}

export function createFakeAltergoHome(): FakeAltergoHome {
  const home = mkdtempSync(join(tmpdir(), 'uplnk-altergo-'));
  const accountsDir = join(home, 'accounts');
  mkdirSync(accountsDir, { recursive: true });

  return {
    home,
    accountsDir,

    addAccount(name: string, providers: string[]): string {
      const accountDir = join(accountsDir, name);
      mkdirSync(accountDir, { recursive: true });

      const providerDirMap: Record<string, string> = {
        'claude-code': '.claude',
        'gemini': '.gemini',
        'codex': '.codex',
        'copilot': '.copilot',
      };

      for (const provider of providers) {
        const dotDir = providerDirMap[provider];
        if (dotDir !== undefined) {
          mkdirSync(join(accountDir, dotDir), { recursive: true });
        }
      }

      return accountDir;
    },

    addClaudeSession(account: string, sessionFolder: string, jsonlLines: object[]): string {
      const projectsDir = join(accountsDir, account, '.claude', 'projects', sessionFolder);
      mkdirSync(projectsDir, { recursive: true });

      const filePath = join(projectsDir, 'session.jsonl');
      const content = jsonlLines.map((l) => JSON.stringify(l)).join('\n');
      writeFileSync(filePath, content, 'utf-8');
      return filePath;
    },

    addGeminiSession(account: string, sessionName: string, obj: object): string {
      const tmpDir = join(accountsDir, account, '.gemini', 'tmp');
      mkdirSync(tmpDir, { recursive: true });

      const filePath = join(tmpDir, `${sessionName}.json`);
      writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf-8');
      return filePath;
    },

    setActiveAccount(provider: string, account: string): void {
      const stateFile = join(home, 'state.json');
      const current: Record<string, string> = {};
      if (existsSync(stateFile)) {
        try {
          Object.assign(
            current,
            JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, string>,
          );
        } catch { /* ignore malformed state */ }
      }
      current[provider] = account;
      writeFileSync(stateFile, JSON.stringify(current), 'utf-8');
    },

    cleanup(): void {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/** Minimal valid Claude Code JSONL line */
export function makeClaudeJSONLLine(
  role: 'user' | 'assistant',
  content: string,
  timestamp?: string,
): object {
  return {
    type: 'message',
    message: {
      role,
      content,
      ...(timestamp !== undefined ? { timestamp } : {}),
    },
  };
}

/** Minimal valid Gemini session object */
export function makeGeminiSession(
  messages: Array<{ role: string; text: string }>,
): object {
  return {
    messages: messages.map((m) => ({
      role: m.role,
      parts: [{ text: m.text }],
    })),
  };
}
