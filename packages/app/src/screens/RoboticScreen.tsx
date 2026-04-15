import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Config } from '../lib/config.js';
import { useRobotic } from '../hooks/useRobotic.js';
import { getAvailableTmuxPanes } from '../robotic/transport/detect.js';
import { BUILTIN_TARGETS } from '../robotic/targets/Target.js';

interface Props {
  onBack: () => void;
  config: Config;
}

// ---------------------------------------------------------------------------
// Simple inline text field (avoids ink-text-input dependency, matches
// the cursor-field pattern used in AddProviderScreen)
// ---------------------------------------------------------------------------

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  focused: boolean;
  placeholder?: string;
}

function TextField({ label, value, onChange, onSubmit, focused, placeholder }: TextFieldProps) {
  useInput(
    (input, key) => {
      if (!focused) return;
      if (key.return) { onSubmit(); return; }
      if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input.length > 0) { onChange(value + input); }
    },
    { isActive: focused },
  );

  const display = value.length > 0 ? value : (placeholder ?? '');
  const color = value.length > 0 ? 'white' : 'gray';

  return (
    <Box>
      <Text color="gray">{label}: </Text>
      <Text color={color}>{display}</Text>
      {focused && <Text color="cyan">_</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Setup form
// ---------------------------------------------------------------------------

interface SetupFormProps {
  config: Config;
  onStart: (opts: { target: string; goal: string; pane?: string }) => void;
  onBack: () => void;
}

const TARGET_NAMES = Object.keys(BUILTIN_TARGETS);

function SetupForm({ config, onStart, onBack }: SetupFormProps) {
  const [goal, setGoal] = useState('');
  const [targetIdx, setTargetIdx] = useState(0);
  const [pane, setPane] = useState('');
  const [focusedField, setFocusedField] = useState<'goal' | 'pane'>('goal');
  const [availablePanes, setAvailablePanes] = useState<string[]>([]);

  // Pre-fill with default target from config if set
  const defaultTargetName = config.robotic?.defaultTarget;
  useEffect(() => {
    if (defaultTargetName !== undefined) {
      const idx = TARGET_NAMES.indexOf(defaultTargetName);
      if (idx !== -1) setTargetIdx(idx);
    }
    // Populate available pane list when inside tmux
    if (process.env['TMUX']) {
      setAvailablePanes(getAvailableTmuxPanes());
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTarget = TARGET_NAMES[targetIdx] ?? 'claude-code';

  useInput((_input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.tab) {
      setFocusedField((f) => f === 'goal' ? 'pane' : 'goal');
      return;
    }
    // Cycle targets with left/right arrows
    if (key.leftArrow) {
      setTargetIdx((i) => (i - 1 + TARGET_NAMES.length) % TARGET_NAMES.length);
      return;
    }
    if (key.rightArrow) {
      setTargetIdx((i) => (i + 1) % TARGET_NAMES.length);
      return;
    }
  });

  const handleSubmit = useCallback(() => {
    if (goal.trim().length === 0) return;
    onStart({
      target: selectedTarget,
      goal: goal.trim(),
      ...(pane.trim().length > 0 ? { pane: pane.trim() } : {}),
    });
  }, [goal, selectedTarget, pane, onStart]);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">Robotic Mode</Text>
        <Text color="gray"> — AI-to-AI autonomous orchestration</Text>
      </Box>

      {/* Target selector */}
      <Box marginBottom={1}>
        <Text color="gray">Target: </Text>
        <Text color="gray">[</Text>
        <Text color="cyan" bold>{selectedTarget}</Text>
        <Text color="gray">]</Text>
        <Text color="gray" dimColor>  left/right to change</Text>
      </Box>

      {/* Goal input */}
      <TextField
        label="Goal"
        value={goal}
        onChange={setGoal}
        onSubmit={handleSubmit}
        focused={focusedField === 'goal'}
        placeholder="e.g. implement a FastAPI server with JWT auth"
      />

      {/* Pane input (tmux only) */}
      {process.env['TMUX'] && (
        <Box marginTop={1} flexDirection="column">
          <TextField
            label="Tmux pane"
            value={pane}
            onChange={setPane}
            onSubmit={handleSubmit}
            focused={focusedField === 'pane'}
            placeholder="e.g. %1 or main:0.1 (leave blank for auto)"
          />
          {availablePanes.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color="gray" dimColor>Available panes:</Text>
              {availablePanes.slice(0, 6).map((p) => (
                <Text key={p} color="gray" dimColor>  {p}</Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">Tab to switch fields  Enter to start  Esc to cancel</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Running view — split pane
// ---------------------------------------------------------------------------

interface RunningViewProps {
  state: ReturnType<typeof useRobotic>['state'];
  onAbort: () => void;
  onBack: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  done: 'cyan',
  error: 'red',
  connecting: 'yellow',
  paused: 'yellow',
  idle: 'gray',
};

function RunningView({ state, onAbort, onBack }: RunningViewProps) {
  useInput((input, key) => {
    if (key.escape) {
      if (state.status === 'done' || state.status === 'idle' || state.status === 'error') {
        onBack();
      } else {
        onAbort();
      }
    }
    if (input === 'a' && (state.status === 'running' || state.status === 'paused')) {
      onAbort();
    }
  });

  const outboundTurns = state.turns.filter((t) => t.direction === 'uplnk->target');
  const inboundTurns = state.turns.filter((t) => t.direction === 'target->uplnk');
  const statusColor = STATUS_COLORS[state.status] ?? 'white';
  const progressPct = Math.round(state.goalProgress * 100);

  return (
    <Box flexDirection="column">
      {/* Header bar */}
      <Box paddingX={1} marginBottom={1}>
        <Text bold color="magenta">Robotic Mode</Text>
        <Text color="gray"> — {state.target} — </Text>
        <Text color={statusColor} bold>{state.status.toUpperCase()}</Text>
        <Text color="gray"> — progress: {progressPct}%</Text>
      </Box>

      {/* Goal */}
      <Box paddingX={1} marginBottom={1}>
        <Text color="gray">Goal: </Text>
        <Text>{state.goal.slice(0, 120)}</Text>
      </Box>

      {/* Split pane */}
      <Box flexDirection="row" gap={1}>
        {/* Left — uplnk instructions */}
        <Box flexDirection="column" width="50%">
          <Text bold color="blue" underline>uplnk instructions</Text>
          {outboundTurns.length === 0 && (
            <Text color="gray" dimColor>Waiting...</Text>
          )}
          {outboundTurns.slice(-4).map((t, i) => (
            <Box key={i} marginTop={1} flexDirection="column">
              <Text color="blue" dimColor>turn {t.turn}:</Text>
              <Text wrap="wrap">{t.content.slice(0, 180)}</Text>
            </Box>
          ))}
        </Box>

        {/* Right — target responses */}
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="green" underline>{state.target} output</Text>
          {inboundTurns.length === 0 && (
            <Text color="gray" dimColor>Waiting for response...</Text>
          )}
          {inboundTurns.slice(-3).map((t, i) => (
            <Box key={i} marginTop={1} flexDirection="column">
              <Text color="green" dimColor>response {t.turn}:</Text>
              <Text wrap="wrap">{t.content.slice(0, 280)}</Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Error */}
      {state.error !== undefined && state.status === 'error' && (
        <Box marginTop={1} paddingX={1}>
          <Text color="red">Error: {state.error}</Text>
        </Box>
      )}

      {/* Success */}
      {state.status === 'done' && (
        <Box marginTop={1} paddingX={1}>
          <Text color="green" bold>
            Goal achieved in {Math.ceil(state.turns.length / 2)} turns!
          </Text>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} paddingX={1}>
        {state.status === 'running' && (
          <Text color="gray">[a] abort  [Esc] abort + back</Text>
        )}
        {(state.status === 'done' || state.status === 'error' || state.status === 'idle') && (
          <Text color="gray">[Esc] back</Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function RoboticScreen({ onBack, config }: Props) {
  const { state, start, abort } = useRobotic(config);
  const [setupMode, setSetupMode] = useState(true);
  const roboticEnabled = config.robotic?.enabled === true;

  // Always call useInput unconditionally (hooks cannot be conditional)
  useInput((_, key) => {
    if (!roboticEnabled && key.escape) onBack();
  }, { isActive: !roboticEnabled });

  // Guard: feature flag
  if (!roboticEnabled) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Robotic Mode is disabled</Text>
        <Text color="gray">
          Enable it in ~/.uplnk/config.json:
        </Text>
        <Text>{'  "robotic": { "enabled": true }'}</Text>
        <Box marginTop={1}><Text color="gray">Press Esc to go back</Text></Box>
      </Box>
    );
  }

  if (setupMode && state.status === 'idle') {
    return (
      <SetupForm
        config={config}
        onBack={onBack}
        onStart={(opts) => {
          setSetupMode(false);
          void start(opts);
        }}
      />
    );
  }

  return (
    <RunningView
      state={state}
      onAbort={abort}
      onBack={() => {
        setSetupMode(true);
        onBack();
      }}
    />
  );
}
