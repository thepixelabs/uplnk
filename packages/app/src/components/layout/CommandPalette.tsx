/**
 * CommandPalette — Ctrl+K keyboard-first command launcher.
 *
 * Opens as a modal overlay. User types to fuzzy-search commands.
 * Enter executes the selected command. Escape closes.
 *
 * Commands are registered by passing them as props — ChatScreen builds
 * the list based on current state (streaming? has artifact? etc.).
 *
 * Design (ref: 08-vesper-interaction-v2.md):
 * - Full-width, centered vertically
 * - Shows up to 8 results
 * - Fuzzy match: case-insensitive substring match on name + description
 * - Keyboard: ↑/↓ to navigate, Enter to execute, Escape to close
 */

import { memo, useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

export interface PaletteCommand {
  id: string;
  /** Short display name */
  name: string;
  /** Keyboard shortcut hint (displayed on right) */
  shortcut?: string;
  /** Longer description shown in the item */
  description?: string;
  /** Function to call when command is selected */
  execute: () => void;
  /** Visual group for separator display */
  group?: string;
  /** Whether the command is currently disabled */
  disabled?: boolean;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

const MAX_VISIBLE = 8;

function fuzzyMatch(query: string, target: string): boolean {
  if (query === '') return true;
  return target.toLowerCase().includes(query.toLowerCase());
}

export const CommandPalette = memo(function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const filtered = useMemo(() => {
    const enabled = commands.filter((c) => !c.disabled);
    if (query === '') return enabled.slice(0, MAX_VISIBLE);
    return enabled
      .filter(
        (c) =>
          fuzzyMatch(query, c.name) ||
          fuzzyMatch(query, c.description ?? '') ||
          fuzzyMatch(query, c.id),
      )
      .slice(0, MAX_VISIBLE);
  }, [commands, query]);

  // Reset cursor when filtered list changes
  const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }

    if (key.return) {
      const cmd = filtered[safeCursor];
      if (cmd !== undefined) {
        onClose();
        cmd.execute();
      }
      return;
    }

    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }

    if (key.downArrow) {
      setCursor((c) => Math.min(filtered.length - 1, c + 1));
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0) {
      setCursor(0);
      setQuery((q) => q + input);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#60A5FA"
      marginX={4}
      marginY={1}
      paddingX={1}
    >
      {/* Search input row */}
      <Box marginBottom={1}>
        <Text color="#60A5FA">{'❯ '}</Text>
        <Text>{query.length > 0 ? query : ''}</Text>
        {query.length === 0 && <Text color="#475569">  search commands…</Text>}
        <Text color="#60A5FA">│</Text>
      </Box>

      {/* Results */}
      {filtered.length === 0 ? (
        <Box>
          <Text dimColor>No commands match "{query}"</Text>
        </Box>
      ) : (
        filtered.map((cmd, i) => {
          const isSelected = i === safeCursor;
          return (
            <Box key={cmd.id} justifyContent="space-between" paddingX={1}>
              <Box>
                <Text {...(isSelected ? { color: '#60A5FA' as const } : {})} bold={isSelected}>
                  {isSelected ? '▶ ' : '  '}
                  {cmd.name}
                </Text>
                {cmd.description !== undefined && (
                  <Text dimColor>  {cmd.description}</Text>
                )}
              </Box>
              {cmd.shortcut !== undefined && (
                <Text color="#334155">{cmd.shortcut}</Text>
              )}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        <Text color="#334155">↑↓ navigate  Enter execute  Esc close</Text>
      </Box>
    </Box>
  );
});
