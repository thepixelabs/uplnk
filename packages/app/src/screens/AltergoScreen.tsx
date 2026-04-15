import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useAltergo } from '../hooks/useAltergo.js';
import type { Config } from '../lib/config.js';

interface Props {
  onBack: () => void;
  config: Config;
}

function formatWhen(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute)).toString()}m ago`;
  if (diff < day) return `${Math.floor(diff / hour).toString()}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day).toString()}d ago`;
  return date.toISOString().slice(0, 10);
}

export function AltergoScreen({ onBack, config }: Props) {
  const { state, refresh, importSession, importAll, launch } = useAltergo(config);
  const [selectedAccount, setSelectedAccount] = useState(0);
  const [selectedSession, setSelectedSession] = useState(0);
  const [activePane, setActivePane] = useState<'accounts' | 'sessions'>('accounts');

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (key.tab) {
      setActivePane((p) => (p === 'accounts' ? 'sessions' : 'accounts'));
      return;
    }

    if (key.upArrow) {
      if (activePane === 'accounts') {
        setSelectedAccount((c) => Math.max(0, c - 1));
      } else {
        setSelectedSession((c) => Math.max(0, c - 1));
      }
      return;
    }

    if (key.downArrow) {
      if (activePane === 'accounts') {
        setSelectedAccount((c) => Math.min(Math.max(0, state.accounts.length - 1), c + 1));
      } else {
        setSelectedSession((c) => Math.min(Math.max(0, state.sessions.slice(0, 15).length - 1), c + 1));
      }
      return;
    }

    if (key.return) {
      if (activePane === 'accounts') {
        const account = state.accounts[selectedAccount];
        if (account !== undefined) {
          launch(account.name);
        }
      } else {
        const session = state.sessions[selectedSession];
        if (session !== undefined) {
          void importSession(session);
        }
      }
      return;
    }

    if (input === 'r') {
      refresh();
      return;
    }

    if (input === 'i' && activePane === 'sessions') {
      const session = state.sessions[selectedSession];
      if (session !== undefined) {
        void importSession(session);
      }
      return;
    }

    if (input === 'a' && activePane === 'accounts') {
      const account = state.accounts[selectedAccount];
      if (account !== undefined) {
        void importAll(account.name);
      }
      return;
    }
  });

  if (state.loading) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Altergo</Text>
        <Text color="gray">Detecting altergo...</Text>
      </Box>
    );
  }

  if (!state.installed) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Altergo not found</Text>
        <Text>Install altergo: <Text color="cyan">pip install altergo</Text></Text>
        <Text color="gray">altergo manages multiple AI coding assistant accounts</Text>
        <Text color="gray">(claude, gemini, codex, copilot)</Text>
        <Box marginTop={1}>
          <Text color="gray">Press Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  if (state.error !== undefined) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold>Altergo</Text>
        <Text color="red">Error: {state.error}</Text>
        <Text color="gray">Press r to retry, Esc to go back</Text>
      </Box>
    );
  }

  const visibleSessions = state.sessions.slice(0, 15);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold>Altergo </Text>
        {state.version !== undefined && (
          <Text color="gray">{state.version}</Text>
        )}
        <Text color="gray">   {String(state.accounts.length)} account{state.accounts.length !== 1 ? 's' : ''}  {String(state.sessions.length)} session{state.sessions.length !== 1 ? 's' : ''}</Text>
      </Box>

      <Box flexDirection="row" gap={2}>
        {/* Left pane: accounts */}
        <Box flexDirection="column" width={32}>
          <Text bold color={activePane === 'accounts' ? 'cyan' : 'white'}>
            Accounts
          </Text>

          {state.accounts.length === 0 && (
            <Text dimColor>No accounts found in ~/.altergo/accounts/</Text>
          )}

          {state.accounts.map((acct, i) => {
            const isCursor = i === selectedAccount && activePane === 'accounts';
            return (
              <Box key={acct.name}>
                <Text color={isCursor ? 'cyan' : 'white'}>
                  {isCursor ? '▶ ' : '  '}
                  <Text bold={isCursor}>{acct.name}</Text>
                </Text>
                <Text color="gray"> [{acct.providers.join(',')}]</Text>
              </Box>
            );
          })}
        </Box>

        {/* Right pane: sessions */}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color={activePane === 'sessions' ? 'cyan' : 'white'}>
            Recent Sessions
          </Text>

          {state.sessions.length === 0 && (
            <Text dimColor>No sessions found. Switch to accounts pane and press a to import.</Text>
          )}

          {visibleSessions.map((sess, i) => {
            const isCursor = i === selectedSession && activePane === 'sessions';
            const isImporting = state.importing.has(sess.sourcePath);
            const providerPad = sess.provider.padEnd(12);
            const accountPad = sess.account.slice(0, 10).padEnd(10);
            const titleSlice = sess.title.slice(0, 28);

            return (
              <Box key={`${sess.provider}:${sess.account}:${sess.id}`}>
                <Text color={isCursor ? 'cyan' : 'white'}>
                  {isCursor ? '▶ ' : '  '}
                  <Text bold={isCursor}>{providerPad}</Text>
                  {' '}
                  <Text>{accountPad}</Text>
                  {' '}
                  <Text>{titleSlice}</Text>
                  {'  '}
                  <Text dimColor>{String(sess.messageCount)}msg</Text>
                  {'  '}
                  <Text dimColor>{formatWhen(sess.lastActivity)}</Text>
                  {isImporting ? <Text color="yellow"> ...</Text> : null}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text dimColor>
          [Tab] switch pane  [↑↓] navigate  [Enter] launch/import  [i] import  [a] import-all  [r] refresh  [Esc] back
        </Text>
      </Box>
    </Box>
  );
}
