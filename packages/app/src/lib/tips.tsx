/**
 * Startup tip-of-the-run rotation.
 *
 * Each launch picks the next eligible tip from TIPS and shows it under
 * the chat for a few seconds, then auto-hides. The index is persisted to
 * ~/.uplnk/tip-state.json so consecutive launches advance through the
 * catalogue rather than repeating one tip forever.
 *
 * Platform-specific tips (currently macOS Option-drag) are filtered out
 * on the wrong OS so a Linux user never sees darwin-only advice.
 */

import type { ReactNode } from 'react';
import { Text } from 'ink';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUplnkDir } from '@uplnk/db';

export interface Tip {
  id: string;
  platforms?: NodeJS.Platform[];
  render: () => ReactNode;
}

/**
 * Catalogue of one-line tips. Order is preserved across launches via
 * tip-state.json; appending a new tip here means it gets shown after the
 * current rotation cycle wraps around.
 */
export const TIPS: Tip[] = [
  {
    id: 'macos-copy',
    platforms: ['darwin'],
    render: () => (
      <Text>
        hold <Text color="#60A5FA">Option</Text> and drag to select text, then <Text color="#60A5FA">⌘C</Text> to copy
      </Text>
    ),
  },
  {
    id: 'help-panel',
    render: () => (
      <Text>
        press <Text color="#60A5FA">?</Text> on an empty input to toggle the help panel
      </Text>
    ),
  },
  {
    id: 'palette',
    render: () => (
      <Text>
        press <Text color="#60A5FA">Ctrl+K</Text> to open the command palette
      </Text>
    ),
  },
  {
    id: 'switch-model',
    render: () => (
      <Text>
        type <Text color="#60A5FA">/model</Text> to switch models — picks persist across restarts
      </Text>
    ),
  },
  {
    id: 'switch-provider',
    render: () => (
      <Text>
        type <Text color="#60A5FA">/provider</Text> to switch between provider profiles
      </Text>
    ),
  },
  {
    id: 'mention-file',
    render: () => (
      <Text>
        type <Text color="#60A5FA">@</Text> in the input to attach a file or folder
      </Text>
    ),
  },
  {
    id: 'mention-agent',
    render: () => (
      <Text>
        prefix a message with <Text color="#60A5FA">@agent-name</Text> to delegate to a specialised agent
      </Text>
    ),
  },
  {
    id: 'fork',
    render: () => (
      <Text>
        <Text color="#60A5FA">/fork [n]</Text> branches a new conversation from message n
      </Text>
    ),
  },
  {
    id: 'compact',
    render: () => (
      <Text>
        long context? <Text color="#60A5FA">/compact</Text> summarises older messages in-place
      </Text>
    ),
  },
  {
    id: 'scan',
    render: () => (
      <Text>
        <Text color="#60A5FA">/scan</Text> finds Ollama and other LLM servers on your LAN
      </Text>
    ),
  },
  {
    id: 'export',
    render: () => (
      <Text>
        <Text color="#60A5FA">/export md</Text> or <Text color="#60A5FA">/export json</Text> writes the current conversation to a file
      </Text>
    ),
  },
  {
    id: 'paste',
    render: () => (
      <Text>
        <Text color="#60A5FA">Ctrl+V</Text> pastes images (vision-capable models) or text blocks
      </Text>
    ),
  },
  {
    id: 'multiline',
    render: () => (
      <Text>
        <Text color="#60A5FA">Shift+Enter</Text> (or <Text color="#60A5FA">Alt+Enter</Text>) inserts a newline without submitting
      </Text>
    ),
  },
  {
    id: 'history',
    render: () => (
      <Text>
        <Text color="#60A5FA">↑/↓</Text> in an empty input scrolls through prior messages
      </Text>
    ),
  },
  {
    id: 'scroll',
    render: () => (
      <Text>
        <Text color="#60A5FA">PgUp/PgDn</Text> scrolls the chat transcript; <Text color="#60A5FA">Esc</Text> jumps back to the live tail
      </Text>
    ),
  },
  {
    id: 'settings',
    render: () => (
      <Text>
        <Text color="#60A5FA">Ctrl+,</Text> opens settings; <Text color="#60A5FA">/settings</Text> works too
      </Text>
    ),
  },
  {
    id: 'conversations',
    render: () => (
      <Text>
        <Text color="#60A5FA">Ctrl+L</Text> or <Text color="#60A5FA">/conversations</Text> lists and resumes past chats
      </Text>
    ),
  },
  {
    id: 'role',
    render: () => (
      <Text>
        <Text color="#60A5FA">/role code-reviewer</Text> (or another id) switches the assistant persona
      </Text>
    ),
  },
  {
    id: 'abort',
    render: () => (
      <Text>
        <Text color="#60A5FA">Ctrl+C</Text> once aborts a running stream; press twice to quit
      </Text>
    ),
  },
  {
    id: 'mcp',
    render: () => (
      <Text>
        <Text color="#60A5FA">/mcp</Text> shows MCP server status and retries failed connections
      </Text>
    ),
  },
];

function getStatePath(): string {
  return join(getUplnkDir(), 'tip-state.json');
}

interface TipState {
  tipIndex?: number;
}

function readState(): TipState {
  try {
    const path = getStatePath();
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'tipIndex' in parsed) {
      const v = (parsed as { tipIndex: unknown }).tipIndex;
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        return { tipIndex: Math.floor(v) };
      }
    }
    return {};
  } catch {
    return {};
  }
}

function writeState(state: TipState): void {
  try {
    writeFileSync(getStatePath(), JSON.stringify(state));
  } catch {
    // Persistence failures are silent — the worst case is the same tip on
    // two consecutive launches, which is not worth bothering the user.
  }
}

/**
 * Returns the next tip in rotation that applies to this platform, and
 * advances the persisted index by one. Returns null if no tip applies
 * (e.g. an exotic platform with every tip filtered out).
 */
export function pickNextTip(): Tip | null {
  const eligible = TIPS.filter(
    (t) => t.platforms === undefined || t.platforms.includes(process.platform),
  );
  if (eligible.length === 0) return null;
  const { tipIndex = 0 } = readState();
  const tip = eligible[tipIndex % eligible.length] ?? null;
  writeState({ tipIndex: (tipIndex + 1) % Number.MAX_SAFE_INTEGER });
  return tip;
}
