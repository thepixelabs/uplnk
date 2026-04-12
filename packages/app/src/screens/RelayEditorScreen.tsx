/**
 * RelayEditorScreen — 4-step wizard to create or edit a RelayPlan.
 *
 * Steps: name → scout → anchor → review.
 * Loads an existing plan when planId is provided (edit mode).
 * Calls saveRelay then onDone on final save.
 */

import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, listProviders } from '@uplnk/db';
import { loadRelay, saveRelay } from '../lib/workflows/persistence.js';
import type { RelayPlan, RelayPhaseConfig } from '../lib/workflows/planSchema.js';

interface Props {
  planId?: string;
  onDone: (plan: RelayPlan) => void;
  onCancel: () => void;
}

type EditorStep = 'name' | 'scout' | 'anchor' | 'review';
type PhaseSubStep = 'provider' | 'model' | 'prompt';

interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string | null;
  providerType: string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || `relay-${Date.now().toString(36)}`
  );
}

const DEFAULT_SCOUT_PROMPT =
  'Analyze the task below. Think through the approach step by step. Identify the key risk or complexity. Be concise.';

const DEFAULT_ANCHOR_PROMPT =
  'You are the final responder. Use the scout analysis above to produce a high-quality, actionable answer.';

function emptyPhase(): RelayPhaseConfig & { mcpEnabled?: boolean } {
  return {
    providerId: '',
    model: '',
    systemPrompt: '',
  };
}

function stepLabel(step: EditorStep): string {
  const map: Record<EditorStep, string> = {
    name: 'Step 1 of 4 — Name',
    scout: 'Step 2 of 4 — Scout',
    anchor: 'Step 3 of 4 — Anchor',
    review: 'Step 4 of 4 — Review',
  };
  return map[step];
}

function StepIndicator({ step }: { step: EditorStep }) {
  const order: EditorStep[] = ['name', 'scout', 'anchor', 'review'];
  const idx = order.indexOf(step);
  return (
    <Box marginTop={1}>
      {order.map((s, i) => (
        <Text key={s} {...(i === idx ? { color: '#60A5FA' as const } : { dimColor: true })}>
          {i <= idx ? '●' : '○'}{i < order.length - 1 ? '──' : ''}
        </Text>
      ))}
    </Box>
  );
}

// ── Name step ────────────────────────────────────────────────────────────────

function NameStep({
  value,
  onChange,
  onNext,
  onBack,
  isEdit,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
  isEdit: boolean;
}) {
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.return) { if (value.trim() !== '') onNext(); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (key.ctrl || key.meta) return;
    if (input.length === 1) onChange(value + input);
  });

  const derivedId = value.trim() !== '' ? slugify(value) : '';

  return (
    <Box flexDirection="column">
      <Text>{isEdit ? 'Relay name' : 'Give your relay a name'}</Text>
      <Box marginTop={1}>
        <Text>{'> '}<Text color="#60A5FA">{value}</Text>█</Text>
      </Box>
      {derivedId !== '' && (
        <Box marginTop={1}>
          <Text dimColor>id: {derivedId}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter continue  Esc cancel</Text>
      </Box>
    </Box>
  );
}

// ── Phase step (scout / anchor) ───────────────────────────────────────────────

function PhaseStep({
  phase,
  phaseName,
  phaseColor,
  defaultPrompt,
  mcpEnabled,
  onMcpToggle,
  onChange,
  onNext,
  onBack,
}: {
  phase: RelayPhaseConfig;
  phaseName: string;
  phaseColor: string;
  defaultPrompt: string;
  mcpEnabled?: boolean;
  onMcpToggle?: () => void;
  onChange: (updated: RelayPhaseConfig) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const [subStep, setSubStep] = useState<PhaseSubStep>('provider');
  const [providerCursor, setProviderCursor] = useState(0);
  const [providers, setProviders] = useState<ProviderRow[]>([]);

  useEffect(() => {
    try {
      const rows = listProviders(db) as ProviderRow[];
      setProviders(rows);
      // Pre-position cursor if a provider is already selected.
      if (phase.providerId !== '') {
        const idx = rows.findIndex((r) => r.id === phase.providerId);
        if (idx >= 0) setProviderCursor(idx);
      }
    } catch {
      setProviders([]);
    }
    // Only run on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (subStep === 'provider') {
        onBack();
      } else if (subStep === 'model') {
        setSubStep('provider');
      } else if (subStep === 'prompt') {
        setSubStep('model');
      }
      return;
    }

    if (subStep === 'provider') {
      if (key.upArrow) { setProviderCursor((c) => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setProviderCursor((c) => Math.min(Math.max(0, providers.length - 1), c + 1)); return; }
      if (key.return) {
        const selected = providers[providerCursor];
        if (selected !== undefined) {
          onChange({
            ...phase,
            providerId: selected.id,
            model: phase.model !== '' ? phase.model : (selected.defaultModel ?? ''),
          });
          setSubStep('model');
        }
        return;
      }
      return;
    }

    if (subStep === 'model') {
      if (key.return) {
        if (phase.model.trim() !== '') {
          // Pre-fill prompt if empty.
          if (phase.systemPrompt === '') {
            onChange({ ...phase, systemPrompt: defaultPrompt });
          }
          setSubStep('prompt');
        }
        return;
      }
      if (key.backspace || key.delete) {
        onChange({ ...phase, model: phase.model.slice(0, -1) });
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input.length === 1) {
        onChange({ ...phase, model: phase.model + input });
      }
      return;
    }

    if (subStep === 'prompt') {
      if (key.return && (key.ctrl || key.meta)) {
        // Ctrl+Enter advances without requiring a non-empty prompt.
        onNext();
        return;
      }
      if (key.return) {
        // Plain Enter adds a newline in the prompt.
        onChange({ ...phase, systemPrompt: phase.systemPrompt + '\n' });
        return;
      }
      if (key.backspace || key.delete) {
        onChange({ ...phase, systemPrompt: phase.systemPrompt.slice(0, -1) });
        return;
      }
      if (!key.ctrl && !key.meta) {
        if (input === '\t') {
          // Tab = advance step.
          onNext();
          return;
        }
        // 't' toggles MCP when the toggle is available (anchor phase only).
        if (input === 't' && onMcpToggle !== undefined) {
          onMcpToggle();
          return;
        }
        if (input.length === 1) {
          onChange({ ...phase, systemPrompt: phase.systemPrompt + input });
          return;
        }
      }
      return;
    }
  });

  const selectedProvider = providers.find((p) => p.id === phase.providerId);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={phaseColor}>{phaseName} phase</Text>
        {mcpEnabled !== undefined && (
          <Text dimColor>   MCP: <Text {...(mcpEnabled ? { color: '#4ADE80' as const } : {})}>{mcpEnabled ? 'on' : 'off'}</Text>
            {onMcpToggle !== undefined ? <Text dimColor>  (t toggle)</Text> : null}
          </Text>
        )}
      </Text>

      {subStep === 'provider' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Select a provider:</Text>
          {providers.length === 0 && (
            <Box marginTop={1}>
              <Text dimColor>No providers configured. Add one first via /provider.</Text>
            </Box>
          )}
          {providers.map((p, i) => {
            const isCursor = i === providerCursor;
            return (
              <Box key={p.id}>
                <Text {...(isCursor ? { color: '#60A5FA' as const } : {})}>
                  {isCursor ? '▶ ' : '  '}
                  <Text bold={isCursor}>{p.name.padEnd(28)}</Text>
                  {'  '}
                  <Text dimColor>{p.baseUrl.slice(0, 32)}</Text>
                </Text>
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text dimColor>↑↓ navigate  Enter select  Esc back</Text>
          </Box>
        </Box>
      )}

      {subStep === 'model' && (
        <Box marginTop={1} flexDirection="column">
          {selectedProvider !== undefined && (
            <Text dimColor>Provider: <Text color="#60A5FA">{selectedProvider.name}</Text></Text>
          )}
          <Text>Model:</Text>
          <Box marginTop={1}>
            <Text>{'> '}<Text color="#60A5FA">{phase.model}</Text>█</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Enter continue  Esc back</Text>
          </Box>
        </Box>
      )}

      {subStep === 'prompt' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>System prompt (Tab to continue, Enter for newline):</Text>
          <Box marginTop={1} borderStyle="single" borderColor="#334155" paddingX={1}>
            <Text>{phase.systemPrompt !== '' ? phase.systemPrompt : <Text dimColor>{defaultPrompt}</Text>}█</Text>
          </Box>
          {onMcpToggle !== undefined && mcpEnabled !== undefined && (
            <Box marginTop={1}>
              <Text dimColor>
                MCP: <Text {...(mcpEnabled ? { color: '#4ADE80' as const } : {})}>{mcpEnabled ? 'enabled' : 'disabled'}</Text>
                {'   t toggle'}
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Tab continue  Esc back</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

// Special wrapper for anchor that handles 't' toggle inside its own useInput
function AnchorPhaseStep({
  phase,
  mcpEnabled,
  onMcpToggle,
  onChange,
  onNext,
  onBack,
}: {
  phase: RelayPhaseConfig;
  mcpEnabled: boolean;
  onMcpToggle: () => void;
  onChange: (updated: RelayPhaseConfig) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <PhaseStep
      phase={phase}
      phaseName="Anchor"
      phaseColor="#A78BFA"
      defaultPrompt={DEFAULT_ANCHOR_PROMPT}
      mcpEnabled={mcpEnabled}
      onMcpToggle={onMcpToggle}
      onChange={onChange}
      onNext={onNext}
      onBack={onBack}
    />
  );
}

// ── Review step ───────────────────────────────────────────────────────────────

function ReviewStep({
  plan,
  mcpEnabled,
  onSave,
  onBack,
}: {
  plan: Omit<RelayPlan, 'anchor'> & { anchor: RelayPhaseConfig & { mcpEnabled: boolean } };
  mcpEnabled: boolean;
  onSave: () => void;
  onBack: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (input === 's' || input === 'S') { onSave(); return; }
  });

  return (
    <Box flexDirection="column">
      <Text>Review your relay</Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>{'Name    '}</Text>
          <Text color="#60A5FA">{plan.name}</Text>
        </Box>
        <Box>
          <Text dimColor>{'id      '}</Text>
          <Text dimColor>{plan.id}</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold color="#60A5FA">Scout</Text>
        </Box>
        <Box>
          <Text dimColor>{'  provider  '}</Text>
          <Text>{plan.scout.providerId}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  model     '}</Text>
          <Text>{plan.scout.model}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  prompt    '}</Text>
          <Text>{plan.scout.systemPrompt.slice(0, 60)}{plan.scout.systemPrompt.length > 60 ? '…' : ''}</Text>
        </Box>

        <Box marginTop={1}>
          <Text bold color="#A78BFA">Anchor</Text>
        </Box>
        <Box>
          <Text dimColor>{'  provider  '}</Text>
          <Text>{plan.anchor.providerId}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  model     '}</Text>
          <Text>{plan.anchor.model}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  prompt    '}</Text>
          <Text>{plan.anchor.systemPrompt.slice(0, 60)}{plan.anchor.systemPrompt.length > 60 ? '…' : ''}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  mcp       '}</Text>
          <Text {...(mcpEnabled ? { color: '#4ADE80' as const } : {})}>{mcpEnabled ? 'enabled' : 'disabled'}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>s save  Esc back</Text>
      </Box>
    </Box>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export function RelayEditorScreen({ planId, onDone, onCancel }: Props) {
  const isEdit = planId !== undefined;

  const [step, setStep] = useState<EditorStep>('name');
  const [planName, setPlanName] = useState('');
  const [scout, setScout] = useState<RelayPhaseConfig>(emptyPhase());
  const [anchor, setAnchor] = useState<RelayPhaseConfig>(emptyPhase());
  const [mcpEnabled, setMcpEnabled] = useState(true);

  // Load existing plan in edit mode.
  useEffect(() => {
    if (planId === undefined) return;
    try {
      const existing = loadRelay(planId);
      setPlanName(existing.name);
      setScout({
        providerId: existing.scout.providerId,
        model: existing.scout.model,
        systemPrompt: existing.scout.systemPrompt,
        maxOutputTokens: existing.scout.maxOutputTokens,
        temperature: existing.scout.temperature,
      });
      setAnchor({
        providerId: existing.anchor.providerId,
        model: existing.anchor.model,
        systemPrompt: existing.anchor.systemPrompt,
        maxOutputTokens: existing.anchor.maxOutputTokens,
        temperature: existing.anchor.temperature,
      });
      setMcpEnabled(existing.anchor.mcpEnabled);
    } catch {
      // If load fails, fall through to create-new flow with blank state.
    }
  }, [planId]);

  const buildPlan = (): RelayPlan => ({
    version: 1,
    id: planId ?? slugify(planName),
    name: planName,
    scout,
    anchor: { ...anchor, mcpEnabled },
  });

  const handleSave = (): void => {
    const plan = buildPlan();
    saveRelay(plan);
    onDone(plan);
  };

  const title = isEdit ? `Edit Relay: ${planName}` : 'New Relay';

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>{title}</Text>
        <Text dimColor>   {stepLabel(step)}  ·  Esc back</Text>
      </Box>
      <StepIndicator step={step} />
      <Box marginTop={1} flexDirection="column">
        {step === 'name' && (
          <NameStep
            value={planName}
            onChange={setPlanName}
            onNext={() => { if (planName.trim() !== '') setStep('scout'); }}
            onBack={onCancel}
            isEdit={isEdit}
          />
        )}

        {step === 'scout' && (
          <PhaseStep
            phase={scout}
            phaseName="Scout"
            phaseColor="#60A5FA"
            defaultPrompt={DEFAULT_SCOUT_PROMPT}
            onChange={setScout}
            onNext={() => setStep('anchor')}
            onBack={() => setStep('name')}
          />
        )}

        {step === 'anchor' && (
          <AnchorPhaseStep
            phase={anchor}
            mcpEnabled={mcpEnabled}
            onMcpToggle={() => setMcpEnabled((v) => !v)}
            onChange={setAnchor}
            onNext={() => setStep('review')}
            onBack={() => setStep('scout')}
          />
        )}

        {step === 'review' && (
          <ReviewStep
            plan={buildPlan()}
            mcpEnabled={mcpEnabled}
            onSave={handleSave}
            onBack={() => setStep('anchor')}
          />
        )}
      </Box>
    </Box>
  );
}
