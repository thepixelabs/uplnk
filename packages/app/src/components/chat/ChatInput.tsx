import { memo, useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';

// Primary accent color — matches colors.primary without chalk ANSI strings,
// which can confuse Ink's widestLine measurement for box-drawing glyphs.
const CURSOR_COLOR = '#60A5FA';

interface Props {
  onSubmit: (text: string) => void | Promise<void>;
  onCommand?: (command: string) => void;
  disabled?: boolean;
}

/**
 * ChatInput with:
 * - Enter to submit
 * - ↑/↓ to cycle through sent-message history (current session)
 * - /model command detection → calls onCommand('model-selector')
 * - Multi-line display (up to 5 lines shown)
 *
 * Height rule: the content area is ALWAYS exactly N text rows (1 when empty
 * or single-line, up to 5 when multi-line). Structure is kept consistent
 * between empty and typed states so Ink's line-count tracker never drifts.
 */
export const ChatInput = memo(function ChatInput({ onSubmit, onCommand, disabled = false }: Props) {
  const [value, setValue] = useState('');

  // History: array of submitted messages, oldest-first.
  // historyIndex: -1 = not browsing history (current draft), 0+ = history index
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  // Preserve the in-progress draft when user starts browsing up
  const draftRef = useRef('');

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
          case 'template':
            onCommand?.(`template:${cmdArgs.join(' ')}`);
            return;
          case 'export':
            onCommand?.(`export:${cmdArgs.join(' ')}`);
            return;
          case 'conversations':
          case 'history':
            onCommand?.('conversations');
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

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return) {
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
          // Starting to browse — save current draft
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
          // Past the end of history — restore draft
          historyIndexRef.current = -1;
          setValue(draftRef.current);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        // Any edit exits history-browsing mode and works on the current text
        historyIndexRef.current = -1;
        return;
      }

      if (key.ctrl || key.meta) return;

      // Regular character input
      historyIndexRef.current = -1;
      setValue((prev) => prev + input);
    },
  );

  const lines = value.split('\n');
  const displayLines = lines.length > 5 ? lines.slice(-5) : lines;

  const promptColor = disabled ? 'gray' : 'cyan';
  const borderColor = disabled ? 'gray' : 'cyan';

  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1} flexDirection="column">
      <Box>
        <Text color={promptColor}>{'❯ '}</Text>
        <Box flexDirection="column">
          {value === '' ? (
            disabled ? (
              <Text dimColor>⠿ streaming… (Ctrl+C to abort)</Text>
            ) : (
              // Use Ink-native color prop (not chalk ANSI string) so that
              // squashTextNodes + widestLine measure the cursor glyph correctly.
              <Box>
                <Text color={CURSOR_COLOR}>│</Text>
                <Text dimColor>  type a message  /model  /template  /export  Enter to send</Text>
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
  );
});
