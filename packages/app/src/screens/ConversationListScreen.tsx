/**
 * ConversationListScreen — browse and resume saved conversations.
 *
 * Lists the 50 most recently updated conversations (soft-deletes excluded).
 * Typing filters the list by searching title AND message content via
 * `searchConversations()`. Enter resumes the cursor's conversation; Esc
 * returns to chat without changing anything.
 *
 * Visual language matches the rest of Pylon's screens: `▶ ` cursor, blue
 * `#60A5FA` on selection, dimColor secondary text. No box-drawing borders on
 * list rows.
 */

import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, listConversations, searchConversations } from 'pylon-db';
import type { Conversation } from 'pylon-db';

interface Props {
  /** Called with the conversation id when the user picks one. */
  onSelect: (conversationId: string) => void;
  onBack: () => void;
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute)).toString()}m ago`;
  if (diff < day) return `${Math.floor(diff / hour).toString()}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day).toString()}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function previewTitle(c: Conversation): string {
  const raw = c.title.trim();
  if (raw === '' || raw === 'New conversation') return '(untitled)';
  return raw;
}

export function ConversationListScreen({ onSelect, onBack }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const rows: Conversation[] = useMemo(
    () => (query.trim() === '' ? listConversations(db) : searchConversations(db, query)),
    [query],
  );

  useInput((input, key) => {
    if (key.escape) {
      if (query !== '') { setQuery(''); setCursor(0); return; }
      onBack();
      return;
    }
    if (key.return) {
      const row = rows[cursor];
      if (row !== undefined) onSelect(row.id);
      return;
    }
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow) { setCursor((c) => Math.min(rows.length - 1, c + 1)); return; }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input.length === 1 && input >= ' ') {
      setQuery((q) => q + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>Conversations</Text>
        <Text dimColor>   ↑↓ navigate · type to search · Enter resume · Esc back</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Search: <Text color="#60A5FA">{query}</Text>{query === '' ? <Text dimColor> (try "webhook", a model id, a filename)</Text> : null}█</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 && query === '' && (
          <Text dimColor>No saved conversations yet. Start chatting!</Text>
        )}
        {rows.length === 0 && query !== '' && (
          <Text dimColor>No matches for "{query}". Esc to clear.</Text>
        )}
        {rows.map((row, i) => {
          const isCursor = i === cursor;
          return (
            <Box key={row.id}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold={isCursor}>{previewTitle(row).slice(0, 50).padEnd(50)}</Text>
                {'  '}
                <Text dimColor>{formatWhen(row.updatedAt).padStart(8)}</Text>
                {'  '}
                <Text dimColor>{(row.modelId ?? '').slice(0, 20)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      {rows.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{String(rows.length)} conversation{rows.length === 1 ? '' : 's'}{query !== '' ? ' matching' : ''}</Text>
        </Box>
      )}
    </Box>
  );
}
