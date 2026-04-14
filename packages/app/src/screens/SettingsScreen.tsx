/**
 * SettingsScreen — global configuration editor.
 *
 * Allows editing the ~/.uplnk/config.json values like displayName,
 * theme, telemetry, etc.
 */

import { memo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Config } from '../lib/config.js';
import { saveConfig } from '../lib/config.js';

interface Props {
  config: Config;
  onDone: (newConfig: Config) => void;
  onBack: () => void;
}

type SettingField = 'displayName' | 'theme' | 'telemetry' | 'git' | 'rag' | 'updates' | 'splashScreen';

interface SettingRow {
  id: SettingField;
  label: string;
  type: 'text' | 'boolean' | 'enum';
  options?: string[];
  description: string;
}

const SETTINGS: SettingRow[] = [
  {
    id: 'displayName',
    label: 'Display Name',
    type: 'text',
    description: 'Name shown in chat instead of "you"',
  },
  {
    id: 'theme',
    label: 'Theme',
    type: 'enum',
    options: ['dark', 'light'],
    description: 'TUI color scheme',
  },
  {
    id: 'telemetry',
    label: 'Telemetry',
    type: 'boolean',
    description: 'Anonymous usage statistics',
  },
  {
    id: 'git',
    label: 'Git Integration',
    type: 'boolean',
    description: 'Enable git tools (status, diff, commit)',
  },
  {
    id: 'rag',
    label: 'RAG (Knowledge Base)',
    type: 'boolean',
    description: 'Enable semantic codebase search',
  },
  {
    id: 'updates',
    label: 'Update Checks',
    type: 'boolean',
    description: 'Check for newer versions of uplnk',
  },
  {
    id: 'splashScreen',
    label: 'Splash Screen',
    type: 'boolean',
    description: 'Show logo animation on startup',
  },
];

export const SettingsScreen = memo(function SettingsScreen({ config, onDone, onBack }: Props) {
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draftConfig, setDraftConfig] = useState<Config>({ ...config });
  const [tempText, setTempText] = useState('');

  const currentSetting = SETTINGS[cursor]!;

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        return;
      }
      if (key.return) {
        if (currentSetting.id === 'displayName') {
          setDraftConfig((c) => ({ ...c, displayName: tempText.trim() || undefined }));
        }
        setEditing(false);
        return;
      }
      if (key.backspace || key.delete) {
        setTempText((t) => t.slice(0, -1));
        return;
      }
      if (input.length === 1 && !key.ctrl && !key.meta) {
        setTempText((t) => t + input);
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }

    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(SETTINGS.length - 1, c + 1));

    if (key.return || input === ' ') {
      const s = currentSetting;
      if (s.type === 'boolean') {
        setDraftConfig((c) => {
          const next = { ...c };
          if (s.id === 'telemetry') next.telemetry = { ...next.telemetry, enabled: !next.telemetry.enabled };
          else if (s.id === 'git') next.git = { ...next.git, enabled: !next.git.enabled };
          else if (s.id === 'rag') next.rag = { ...next.rag, enabled: !next.rag.enabled };
          else if (s.id === 'updates') next.updates = { ...next.updates, enabled: !next.updates.enabled };
          else if (s.id === 'splashScreen') next.splashScreen = { ...next.splashScreen, enabled: !next.splashScreen?.enabled };
          return next;
        });
      } else if (s.type === 'enum' && s.options) {
        setDraftConfig((c) => {
          const next = { ...c };
          if (s.id === 'theme') next.theme = next.theme === 'dark' ? 'light' : 'dark';
          return next;
        });
      } else if (s.type === 'text') {
        setTempText(draftConfig.displayName ?? '');
        setEditing(true);
      }
    }

    if (input === 's') {
      saveConfig(draftConfig);
      onDone(draftConfig);
    }
  });

  const getVal = (s: SettingRow) => {
    if (s.id === 'displayName') return draftConfig.displayName ?? '(not set)';
    if (s.id === 'theme') return draftConfig.theme;
    if (s.id === 'telemetry') return draftConfig.telemetry.enabled ? 'Enabled' : 'Disabled';
    if (s.id === 'git') return draftConfig.git.enabled ? 'Enabled' : 'Disabled';
    if (s.id === 'rag') return draftConfig.rag.enabled ? 'Enabled' : 'Disabled';
    if (s.id === 'updates') return draftConfig.updates.enabled ? 'Enabled' : 'Disabled';
    if (s.id === 'splashScreen') return (draftConfig.splashScreen?.enabled ?? true) ? 'Enabled' : 'Disabled';
    return '';
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#60A5FA"
      marginX={4}
      marginY={1}
      paddingX={1}
    >
      <Text bold color="#60A5FA">Settings</Text>
      <Box flexDirection="column" marginTop={1}>
        {SETTINGS.map((s, i) => {
          const isCursor = i === cursor;
          const val = getVal(s);
          return (
            <Box key={s.id} justifyContent="space-between">
              <Box>
                <Text {...(isCursor ? { color: '#60A5FA' as const } : {})} bold={isCursor}>
                  {isCursor ? '▶ ' : '  '}
                  {s.label.padEnd(20)}
                </Text>
                <Text dimColor>  {s.description}</Text>
              </Box>
              <Box>
                {isCursor && editing ? (
                  <Text color="#60A5FA">[{tempText}█]</Text>
                ) : (
                  <Text color={isCursor ? '#60A5FA' : '#4ADE80'}>{val}</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑↓ navigate  Enter/Space toggle/edit  Esc back  s save</Text>
        {JSON.stringify(draftConfig) !== JSON.stringify(config) && (
          <Text color="yellow">Changes unsaved. Press 's' to save to config.json.</Text>
        )}
      </Box>
    </Box>
  );
});
