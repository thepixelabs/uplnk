/**
 * ProviderSelectorScreen — quick-switch between configured provider profiles.
 *
 * Triggered by the `/provider` command from ChatInput.
 * Lists providers, supports add / delete / test-connection / set-default
 * inline. Selection passes baseUrl + apiKey back to App so ChatScreen can
 * rebuild its LanguageModel.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, listProviders, deleteProviderConfig, setDefaultProvider, recordProviderTest } from '@uplnk/db';
import type { ProviderConfig as DbRow } from '@uplnk/db';
import type { AuthMode, ProviderKind, ProviderConfig as PyProviderConfig } from '@uplnk/providers';
import { makeProvider, ProviderError } from '@uplnk/providers';
import { resolveSecret } from '../lib/secrets.js';

interface Props {
  onSelect: (providerId: string, defaultModel: string, baseUrl: string, apiKey: string) => void;
  onBack: () => void;
  onAdd: () => void;
  /**
   * Open the AddProviderScreen in edit mode for the given provider.
   * The caller is responsible for navigating to the screen. `apiKey` is
   * the resolved cleartext; `rawApiKey` is the un-resolved column value
   * (a `@secret:` ref or legacy plaintext) that the save path uses to
   * detect "key unchanged" and reuse the existing ref.
   */
  onEdit: (provider: {
    id: string;
    name: string;
    kind: ProviderKind;
    baseUrl: string;
    authMode: AuthMode;
    apiKey: string;
    rawApiKey?: string | null;
    isDefault: boolean;
    defaultModel: string | null;
  }) => void;
}

type TransientMsg = { color: string; text: string } | null;

function rowToConfig(row: DbRow): PyProviderConfig {
  // `row.apiKey` may be a `@secret:` ref or legacy plaintext; resolve either
  // to the cleartext before passing it to the provider adapter's testConnection.
  const resolved = resolveSecret(row.apiKey);
  return {
    id: row.id,
    name: row.name,
    kind: row.providerType as ProviderKind,
    baseUrl: row.baseUrl,
    authMode: (row.authMode ?? 'none') as AuthMode,
    ...(resolved !== undefined ? { apiKey: resolved } : {}),
  };
}

export const ProviderSelectorScreen = memo(function ProviderSelectorScreen({ onSelect, onBack, onAdd, onEdit }: Props) {
  const [providers, setProviders] = useState<DbRow[]>(() => listProviders(db));
  const [cursor, setCursor] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<TransientMsg>(null);

  const refresh = useCallback(() => {
    setProviders(listProviders(db));
  }, []);

  useEffect(() => {
    if (msg === null) return;
    const t = setTimeout(() => { setMsg(null); }, 3500);
    return () => { clearTimeout(t); };
  }, [msg]);

  useInput((input, key) => {
    if (confirmDelete) {
      if (input === 'y' || input === 'Y') {
        const p = providers[cursor];
        if (p !== undefined) {
          deleteProviderConfig(db, p.id);
          refresh();
          setCursor((c) => Math.max(0, Math.min(c, providers.length - 2)));
          setMsg({ color: '#4ADE80', text: `Deleted ${p.name}` });
        }
        setConfirmDelete(false);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) { setConfirmDelete(false); return; }
      return;
    }

    if (key.escape) { onBack(); return; }
    if (providers.length === 0 && input !== 'a') return;

    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(providers.length - 1, c + 1));
    if (key.return) {
      const p = providers[cursor];
      if (p !== undefined) {
        // Resolve the DB column through the secrets backend so overrides
        // passed up to App/ChatScreen always carry cleartext. Falls back
        // to the literal 'ollama' placeholder so OpenAI-compat servers that
        // don't verify auth still get a non-empty Bearer header.
        const resolvedKey = resolveSecret(p.apiKey) ?? 'ollama';
        onSelect(p.id, p.defaultModel ?? 'llama3.2', p.baseUrl, resolvedKey);
      }
      return;
    }
    if (input === 'a') { onAdd(); return; }
    if (input === 'e') {
      const p = providers[cursor];
      if (p === undefined) return;
      // Resolve the api_key column to cleartext before handing it to the
      // edit form so the user sees their actual key (masked) instead of an
      // opaque `@secret:` ref. We ALSO pass the raw column value through as
      // `rawApiKey` so the save path can detect "key unchanged" and reuse
      // the existing ref instead of orphaning it (H1 from security gate).
      onEdit({
        id: p.id,
        name: p.name,
        kind: p.providerType as ProviderKind,
        baseUrl: p.baseUrl,
        authMode: (p.authMode ?? 'none') as AuthMode,
        apiKey: resolveSecret(p.apiKey) ?? '',
        rawApiKey: p.apiKey,
        isDefault: p.isDefault,
        defaultModel: p.defaultModel ?? null,
      });
      return;
    }
    if (input === 'd') {
      if (providers[cursor] !== undefined) setConfirmDelete(true);
      return;
    }
    if (input === 'D') {
      const p = providers[cursor];
      if (p !== undefined) {
        setDefaultProvider(db, p.id);
        refresh();
        setMsg({ color: '#4ADE80', text: `${p.name} is now the default` });
      }
      return;
    }
    if (input === 't') {
      const p = providers[cursor];
      if (p === undefined) return;
      setTestingId(p.id);
      const controller = new AbortController();
      makeProvider(rowToConfig(p))
        .testConnection(controller.signal)
        .then((h) => {
          recordProviderTest(db, p.id, 'ok', h.detail ?? '');
          setMsg({ color: '#4ADE80', text: `${p.name}: ${h.detail ?? 'ok'} (${String(h.latencyMs)}ms)` });
        })
        .catch((err: unknown) => {
          const detail = err instanceof ProviderError ? err.userMessage : err instanceof Error ? err.message : 'failed';
          recordProviderTest(db, p.id, 'fail', detail);
          setMsg({ color: 'red', text: `${p.name}: ${detail}` });
        })
        .finally(() => { setTestingId(null); refresh(); });
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Providers  <Text dimColor>(j/k · Enter select · a add · e edit · t test · D default · d delete · Esc back)</Text></Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.length === 0 && (
          <Text dimColor>No providers configured. Press <Text color="#60A5FA">a</Text> to add one.</Text>
        )}
        {providers.map((p, i) => {
          const isCursor = i === cursor;
          return (
            <Box key={p.id} flexDirection="column" marginY={0}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold>{p.name}</Text>
                {'  '}
                <Text dimColor>{p.providerType}</Text>
                {'  '}
                <Text dimColor>{p.baseUrl}</Text>
                {p.isDefault ? <Text color="#4ADE80">  ● default</Text> : null}
                {testingId === p.id ? <Text color="#60A5FA">  testing…</Text> : null}
              </Text>
              {isCursor && (
                <Box flexDirection="column" marginLeft={4}>
                  <Text dimColor>Model: {p.defaultModel ?? 'not set'}</Text>
                  {p.lastTestStatus !== null && p.lastTestStatus !== undefined && (
                    <Text dimColor>
                      Last test: <Text color={p.lastTestStatus === 'ok' ? '#4ADE80' : 'red'}>{p.lastTestStatus}</Text>
                      {' '}· {p.lastTestDetail ?? ''}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      {confirmDelete && providers[cursor] !== undefined && (
        <Box marginTop={1}>
          <Text color="red">Delete <Text bold>{providers[cursor].name}</Text>? y/n</Text>
        </Box>
      )}
      {msg !== null && (
        <Box marginTop={1}>
          <Text color={msg.color}>{msg.text}</Text>
        </Box>
      )}
    </Box>
  );
});
