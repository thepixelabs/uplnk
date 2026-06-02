import { memo, useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import clipboardy from 'clipboardy';
import { MentionResolver } from '../../lib/agents/mentionResolver.js';
import { getAgentRegistry } from '../../lib/agents/registry.js';
import type { MentionCandidate } from '../../lib/agents/types.js';
import {
  commonPrefix,
  detectPathContext,
  formatPathContextHeader,
  listPathEntries,
  type PathContext,
  type PathEntry,
} from '../../lib/pathMention.js';
import { useVoiceAssistant } from '../voice/VoiceAssistantProvider.js';

// ─── Paste debug logger ────────────────────────────────────────────────────────
// Gated behind UPLNK_DEBUG_PASTE=1. Writes to ~/.uplnk/paste-debug.log using
// synchronous I/O so entries are never lost on crash. Never writes to stdout/
// stderr — that would corrupt Ink's renderer.

const DEBUG_PASTE = process.env['UPLNK_DEBUG_PASTE'] === '1';
let _debugLogPath: string | null = null;

function debugPaste(
  event: string,
  inputLen: number,
  hasNewline: boolean,
  raw: string,
): void {
  if (!DEBUG_PASTE) return;
  try {
    if (_debugLogPath === null) {
      const uplnkDir = path.join(os.homedir(), '.uplnk');
      fs.mkdirSync(uplnkDir, { recursive: true });
      _debugLogPath = path.join(uplnkDir, 'paste-debug.log');
    }
    const line =
      `[${new Date().toISOString()}] event=${event} len=${inputLen} hasNewline=${String(hasNewline)} raw=${JSON.stringify(raw)}\n`;
    fs.appendFileSync(_debugLogPath, line, 'utf8');
  } catch {
    // Never throw from a debug helper
  }
}
// ──────────────────────────────────────────────────────────────────────────────

// Brand accent — cyan that matches the header gradient start
const CURSOR_COLOR = '#00D9FF';
const MENTION_VISIBLE = 8;

/**
 * Fixed total height of the mention popover when open. Parent (ChatScreen)
 * uses this to reduce the message viewport so the popover can render above
 * the input without overflowing the terminal. Must match the popover JSX:
 *   border(2) + marginBottom(1) + header(1) + mode(1) + items(MENTION_VISIBLE)
 *   + overflow(1) + footer(1)
 */
export const MENTION_POPOVER_HEIGHT = 2 + 1 + 1 + 1 + MENTION_VISIBLE + 1 + 1;

interface Props {
  onSubmit: (text: string) => void | Promise<void>;
  onCommand?: (command: string) => void;
  disabled?: boolean;
  /** Project root directory used to build `@file` completion candidates. */
  projectDir?: string;
  /**
   * Fires whenever the @mention popover opens/closes. Parent uses this to
   * reserve `MENTION_POPOVER_HEIGHT` rows in its layout so the popover can
   * grow upward without pushing the input row off the bottom of the terminal.
   */
  onMentionActiveChange?: (active: boolean) => void;
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
  onMentionActiveChange,
}: Props) {
  const [value, setValue] = useState('');
  const [cursorPos, setCursorPos] = useState(0);
  const [mention, setMention] = useState<MentionState>(EMPTY_MENTION);

  useEffect(() => {
    onMentionActiveChange?.(mention.active);
  }, [mention.active, onMentionActiveChange]);
  const { isDictating, toggleDictation, partialTranscription, statusMessage, registerTranscriptionHandler } = useVoiceAssistant();

  // Bracketed paste mode: accumulate terminal-paste chunks between ESC[200~ and ESC[201~.
  // While a paste is in flight, keystrokes are buffered here instead of processed individually.
  const bracketedPasteBufferRef = useRef<string | null>(null);

  // Enable bracketed paste mode on mount; disable on unmount.
  // Guard with isTTY so piped usage (uplnk < file | cat) and vitest don't
  // receive ANSI control sequences on stdout, which would leak into test logs
  // and risk an unhandled exception on a closed pipe at unmount.
  useEffect(() => {
    // Prong 3: log whether the bracketed-paste-enable write actually fired.
    // UPLNK_DEBUG_PASTE=1 will show this entry first in the log — if isTTY is
    // false here, the bracketed-paste path will never work for this session.
    debugPaste(
      process.stdout.isTTY ? 'bracketed-paste-enable-write' : 'bracketed-paste-enable-SKIPPED-no-tty',
      0,
      false,
      '',
    );
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?2004h');
    }
    return () => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?2004l');
      }
    };
  }, []);

  // Register the transcription callback with the provider
  useEffect(() => {
    return registerTranscriptionHandler((text: string) => {
      // Append transcribed text at cursor position
      setValue((prevValue) => {
        const head = prevValue.slice(0, cursorPos);
        const tail = prevValue.slice(cursorPos);
        const spacer = head.length > 0 && !head.endsWith(' ') ? ' ' : '';
        const newValue = `${head}${spacer}${text}${tail}`;
        setCursorPos(newValue.length - tail.length);
        return newValue;
      });
    });
  }, [registerTranscriptionHandler, cursorPos]);

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

  // When the in-progress @token looks like a path (./, ../, ~/, /abs, or has
  // an embedded /), switch from the mixed fuzzy popover to hierarchical
  // segment-wise directory traversal. Recomputed on every query keystroke.
  const pathCtx: PathContext | null = useMemo(() => {
    if (!mention.active || projectDir === undefined) return null;
    return detectPathContext(mention.query, projectDir);
  }, [mention.active, mention.query, projectDir]);

  const pathEntries: PathEntry[] = useMemo(
    () => (pathCtx !== null ? listPathEntries(pathCtx) : []),
    [pathCtx],
  );

  const filtered = useMemo<MentionCandidate[]>(() => {
    if (!mention.active) return [];
    if (pathCtx !== null) return [];
    return mentionResolver.resolve(mention.query, projectDir);
  }, [mentionResolver, mention.active, mention.query, projectDir, pathCtx]);

  /** Reset all paste-tracking counters. Called on submit. */
  const resetPasteState = useCallback(() => {
    pastedPayloadsRef.current = [];
    photoCountRef.current = 0;
    textBlockCountRef.current = 0;
  }, []);

  /**
   * Insert pasted text using the same rules as the Ctrl+V path:
   * - Multi-line → tagged placeholder stored in pastedPayloadsRef
   * - Single-line → inserted literally at the end of the current value
   * Uses functional setState because this may be called from async or
   * deferred contexts where the value closure could be stale.
   */
  const insertPastedText = useCallback((text: string) => {
    if (!text) return;
    // Normalize line endings: \r\n (Windows) first, then bare \r (old Mac /
    // terminal CR) — order matters so \r\n collapses to one \n, not two.
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lineCount = normalized.split('\n').length;
    if (lineCount > 1) {
      textBlockCountRef.current += 1;
      const count = textBlockCountRef.current;
      const countSuffix = count === 1 ? '' : ` #${String(count)}`;
      const tag = `{Text Block: ${String(lineCount)} lines${countSuffix}}`;
      pastedPayloadsRef.current.push({ tag, content: normalized });
      setValue((prev) => prev + tag);
      setCursorPos((prev) => prev + tag.length);
    } else {
      setValue((prev) => prev + normalized);
      setCursorPos((prev) => prev + normalized.length);
    }
    historyIndexRef.current = -1;
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
          case 'settings':
            onCommand?.('settings');
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
            onCommand?.(cmdArgs.length > 0 ? `fork:${cmdArgs[0]}` : 'fork');
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
          case 'mcp':
            onCommand?.('mcp');
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

      // Expand paste placeholder tags before submitting.
      // Each {Text Block: N lines} tag in `text` is replaced with its stored
      // content. Image tags ({Photo}) are skipped — their content sentinel
      // '[image data]' must not be substituted into the text stream.
      let expanded = text;
      for (const payload of pastedPayloadsRef.current) {
        if (payload.content === '[image data]') continue;
        expanded = expanded.split(payload.tag).join(payload.content);
      }

      resetPasteState();

      const result = onSubmit(expanded);
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
      // ─── Prong 1: Heuristic-based paste detection ─────────────────────────
      // Fires BEFORE the bracketed-paste path and BEFORE the disabled guard.
      //
      // Condition: input has a newline AND length > 8, AND we are not already
      // mid-bracketed-paste (buffer non-null), AND the chunk does not carry the
      // bracketed-paste start marker (which the next block handles correctly).
      //
      // Rationale for length > 8:
      //   - A single typed character is 1 byte. Ink never delivers a typed
      //     Enter fused with other characters — Enter is its own data event.
      //   - Known compound sequences that contain '\n' are short: Alt+Enter can
      //     arrive as '\x1b\n' (2 bytes, stripped ESC = 1 byte '\n'). Shift+Enter
      //     via kitty protocol uses '\r' not '\n'. So any chunk with a literal
      //     '\n' AND length > 8 cannot plausibly be a single keystroke combo.
      //   - 'a\nb' (length 3) is under the threshold and falls through — this is
      //     intentional: a 3-byte chunk with a newline is ambiguous and rare;
      //     accepting false-negatives here is safer than false-positives on typed
      //     Alt+sequences. Documented trade-off; revisit with debounce if needed.
      //   - A real paste arriving without bracketed mode is typically hundreds of
      //     bytes. length > 8 is a conservative floor with generous headroom.
      //
      // Skip when bracketedPasteBufferRef.current !== null (mid-bracketed-paste
      // accumulation, handled below) or when input starts with '[200~' (the
      // bracketed-paste start marker, handled in the next block).
      if (
        input.length > 8 &&
        (input.includes('\n') || input.includes('\r')) &&
        bracketedPasteBufferRef.current === null &&
        !input.startsWith('[200~')
      ) {
        debugPaste('heuristic-paste', input.length, true, input);
        // Discard while streaming — same policy as the bracketed-paste path.
        if (!disabled) {
          insertPastedText(input);
        }
        return;
      }

      // ─── Bracketed paste mode interception ───────────────────────────────
      // Ink strips the leading ESC from unrecognised sequences, so the terminal's
      // ESC[200~ paste-start arrives as '[200~' and ESC[201~ as '[201~'.

      if (bracketedPasteBufferRef.current !== null) {
        // Currently accumulating a bracketed paste across multiple useInput callbacks.
        // Ink strips the leading \x1b from every chunk it delivers, so a chunk that
        // in the raw stream is '\x1b[201~' arrives here as '[201~'. Re-prefix the
        // stripped ESC byte before searching, so we always match the canonical
        // '\x1b[201~' marker and never accidentally trigger on '[201~' appearing
        // literally in paste content (e.g. shell scripts with escape-sequence examples).
        const prefixed = '\x1b' + input;
        const endIdx = prefixed.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          // End marker found. Content before the marker (accounting for the re-prefixed
          // ESC at position 0) completes the paste. If endIdx === 0, the chunk is
          // exactly the end marker with no payload — slice produces empty string.
          const chunkContent = prefixed.slice(1, endIdx); // strip the re-prefixed ESC, keep payload
          const final = bracketedPasteBufferRef.current + chunkContent;
          bracketedPasteBufferRef.current = null;
          debugPaste('bracketed-end', final.length, final.includes('\n'), final);
          // Paste that arrives while streaming is dropped by design — silently
          // discard rather than injecting content into a disabled input state.
          if (!disabled) {
            insertPastedText(final);
          }
        } else {
          // Still accumulating — Ink may split a paste across multiple callbacks.
          debugPaste('bracketed-accumulate', input.length, input.includes('\n'), input);
          bracketedPasteBufferRef.current += input;
        }
        return;
      }

      if (input.startsWith('[200~')) {
        // Paste-start: Ink stripped the leading ESC, so the raw ESC[200~ marker
        // arrives as '[200~'. Content after the marker is the start of the paste
        // payload. Apply the same re-prefix technique to find the end marker.
        const afterMarker = input.slice('[200~'.length);
        const prefixedAfter = '\x1b' + afterMarker;
        const endIdx = prefixedAfter.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          // Entire paste arrived in one chunk. endIdx 0 would mean the marker
          // immediately followed '[200~' with no payload — slice handles it cleanly.
          const content = prefixedAfter.slice(1, endIdx);
          debugPaste('bracketed-single-chunk', content.length, content.includes('\n'), content);
          if (!disabled) {
            insertPastedText(content);
          }
        } else {
          debugPaste('bracketed-start', afterMarker.length, afterMarker.includes('\n'), afterMarker);
          bracketedPasteBufferRef.current = afterMarker;
        }
        return;
      }
      // ─────────────────────────────────────────────────────────────────────

      if (disabled) return;

      // ~ (backtick/tilde) toggles voice dictation
      if (input === '`' || input === '~') {
        toggleDictation();
        return;
      }

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
          insertPastedText(text);
        }).catch(() => {
          // Clipboard unreadable — silently ignore
        });
        return;
      }

      // ─── Mention-mode routing (takes priority over all other keys) ───────
      if (mention.active) {
        // Unified list length across mixed + path modes, for cursor clamping.
        const activeLen = pathCtx !== null ? pathEntries.length : filtered.length;

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
        // Tab — path-mode only: extend the in-progress segment to the longest
        // shared prefix of the currently listed entries. If there is only a
        // single matching dir and the segment already equals its full name,
        // descend into it.
        if (key.tab && pathCtx !== null) {
          if (pathEntries.length === 0) return;
          const cp = commonPrefix(pathEntries);
          if (cp.length > pathCtx.currentSegment.length) {
            const delta = cp.slice(pathCtx.currentSegment.length);
            setMention((m) => ({ ...m, query: m.query + delta, cursor: 0 }));
            setValue((prev) => prev + delta);
            setCursorPos((prev) => prev + delta.length);
            return;
          }
          // Single unambiguous directory match — descend.
          if (
            pathEntries.length === 1 &&
            pathEntries[0]!.isDir &&
            pathEntries[0]!.name === pathCtx.currentSegment
          ) {
            const slash = '/';
            setMention((m) => ({ ...m, query: m.query + slash, cursor: 0 }));
            setValue((prev) => prev + slash);
            setCursorPos((prev) => prev + 1);
            return;
          }
          return;
        }
        if (key.return) {
          if (pathCtx !== null) {
            const entry = pathEntries[mention.cursor];
            if (entry === undefined) return;
            if (entry.isDir) {
              // Descend: append '<name>/' (completing any partial segment).
              const completion =
                entry.name.slice(pathCtx.currentSegment.length) + '/';
              setMention((m) => ({ ...m, query: m.query + completion, cursor: 0 }));
              setValue((prev) => prev + completion);
              setCursorPos((prev) => prev + completion.length);
              return;
            }
            // File — complete the segment and close the popover.
            const completion = entry.name.slice(pathCtx.currentSegment.length);
            const finalTrailingSpace = ' ';
            setValue((prev) => prev + completion + finalTrailingSpace);
            setCursorPos((prev) => prev + completion.length + 1);
            setMention(EMPTY_MENTION);
            return;
          }
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
            cursor: Math.min(Math.max(0, activeLen - 1), m.cursor + 1),
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
      // Ink's useInput strips the leading ESC from unrecognised sequences, so
      // the handler receives '[13;2u' (without the ESC prefix).
      if (input === '[13;2u') {
        const newVal = value.slice(0, cursorPos) + '\n' + value.slice(cursorPos);
        setValue(newVal);
        setCursorPos(cursorPos + 1);
        historyIndexRef.current = -1;
        return;
      }

      // ─── Word navigation — raw Kitty sequences (ESC[key;mod u) ──────────
      // Alt+Left/Right (ESC[1;3D / ESC[1;3C) are already handled by Ink's
      // fnKeyRe parser which sets key.leftArrow/rightArrow + key.meta=true.
      // The key.leftArrow + key.meta path below (line ~493) handles those.
      //
      // Alt+Backspace (ESC[127;3u) is NOT recognised by fnKeyRe, so we must
      // match it explicitly. Ink strips the leading ESC → arrives as '[127;3u'.
      if (input === '[127;3u') {
        const newPos = moveWordLeft(value, cursorPos);
        setValue(value.slice(0, newPos) + value.slice(cursorPos));
        setCursorPos(newPos);
        historyIndexRef.current = -1;
        return;
      }

      // Kitty protocol encodes ALL modifier+key combos as ESC[<keycode>;<mod>u.
      // Ink strips the leading ESC from unrecognised sequences, so they arrive
      // as '[<keycode>;<mod>u'. Drop any remaining unhandled ones here so they
      // don't fall through to the character input handler and appear as text.
      if (/^\[\d+;\d+u$/.test(input)) {
        return;
      }

      // SGR mouse sequences (ESC[<b;x;yM|m) arrive here as '[<b;x;yM|m' for the
      // same reason — drop them so wheel/click events don't get echoed as text.
      if (/^\[<\d+;\d+;\d+[Mm]$/.test(input)) {
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

      // "?" on its own (empty buffer, no modifier, not in any subflow) toggles
      // the help panel. We still allow questions starting with "?" — the user
      // just needs to type one character first (e.g. a space) before the "?",
      // which is the convention in lazygit/k9s/less. Treats the bare-? as a
      // command shortcut, not a typing keystroke.
      if (input === '?' && value === '' && !key.ctrl && !key.meta) {
        onCommand?.('help');
        return;
      }

      // Regular character input — insert at cursor position
      debugPaste('normal-key', input.length, input.includes('\n'), input);
      historyIndexRef.current = -1;
      const newVal = value.slice(0, cursorPos) + input + value.slice(cursorPos);
      setValue(newVal);
      setCursorPos(cursorPos + input.length);
    },
  );

  const lines = value.split('\n');
  const displayLines = lines.length > 5 ? lines.slice(-5) : lines;
  // Scroll the mention popover so the selected cursor stays inside the
  // MENTION_VISIBLE window. Without this, cursor advances past index 7 but
  // the slice stays pinned at [0, 8) and the selection indicator disappears.
  const mentionTotal = pathCtx !== null ? pathEntries.length : filtered.length;
  const mentionScrollOffset = Math.max(
    0,
    Math.min(
      Math.max(0, mentionTotal - MENTION_VISIBLE),
      mention.cursor - MENTION_VISIBLE + 1,
    ),
  );
  const visibleFiltered = filtered.slice(
    mentionScrollOffset,
    mentionScrollOffset + MENTION_VISIBLE,
  );
  const visiblePathEntries = pathEntries.slice(
    mentionScrollOffset,
    mentionScrollOffset + MENTION_VISIBLE,
  );
  const overflowAbove = mentionScrollOffset;
  const overflowBelow = Math.max(
    0,
    mentionTotal - mentionScrollOffset - MENTION_VISIBLE,
  );

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
      {statusMessage && (
        <Box marginBottom={1}>
          <Text color="yellow">Voice: {statusMessage}</Text>
        </Box>
      )}
      {isDictating && (
        <Box marginBottom={1} borderStyle="round" borderColor="#4ADE80" paddingX={1}>
          <Text color="#4ADE80">🎤 Listening… </Text>
          <Text dimColor>{partialTranscription || 'speak now'}</Text>
        </Box>
      )}
      {mention.active && (
        // Fixed-height popover: 1 header + 1 mode + MENTION_VISIBLE items
        // + 1 overflow + 1 footer = stable layout so the chat input below
        // never shifts as the user types and the result list grows/shrinks.
        <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="#7B6FFF" paddingX={1}>
          <Box>
            <Text color="#7B6FFF">@ </Text>
            <Text color="#00D9FF" bold>{mention.query || '…'}</Text>
            {pathCtx !== null && pathEntries.length === 0 ? (
              <Text color="#FBBF24">  (empty)</Text>
            ) : null}
            {pathCtx === null && filtered.length === 0 ? (
              <Text color="#FBBF24">  no matches</Text>
            ) : null}
          </Box>
          <Text dimColor>{pathCtx !== null ? `  ${formatPathContextHeader(pathCtx)}` : ' '}</Text>
          {Array.from({ length: MENTION_VISIBLE }).map((_, i) => {
            const idx = i + mentionScrollOffset;
            const isSelected = idx === mention.cursor;
            const prefix = isSelected ? '▶ ' : '  ';
            if (pathCtx !== null) {
              const entry = visiblePathEntries[i];
              if (entry === undefined) {
                return <Text key={`pad-${String(i)}`}> </Text>;
              }
              const icon = entry.isDir ? '📁 ' : '   ';
              return (
                <Box key={entry.name}>
                  <Text color={isSelected ? '#00D9FF' : '#64748B'}>
                    {prefix}{icon}{entry.name}{entry.isDir ? '/' : ''}
                  </Text>
                </Box>
              );
            }
            const candidate = visibleFiltered[i];
            if (candidate === undefined) {
              return <Text key={`pad-${String(i)}`}> </Text>;
            }
            if (candidate.kind === 'agent') {
              const agentColor = isSelected ? ((candidate.color as string | undefined) ?? '#00D9FF') : '#64748B';
              return (
                <Box key={candidate.name}>
                  <Text color={agentColor}>{prefix}{candidate.icon} </Text>
                  <Text color={agentColor} bold={isSelected}>{candidate.name}</Text>
                  <Text color="#475569"> — {candidate.description.slice(0, 80)}</Text>
                </Box>
              );
            }
            if (candidate.kind === 'folder') {
              return (
                <Box key={candidate.path}>
                  <Text color={isSelected ? '#00D9FF' : '#64748B'}>
                    {prefix}📁 {candidate.path}
                  </Text>
                </Box>
              );
            }
            return (
              <Box key={candidate.path}>
                <Text color={isSelected ? '#00D9FF' : '#64748B'}>
                  {prefix}{candidate.path}
                </Text>
              </Box>
            );
          })}
          <Text dimColor>
            {overflowAbove > 0 || overflowBelow > 0
              ? `  ${overflowAbove > 0 ? `↑ ${String(overflowAbove)} above` : ''}${overflowAbove > 0 && overflowBelow > 0 ? '  ·  ' : ''}${overflowBelow > 0 ? `↓ ${String(overflowBelow)} below` : ''}`
              : ' '}
          </Text>
          <Text dimColor>
            {pathCtx !== null
              ? '  ↑↓ select · Enter → open/pick · Tab complete · Esc cancel'
              : '  ↑↓ select · Enter insert · Esc cancel'}
          </Text>
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
