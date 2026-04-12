/**
 * NetworkScanScreen — discover local AI servers and add them as providers.
 *
 * Immediately starts a network scan on mount using useNetworkScan. Shows
 * discovered servers as they stream in; the user can add individual servers
 * (Enter) or all at once (a). Press r to rescan, Esc to cancel and go back.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, upsertProviderConfig } from '@uplnk/db';
import type { DiscoveredServer } from '../lib/networkScanner.js';
import { useNetworkScan } from '../hooks/useNetworkScan.js';

interface Props {
  onBack: () => void;
  scope?: 'localhost' | 'subnet';
  /**
   * ISO timestamp from config.networkScanner.subnetConfirmedAt.
   * When present and the user presses 'r' to rescan, subnet scope is
   * offered automatically without re-confirming via the CLI flag.
   */
  subnetConfirmedAt?: string;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const PROVIDER_KIND_LABELS: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  vllm: 'vLLM',
  llamacpp: 'llama.cpp',
  localai: 'LocalAI',
  openwebui: 'OpenWebUI',
};

const KIND_TO_PROVIDER_TYPE: Record<string, string> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  vllm: 'vllm',
  llamacpp: 'llama-cpp',
  localai: 'localai',
  openwebui: 'openai-compatible',
};

function serverKindToProviderType(kind: string): string {
  return KIND_TO_PROVIDER_TYPE[kind] ?? 'openai-compatible';
}

function addServer(server: DiscoveredServer): void {
  upsertProviderConfig(db, {
    id: server.id,
    name: `${PROVIDER_KIND_LABELS[server.kind] ?? server.kind} at ${server.host}`,
    providerType: serverKindToProviderType(server.kind),
    baseUrl: server.url,
    apiKey: server.kind === 'ollama' ? 'ollama' : null,
    defaultModel: server.models[0] ?? null,
    isDefault: false,
    authMode: 'none',
  });
}

function truncateModel(models: string[]): string {
  if (models.length === 0) return '—';
  const first = (models[0] ?? '').slice(0, 16);
  if (models.length === 1) return first;
  return `${first} +${String(models.length - 1)}`;
}

export function NetworkScanScreen({ onBack, scope, subnetConfirmedAt }: Props) {
  const { servers, status, hostsProbed, totalHosts, errorMessage, startScan, cancelScan, reset } =
    useNetworkScan();

  const [cursor, setCursor] = useState(0);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [frame, setFrame] = useState(0);

  // Spinner animation — only while scanning.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (status === 'scanning') {
      intervalRef.current = setInterval(() => {
        setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
      }, 100);
    } else {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [status]);

  // Kick off the scan on mount.
  useEffect(() => {
    startScan(scope ?? 'localhost');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep cursor in range as servers stream in.
  useEffect(() => {
    if (servers.length > 0) {
      setCursor((c) => Math.min(c, servers.length - 1));
    }
  }, [servers.length]);

  useInput((input, key) => {
    if (key.escape) {
      cancelScan();
      onBack();
      return;
    }

    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, servers.length - 1), c + 1));
      return;
    }

    if (key.return) {
      const server = servers[cursor];
      if (server !== undefined && !added.has(server.id)) {
        addServer(server);
        setAdded((prev) => new Set([...prev, server.id]));
      }
      return;
    }

    if (input === 'a') {
      const newAdded = new Set(added);
      for (const server of servers) {
        if (!newAdded.has(server.id)) {
          addServer(server);
          newAdded.add(server.id);
        }
      }
      setAdded(newAdded);
      return;
    }

    if (input === 'r') {
      reset();
      setAdded(new Set());
      setCursor(0);
      // If the user has confirmed subnet scanning and no explicit scope was
      // passed in, upgrade to subnet on rescan.
      const rescanScope =
        scope ?? (subnetConfirmedAt !== undefined ? 'subnet' : 'localhost');
      startScan(rescanScope);
      return;
    }
  });

  const spinner = SPINNER_FRAMES[frame] ?? '⠋';
  const isScanning = status === 'scanning';

  const statusText = (): string => {
    if (status === 'scanning') {
      return totalHosts > 0
        ? `scanning… ${spinner}  ${String(hostsProbed)}/${String(totalHosts)}`
        : `scanning… ${spinner}`;
    }
    if (status === 'done') return `${String(servers.length)} found`;
    if (status === 'cancelled') return 'cancelled';
    if (status === 'error') return 'error';
    return 'idle';
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>Network Scanner</Text>
        <Text>{'   '}</Text>
        {isScanning ? (
          <Text color="#60A5FA">{statusText()}</Text>
        ) : (
          <Text dimColor>{statusText()}</Text>
        )}
      </Box>

      {status === 'error' && errorMessage !== null && (
        <Box marginTop={1}>
          <Text color="red">Error: {errorMessage}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        {servers.length === 0 && isScanning && (
          <Text dimColor>Probing hosts…</Text>
        )}
        {servers.length === 0 && !isScanning && status !== 'error' && (
          <Text dimColor>No servers found. Press r to rescan with a broader scope.</Text>
        )}

        {servers.map((server, i) => {
          const isCursor = i === cursor;
          const isAdded = added.has(server.id);
          const kindLabel = (PROVIDER_KIND_LABELS[server.kind] ?? server.kind).padEnd(12);
          const hostPort = `${server.host}:${String(server.port)}`.padEnd(24);
          const models = truncateModel(server.models).padEnd(20);
          const latency = `${String(server.latencyMs)}ms`.padStart(6);

          return (
            <Box key={server.id}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold={isCursor}>{hostPort}</Text>
                {'  '}
                <Text>{kindLabel}</Text>
                {'  '}
                <Text dimColor>{models}</Text>
                {'  '}
                <Text dimColor>{latency}</Text>
                {'  '}
                {isAdded ? <Text color="#4ADE80">✓</Text> : <Text>{'  '}</Text>}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Enter add  ↑↓ navigate  a add-all  r rescan  Esc back</Text>
      </Box>
    </Box>
  );
}
