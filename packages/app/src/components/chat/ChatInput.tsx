import { memo, useState, useRef, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { execSync } from 'node:child_process';
import clipboardy from 'clipboardy';
import { MentionResolver } from '../../lib/agents/mentionResolver.js';
import { getAgentRegistry } from '../../lib/agents/registry.js';
import type { MentionCandidate } from '../../lib/agents/types.js';

// Brand accent — cyan that matches the header gradient start
const CURSOR_COLOR = '#00D9FF';
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

interface PastedPayload {
  tag: string;
  content: string;
}

const EMPTY_MENTION: MentionState = { active: false, startIdx: -1, query: '', cursor: 0 };

/**
 * Detect whether the clipboard holds an image on macOS by querying
 * `clipboard info` via osascript. Returns true if an image type is found.
 * Falls back to false on non-macOS or when osascript is unavailable.
 */
function clipboardHasImage(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const info = execSync("osascript -e 'clipboard info'", { encoding: 'utf8', timeout: 2000 });
    return /«class PNGf»|«class TIFF»|«class GIFf»/.test(info);
  } catch {
    return false;
  }
}

/** Move cursor left past whitespace then past a word. */
function moveWordLeft(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  while (i > 0 && /\S/.test(text[i - 1]!)) i--;
  return i;
}

/** Move cursor right past whitespace then past a word. */
function moveWordRight(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  while (i < text.length && /\S/.test(text[i]!)) i++;
  return i;
}

/**
 * Render text segments, applying color to `{...}` paste tags:
 * - `{Photo...}` → orange (#F97316)
 * - `{Text Block...}` → green (#4ADE80)
 * - `{@../...}` or `{@./...}` → cherry (#F43F5E)
 * - `{@...}` → blue (#60A5FA)
 */
function renderSegments(text: string): React.ReactNode[] {
  return text.split(/(\{[^}]+\})/g).map((seg, idx) => {
    if (seg.startsWith('{') && seg.endsWith('}')) {
      const inner = seg.slice(1, -1);
      let color: string | undefined;
      if (inner.startsWith('Photo')) color = '#F97316';
      else if (inner.startsWith('Text Block')) color = '#4ADE80';
      else if (inner.startsWith('@../') || inner.startsWith('@./')) color = '#F43F5E';
      else if (inner.startsWith('@')) color = '#60A5FA';
      return color ? (
        <Text key={idx} color={color}>{seg}</Text>
      ) : (
        <Text key={idx}>{seg}</Text>
      );
    }
    return <Text key={idx}>{seg}</Text>;
  });
}

/**
 * Render a single line of input text with an optional inline cursor.
 * - `cursorCol` = undefined → no cursor rendered on this line
 * - `cursorCol` = number   → cursor `│` rendered at that column position
 */
function renderTaggedLine(
  line: string,
  cursorCol: number | undefined,
  cursorColor: string,
  key?: React.Key,
): React.ReactNode {
  if (cursorCol === undefined) {
    return <Box key={key}>{renderSegments(line)}</Box>;
  }
  const before = line.slice(0, cursorCol);
  const after = line.slice(cursorCol);
  return (
    <Box key={key}>
      {renderSegments(before)}
      <Text color={cursorColor}>│</Text>
      {renderSegments(after)}
    </Box>
  );
}

/**
 * ChatInput with:
 * - Enter to submit
 * - Shift+Enter inserts a literal newline (requires kitty keyboard protocol, enabled
 *   at startup via ESC[=1u — supported by iTerm2 and kitty terminal)
 * - Alt/Meta+Enter also inserts a literal newline as a fallback
 * - ↑/↓ to cycle through sent-message history (current session) when in
 *   normal mode; when `@file` mention is active, ↑/↓ scroll the candidate list
 * - ←/→ to move the cursor one character at a time
 * - Alt/Option+←/→ (or Meta+B/F readline bindings) to jump by word
 * - Alt/Option+Backspace or Ctrl+W to delete the word left of the cursor
 * - /model, /provider, /role, /export, /conversations, /fork slash commands
 * - Multi-line display (up to 5 lines shown, older lines scroll off the top)
 * - `@file` mention: type `@` to open a path popover, type to filter, Enter
 *   inserts the selected path, Esc closes without inserting
 * - Ctrl+V paste: detects image vs multiline vs single-line text and inserts
 *   appropriate inline tags or literal text
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
  const [cursorPos, setCursorPos] = useState(0);
  const [mention, setMention] = useState<MentionState>(EMPTY_MENTION);

  // History: array of submitted messages, oldest-first.
  // historyIndex: -1 = not browsing history (current draft), 0+ = history index
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // Preserve the in-progress draft when user starts browsing up
  const draftRef = useRef('');

  // Paste payload store — holds actual content for each inserted tag.
  // Cleared on submit/clear.
  const pastedPayloadsRef = useRef<PastedPayload[]>([]);

  // Counters for numbering duplicate paste tags.
  const photoCountRef = useRef(0);
  const textBlockCountRef = useRef(0);

  // Unified mention resolver — agents + folders + files.
  const mentionResolver = useMemo(
    () => new MentionResolver(getAgentRegistry(projectDir !== undefined ? { projectDir } : undefined)),
    [projectDir],
  );
  const filtered = useMemo<MentionCandidate[]>(
    () => (mention.active ? mentionResolver.resolve(mention.query, projectDir) : []),
    [mentionResolver, mention.active, mention.query, projectDir],
  );

  /** Reset all paste-tracking counters. Called on submit. */
  const resetPasteState = useCallback(() => {
    pastedPayloadsRef.current = [];
    photoCountRef.current = 0;
    textBlockCountRef.current = 0;
  }, []);

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // Slash command routing
      if (trimmed.startsWith('/')) {
        const [cmd, ...cmdArgs] = trimmed.slice(1).split(/\s+/);
        setValue('');
        setCursorPos(0);
        historyIndexRef.current = -1;
        resetPasteState();

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
          case 'help':
            onCommand?.('help');
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
      setCursorPos(0);
      resetPasteState();

      const result = onSubmit(text);
      if (result instanceof Promise) result.catch(console.error);
    },
    [onSubmit, onCommand, resetPasteState],
  );

  const insertMentionChoice = useCallback(
    (candidate: MentionCandidate) => {
      const head = value.slice(0, mention.startIdx);
      const insertText = candidate.kind === 'folder'
        ? `@${candidate.path} `
        : `@${candidate.insertText} `;
      const newVal = `${head}${insertText}`;
      setValue(newVal);
      setCursorPos(newVal.length);
      setMention(EMPTY_MENTION);
    },
    [mention.startIdx, value],
  );

  useInput(
    (input, key) => {
      if (disabled) return;

      // ─── Ctrl+V paste ────────────────────────────────────────────────────
      if (key.ctrl && input === 'v') {
        // First check if clipboard holds an image (macOS only)
        if (clipboardHasImage()) {
          photoCountRef.current += 1;
          const count = photoCountRef.current;
          const tag = count === 1 ? '{Photo}' : `{Photo #${String(count)}}`;
          pastedPayloadsRef.current.push({ tag, content: '[image data]' });
          const newVal = value.slice(0, cursorPos) + tag + value.slice(cursorPos);
          setValue(newVal);
          setCursorPos(cursorPos + tag.length);
          historyIndexRef.current = -1;
          return;
        }

        // Read text from clipboard asynchronously
        clipboardy.read().then((text) => {
          if (!text) return;
          const lineCount = text.split('\n').length;

          if (lineCount > 1) {
            // Multiline — insert a tagged placeholder
            textBlockCountRef.current += 1;
            const count = textBlockCountRef.current;
            const countSuffix = count === 1 ? '' : ` #${String(count)}`;
            const tag = `{Text Block: ${String(lineCount)} lines${countSuffix}}`;
            pastedPayloadsRef.current.push({ tag, content: text });
            // Use functional form because this is async — value in closure may be stale
            setValue((prev) => prev + tag);
            setCursorPos((prev) => prev + tag.length);
          } else {
            // Single-line — insert literally
            setValue((prev) => prev + text);
            setCursorPos((prev) => prev + text.length);
          }
          historyIndexRef.current = -1;
        }).catch(() => {
          // Clipboard unreadable — silently ignore
        });
        return;
      }

      // ─── Mention-mode routing (takes priority over all other keys) ───────
      if (mention.active) {
        if (key.escape) {
          // Strip the abandoned `@query` substring so a subsequent `@`
          // trigger at end-of-buffer still fires the popover. Without this,
          // the buffer keeps a stale `@xxx` that prevents re-activation
          // and will be silently dropped by insertMentionChoice later.
          const startIdx = mention.startIdx;
          setValue((prev) => prev.slice(0, startIdx));
          setCursorPos(mention.startIdx);
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
            setCursorPos((prev) => Math.max(0, prev - 1));
            return;
          }
          setMention((m) => ({ ...m, query: m.query.slice(0, -1), cursor: 0 }));
          setValue((prev) => prev.slice(0, -1));
          setCursorPos((prev) => Math.max(0, prev - 1));
          return;
        }
        // Space closes the popover and commits the `@query` as literal text
        if (input === ' ') {
          setMention(EMPTY_MENTION);
          setValue((prev) => prev + ' ');
          setCursorPos((prev) => prev + 1);
          return;
        }
        if (input.length === 1 && !key.ctrl && !key.meta) {
          setMention((m) => ({ ...m, query: m.query + input, cursor: 0 }));
          setValue((prev) => prev + input);
          setCursorPos((prev) => prev + 1);
          return;
        }
        // Unknown key — ignore while popover is open
        return;
      }

      // ─── Normal-mode keys ────────────────────────────────────────────────

      // Kitty keyboard protocol: Shift+Enter is sent as ESC [ 13 ; 2 u.
      // ink's keypress parser does not recognise this CSI u sequence, so it
      // arrives here as a raw input string rather than key.return+key.shift.
      if (input === '\x1b[13;2u') {
        const newVal = value.slice(0, cursorPos) + '\n' + value.slice(cursorPos);
        setValue(newVal);
        setCursorPos(cursorPos + 1);
        historyIndexRef.current = -1;
        return;
      }

      // ─── Word navigation — raw Kitty sequences (ESC[key;mod u) ──────────
      // These must be checked BEFORE the generic Kitty drop handler below.

      // Kitty Alt+Left → ESC [ 1 ; 3 D
      if (input === '\x1b[1;3D') {
        setCursorPos(moveWordLeft(value, cursorPos));
        return;
      }
      // Kitty Alt+Right → ESC [ 1 ; 3 C
      if (input === '\x1b[1;3C') {
        setCursorPos(moveWordRight(value, cursorPos));
        return;
      }
      // Kitty Alt+Backspace → ESC [ 127 ; 3 u
      if (input === '\x1b[127;3u') {
        const newPos = moveWordLeft(value, cursorPos);
        setValue(value.slice(0, newPos) + value.slice(cursorPos));
        setCursorPos(newPos);
        historyIndexRef.current = -1;
        return;
      }

      // Kitty protocol encodes ALL modifier+key combos as ESC[<keycode>;<mod>u.
      // ink doesn't parse these, so unhandled ones (e.g. Ctrl+K = ESC[107;5u)
      // would otherwise fall through to the character input handler and appear
      // as literal text. Drop them here.
      if (/^\x1b\[\d+;\d+u$/.test(input)) {
        return;
      }

      if (key.return) {
        // Alt/Meta+Enter inserts a newline; plain Enter submits.
        // Shift+Enter is handled above via the kitty keyboard protocol sequence
        // for terminals that support it (requires enterAltScreen to send ESC[=1u).
        if (key.shift || key.meta) {
          const newVal = value.slice(0, cursorPos) + '\n' + value.slice(cursorPos);
          setValue(newVal);
          setCursorPos(cursorPos + 1);
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
        if (entry !== undefined) {
          setValue(entry);
          setCursorPos(entry.length);
        }
        return;
      }

      if (key.downArrow) {
        if (historyIndexRef.current === -1) return;

        const history = historyRef.current;
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          const entry = history[historyIndexRef.current];
          if (entry !== undefined) {
            setValue(entry);
            setCursorPos(entry.length);
          }
        } else {
          historyIndexRef.current = -1;
          setValue(draftRef.current);
          setCursorPos(draftRef.current.length);
        }
        return;
      }

      // ─── Cursor movement: ← / → ──────────────────────────────────────────
      if (key.leftArrow) {
        // Alt/Meta+Left → jump one word left
        if (key.meta) {
          setCursorPos(moveWordLeft(value, cursorPos));
        } else {
          setCursorPos(Math.max(0, cursorPos - 1));
        }
        return;
      }
      if (key.rightArrow) {
        // Alt/Meta+Right → jump one word right
        if (key.meta) {
          setCursorPos(moveWordRight(value, cursorPos));
        } else {
          setCursorPos(Math.min(value.length, cursorPos + 1));
        }
        return;
      }

      // ─── Word navigation — readline-style Meta+B / Meta+F ────────────────
      // macOS Option+Left/Right sends ESC+b / ESC+f which Ink/readline parses
      // as key.meta=true with input='b' or input='f'.
      if (key.meta && input === 'b') {
        setCursorPos(moveWordLeft(value, cursorPos));
        return;
      }
      if (key.meta && input === 'f') {
        setCursorPos(moveWordRight(value, cursorPos));
        return;
      }

      // ─── Delete word left ─────────────────────────────────────────────────
      // macOS Option+Backspace → key.meta=true + key.backspace/delete
      if (key.meta && (key.backspace || key.delete)) {
        const newPos = moveWordLeft(value, cursorPos);
        setValue(value.slice(0, newPos) + value.slice(cursorPos));
        setCursorPos(newPos);
        historyIndexRef.current = -1;
        return;
      }
      // Ctrl+W — traditional readline delete-word-backward
      if (key.ctrl && input === 'w') {
        const newPos = moveWordLeft(value, cursorPos);
        setValue(value.slice(0, newPos) + value.slice(cursorPos));
        setCursorPos(newPos);
        historyIndexRef.current = -1;
        return;
      }

      // ─── Backspace / Delete — remove char left of cursor ─────────────────
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          setValue(value.slice(0, cursorPos - 1) + value.slice(cursorPos));
          setCursorPos(cursorPos - 1);
        }
        historyIndexRef.current = -1;
        return;
      }

      if (key.ctrl || key.meta) return;

      // `@` trigger: open mention popover when the cursor is at the end of the
      // value AND there's either a preceding space or the buffer is empty.
      // This prevents "email@example.com" from opening the popover.
      if (input === '@' && projectDir !== undefined) {
        const atStart = cursorPos === 0;
        const charBefore = value.slice(cursorPos - 1, cursorPos);
        const afterSpace = charBefore === '' || charBefore === ' ' || charBefore === '\n';
        if (atStart || afterSpace) {
          const newVal = value.slice(0, cursorPos) + '@' + value.slice(cursorPos);
          setValue(newVal);
          setMention({ active: true, startIdx: cursorPos, query: '', cursor: 0 });
          setCursorPos(cursorPos + 1);
          return;
        }
      }

      // Regular character input — insert at cursor position
      historyIndexRef.current = -1;
      const newVal = value.slice(0, cursorPos) + input + value.slice(cursorPos);
      setValue(newVal);
      setCursorPos(cursorPos + input.length);
    },
  );

  const lines = value.split('\n');
  const displayLines = lines.length > 5 ? lines.slice(-5) : lines;
  const visibleFiltered = filtered.slice(0, MENTION_VISIBLE);
  const overflowCount = filtered.length - visibleFiltered.length;

  const promptColor = disabled ? '#475569' : '#00D9FF';
  const borderColor = disabled ? '#374151' : '#7B6FFF';

  // Compute which display line the cursor falls on and its column within that line.
  const beforeCursor = value.slice(0, cursorPos);
  const beforeCursorLines = beforeCursor.split('\n');
  const cursorLineIndex = beforeCursorLines.length - 1;
  const cursorColInLine = beforeCursorLines[beforeCursorLines.length - 1]!.length;
  const displayOffset = lines.length > 5 ? lines.length - 5 : 0;
  // Index within displayLines (-1 means the cursor is scrolled above the visible window)
  const displayCursorLine = cursorLineIndex - displayOffset;

  return (
    <Box flexDirection="column">
      {mention.active && (
        <Box flexDirection="column" marginBottom={1} paddingX={1}>
          <Text dimColor>
            @  <Text color="#60A5FA">{mention.query || '…'}</Text>
            {filtered.length === 0 ? <Text color="yellow">  no matches</Text> : null}
          </Text>
          {visibleFiltered.map((candidate, i) => {
            const isSelected = i === mention.cursor;
            const prefix = isSelected ? '▶ ' : '  ';
            if (candidate.kind === 'agent') {
              const agentColor = isSelected ? (candidate.color as string) : undefined;
              return (
                <Box key={candidate.name} flexDirection="column">
                  <Text {...(agentColor !== undefined ? { color: agentColor } : {})}>
                    {prefix}{candidate.icon} <Text bold={isSelected}>{candidate.name}</Text>
                  </Text>
                  <Text dimColor>    {candidate.description.slice(0, 60)}</Text>
                </Box>
              );
            }
            if (candidate.kind === 'folder') {
              return (
                <Box key={candidate.path}>
                  <Text {...(isSelected ? { color: '#60A5FA' as const } : { dimColor: true })}>
                    {prefix}📁 {candidate.path}
                  </Text>
                </Box>
              );
            }
            // file
            return (
              <Box key={candidate.path}>
                <Text {...(isSelected ? { color: '#60A5FA' as const } : {})}>
                  {prefix}{candidate.path}
                </Text>
              </Box>
            );
          })}
          {overflowCount > 0 && (
            <Text dimColor>  …{String(overflowCount)} more (keep typing to narrow)</Text>
          )}
          <Text dimColor>  ↑↓ select · Enter insert · Esc cancel</Text>
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
                  <Text dimColor>  type a message  /help  /model  /role  @agent  @file  Shift+Enter newline</Text>
                </Box>
              )
            ) : (
              displayLines.map((line, i) => {
                const col = (!disabled && i === displayCursorLine) ? cursorColInLine : undefined;
                return renderTaggedLine(line, col, CURSOR_COLOR, i);
              })
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
});
