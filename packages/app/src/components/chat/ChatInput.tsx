import { memo, useState, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { listMentionCandidates, filterMentionCandidates } from '../../lib/fileMention.js';

// Primary accent color — matches colors.primary without chalk ANSI strings,
// which can confuse Ink's widestLine measurement for box-drawing glyphs.
const CURSOR_COLOR = '#60A5FA';
const MENTION_VISIBLE = 8;

interface Props {
  onSubmit: (text: string) => void | Promise<void>;
  onCommand?: (command: string) => void;
  disabled?: boolean;
  /** Project root directory used to build `@file` completion candidates. */
  projectDir?: string;
}

interface MentionState {
  active: boolean;
  /** Index of the '@' trigger character within `value`. */
  startIdx: number;
  /** Chars typed since the '@' trigger (used to filter candidates). */
  query: string;
  /** Currently-selected index within the filtered candidate list. */
  cursor: number;
}

const EMPTY_MENTION: MentionState = { active: false, startIdx: -1, query: '', cursor: 0 };

/**
 * ChatInput with:
 * - Enter to submit
 * - Shift+Enter (or Alt/Meta+Enter fallback) inserts a literal newline
 * - ↑/↓ to cycle through sent-message history (current session) when in
 *   normal mode; when `@file` mention is active, ↑/↓ scroll the candidate list
 * - /model, /provider, /role, /export, /conversations, /fork slash commands
 * - Multi-line display (up to 5 lines shown, older lines scroll off the top)
 * - `@file` mention: type `@` to open a path popover, type to filter, Enter
 *   inserts the selected path, Esc closes without inserting
 *
 * Height rule: the content area is ALWAYS exactly N text rows (1 when empty
 * or single-line, up to 5 when multi-line). Structure is kept consistent
 * between empty and typed states so Ink's line-count tracker never drifts.
 */
export const ChatInput = memo(function ChatInput({
  onSubmit,
  onCommand,
  disabled = false,
  projectDir,
}: Props) {
  const [value, setValue] = useState('');
  const [mention, setMention] = useState<MentionState>(EMPTY_MENTION);

  // History: array of submitted messages, oldest-first.
  // historyIndex: -1 = not browsing history (current draft), 0+ = history index
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // Preserve the in-progress draft when user starts browsing up
  const draftRef = useRef('');

  // Candidate list is cached in the module; first `@` pays the walk cost.
  const candidates = useMemo(
    () => (projectDir !== undefined ? listMentionCandidates(projectDir) : []),
    [projectDir],
  );
  const filtered = useMemo(
    () => (mention.active ? filterMentionCandidates(candidates, mention.query, 50) : []),
    [candidates, mention.active, mention.query],
  );

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Slash command routing
      if (trimmed.startsWith('/')) {
        const [cmd, ...cmdArgs] = trimmed.slice(1).split(/\s+/);
        setValue('');
        historyIndexRef.current = -1;

        switch (cmd) {
          case 'model':
            onCommand?.('model-selector');
            return;
          case 'provider':
            onCommand?.('provider-selector');
            return;
          case 'add-provider':
            onCommand?.('add-provider');
            return;
          case 'role':
            onCommand?.(`role:${cmdArgs.join(' ')}`);
            return;
          case 'export':
            onCommand?.(`export:${cmdArgs.join(' ')}`);
            return;
          case 'conversations':
          case 'history':
            onCommand?.('conversations');
            return;
          case 'fork':
            onCommand?.('fork');
            return;
          case 'relay':
            onCommand?.('relay-picker');
            return;
          case 'scan':
            onCommand?.('network-scan');
            return;
          case 'compact':
            onCommand?.('compact');
            return;
          default:
            // Unknown command — fall through to normal submit so LLM can handle it
        }
      }

      // Add to history
      historyRef.current.push(trimmed);
      historyIndexRef.current = -1;
      draftRef.current = '';

      setValue('');

      const result = onSubmit(text);
      if (result instanceof Promise) result.catch(console.error);
    },
    [onSubmit, onCommand],
  );

  const insertMentionChoice = useCallback(
    (selectedPath: string) => {
      setValue((prev) => {
        // Replace value[startIdx..end] with '@<path> '
        const head = prev.slice(0, mention.startIdx);
        return `${head}@${selectedPath} `;
      });
      setMention(EMPTY_MENTION);
    },
    [mention.startIdx],
  );

  useInput(
    (input, key) => {
      if (disabled) return;

      // ─── Mention-mode routing (takes priority over all other keys) ───────
      if (mention.active) {
        if (key.escape) {
          // Strip the abandoned `@query` substring so a subsequent `@`
          // trigger at end-of-buffer still fires the popover. Without this,
          // the buffer keeps a stale `@xxx` that prevents re-activation
          // and will be silently dropped by insertMentionChoice later.
          const startIdx = mention.startIdx;
          setValue((prev) => prev.slice(0, startIdx));
          setMention(EMPTY_MENTION);
          return;
        }
        if (key.return) {
          const choice = filtered[mention.cursor];
          if (choice !== undefined) insertMentionChoice(choice);
          return;
        }
        if (key.upArrow) {
          setMention((m) => ({ ...m, cursor: Math.max(0, m.cursor - 1) }));
          return;
        }
        if (key.downArrow) {
          setMention((m) => ({
            ...m,
            cursor: Math.min(Math.max(0, filtered.length - 1), m.cursor + 1),
          }));
          return;
        }
        if (key.backspace || key.delete) {
          if (mention.query === '') {
            // Back-delete over the '@' closes the popover
            setMention(EMPTY_MENTION);
            setValue((prev) => prev.slice(0, -1));
            return;
          }
          setMention((m) => ({ ...m, query: m.query.slice(0, -1), cursor: 0 }));
          setValue((prev) => prev.slice(0, -1));
          return;
        }
        // Space closes the popover and commits the `@query` as literal text
        if (input === ' ') {
          setMention(EMPTY_MENTION);
          setValue((prev) => prev + ' ');
          return;
        }
        if (input.length === 1 && !key.ctrl && !key.meta) {
          setMention((m) => ({ ...m, query: m.query + input, cursor: 0 }));
          setValue((prev) => prev + input);
          return;
        }
        // Unknown key — ignore while popover is open
        return;
      }

      // ─── Normal-mode keys ────────────────────────────────────────────────

      if (key.return) {
        // Shift+Enter or Alt/Meta+Enter inserts a newline; plain Enter submits.
        if (key.shift || key.meta) {
          setValue((prev) => prev + '\n');
          historyIndexRef.current = -1;
          return;
        }
        if (value.trim()) {
          handleSubmit(value);
        }
        return;
      }

      // History navigation: ↑ / ↓
      if (key.upArrow) {
        const history = historyRef.current;
        if (history.length === 0) return;

        if (historyIndexRef.current === -1) {
          draftRef.current = value;
          historyIndexRef.current = history.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }
        const entry = history[historyIndexRef.current];
        if (entry !== undefined) setValue(entry);
        return;
      }

      if (key.downArrow) {
        if (historyIndexRef.current === -1) return;

        const history = historyRef.current;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          const entry = history[historyIndexRef.current];
          if (entry !== undefined) setValue(entry);
        } else {
          historyIndexRef.current = -1;
          setValue(draftRef.current);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        historyIndexRef.current = -1;
        return;
      }

      if (key.ctrl || key.meta) return;

      // `@` trigger: open mention popover when the cursor is at the end of the
      // value AND there's either a preceding space or the buffer is empty.
      // This prevents "email@example.com" from opening the popover.
      if (input === '@' && projectDir !== undefined) {
        const atStart = value.length === 0;
        const lastChar = value.slice(-1);
        const afterSpace = lastChar === '' || lastChar === ' ' || lastChar === '\n';
        if (atStart || afterSpace) {
          const startIdx = value.length;
          setValue((prev) => prev + '@');
          setMention({ active: true, startIdx, query: '', cursor: 0 });
          return;
        }
      }

      // Regular character input
      historyIndexRef.current = -1;
      setValue((prev) => prev + input);
    },
  );

  const lines = value.split('\n');
  const displayLines = lines.length > 5 ? lines.slice(-5) : lines;
  const visibleFiltered = filtered.slice(0, MENTION_VISIBLE);
  const overflowCount = filtered.length - visibleFiltered.length;

  const promptColor = disabled ? 'gray' : 'cyan';
  const borderColor = disabled ? 'gray' : 'cyan';

  return (
    <Box flexDirection="column">
      {mention.active && (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
          <Text dimColor>
            @file  <Text color="#60A5FA">{mention.query}</Text>
            {filtered.length === 0 ? <Text color="yellow">  no matches</Text> : null}
          </Text>
          {visibleFiltered.map((path, i) => (
            <Box key={path}>
              <Text {...(i === mention.cursor ? { color: '#60A5FA' as const } : {})}>
                {i === mention.cursor ? '▶ ' : '  '}
                {path}
              </Text>
            </Box>
          ))}
          {overflowCount > 0 && (
            <Text dimColor>  …{String(overflowCount)} more (keep typing to narrow)</Text>
          )}
          <Text dimColor>  ↑↓ select · Enter insert · Esc cancel · Space commits literally</Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
        <Box>
          <Text color={promptColor}>{'❯ '}</Text>
          <Box flexDirection="column">
            {value === '' ? (
              disabled ? (
                <Text dimColor>⠿ streaming… (Ctrl+C to abort)</Text>
              ) : (
                <Box>
                  <Text color={CURSOR_COLOR}>│</Text>
                  <Text dimColor>  type a message  /model  /role  /history  @file  Shift+Enter newline</Text>
                </Box>
              )
            ) : (
              displayLines.map((line, i) => (
                <Box key={i}>
                  <Text>{line}</Text>
                  {i === displayLines.length - 1 && !disabled && (
                    <Text color={CURSOR_COLOR}>│</Text>
                  )}
                </Box>
              ))
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
});
