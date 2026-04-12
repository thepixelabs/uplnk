import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../../lib/colors.js';

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}

export function ChatInput({ onSubmit, disabled = false }: Props) {
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.return && key.ctrl) {
        // Ctrl+Enter sends
        if (value.trim()) {
          onSubmit(value);
          setValue('');
        }
        return;
      }

      if (key.return) {
        // Enter inserts newline (developer-friendly default)
        setValue((prev) => prev + '\n');
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }

      if (key.ctrl || key.meta) return;

      setValue((prev) => prev + input);
    },
    { isActive: !disabled },
  );

  const lines = value.split('\n');
  const displayLines = lines.length > 5 ? lines.slice(-5) : lines;

  return (
    <Box borderStyle="single" borderColor={disabled ? 'gray' : 'blue'} paddingX={1} flexDirection="column">
      <Box>
        <Text color={disabled ? 'gray' : 'blue'}>{'> '}</Text>
        <Box flexDirection="column">
          {displayLines.map((line, i) => (
            <Text key={i}>{line}{i === displayLines.length - 1 && !disabled ? colors.primary('▋') : ''}</Text>
          ))}
          {!value && !disabled && (
            <Text dimColor>Type a message… (Enter for newline, Ctrl+Enter to send)</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
