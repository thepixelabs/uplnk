import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, getDefaultProvider } from '@uplnk/db';
import type { Model, ProviderConfig as PyProviderConfig, AuthMode } from '@uplnk/providers';
import { useModelSelector } from '../hooks/useModelSelector.js';
import { usePullQueue, type PullState } from '../hooks/usePullQueue.js';
import { renderGaugeBar } from '../lib/tokenCounter.js';
import { resolveSecret } from '../lib/secrets.js';

interface Props {
  onSelect: (model: string) => void;
  onBack: () => void;
  routerEnabled?: boolean;
  providerConfig?: PyProviderConfig | null;
}

type SourceFilter = 'all' | 'installed' | 'catalog';
type CloudFilter  = 'all' | 'cloud' | 'local';

interface Row {
  kind: 'header' | 'model';
  label: string;
  model?: Model;
  selectable: boolean;
}

const PAGE_SIZE = 20;

// ── formatters ──────────────────────────────────────────────────────────────

function fmtSize(bytes?: number): string {
  if (bytes === undefined) return '';
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)}G`;
  return `${(bytes / 1_000_000).toFixed(0)}M`;
}

function fmtCtx(tokens?: number): string {
  if (tokens === undefined) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000).toString()}k`;
  return tokens.toString();
}

function fmtCost(usd?: number): string {
  if (usd === undefined) return '';
  if (usd === 0) return 'free';
  return `$${usd.toFixed(2)}/M`;
}

function fmtCaps(caps?: Model['capabilities']): string {
  if (caps === undefined) return '   ';
  const t = caps.tools === true;
  const v = caps.vision === true;
  if (t && v) return 'T+V';
  if (t) return '[T]';
  if (v) return '[V]';
  return '   ';
}

// ── pull progress helpers ────────────────────────────────────────────────────

function pullBar(p: PullState): string {
  return p.total > 0 ? renderGaugeBar(p.completed, p.total, 12) : '            ';
}

function pullPct(p: PullState): string {
  if (p.total <= 0) return '   ';
  return `${String(Math.round((p.completed / p.total) * 100)).padStart(3)}%`;
}

function pullPhaseText(p: PullState): string {
  if (p.phase === 'done')      return 'done ✓';
  if (p.phase === 'error')     return `err: ${(p.errorMsg ?? '?').slice(0, 12)}`;
  if (p.phase === 'verifying') return 'verifying…';
  if (p.total > 0)             return 'downloading…';
  return p.statusText.slice(0, 14);
}

// ── icon / status helpers ────────────────────────────────────────────────────
// Icon encodes *type* (local vs cloud); color encodes *install status*.
// Green ● = installed on server. ~ = cloud-backed (API). space = local, not pulled.
function rowIcon(m: Model): { char: string; color: string } {
  if (m.source !== 'catalog') return { char: '●', color: '#4ADE80' }; // installed
  if (m.isCloud === true)     return { char: '~', color: '#60A5FA' }; // cloud, not installed
  return                             { char: ' ', color: '#475569' }; // local catalog
}

function rowStatus(m: Model): { text: string; color: string } {
  if (m.source !== 'catalog') return { text: 'installed', color: '#4ADE80' };
  if (m.isCloud === true)     return { text: 'cloud',     color: '#60A5FA' };
  return                             { text: 'catalog',   color: '#475569' };
}

// ── default provider ─────────────────────────────────────────────────────────

function readDefaultProviderConfig(): PyProviderConfig | null {
  const row = getDefaultProvider(db);
  if (row === undefined) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.providerType as PyProviderConfig['kind'],
    baseUrl: row.baseUrl,
    authMode: (row.authMode ?? 'none') as AuthMode,
    apiKey: resolveSecret(row.apiKey),
  };
}

// ── component ────────────────────────────────────────────────────────────────

export function ModelSelectorScreen({ onSelect, onBack, routerEnabled, providerConfig }: Props) {
  const effectiveConfig = useMemo(
    () => providerConfig ?? readDefaultProviderConfig(),
    [providerConfig],
  );

  const {
    installed, available,
    isLoading, isCatalogRefreshing,
    error, errorCode, catalogError,
    refresh,
  } = useModelSelector(effectiveConfig);

  const { pulls, startPull, dismiss } = usePullQueue(effectiveConfig, refresh);

  const [cursor,       setCursor]       = useState(0);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [cloudFilter,  setCloudFilter]  = useState<CloudFilter>('all');
  const [query,        setQuery]        = useState('');
  const [searchMode,   setSearchMode]   = useState(false);

  // ── filtering ──────────────────────────────────────────────────────────────
  const matchesModel = (m: Model): boolean => {
    if (cloudFilter === 'cloud' && m.isCloud !== true) return false;
    if (cloudFilter === 'local' && m.isCloud === true) return false;
    if (query === '') return true;
    const q = query.toLowerCase();
    return (
      m.id.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      (m.family?.toLowerCase().includes(q) ?? false)
    );
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredInstalled = useMemo(() => installed.filter(matchesModel), [installed, query, cloudFilter]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filteredAvailable = useMemo(() => available.filter(matchesModel), [available, query, cloudFilter]);

  // ── row list ───────────────────────────────────────────────────────────────
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (sourceFilter !== 'catalog') {
      out.push({ kind: 'header', label: `Installed  (${String(filteredInstalled.length)})`, selectable: false });
      if (filteredInstalled.length === 0)
        out.push({ kind: 'header', label: '  (none)', selectable: false });
      for (const m of filteredInstalled)
        out.push({ kind: 'model', label: m.id, model: m, selectable: true });
    }
    if (sourceFilter !== 'installed') {
      out.push({ kind: 'header', label: `Catalog — not installed  (${String(filteredAvailable.length)})`, selectable: false });
      for (const m of filteredAvailable)
        out.push({ kind: 'model', label: m.id, model: m, selectable: true });
    }
    return out;
  }, [sourceFilter, filteredInstalled, filteredAvailable]);

  const selectableIndexes = useMemo(
    () => rows.map((r, i) => (r.selectable ? i : -1)).filter((i) => i !== -1),
    [rows],
  );

  const clampedCursor   = Math.min(cursor, Math.max(0, selectableIndexes.length - 1));
  const selectedRowIdx  = selectableIndexes[clampedCursor] ?? -1;
  const selectedModel   = selectedRowIdx >= 0 ? rows[selectedRowIdx]?.model : undefined;

  // ── viewport: keep selected row centered in a PAGE_SIZE window ────────────
  const windowStart = useMemo(() => {
    if (selectedRowIdx < 0 || rows.length <= PAGE_SIZE) return 0;
    const ideal = Math.max(0, selectedRowIdx - Math.floor(PAGE_SIZE / 2));
    return Math.min(ideal, rows.length - PAGE_SIZE);
  }, [selectedRowIdx, rows.length]);

  const visibleRows  = rows.slice(windowStart, windowStart + PAGE_SIZE);
  const aboveCount   = windowStart;
  const belowCount   = Math.max(0, rows.length - windowStart - PAGE_SIZE);

  // ── keyboard ───────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (searchMode) {
      if (key.escape)                          { setSearchMode(false); setQuery(''); setCursor(0); return; }
      if (key.return)                          { setSearchMode(false); return; }
      if (key.backspace || key.delete)         { setQuery((q) => q.slice(0, -1)); setCursor(0); return; }
      if (input.length === 1 && !key.ctrl && !key.meta) { setQuery((q) => q + input); setCursor(0); }
      return;
    }

    if (key.escape)                            { onBack(); return; }
    if (input === '/')                         { setSearchMode(true); return; }
    if (input === 'r' || (key.ctrl && input === 'r')) { refresh(); return; }
    if (input === 'f') {
      setSourceFilter((f) => f === 'all' ? 'installed' : f === 'installed' ? 'catalog' : 'all');
      setCursor(0); return;
    }
    if (input === 'c') {
      setCloudFilter((f) => f === 'all' ? 'cloud' : f === 'cloud' ? 'local' : 'all');
      setCursor(0); return;
    }
    if (key.upArrow || input === 'k')          { setCursor((c) => Math.max(0, c - 1)); return; }
    if (key.downArrow || input === 'j')        { setCursor((c) => Math.min(selectableIndexes.length - 1, c + 1)); return; }
    if (input === 'g')                         { setCursor(0); return; }
    if (input === 'G')                         { setCursor(Math.max(0, selectableIndexes.length - 1)); return; }
    if (input === 'x' && selectedModel)        { dismiss(selectedModel.id); return; }
    if (key.return && selectedModel) {
      if (selectedModel.source === 'catalog') {
        startPull(selectedModel.id);
      } else {
        onSelect(selectedModel.id);
      }
    }
  });

  // ── filter label helpers ───────────────────────────────────────────────────
  const cloudLabel = cloudFilter === 'all' ? 'all' : cloudFilter === 'cloud' ? '~ cloud' : '● local';

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#60A5FA" marginX={4} marginY={1} paddingX={1}>

      {/* Title + keybinding hint */}
      <Box justifyContent="space-between">
        <Box>
          <Text bold color="#60A5FA">Models</Text>
          {routerEnabled === true && <Text dimColor color="#60A5FA">  (router)</Text>}
        </Box>
        <Text dimColor>j/k navigate  / search  f source  c cloud  r refresh  Enter load/pull  x dismiss  Esc back</Text>
      </Box>

      {/* Provider + active filters */}
      <Box gap={3}>
        {effectiveConfig !== null
          ? <Text dimColor><Text color="#60A5FA">{effectiveConfig.name}</Text>  {effectiveConfig.baseUrl}</Text>
          : <Text color="yellow">No provider configured. Press Esc, run /provider.</Text>
        }
        <Text dimColor>
          source:<Text color="#60A5FA"> {sourceFilter}</Text>
          {'   '}
          cloud:<Text color="#60A5FA"> {cloudLabel}</Text>
          {query !== '' && <Text>   search:<Text color="#60A5FA"> {query}</Text></Text>}
        </Text>
        {searchMode && <Text color="#60A5FA">search: {query}█</Text>}
      </Box>

      {/* Loading / error banners */}
      {isLoading          && <Text dimColor>  Fetching installed models…</Text>}
      {isCatalogRefreshing && <Text dimColor>  Refreshing catalog from ollama.com…</Text>}
      {!isLoading && error !== null && (
        <Text color="red">  ✗ {error}{errorCode !== null ? ` (${errorCode})` : ''}</Text>
      )}
      {catalogError !== null && (
        <Text color="yellow">  ⚠ Catalog refresh failed: {catalogError}</Text>
      )}

      {/* Column header */}
      <Box marginTop={1}>
        <Text dimColor>
          {'     '}
          {'model'.padEnd(28)}
          {'  '}
          {'family'.padEnd(10)}
          {'  '}
          {'ctx'.padStart(6)}
          {'  '}
          {'caps'.padEnd(4)}
          {'  '}
          {'size'.padStart(6)}
          {'  '}
          {'status'}
        </Text>
      </Box>

      {/* List + detail panel */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>

          {/* Overflow indicator — above */}
          {aboveCount > 0 && (
            <Text dimColor>  ▲ {String(aboveCount)} more above</Text>
          )}

          {visibleRows.map((row, sliceIdx) => {
            const rowIdx = windowStart + sliceIdx;

            if (row.kind === 'header') {
              return (
                <Box key={`h-${String(rowIdx)}`} marginTop={sliceIdx === 0 ? 0 : 1}>
                  <Text bold dimColor>── {row.label} ──</Text>
                </Box>
              );
            }

            const m = row.model;
            if (m === undefined) return null;
            const isCursor = rowIdx === selectedRowIdx;
            const icon   = rowIcon(m);
            const status = rowStatus(m);
            const idStr  = m.id.length > 27 ? `${m.id.slice(0, 26)}…` : m.id.padEnd(28);
            const pull   = pulls.get(m.id);

            // Pulling row — show progress bar instead of metadata columns
            if (pull !== undefined) {
              const barColor  = pull.phase === 'done' ? '#4ADE80' : pull.phase === 'error' ? 'red' : '#60A5FA';
              const textColor = pull.phase === 'done' ? '#4ADE80' : pull.phase === 'error' ? 'red' : '#94A3B8';
              return (
                <Box key={`m-${m.id}-${String(rowIdx)}`}>
                  <Text {...(isCursor ? { color: '#60A5FA' as const } : {})} bold={isCursor}>
                    {isCursor ? '▶ ' : '  '}
                    <Text color={icon.color}>{icon.char} </Text>
                    <Text bold={isCursor}>{idStr}</Text>
                    {'  '}
                    <Text color={barColor}>{pullBar(pull)}</Text>
                    {' '}
                    <Text color={barColor}>{pullPct(pull)}</Text>
                    {'  '}
                    <Text color={textColor}>{pullPhaseText(pull)}</Text>
                  </Text>
                </Box>
              );
            }

            return (
              <Box key={`m-${m.id}-${String(rowIdx)}`}>
                <Text {...(isCursor ? { color: '#60A5FA' as const } : {})} bold={isCursor}>
                  {isCursor ? '▶ ' : '  '}
                  <Text color={icon.color}>{icon.char} </Text>
                  <Text bold={isCursor}>{idStr}</Text>
                  {'  '}
                  <Text dimColor>{(m.family ?? '').padEnd(10)}</Text>
                  {'  '}
                  <Text dimColor>{fmtCtx(m.contextWindow).padStart(6)}</Text>
                  {'  '}
                  <Text dimColor>{fmtCaps(m.capabilities).padEnd(4)}</Text>
                  {'  '}
                  <Text dimColor>{(m.sizeBytes !== undefined ? fmtSize(m.sizeBytes) : '').padStart(6)}</Text>
                  {'  '}
                  <Text color={status.color}>{status.text}</Text>
                </Text>
              </Box>
            );
          })}

          {/* Overflow indicator — below */}
          {belowCount > 0 && (
            <Text dimColor>  ▼ {String(belowCount)} more below</Text>
          )}

          {!isLoading && rows.length === 0 && (
            <Text dimColor>  No models match the current filters.</Text>
          )}
        </Box>

        {/* Detail panel */}
        <Box
          flexDirection="column"
          width={34}
          paddingLeft={2}
          borderStyle="single"
          borderColor="#334155"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          {selectedModel !== undefined
            ? <DetailPanel model={selectedModel} />
            : <Text dimColor>Select a model to see details.</Text>
          }
        </Box>
      </Box>

      {/* Total download progress footer */}
      {pulls.size > 0 && <PullFooter pulls={pulls} />}

    </Box>
  );
}

// ── pull footer ───────────────────────────────────────────────────────────────

function PullFooter({ pulls }: { pulls: ReadonlyMap<string, PullState> }) {
  const entries    = Array.from(pulls.values());
  const active     = entries.filter((p) => p.phase === 'pulling' || p.phase === 'verifying' || p.phase === 'pending').length;
  const done       = entries.filter((p) => p.phase === 'done').length;
  const errors     = entries.filter((p) => p.phase === 'error').length;
  const totalDone  = entries.reduce((s, p) => s + p.completed, 0);
  const totalBytes = entries.reduce((s, p) => s + p.total, 0);
  const bar        = totalBytes > 0 ? renderGaugeBar(totalDone, totalBytes, 16) : '';
  const pct        = totalBytes > 0 ? ` ${String(Math.round((totalDone / totalBytes) * 100))}%` : '';
  const sizeStr    = totalBytes > 0 ? `  ${fmtSize(totalDone)} / ${fmtSize(totalBytes)}` : '';

  return (
    <Box
      borderStyle="single"
      borderColor="#334155"
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      <Text bold color="#60A5FA">Downloads  </Text>
      {bar !== '' && <Text color="#60A5FA">{bar}{pct}</Text>}
      {sizeStr !== '' && <Text dimColor>{sizeStr}   </Text>}
      {active > 0  && <Text color="#FCD34D">{String(active)} active   </Text>}
      {done > 0    && <Text color="#4ADE80">{String(done)} done   </Text>}
      {errors > 0  && <Text color="red">{String(errors)} failed   </Text>}
      <Text dimColor>  x to dismiss</Text>
    </Box>
  );
}

// ── detail panel ─────────────────────────────────────────────────────────────

function DetailPanel({ model }: { model: Model }) {
  const icon   = rowIcon(model);
  const status = rowStatus(model);
  return (
    <Box flexDirection="column">
      <Text bold>
        <Text color={icon.color}>{icon.char} </Text>
        {model.displayName}
      </Text>
      <Text dimColor>{model.kind}{model.family !== undefined ? ` · ${model.family}` : ''}</Text>

      <Box marginTop={1} flexDirection="column">
        <DRow label="Status"><Text color={status.color}>{status.text}</Text></DRow>
        <DRow label="Type">
          {model.isCloud === true
            ? <Text color="#60A5FA">cloud / API-backed</Text>
            : <Text color="#93C5FD">local / open-weight</Text>
          }
        </DRow>
        <DRow label="Context">
          <Text>{fmtCtx(model.contextWindow)}{model.contextWindow !== undefined ? ' tokens' : ''}</Text>
        </DRow>
        {model.maxOutputTokens !== undefined && (
          <DRow label="Max out"><Text>{fmtCtx(model.maxOutputTokens)} tokens</Text></DRow>
        )}
        {model.sizeBytes !== undefined && (
          <DRow label="Size"><Text>{fmtSize(model.sizeBytes)}</Text></DRow>
        )}
        {(model.inputCostPer1M !== undefined || model.outputCostPer1M !== undefined) && (
          <>
            <DRow label="Input $"><Text>{fmtCost(model.inputCostPer1M)}</Text></DRow>
            <DRow label="Output $"><Text>{fmtCost(model.outputCostPer1M)}</Text></DRow>
          </>
        )}
        {model.capabilities !== undefined && (
          <>
            <DRow label="Tools">
              {model.capabilities.tools === true ? <Text color="#4ADE80">yes</Text> : <Text dimColor>—</Text>}
            </DRow>
            <DRow label="Vision">
              {model.capabilities.vision === true ? <Text color="#4ADE80">yes</Text> : <Text dimColor>—</Text>}
            </DRow>
          </>
        )}
      </Box>

      <Box marginTop={1}>
        {model.source === 'catalog'
          ? <Text dimColor wrap="wrap">ollama pull {model.id}</Text>
          : <Text color="#4ADE80">Enter to load this model.</Text>
        }
      </Box>
    </Box>
  );
}

function DRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text dimColor>{label.padEnd(9)}</Text>
      {typeof children === 'string' ? <Text>{children}</Text> : children}
    </Box>
  );
}
