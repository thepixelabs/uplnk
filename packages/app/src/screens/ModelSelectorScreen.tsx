import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, getDefaultProvider } from '@uplnk/db';
import type { Model, ProviderConfig as PyProviderConfig, AuthMode } from '@uplnk/providers';
import { useModelSelector } from '../hooks/useModelSelector.js';
import { resolveSecret } from '../lib/secrets.js';

interface Props {
  onSelect: (model: string) => void;
  onBack: () => void;
  routerEnabled?: boolean;
  /** Override for tests / provider flow — when omitted, reads the default. */
  providerConfig?: PyProviderConfig | null;
}

type Filter = 'all' | 'installed' | 'known';

interface Row {
  kind: 'header' | 'model';
  label: string;
  model?: Model;
  /** Index used by the cursor; headers are not selectable. */
  selectable: boolean;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(0)}M`;
}

function formatContext(tokens?: number): string {
  if (tokens === undefined) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000).toString()}k`;
  return tokens.toString();
}

function formatCost(usd?: number): string {
  if (usd === undefined) return '';
  if (usd === 0) return 'free';
  return `$${usd.toFixed(2)}/M`;
}

function readDefaultProviderConfig(): PyProviderConfig | null {
  const row = getDefaultProvider(db);
  if (row === undefined) return null;
  // Resolve the api_key column through the secrets backend — the raw
  // column value is usually a `@secret:` ref under the v0.2 backend,
  // and passing a ref verbatim to the provider adapter silently breaks
  // `GET /models` discovery with a 401.
  const resolved = resolveSecret(row.apiKey);
  return {
    id: row.id,
    name: row.name,
    kind: row.providerType as PyProviderConfig['kind'],
    baseUrl: row.baseUrl,
    authMode: (row.authMode ?? 'none') as AuthMode,
    apiKey: resolved,
  };
}

export function ModelSelectorScreen({ onSelect, onBack, routerEnabled, providerConfig }: Props) {
  const effectiveConfig = useMemo(
    () => providerConfig ?? readDefaultProviderConfig(),
    [providerConfig],
  );
  const { installed, available, isLoading, error, errorCode, refresh } = useModelSelector(effectiveConfig);

  const [cursor, setCursor] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);

  const matches = (m: Model): boolean => {
    if (query === '') return true;
    const q = query.toLowerCase();
    return (
      m.id.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      (m.family?.toLowerCase().includes(q) ?? false)
    );
  };

  const filteredInstalled = useMemo(
    () => installed.filter(matches),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [installed, query],
  );
  const filteredAvailable = useMemo(
    () => available.filter(matches),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [available, query],
  );

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (filter !== 'known') {
      out.push({ kind: 'header', label: `Installed on server  (${String(filteredInstalled.length)})`, selectable: false });
      if (filteredInstalled.length === 0) {
        out.push({ kind: 'header', label: '  (none)', selectable: false });
      }
      for (const m of filteredInstalled) out.push({ kind: 'model', label: m.id, model: m, selectable: true });
    }
    if (filter !== 'installed') {
      out.push({ kind: 'header', label: `Known — not installed  (${String(filteredAvailable.length)})`, selectable: false });
      for (const m of filteredAvailable) out.push({ kind: 'model', label: m.id, model: m, selectable: true });
    }
    return out;
  }, [filter, filteredInstalled, filteredAvailable]);

  const selectableIndexes = useMemo(
    () => rows.map((r, i) => (r.selectable ? i : -1)).filter((i) => i !== -1),
    [rows],
  );
  const clampedCursor = selectableIndexes.length === 0
    ? 0
    : Math.min(cursor, selectableIndexes.length - 1);
  const selectedRowIndex = selectableIndexes[clampedCursor] ?? -1;
  const selectedModel = selectedRowIndex >= 0 ? rows[selectedRowIndex]?.model : undefined;

  useInput((input, key) => {
    if (searchMode) {
      if (key.escape) { setSearchMode(false); setQuery(''); setCursor(0); return; }
      if (key.return) { setSearchMode(false); return; }
      if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setCursor(0); return; }
      if (input.length === 1 && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setCursor(0);
      }
      return;
    }

    if (key.escape) { onBack(); return; }
    if (input === '/') { setSearchMode(true); return; }
    if (input === 'r' || key.ctrl && input === 'r') { refresh(); return; }
    if (input === 'f') {
      setFilter((f) => (f === 'all' ? 'installed' : f === 'installed' ? 'known' : 'all'));
      setCursor(0);
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(selectableIndexes.length - 1, c + 1));
      return;
    }
    if (input === 'g') { setCursor(0); return; }
    if (input === 'G') { setCursor(Math.max(0, selectableIndexes.length - 1)); return; }
    if (key.return && selectedModel && selectedModel.source !== 'catalog') {
      onSelect(selectedModel.id);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#60A5FA"
      marginX={4}
      marginY={1}
      paddingX={1}
    >
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box>
            <Text bold color="#60A5FA">Models</Text>
            {routerEnabled === true && <Text color="#60A5FA" dimColor>   (router)</Text>}
          </Box>
          <Text dimColor>j/k navigate · / search · f filter · r refresh · Enter load · Esc back</Text>
        </Box>
        <Box>
          {effectiveConfig !== null ? (
            <Text dimColor>
              Provider: <Text color="#60A5FA">{effectiveConfig.name}</Text>
              {'  '}
              <Text>{effectiveConfig.baseUrl}</Text>
            </Text>
          ) : (
            <Text color="yellow">No provider configured. Press Esc, run /provider.</Text>
          )}
        </Box>
        <Box>
          <Text dimColor>Filter: <Text color="#60A5FA">{filter}</Text>  </Text>
          {searchMode ? (
            <Text>Search: <Text color="#60A5FA">{query}</Text>█</Text>
          ) : query !== '' ? (
            <Text dimColor>Search: <Text color="#60A5FA">{query}</Text>  (/ to edit · Esc to clear)</Text>
          ) : null}
        </Box>
      </Box>

      {isLoading && (
        <Box marginTop={1}><Text dimColor>Fetching models…</Text></Box>
      )}

      {!isLoading && error !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">✗ {error}</Text>
          {errorCode !== null && <Text dimColor>   code: {errorCode}</Text>}
          <Text dimColor>   Known models from the catalog are still shown below.</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" width="60%">
          {rows.map((row, i) => {
            if (row.kind === 'header') {
              return (
                <Box key={`h-${String(i)}`} marginTop={i === 0 ? 0 : 1}>
                  <Text bold dimColor>── {row.label} ──</Text>
                </Box>
              );
            }
            const isCursor = i === selectedRowIndex;
            const m = row.model;
            if (m === undefined) return null;
            const badge = m.source === 'catalog' ? 'catalog ' : 'installed';
            const badgeColor = m.source === 'catalog' ? '#64748B' : '#4ADE80';
            return (
              <Box key={`m-${m.id}-${String(i)}`}>
                <Text {...(isCursor ? { color: '#60A5FA' as const } : {})} bold={isCursor}>
                  {isCursor ? '▶ ' : '  '}
                  <Text bold={isCursor}>{m.id.padEnd(30)}</Text>
                  {'  '}
                  <Text dimColor>{formatContext(m.contextWindow).padStart(6)}</Text>
                  {'  '}
                  <Text dimColor>{(m.sizeBytes !== undefined ? formatSize(m.sizeBytes) : '').padStart(6)}</Text>
                  {'  '}
                  <Text color={badgeColor}>{badge}</Text>
                </Text>
              </Box>
            );
          })}
          {!isLoading && rows.length === 0 && (
            <Text dimColor>No models match. Press Esc to clear search.</Text>
          )}
        </Box>

        <Box flexDirection="column" width="40%" paddingLeft={2}>
          {selectedModel !== undefined ? (
            <DetailPanel model={selectedModel} />
          ) : (
            <Text dimColor>Select a model to see details.</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}

function DetailPanel({ model }: { model: Model }) {
  return (
    <Box flexDirection="column">
      <Text bold>{model.displayName}</Text>
      <Text dimColor>{model.kind}{model.family !== undefined ? ` · ${model.family}` : ''}</Text>
      <Box marginTop={1} flexDirection="column">
        <Row label="Source">
          {model.source === 'server' && <Text color="#4ADE80">server only</Text>}
          {model.source === 'catalog' && <Text dimColor>catalog — not on server</Text>}
          {model.source === 'both' && <Text color="#4ADE80">server + catalog</Text>}
        </Row>
        <Row label="Context"><Text>{formatContext(model.contextWindow)}{model.contextWindow !== undefined ? ' tokens' : ''}</Text></Row>
        {model.maxOutputTokens !== undefined && (
          <Row label="Max out"><Text>{formatContext(model.maxOutputTokens)} tokens</Text></Row>
        )}
        {model.sizeBytes !== undefined && <Row label="Size">{formatSize(model.sizeBytes)}</Row>}
        {(model.inputCostPer1M !== undefined || model.outputCostPer1M !== undefined) && (
          <>
            <Row label="Input $">{formatCost(model.inputCostPer1M)}</Row>
            <Row label="Output $">{formatCost(model.outputCostPer1M)}</Row>
          </>
        )}
        {model.capabilities !== undefined && (
          <Row label="Tools">
            {model.capabilities.tools === true ? <Text color="#4ADE80">yes</Text> : <Text dimColor>—</Text>}
          </Row>
        )}
      </Box>
      <Box marginTop={1}>
        {model.source === 'catalog' ? (
          <Text dimColor>Not on server. Pull it externally (e.g. `ollama pull {model.id}`) then refresh.</Text>
        ) : (
          <Text color="#4ADE80">Enter to load this model.</Text>
        )}
      </Box>
    </Box>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(9)}</Text>
      {typeof children === 'string' ? <Text>{children}</Text> : children}
    </Box>
  );
}
