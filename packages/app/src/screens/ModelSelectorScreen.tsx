import { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface Props {
  onSelect: (model: string) => void;
  onBack: () => void;
}

// Placeholder: real version fetches from Ollama /api/tags
const PLACEHOLDER_MODELS = [
  'llama3.2',
  'llama3.2:1b',
  'qwen2.5-coder:7b',
  'mistral',
  'phi3',
];

export function ModelSelectorScreen({ onSelect, onBack }: Props) {
  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(PLACEHOLDER_MODELS.length - 1, c + 1));
    if (key.return) {
      const model = PLACEHOLDER_MODELS[cursor];
      if (model) onSelect(model);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Select model  (↑↓ navigate, Enter select, Esc back)</Text>
      <Box flexDirection="column" marginTop={1}>
        {PLACEHOLDER_MODELS.map((model, i) => (
          <Box key={model}>
            <Text {...(i === cursor ? { color: 'blue' as const } : {})}>
              {i === cursor ? '▶ ' : '  '}{model}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
