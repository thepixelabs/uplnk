import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { db, upsertProviderConfig, setDefaultProvider, recordProviderTest } from '@uplnk/db';
import type { AuthMode, ProviderConfig as PyProviderConfig, ProviderKind } from '@uplnk/providers';
import { makeProvider, PROVIDER_KIND_OPTIONS, ProviderError } from '@uplnk/providers';
import { migratePlaintext, isSecretRef, getSecretsBackend } from '../lib/secrets.js';

interface Props {
  onDone: () => void;
  onCancel: () => void;
  /**
   * When provided, the screen runs in EDIT mode: prefilled with the row's
   * current values, the wizard skips straight to the URL step (kind/name
   * are typically not what you're changing in an edit), and on save it
   * UPSERTS the same id rather than minting a new one.
   *
   * `apiKey` is the resolved cleartext (caller is responsible for
   * resolving any `@secret:` ref before passing it in). `rawApiKey` is the
   * UN-resolved column value — passing it through lets the save path
   * detect "key was unchanged" and reuse the existing `@secret:` ref
   * instead of generating a new one. Without this, every edit would
   * orphan the previous ref in the encrypted store.
   */
  editing?: {
    id: string;
    name: string;
    kind: ProviderKind;
    baseUrl: string;
    authMode: AuthMode;
    apiKey: string;
    /**
     * Optional un-resolved api_key column value. When supplied AND the user
     * leaves `apiKey` (the cleartext) untouched in the wizard, the save
     * path will REUSE this ref instead of calling `migratePlaintext` and
     * orphaning the old ref. Older callers without this field still work
     * correctly — they just incur a fresh ref on every edit.
     */
    rawApiKey?: string | null;
    isDefault: boolean;
    defaultModel: string | null;
  };
}

type Step = 'kind' | 'name' | 'url' | 'auth' | 'test';

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

interface Draft {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  authMode: AuthMode;
  apiKey: string;
}

const EMPTY_DRAFT: Draft = {
  kind: 'ollama',
  name: '',
  baseUrl: '',
  authMode: 'none',
  apiKey: '',
};

function draftToConfig(d: Draft, idOverride?: string): PyProviderConfig {
  return {
    id: idOverride ?? `${d.kind}-${Date.now().toString(36)}`,
    name: d.name,
    kind: d.kind,
    baseUrl: d.baseUrl,
    authMode: d.authMode,
    ...(d.apiKey !== '' ? { apiKey: d.apiKey } : {}),
  };
}

export function AddProviderScreen({ onDone, onCancel, editing }: Props) {
  // EDIT mode: skip straight to the URL step (most common edit) with the
  // row's current values prefilled. The user can Esc back to earlier steps
  // (kind/name) if they really want to retype them.
  const [step, setStep] = useState<Step>(editing !== undefined ? 'url' : 'kind');
  const [draft, setDraft] = useState<Draft>(
    editing !== undefined
      ? {
          kind: editing.kind,
          name: editing.name,
          baseUrl: editing.baseUrl,
          authMode: editing.authMode,
          apiKey: editing.apiKey,
        }
      : EMPTY_DRAFT,
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>{editing !== undefined ? 'Edit Provider' : 'Add Provider'}</Text>
        <Text dimColor>  {stepLabel(step)}  ·  Esc back</Text>
      </Box>
      <StepIndicator step={step} />
      <Box marginTop={1} flexDirection="column">
        {step === 'kind' && (
          <KindStep
            value={draft.kind}
            onSelect={(kind) => {
              const opt = PROVIDER_KIND_OPTIONS.find((o) => o.kind === kind);
              setDraft({
                ...draft,
                kind,
                baseUrl: opt?.defaultBaseUrl ?? '',
                authMode: (opt?.defaultAuth ?? 'none') as AuthMode,
              });
              setStep('name');
            }}
            onBack={onCancel}
          />
        )}
        {step === 'name' && (
          <NameStep
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v })}
            onNext={() => { if (draft.name.trim() !== '') setStep('url'); }}
            onBack={() => setStep('kind')}
          />
        )}
        {step === 'url' && (
          <UrlStep
            value={draft.baseUrl}
            onChange={(v) => setDraft({ ...draft, baseUrl: v })}
            onNext={() => { if (draft.baseUrl.trim() !== '') setStep('auth'); }}
            onBack={() => setStep('name')}
          />
        )}
        {step === 'auth' && (
          <AuthStep
            mode={draft.authMode}
            apiKey={draft.apiKey}
            onModeChange={(m) => setDraft({ ...draft, authMode: m, apiKey: m === 'none' ? '' : draft.apiKey })}
            onKeyChange={(v) => setDraft({ ...draft, apiKey: v })}
            onNext={() => setStep('test')}
            onBack={() => setStep('url')}
          />
        )}
        {step === 'test' && (
          <TestStep
            draft={draft}
            onRetry={() => {/* retry triggered by re-render of key */}}
            onSave={(setDefault) => {
              // EDIT mode: keep the same id so we update the existing row.
              // ADD mode: mint a fresh id from the kind + timestamp.
              const cfg = draftToConfig(draft, editing?.id);
              // Key handling:
              //   - Empty input → null column value
              //   - Edit mode AND input matches the original cleartext → reuse
              //     the existing `@secret:` ref so we DON'T mint a new ref and
              //     orphan the old one in the encrypted store. (security gate
              //     finding H1 from round 2)
              //   - Otherwise → migratePlaintext writes a fresh ref
              let storedKey: string | null;
              if (draft.apiKey === '') {
                storedKey = null;
              } else if (
                editing !== undefined &&
                draft.apiKey === editing.apiKey &&
                editing.rawApiKey !== undefined &&
                editing.rawApiKey !== null
              ) {
                storedKey = editing.rawApiKey;
              } else {
                storedKey = migratePlaintext(draft.apiKey);
              }
              // Edit-with-key-change cleanup: when we mint a fresh ref for a
              // changed key (or null out an existing key), the previous ref
              // stored against this row becomes orphaned. Drop it from the
              // backend now so prune-secrets isn't the only path that
              // reclaims it. Only fires for `@secret:` refs — legacy
              // plaintext or the literal `'ollama'` placeholder isn't ours
              // to delete from the backend.
              if (
                editing !== undefined &&
                editing.rawApiKey !== undefined &&
                editing.rawApiKey !== null &&
                isSecretRef(editing.rawApiKey) &&
                editing.rawApiKey !== storedKey
              ) {
                try { getSecretsBackend().deleteSecret(editing.rawApiKey); } catch { /* best-effort */ }
              }
              const finalIsDefault = setDefault || (editing?.isDefault ?? false);
              upsertProviderConfig(db, {
                id: cfg.id,
                name: cfg.name,
                providerType: cfg.kind,
                baseUrl: cfg.baseUrl,
                apiKey: storedKey,
                defaultModel: editing?.defaultModel ?? null,
                isDefault: finalIsDefault,
                authMode: draft.authMode,
              });
              if (setDefault) setDefaultProvider(db, cfg.id);
              recordProviderTest(db, cfg.id, 'ok', editing !== undefined ? 'Updated after successful test' : 'Saved after successful test');
              onDone();
            }}
            onBack={() => setStep('auth')}
          />
        )}
      </Box>
    </Box>
  );
}

function stepLabel(s: Step): string {
  const map: Record<Step, string> = {
    kind: 'Step 1 of 5 · Type',
    name: 'Step 2 of 5 · Name',
    url: 'Step 3 of 5 · URL',
    auth: 'Step 4 of 5 · Auth',
    test: 'Step 5 of 5 · Test & Save',
  };
  return map[s];
}

function StepIndicator({ step }: { step: Step }) {
  const order: Step[] = ['kind', 'name', 'url', 'auth', 'test'];
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

function KindStep({
  value, onSelect, onBack,
}: {
  value: ProviderKind;
  onSelect: (k: ProviderKind) => void;
  onBack: () => void;
}) {
  const [cursor, setCursor] = useState(() =>
    Math.max(0, PROVIDER_KIND_OPTIONS.findIndex((o) => o.kind === value)),
  );
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(PROVIDER_KIND_OPTIONS.length - 1, c + 1));
    if (key.return) {
      const opt = PROVIDER_KIND_OPTIONS[cursor];
      if (opt !== undefined) onSelect(opt.kind);
    }
  });
  return (
    <Box flexDirection="column">
      <Text dimColor>Pick the kind of server. We preload sensible defaults for each.</Text>
      <Box marginTop={1} flexDirection="column">
        {PROVIDER_KIND_OPTIONS.map((o, i) => (
          <Box key={o.kind}>
            <Text {...(i === cursor ? { color: '#60A5FA' as const } : {})}>
              {i === cursor ? '▶ ' : '  '}
              <Text bold={i === cursor}>{o.label.padEnd(22)}</Text>
              <Text dimColor>{o.hint}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function NameStep({
  value, onChange, onNext, onBack,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.return) { onNext(); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (input.length === 1 && !key.ctrl && !key.meta) onChange(value + input);
  });
  return (
    <Box flexDirection="column">
      <Text>Name your provider</Text>
      <Box marginTop={1}>
        <Text>{'> '}<Text color="#60A5FA">{value}</Text>█</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Shown in status bar and model browser. Enter to continue.</Text>
      </Box>
    </Box>
  );
}

function UrlStep({
  value, onChange, onNext, onBack,
}: {
  value: string;
  onChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.return) { onNext(); return; }
    if (key.backspace || key.delete) { onChange(value.slice(0, -1)); return; }
    if (input.length === 1 && !key.ctrl && !key.meta) onChange(value + input);
  });
  return (
    <Box flexDirection="column">
      <Text>Base URL</Text>
      <Box marginTop={1}>
        <Text>{'> '}<Text color="#60A5FA">{value}</Text>█</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Example: http://192.168.1.50:11434  ·  https://api.runpod.io/v1</Text>
      </Box>
    </Box>
  );
}

function AuthStep({
  mode, apiKey, onModeChange, onKeyChange, onNext, onBack,
}: {
  mode: AuthMode;
  apiKey: string;
  onModeChange: (m: AuthMode) => void;
  onKeyChange: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  // Start focused on the key field when the chosen mode needs one — saves a Tab.
  const [field, setField] = useState<'mode' | 'key'>(mode === 'none' ? 'mode' : 'key');
  const needsKey = mode !== 'none';
  const canAdvance = !needsKey || apiKey !== '';

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.tab) {
      setField((f) => (f === 'mode' ? 'key' : 'mode'));
      return;
    }
    if (key.return) {
      if (canAdvance) { onNext(); return; }
      // If key is required but empty, jump focus to the key field instead of
      // silently doing nothing.
      setField('key');
      return;
    }
    if (field === 'mode') {
      if (input === '1') { onModeChange('none'); return; }
      if (input === '2') { onModeChange('api-key'); setField('key'); return; }
      if (input === '3') { onModeChange('bearer'); setField('key'); return; }
      return;
    }
    if (field === 'key') {
      if (key.backspace || key.delete) { onKeyChange(apiKey.slice(0, -1)); return; }
      if (input.length >= 1 && !key.ctrl && !key.meta) onKeyChange(apiKey + input);
    }
  });

  const masked = apiKey === '' ? '' : '•'.repeat(Math.min(apiKey.length, 24));
  return (
    <Box flexDirection="column">
      <Text>Authentication</Text>
      <Box marginTop={1} flexDirection="column">
        <Text {...(field === 'mode' ? { color: '#60A5FA' as const } : { dimColor: true })}>
          {field === 'mode' ? '▶ ' : '  '}Mode  (press 1 none · 2 api-key · 3 bearer)
        </Text>
        <Box marginLeft={4}>
          <Text>
            [{mode === 'none' ? 'x' : ' '}] none  {' '}
            [{mode === 'api-key' ? 'x' : ' '}] api-key  {' '}
            [{mode === 'bearer' ? 'x' : ' '}] bearer
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text {...(field === 'key' ? { color: '#60A5FA' as const } : { dimColor: true })}>
            {field === 'key' ? '▶ ' : '  '}Key {mode === 'none' ? <Text dimColor>(not needed — press Enter)</Text> : null}
          </Text>
        </Box>
        <Box marginLeft={4}>
          <Text>{'> '}<Text color="#60A5FA">{masked}</Text>{field === 'key' ? '█' : ''}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        {canAdvance ? (
          <Text color="#4ADE80">Enter to continue  ·  Tab switches fields  ·  Esc back</Text>
        ) : (
          <Text color="yellow">Enter an API key, then press Enter  ·  Tab switches fields  ·  Esc back</Text>
        )}
      </Box>
    </Box>
  );
}

function TestStep({
  draft, onSave, onBack,
}: {
  draft: Draft;
  onRetry: () => void;
  onSave: (setDefault: boolean) => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<'testing' | 'ok' | 'fail'>('testing');
  const [detail, setDetail] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [showSpinner, setShowSpinner] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const cfg = useMemo(() => draftToConfig(draft), [draft]);

  // Run the connection test whenever retryKey changes.
  useEffect(() => {
    setStatus('testing');
    setDetail('');
    setLatency(null);
    setElapsed(0);
    const started = Date.now();
    const spinnerTimer = setTimeout(() => { setShowSpinner(true); }, 200);
    const elapsedTimer = setInterval(() => { setElapsed(Date.now() - started); }, 100);
    const provider = makeProvider(cfg);
    const controller = new AbortController();
    provider.testConnection(controller.signal)
      .then((h) => {
        setStatus('ok');
        setLatency(h.latencyMs);
        setDetail(h.detail ?? '');
      })
      .catch((err: unknown) => {
        setStatus('fail');
        setDetail(err instanceof ProviderError ? err.userMessage : err instanceof Error ? err.message : 'Unknown error');
      })
      .finally(() => {
        clearTimeout(spinnerTimer);
        clearInterval(elapsedTimer);
        setShowSpinner(false);
      });
    return () => {
      clearTimeout(spinnerTimer);
      clearInterval(elapsedTimer);
      controller.abort();
    };
  }, [cfg, retryKey]);

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (status === 'testing') return;
    if (status === 'ok') {
      if (key.return) { onSave(true); return; }
      if (input === 's' || input === 'S') { onSave(false); return; }
    }
    if (status === 'fail') {
      if (input === 'r' || input === 'R') { setRetryKey((k) => k + 1); return; }
    }
  });

  const spinner = SPINNER_FRAMES[Math.floor(elapsed / 80) % SPINNER_FRAMES.length] ?? '⠋';

  return (
    <Box flexDirection="column">
      <Text>Testing <Text color="#60A5FA">{draft.name}</Text> at <Text dimColor>{draft.baseUrl}</Text></Text>
      <Box marginTop={1} flexDirection="column">
        {status === 'testing' && (
          <Text>
            {showSpinner ? <Text color="#60A5FA">{spinner} </Text> : '  '}
            Connecting{elapsed > 2000 ? ` (${(elapsed / 1000).toFixed(1)}s)` : ''}…
          </Text>
        )}
        {status === 'ok' && (
          <>
            <Text color="#4ADE80">✓ Connected — {detail}{latency !== null ? ` (${String(latency)}ms)` : ''}</Text>
            <Box marginTop={1}>
              <Text dimColor>Enter to save as default · S to save without default · Esc back</Text>
            </Box>
          </>
        )}
        {status === 'fail' && (
          <>
            <Text color="red">✗ {detail}</Text>
            <Box marginTop={1}>
              <Text dimColor>R to retry · Esc to go back and edit</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
