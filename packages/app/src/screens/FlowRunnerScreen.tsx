/**
 * FlowRunnerScreen — show a flow executing step by step.
 *
 * Starts the flow on mount. Shows each step with a status icon and streams
 * the current chat step's LLM output live. Waits for a key after completion.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useFlowRunner } from '../hooks/useFlowRunner.js';
import type { LoadedFlow } from '../flow/loader.js';
import type { Config } from '../lib/config.js';
import type { StepStatus } from '../hooks/useFlowRunner.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function statusIcon(status: StepStatus, spinnerFrame: string): string {
  switch (status) {
    case 'pending':  return '○';
    case 'running':  return spinnerFrame;
    case 'done':     return '✓';
    case 'error':    return '✗';
    case 'skipped':  return '–';
    default:         return '?';
  }
}

function statusColor(status: StepStatus): string | undefined {
  switch (status) {
    case 'running': return '#60A5FA';
    case 'done':    return '#4ADE80';
    case 'error':   return '#F87171';
    case 'skipped': return undefined;
    default:        return undefined;
  }
}

interface Props {
  loadedFlow: LoadedFlow;
  inputs?: Record<string, unknown>;
  onDone: () => void;
  onBack: () => void;
  config: Config;
}

export function FlowRunnerScreen({ loadedFlow, inputs, onDone: _onDone, onBack, config }: Props) {
  const { state, load, run, cancel } = useFlowRunner(config);
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const didStart = useRef(false);

  // Load the flow on mount
  useEffect(() => {
    load(loadedFlow);
  }, [load, loadedFlow]);

  // Start the run once the flow is loaded (status transitions to 'idle')
  useEffect(() => {
    if (state.status === 'idle' && state.loadedFlow !== null && !didStart.current) {
      didStart.current = true;
      void run(inputs);
    }
  }, [state.status, state.loadedFlow, run, inputs]);

  // Spinner while running
  const isRunning = state.status === 'running';
  useEffect(() => {
    if (isRunning) {
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
  }, [isRunning]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      cancel();
      onBack();
      return;
    }
  });

  const spinner = SPINNER_FRAMES[frame] ?? '⠋';
  const flow = state.flow ?? loadedFlow.def;
  const steps = flow.steps;

  // Find the currently-streaming chat step
  const activeStepId = state.currentStepId;
  const activeStepStatus = activeStepId !== undefined && activeStepId !== null
    ? state.stepStatuses[activeStepId]
    : undefined;
  const streamText = activeStepStatus?.streamedText ?? '';

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>{flow.name}</Text>
        {flow.description !== undefined && (
          <Text dimColor>   {flow.description}</Text>
        )}
      </Box>

      {/* Step tree */}
      <Box flexDirection="column">
        {steps.map((step) => {
          const stepStatus = state.stepStatuses[step.id];
          const sstatus: StepStatus = stepStatus?.status ?? 'pending';
          const icon = statusIcon(sstatus, spinner);
          const color = statusColor(sstatus);
          const displayName = ('name' in step && step.name !== undefined) ? step.name : step.id;

          return (
            <Box key={step.id} flexDirection="column">
              {color !== undefined ? (
                <Text color={color}>
                  {icon} {displayName.padEnd(24)} <Text dimColor>[{step.type}]</Text>
                </Text>
              ) : (
                <Text>
                  {icon} {displayName.padEnd(24)} <Text dimColor>[{step.type}]</Text>
                </Text>
              )}
              {sstatus === 'error' && stepStatus?.error !== null && stepStatus?.error !== undefined && (
                <Text color="#F87171">   {stepStatus.error}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Live stream output for the current chat step */}
      {streamText !== '' && (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="#60A5FA" paddingX={1}>
          <Text dimColor>{activeStepId ?? 'output'}</Text>
          <Text>{streamText}</Text>
        </Box>
      )}

      {/* Running spinner line */}
      {state.status === 'running' && streamText === '' && (
        <Box marginTop={1}>
          <Text color="#60A5FA">{spinner} </Text>
          <Text dimColor>Running...</Text>
        </Box>
      )}

      {/* Error state */}
      {state.status === 'error' && state.error !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">Flow failed: {state.error}</Text>
        </Box>
      )}

      {/* Completed state — show outputs if available */}
      {state.status === 'done' && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#4ADE80">Flow complete.</Text>
          {state.output !== null && Object.keys(state.output).length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Outputs:</Text>
              {Object.entries(state.output).map(([k, v]) => (
                <Text key={k} dimColor>
                  {'  '}{k}: <Text>{String(v)}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {state.status === 'cancelled' && (
        <Box marginTop={1}>
          <Text color="yellow">Cancelled.</Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          {(state.status === 'done' || state.status === 'error' || state.status === 'cancelled')
            ? 'Esc back'
            : 'Esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}
