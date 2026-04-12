/**
 * RelayPickerScreen — browse saved relay plans and launch or manage them.
 *
 * Shows the list of saved RelayPlans. The user selects a plan with ↑↓ + Enter
 * which opens an inline task-input prompt; a second Enter submits. Also
 * supports creating (n), editing (e), and deleting (d) plans.
 */

import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { listRelays, deleteRelay } from '../lib/workflows/persistence.js';
import type { RelayPlan } from '../lib/workflows/planSchema.js';

interface Props {
  onRunRelay: (plan: RelayPlan, input: string) => void;
  onEdit: (planId: string) => void;
  onNew: () => void;
  onBack: () => void;
}

type PickerMode = 'list' | 'task-input' | 'delete-confirm';

function loadRelays(): RelayPlan[] {
  try {
    return listRelays();
  } catch {
    return [];
  }
}

function relaySubtitle(plan: RelayPlan): string {
  const scoutModel = plan.scout.model.slice(0, 18);
  const anchorModel = plan.anchor.model.slice(0, 18);
  return `${scoutModel} → ${anchorModel}`;
}

export function RelayPickerScreen({ onRunRelay, onEdit, onNew, onBack }: Props) {
  const [relays, setRelays] = useState<RelayPlan[]>(() => loadRelays());
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<PickerMode>('list');
  const [taskInput, setTaskInput] = useState('');

  const clampedCursor = relays.length === 0 ? 0 : Math.min(cursor, relays.length - 1);
  const selectedPlan = relays[clampedCursor];

  const reload = (): void => {
    const fresh = loadRelays();
    setRelays(fresh);
    setCursor((c) => (fresh.length === 0 ? 0 : Math.min(c, fresh.length - 1)));
  };

  useInput((input, key) => {
    if (mode === 'delete-confirm') {
      if (input === 'y' || input === 'Y') {
        if (selectedPlan !== undefined) {
          try { deleteRelay(selectedPlan.id); } catch { /* best-effort */ }
          reload();
        }
        setMode('list');
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setMode('list');
        return;
      }
      return;
    }

    if (mode === 'task-input') {
      if (key.escape) {
        setMode('list');
        setTaskInput('');
        return;
      }
      if (key.return) {
        if (taskInput.trim() !== '' && selectedPlan !== undefined) {
          onRunRelay(selectedPlan, taskInput.trim());
        }
        return;
      }
      if (key.backspace || key.delete) {
        setTaskInput((t) => t.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input.length === 1) {
        setTaskInput((t) => t + input);
      }
      return;
    }

    // mode === 'list'
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, relays.length - 1), c + 1));
      return;
    }
    if (key.return) {
      if (selectedPlan !== undefined) {
        setMode('task-input');
        setTaskInput('');
      }
      return;
    }
    if (input === 'n') {
      onNew();
      return;
    }
    if (input === 'e') {
      if (selectedPlan !== undefined) onEdit(selectedPlan.id);
      return;
    }
    if (input === 'd') {
      if (selectedPlan !== undefined) setMode('delete-confirm');
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>My Relays</Text>
        <Text dimColor>   n new  e edit  d delete  Esc back</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {relays.length === 0 && (
          <Text dimColor>No relays yet. Press 'n' to create your first relay.</Text>
        )}

        {relays.map((plan, i) => {
          const isCursor = i === clampedCursor;
          return (
            <Box key={plan.id}>
              <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                {isCursor ? '▶ ' : '  '}
                <Text bold={isCursor}>{plan.name.slice(0, 30).padEnd(30)}</Text>
                {'  '}
                <Text dimColor>{relaySubtitle(plan)}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>

      {mode === 'delete-confirm' && selectedPlan !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Delete "{selectedPlan.name}"? (y/n)</Text>
        </Box>
      )}

      {mode === 'task-input' && selectedPlan !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Task: enter your task and press Enter</Text>
          <Box>
            <Text color="#60A5FA">{'❯ '}</Text>
            <Text>{taskInput}</Text>
            <Text>█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter run  Esc cancel</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
