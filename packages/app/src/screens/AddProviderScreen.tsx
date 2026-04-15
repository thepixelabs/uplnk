import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Key } from 'ink';
import { db, upsertProviderConfig, setDefaultProvider, recordProviderTest } from '@uplnk/db';
import type { AuthMode, ProviderConfig as PyProviderConfig, ProviderKind } from '@uplnk/providers';
import { makeProvider, PROVIDER_KIND_OPTIONS, ProviderError } from '@uplnk/providers';
import { migratePlaintext, isSecretRef, getSecretsBackend } from '../lib/secrets.js';

// ---------------------------------------------------------------------------
// Text-input helpers — cursor-aware, word navigation, readline shortcuts
// ---------------------------------------------------------------------------

function prevWordBoundary(text: string, pos: number): number {
  let i = pos - 1;
  while (i > 0 && /\s/.test(text[i] ?? '')) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? '')) i--;
  return Math.max(0, i);
}

function nextWordBoundary(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !/\s/.test(text[i] ?? '')) i++;
  while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  return i;
}

/**
 * Manages cursor position for a plain-text field.
 * Returns { cursor, handleKey } — the caller must forward useInput events here.
 * onChange / onCommit / onBack are called for semantic actions; raw navigation
 * key events are consumed without calling any of them.
 */
function useTextInput(
  value: string,
  onChange: (v: string) => void,
  {
    onCommit,
    onBack,
  }: { onCommit?: () => void; onBack?: () => void },
) {
  const [cursor, setCursor] = useState(value.length);

  // Keep cursor in bounds if value is replaced externally.
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value.length]);

  function handleKey(input: string, key: Key) {
    // --- escape / enter ---
    if (key.escape) { onBack?.(); return; }
    if (key.return) { onCommit?.(); return; }

    // --- arrow navigation ---
    if (key.leftArrow) {
      if (key.meta) {
        setCursor(prevWordBoundary(value, cursor));
      } else if (key.ctrl) {
        setCursor(0);
      } else {
        setCursor((c) => Math.max(0, c - 1));
      }
      return;
    }
    if (key.rightArrow) {
      if (key.meta) {
        setCursor(nextWordBoundary(value, cursor));
      } else if (key.ctrl) {
        setCursor(value.length);
      } else {
        setCursor((c) => Math.min(value.length, c + 1));
      }
      return;
    }

    // --- readline line-start / line-end ---
    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(value.length); return; }

    // --- delete ---
    if (key.backspace || key.delete) {
      if (key.meta || (key.ctrl && input === 'w')) {
        // alt+backspace or ctrl+W: delete previous word
        const start = prevWordBoundary(value, cursor);
        onChange(value.slice(0, start) + value.slice(cursor));
        setCursor(start);
      } else if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor((c) => c - 1);
      }
      return;
    }
    // ctrl+W as a standalone key (some terminals send it without backspace)
    if (key.ctrl && input === 'w') {
      const start = prevWordBoundary(value, cursor);
      onChange(value.slice(0, start) + value.slice(cursor));
      setCursor(start);
      return;
    }

    // --- regular character ---
    if (input.length === 1 && !key.ctrl && !key.meta) {
      onChange(value.slice(0, cursor) + input + value.slice(cursor));
      setCursor((c) => c + 1);
    }
  }

  return { cursor, handleKey };
}

/** Renders a value string with a block cursor inserted at the given position. */
function TextWithCursor({ value, cursor }: { value: string; cursor: number }) {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  return (
    <Text>
      <Text color="#60A5FA">{before}</Text>
      <Text>█</Text>
      <Text color="#60A5FA">{after}</Text>
    </Text>
  );
}

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

  // Q cancels the whole wizard from any step without having to Esc back
  // through each individual step — but NOT when the user is typing in a text
  // field (name/url/auth-key), where 'q' is just a character.
  const isTextStep = step === 'name' || step === 'url' || step === 'auth';
  useInput((input, key) => {
    if (!isTextStep && !key.ctrl && !key.meta && (input === 'q' || input === 'Q')) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold>{editing !== undefined ? 'Edit Provider' : 'Add Provider'}</Text>
        <Text dimColor>  {stepLabel(step)}  ·  Esc back  ·  Q cancel</Text>
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
            onEditUrl={() => setStep('url')}
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
  const { cursor, handleKey } = useTextInput(value, onChange, { onCommit: onNext, onBack });
  useInput(handleKey);
  return (
    <Box flexDirection="column">
      <Text>Name your provider</Text>
      <Box marginTop={1}>
        <Text>{'> '}</Text><TextWithCursor value={value} cursor={cursor} />
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
  const { cursor, handleKey } = useTextInput(value, onChange, { onCommit: onNext, onBack });
  useInput(handleKey);
  return (
    <Box flexDirection="column">
      <Text>Base URL</Text>
      <Box marginTop={1}>
        <Text>{'> '}</Text><TextWithCursor value={value} cursor={cursor} />
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

  // Cursor-aware key field. Note: the key value is masked in the UI but the
  // cursor position is tracked against the real (unmasked) string length.
  const [keyCursor, setKeyCursor] = useState(apiKey.length);
  useEffect(() => { setKeyCursor((c) => Math.min(c, apiKey.length)); }, [apiKey.length]);

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.tab) {
      setField((f) => (f === 'mode' ? 'key' : 'mode'));
      return;
    }
    if (key.return) {
      if (canAdvance) { onNext(); return; }
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
      // Arrow navigation within the (masked) key field.
      if (key.leftArrow) {
        if (key.meta) setKeyCursor(prevWordBoundary(apiKey, keyCursor));
        else if (key.ctrl) setKeyCursor(0);
        else setKeyCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        if (key.meta) setKeyCursor(nextWordBoundary(apiKey, keyCursor));
        else if (key.ctrl) setKeyCursor(apiKey.length);
        else setKeyCursor((c) => Math.min(apiKey.length, c + 1));
        return;
      }
      if (key.ctrl && input === 'a') { setKeyCursor(0); return; }
      if (key.ctrl && input === 'e') { setKeyCursor(apiKey.length); return; }
      if (key.backspace || key.delete) {
        if (key.meta || (key.ctrl && input === 'w')) {
          const start = prevWordBoundary(apiKey, keyCursor);
          onKeyChange(apiKey.slice(0, start) + apiKey.slice(keyCursor));
          setKeyCursor(start);
        } else if (keyCursor > 0) {
          onKeyChange(apiKey.slice(0, keyCursor - 1) + apiKey.slice(keyCursor));
          setKeyCursor((c) => c - 1);
        }
        return;
      }
      if (key.ctrl && input === 'w') {
        const start = prevWordBoundary(apiKey, keyCursor);
        onKeyChange(apiKey.slice(0, start) + apiKey.slice(keyCursor));
        setKeyCursor(start);
        return;
      }
      if (input.length >= 1 && !key.ctrl && !key.meta) {
        onKeyChange(apiKey.slice(0, keyCursor) + input + apiKey.slice(keyCursor));
        setKeyCursor((c) => c + 1);
      }
    }
  });

  // Show masked characters with a cursor indicator at keyCursor position.
  const maskedBefore = '•'.repeat(keyCursor);
  const maskedAfter = '•'.repeat(apiKey.length - keyCursor);
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
          {field === 'key' && apiKey.length > 0 ? (
            <Text>
              {'> '}
              <Text color="#60A5FA">{maskedBefore}</Text>
              <Text>█</Text>
              <Text color="#60A5FA">{maskedAfter}</Text>
            </Text>
          ) : (
            <Text>{'> '}<Text color="#60A5FA">{apiKey === '' ? '' : '•'.repeat(Math.min(apiKey.length, 24))}</Text>{field === 'key' ? '█' : ''}</Text>
          )}
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
  draft, onSave, onBack, onEditUrl,
}: {
  draft: Draft;
  onRetry: () => void;
  onSave: (setDefault: boolean) => void;
  onBack: () => void;
  /** Jump directly back to the URL step to fix the address. */
  onEditUrl: () => void;
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
      if (input === 'e' || input === 'E') { onEditUrl(); return; }
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
              <Text dimColor>R retry · E edit URL · Esc edit auth</Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
