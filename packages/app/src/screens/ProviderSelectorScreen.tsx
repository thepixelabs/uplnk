/**
 * ProviderSelectorScreen — quick-switch between configured provider profiles.
 *
 * Triggered by the `/provider` command from ChatInput.
 * Lists all provider configs from the DB, allows selection with ↑/↓/Enter.
 * Esc returns to chat without changing provider.
 *
 * The selected provider is passed back to App via onSelect(providerId, model).
 */

import { memo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, listProviders } from 'pylon-db';

interface Props {
  onSelect: (providerId: string, defaultModel: string, baseUrl: string, apiKey: string) => void;
  onBack: () => void;
}

export const ProviderSelectorScreen = memo(function ProviderSelectorScreen({ onSelect, onBack }: Props) {
  const providers = listProviders(db);
  const [cursor, setCursor] = useState(0);

  useInput((_, key) => {
    if (key.escape) { onBack(); return; }
    if (providers.length === 0) return;

    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow) setCursor((c) => Math.min(providers.length - 1, c + 1));
    if (key.return) {
      const p = providers[cursor];
      if (p !== undefined) {
        onSelect(p.id, p.defaultModel ?? 'llama3.2', p.baseUrl, p.apiKey ?? 'ollama');
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Select provider  (↑↓ navigate, Enter select, Esc back)</Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.length === 0 && (
          <Text dimColor>No providers configured. Edit ~/.pylon/config.json to add providers.</Text>
        )}
        {providers.map((p, i) => (
          <Box key={p.id} flexDirection="column" marginY={0}>
            <Text {...(i === cursor ? { color: '#60A5FA' as const } : {})}>
              {i === cursor ? '▶ ' : '  '}
              <Text bold>{p.name}</Text>
              {'  '}
              <Text dimColor>{p.baseUrl}</Text>
              {p.isDefault ? <Text color="#4ADE80">  (default)</Text> : null}
            </Text>
            {i === cursor && (
              <Text dimColor>     Model: {p.defaultModel ?? 'not set'}</Text>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
});
