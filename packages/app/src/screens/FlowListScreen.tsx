/**
 * FlowListScreen — browse flows in ~/.uplnk/flows/ and launch one.
 *
 * Arrow keys navigate, Enter selects, Esc goes back.
 */

import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { listFlows, getFlowsDir } from '../flow/loader.js';
import type { LoadedFlow } from '../flow/loader.js';
import type { FlowDef } from '../flow/schema.js';
import type { Config } from '../lib/config.js';

interface Props {
  onBack: () => void;
  onRun: (flow: FlowDef, loadedFlow: LoadedFlow) => void;
  config: Config;
}

function loadFlowList(dir: string): { flows: LoadedFlow[]; error?: string } {
  try {
    return { flows: listFlows(dir) };
  } catch (err) {
    return { flows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function FlowListScreen({ onBack, onRun, config }: Props) {
  const flowsDir = getFlowsDir(config.flows.dir);
  const [flows, setFlows] = useState<LoadedFlow[]>(() => loadFlowList(flowsDir).flows);
  const [cursor, setCursor] = useState(0);
  const [loadError, setLoadError] = useState<string | undefined>();

  // Reload when the screen is shown — picks up any files added since last time
  useEffect(() => {
    const result = loadFlowList(flowsDir);
    setFlows(result.flows);
    setLoadError(result.error);
    setCursor((c) => (result.flows.length === 0 ? 0 : Math.min(c, result.flows.length - 1)));
  }, [flowsDir]);

  const clampedCursor = flows.length === 0 ? 0 : Math.min(cursor, flows.length - 1);
  const selected = flows[clampedCursor];

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, flows.length - 1), c + 1));
      return;
    }
    if (key.return) {
      if (selected !== undefined) {
        onRun(selected.def, selected);
      }
      return;
    }
    if (input === 'r') {
      // Manual reload
      const result = loadFlowList(flowsDir);
      setFlows(result.flows);
      setLoadError(result.error);
      return;
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Flows</Text>
        <Text color="gray">   {flowsDir}</Text>
      </Box>

      {loadError !== undefined && (
        <Box marginBottom={1}>
          <Text color="red">Error loading flows: {loadError}</Text>
        </Box>
      )}

      {/* Flow list */}
      <Box flexDirection="column">
        {flows.length === 0 && (
          <Box flexDirection="column">
            <Text dimColor>No flows found.</Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Create a YAML or JSON file in:</Text>
              <Text color="yellow">  {flowsDir}</Text>
              <Box marginTop={1}>
                <Text dimColor>Example flow (</Text>
                <Text color="yellow">~/.uplnk/flows/hello.yaml</Text>
                <Text dimColor>):</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text dimColor>  apiVersion: uplnk.io/v1</Text>
                <Text dimColor>  name: hello-world</Text>
                <Text dimColor>  steps:</Text>
                <Text dimColor>    - id: greet</Text>
                <Text dimColor>      type: chat</Text>
                <Text dimColor>      prompt: "Say hello in a creative way"</Text>
              </Box>
            </Box>
          </Box>
        )}

        {flows.map((loaded, i) => {
          const isCursor = i === clampedCursor;
          const { def } = loaded;
          return (
            <Box key={def.name}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold={isCursor}>{def.name.slice(0, 28).padEnd(28)}</Text>
                {'  '}
                <Text dimColor>
                  {def.steps.length} step{def.steps.length !== 1 ? 's' : ''}
                  {def.description !== undefined ? `  ${def.description.slice(0, 40)}` : ''}
                </Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color="gray">[↑↓] navigate  [Enter] run  [r] reload  [Esc] back</Text>
      </Box>
    </Box>
  );
}
