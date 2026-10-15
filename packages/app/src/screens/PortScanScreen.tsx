/**
 * PortScanScreen — discover local model servers by scanning common ports.
 *
 * Leaf screen: receives `onSelect(endpoint)` and `onCancel()` from the caller
 * (typically Add-Provider flow or command palette). Streams results live by
 * driving `scanLocalEndpointsStreaming` and pushing into local state.
 *
 * Cancellation: Esc aborts the in-flight scan via an AbortController and
 * fires `onCancel`. The scan also aborts on unmount.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  scanLocalEndpointsStreaming,
  type DiscoveredEndpoint,
  type ScanOptions,
} from '../lib/portScan.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

interface Props {
  /** Called with the highlighted endpoint when the user presses Enter. */
  onSelect: (endpoint: DiscoveredEndpoint) => void;
  /** Called when the user presses Esc (also aborts the scan). */
  onCancel: () => void;
  /** Forwarded to `scanLocalEndpointsStreaming` — primarily for testing. */
  scanOptions?: ScanOptions;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const KIND_LABELS: Record<DiscoveredEndpoint['kind'], string> = {
  'openai-compat': 'OpenAI-compat',
  ollama: 'Ollama',
  'llama-cpp': 'llama.cpp',
  unknown: 'unknown',
};

const INSTALL_HINTS: readonly string[] = [
  'Ollama:     brew install ollama  &&  ollama serve',
  'LM Studio:  download from lmstudio.ai, enable local server',
  'vLLM:       pip install vllm  &&  vllm serve <model>',
  'llama.cpp:  brew install llama.cpp  &&  llama-server -m <model>',
];

function rowText(ep: DiscoveredEndpoint): string {
  // Compact one-line row — caller already pads with cursor glyph.
  const port = String(ep.port).padEnd(6);
  const kind = (KIND_LABELS[ep.kind] ?? ep.kind).padEnd(14);
  const count = `${String(ep.models.length)} models`.padEnd(11);
  const latency = `${String(ep.latencyMs)}ms`.padStart(6);
  return `${port}  ${kind}  ${count}  ${latency}`;
}

export function PortScanScreen({ onSelect, onCancel, scanOptions }: Props) {
  const [endpoints, setEndpoints] = useState<DiscoveredEndpoint[]>([]);
  const [status, setStatus] = useState<'scanning' | 'done' | 'cancelled'>('scanning');
  const [cursor, setCursor] = useState(0);
  const [frame, setFrame] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const { columns } = useTerminalSize();

  // Spinner — only while scanning.
  useEffect(() => {
    if (status !== 'scanning') return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 100);
    return () => clearInterval(t);
  }, [status]);

  // Drive the scan once on mount.
  useEffect(() => {
    const ctrl = new AbortController();
    controllerRef.current = ctrl;

    let cancelled = false;

    (async () => {
      try {
        for await (const ep of scanLocalEndpointsStreaming({
          ...scanOptions,
          signal: ctrl.signal,
        })) {
          if (cancelled) return;
          setEndpoints((prev) => {
            // Insert sorted by port so the list is stable as results trickle in.
            const next = [...prev, ep];
            next.sort((a, b) => a.port - b.port);
            return next;
          });
        }
      } finally {
        if (!cancelled && !ctrl.signal.aborted) {
          setStatus('done');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!ctrl.signal.aborted) ctrl.abort();
    };
    // scanOptions intentionally not in deps — caller passes a stable value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep cursor in range as the list grows.
  useEffect(() => {
    if (endpoints.length > 0 && cursor >= endpoints.length) {
      setCursor(endpoints.length - 1);
    }
  }, [endpoints.length, cursor]);

  useInput((_, key) => {
    if (key.escape) {
      const ctrl = controllerRef.current;
      if (ctrl !== null && !ctrl.signal.aborted) ctrl.abort();
      setStatus('cancelled');
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, endpoints.length - 1), c + 1));
      return;
    }
    if (key.return) {
      const ep = endpoints[cursor];
      if (ep !== undefined) onSelect(ep);
    }
  });

  const spinner = SPINNER_FRAMES[frame] ?? '⠋';
  const isScanning = status === 'scanning';
  // Narrow terminal: drop padding indentation but keep all content.
  const isNarrow = columns < 60;

  return (
    <Box flexDirection="column" padding={isNarrow ? 0 : 1}>
      <Box>
        <Text bold>Port Scan</Text>
        <Text>{'   '}</Text>
        {isScanning ? (
          <Text color="#60A5FA">
            scanning… {spinner}  {String(endpoints.length)} found
          </Text>
        ) : (
          <Text dimColor>
            {status === 'cancelled' ? 'cancelled' : 'done'} — {String(endpoints.length)} endpoint
            {endpoints.length === 1 ? '' : 's'}
          </Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {endpoints.length === 0 && isScanning && (
          <Text dimColor>Probing localhost…</Text>
        )}

        {endpoints.length === 0 && !isScanning && (
          <Box flexDirection="column">
            <Text>No local model servers detected.</Text>
            <Box marginTop={1} flexDirection="column">
              {INSTALL_HINTS.map((hint) => (
                <Text key={hint} dimColor>
                  {'  '}
                  {hint}
                </Text>
              ))}
            </Box>
          </Box>
        )}

        {endpoints.map((ep, i) => {
          const isCursor = i === cursor;
          return (
            <Box key={ep.url}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold={isCursor}>{rowText(ep)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter use  ↑↓ navigate  Esc cancel</Text>
      </Box>
    </Box>
  );
}
