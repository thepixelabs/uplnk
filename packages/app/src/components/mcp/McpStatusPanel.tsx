/**
 * McpStatusPanel — overlay shown by ChatScreen when the user types /mcp.
 *
 * Layout rules:
 *  - Each failed server collapses to a single line by default
 *    (name, id, terse error message). Long messages truncate so the row
 *    width stays predictable across terminal sizes.
 *  - Enter/Space on a selected row toggles a detail block underneath that
 *    row containing the last N lines of the child process's stderr. Detail
 *    lines are indented two columns and ANSI escape codes are stripped so
 *    upstream rich-style colour codes never collide with our own border.
 *  - ↑/↓ (or j/k) move the selection cursor; only an expanded row needs
 *    extra vertical room, so the panel stays compact when there are
 *    multiple failures.
 *
 * Built-in MCP servers (file-browse, command-exec, git, rag) are not
 * shown here — McpManager already excludes them from failedConnections.
 */

import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import clipboard from 'clipboardy';
import type { FailedConnection } from '../../lib/mcp/McpManager.js';
import { getConfigPath } from '../../lib/config.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

interface Props {
  failedServers: FailedConnection[];
  onRetry: () => Promise<void>;
  onClose: () => void;
}

const STDERR_PREVIEW_LINES = 12;

// Box overhead: 1 border + 1 paddingX + 1 marginX per side = 6 chars total.
// Row prefix: "▶ " (2) + "✗ " (2) + name + " (" + id + ") " (4 + id.length) = 8 + name.length + id.length.
// Constant guard so the fallback is never 0 even in test environments.
const BOX_OVERHEAD = 6;
const ROW_PREFIX_FIXED = 8; // "▶ " + "✗ " + " (" + ") "
const SUMMARY_MIN_CHARS = 20; // never truncate below this even on tiny terminals

// Drop ANSI SGR escapes (colour, bold, etc.) so upstream "rich"-rendered
// tracebacks don't fight Ink for the same terminal cells. Unicode
// box-drawing characters from the child are left intact — they're plain
// text and render fine inside our own border as long as our panel doesn't
// add a competing `│` prefix to every line.
const ANSI_SGR_RE = /\x1B\[[0-9;]*m/g;
function stripAnsi(input: string): string {
  return input.replace(ANSI_SGR_RE, '');
}

function tailLines(stderr: string, limit: number): string[] {
  if (stderr.length === 0) return [];
  return stderr
    .split('\n')
    .map(stripAnsi)
    .filter((l) => l.trim() !== '')
    .slice(-limit);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export function McpStatusPanel({ failedServers, onRetry, onClose }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const configPath = getConfigPath();
  const { columns } = useTerminalSize();

  // Clamp cursor when the list shrinks (e.g. after a successful retry).
  const safeCursor = failedServers.length === 0
    ? 0
    : Math.min(cursor, failedServers.length - 1);

  // Auto-dismiss transient feedback messages (clipboard confirmation,
  // future toasts) so they don't linger and start to look like errors.
  // Retrying… intentionally has no auto-clear; the retry resolver clears
  // it explicitly when the work finishes.
  useEffect(() => {
    if (msg === null || retrying) return;
    const t = setTimeout(() => { setMsg(null); }, 3000);
    return () => { clearTimeout(t); };
  }, [msg, retrying]);

  // Drop expanded ids that no longer exist so the Set doesn't grow forever
  // across rounds of retry/edit/retry.
  useEffect(() => {
    if (expanded.size === 0) return;
    const liveIds = new Set(failedServers.map((f) => f.config.id));
    let mutated = false;
    const next = new Set<string>();
    for (const id of expanded) {
      if (liveIds.has(id)) next.add(id);
      else mutated = true;
    }
    if (mutated) setExpanded(next);
  }, [failedServers, expanded]);

  const selected = failedServers[safeCursor];

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(Math.max(0, failedServers.length - 1), c + 1));
      return;
    }
    if ((key.return || input === ' ') && selected !== undefined) {
      toggleExpanded(selected.config.id);
      return;
    }
    if (input === 'r' && !retrying && failedServers.length > 0) {
      setRetrying(true);
      setMsg('Retrying…');
      void onRetry().then(() => {
        setRetrying(false);
        setMsg(null);
      });
      return;
    }
    if (input === 'c') {
      try {
        clipboard.writeSync(configPath);
        setMsg(`Copied ${configPath} to clipboard`);
      } catch {
        setMsg(configPath);
      }
      return;
    }
  });

  const detailHint = useMemo(() => {
    if (failedServers.length === 0) return 'r retry · c copy config path · Esc close';
    return '↑↓ select · enter expand · r retry · c copy · Esc close';
  }, [failedServers.length]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#FBBF24" paddingX={1} marginX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="#FBBF24">MCP servers</Text>
        <Text dimColor>{detailHint}</Text>
      </Box>

      {failedServers.length === 0 ? (
        <Box marginTop={1}>
          <Text color="#4ADE80">✓ All configured MCP servers are connected.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {failedServers.map((f, i) => {
            const isSelected = i === safeCursor;
            const isExpanded = expanded.has(f.config.id);
            const usableCols = columns - BOX_OVERHEAD;
            const prefixCols = ROW_PREFIX_FIXED + f.config.name.length + f.config.id.length;
            const summaryMax = Math.max(SUMMARY_MIN_CHARS, usableCols - prefixCols);
            const summary = truncate(f.error.message.replace(/\s+/g, ' ').trim(), summaryMax);
            return (
              <Box key={f.config.id} flexDirection="column">
                <Text>
                  {isSelected
                    ? <Text color="#FBBF24">▶ </Text>
                    : <Text>  </Text>}
                  <Text color="#F87171">✗ </Text>
                  <Text bold>{f.config.name}</Text>
                  <Text dimColor> ({f.config.id}) </Text>
                  <Text color="#F87171">{summary}</Text>
                </Text>
                {isExpanded && (() => {
                  const tail = tailLines(f.stderrTail, STDERR_PREVIEW_LINES);
                  return (
                    <Box flexDirection="column" paddingLeft={4} marginTop={0} marginBottom={1}>
                      {tail.length === 0 ? (
                        <Text dimColor>(no stderr captured)</Text>
                      ) : (
                        <>
                          <Text dimColor>stderr (last {tail.length} {tail.length === 1 ? 'line' : 'lines'}):</Text>
                          {tail.map((line, j) => (
                            <Text key={String(j)} dimColor>{line}</Text>
                          ))}
                        </>
                      )}
                    </Box>
                  );
                })()}
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Config: {configPath}</Text>
        <Text dimColor>Tip: stdio MCP servers inherit uplnk's cwd. Use absolute paths in args.</Text>
        {msg !== null && <Text color="#60A5FA">{msg}</Text>}
      </Box>
    </Box>
  );
}
