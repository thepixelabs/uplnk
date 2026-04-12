import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useModelSelector } from '../hooks/useModelSelector.js';

interface Props {
  onSelect: (model: string) => void;
  onBack: () => void;
  /** When true, display a "(router)" indicator to signal auto-routing is active. */
  routerEnabled?: boolean;
}

export function ModelSelectorScreen({ onSelect, onBack, routerEnabled }: Props) {
  const [cursor, setCursor] = useState(0);
  const { models, isLoading, error } = useModelSelector();

  useInput((_, key) => {
    if (key.escape) { onBack(); return; }
    if (isLoading || models.length === 0) return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(models.length - 1, c + 1));
    if (key.return) {
      const model = models[cursor];
      if (model !== undefined) onSelect(model);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>Select model  (↑↓ navigate, Enter select, Esc back)</Text>
        {routerEnabled === true && (
          <Text color="#60A5FA" dimColor>  (router active)</Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {isLoading && <Text dimColor>Fetching models…</Text>}
        {!isLoading && error !== null && <Text color="red">Error: {error}</Text>}
        {!isLoading && error === null && models.length === 0 && (
          <Text dimColor>No models found. Is Ollama running?</Text>
        )}
        {!isLoading && models.map((model, i) => (
          <Box key={model}>
            <Text {...(i === cursor ? { color: 'blue' as const } : {})}>
              {i === cursor ? '▶ ' : '  '}{model}
              {routerEnabled === true && i === cursor ? ' (router)' : ''}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
