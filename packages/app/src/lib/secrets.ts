/**
 * SecretsBackend — abstraction over how API keys (and any future per-user
 * secrets) are persisted.
 *
 * Three concrete backends, tried in order at startup:
 *
 *   1. KeyringBackend       — delegates to the OS keychain via a dynamic
 *                             `@napi-rs/keyring` import. Only used if the
 *                             module resolves at runtime (it is NOT a
 *                             hard dependency of pylon-dev). Users who
 *                             want real keychain storage install it via
 *                             `pnpm add @napi-rs/keyring` or `npm i -g`.
 *
 *   2. EncryptedFileBackend — AES-256-GCM encrypted blob at
 *                             `~/.pylon/secrets.enc`, with a per-user
 *                             random 256-bit key stored at
 *                             `~/.pylon/.secret-key` (chmod 600). Has no
 *                             native deps — works everywhere, including
 *                             air-gapped environments.
 *
 *   3. PlaintextBackend     — last-resort fallback. Writes visibly warns
 *                             on stderr so the user knows their keys are
 *                             unencrypted. Only used when file-based
 *                             encryption cannot be initialised (e.g. a
 *                             read-only home directory).
 *
 * The backend is chosen once at process start via `initSecretsBackend()`.
 * All provider-related code goes through `getSecret(ref)` / `setSecret(value)`
 * rather than touching the provider_configs.api_key column directly.
 *
 * A `ref` is an opaque string — callers should not assume its shape.
 * `setSecret` returns a fresh ref; `getSecret(ref)` returns the cleartext.
 * `deleteSecret(ref)` removes the entry. `describeBackend()` returns a
 * short label used by `pylon doctor` to report which backend is active.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getPylonDir } from 'pylon-db';

export interface SecretsBackend {
  readonly name: 'keyring' | 'encrypted-file' | 'plaintext';
  /** Store a secret. Returns an opaque ref to pass to getSecret/deleteSecret. */
  setSecret(value: string): string;
  /** Resolve a ref to the underlying secret. Returns `undefined` if not found. */
  getSecret(ref: string): string | undefined;
  /** Delete a ref. Missing refs are treated as success. */
  deleteSecret(ref: string): void;
  /**
   * Delete multiple refs in a single persist call. Implementations that
   * persist eagerly (encrypted-file) get O(1) writes instead of O(N).
   * Returns the count of refs that were actually present and removed.
   */
  deleteSecretsBulk(refs: string[]): number;
  /**
   * List every ref this backend is currently storing. Used by
   * `pylon doctor prune-secrets` to find orphaned refs.
   *
   * Returns `null` when the backend cannot enumerate (the OS keychain API
   * does not expose a "list accounts" operation in a portable way). Pruning
   * is a no-op against backends that return null.
   */
  listRefs(): string[] | null;
  /** Free any file handles / in-memory state — called on app shutdown. */
  close(): void;
}

// ─── Reference helpers ────────────────────────────────────────────────────────

/** Prefix marking a value in the api_key column as a secrets-backend ref. */
export const SECRET_REF_PREFIX = '@secret:';

/** True when the api_key column value is a ref, not a plaintext legacy value. */
export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

function makeRef(): string {
  // 128 bits is enough to never collide and keeps the ref short.
  return `${SECRET_REF_PREFIX}${randomBytes(16).toString('hex')}`;
}

// ─── EncryptedFileBackend ─────────────────────────────────────────────────────

interface EncryptedEntry {
  iv: string; // hex
  tag: string; // hex
  ciphertext: string; // hex
}

type EncryptedStore = Record<string, EncryptedEntry>;

/**
 * AES-256-GCM encrypted store backed by two files:
 *   - ~/.pylon/.secret-key    — 32-byte random key, chmod 600
 *   - ~/.pylon/secrets.enc    — JSON record of {ref: {iv, tag, ciphertext}}
 *
 * Why AES-GCM: authenticated encryption. The tag catches tampering, which
 * matters because the encrypted store is a plain file an attacker with
 * filesystem access could edit.
 */
class EncryptedFileBackend implements SecretsBackend {
  readonly name = 'encrypted-file' as const;
  private readonly key: Buffer;
  private readonly storePath: string;
  private store: EncryptedStore;

  constructor(pylonDir: string) {
    const keyPath = join(pylonDir, '.secret-key');
    this.storePath = join(pylonDir, 'secrets.enc');
    this.key = this.loadOrCreateKey(keyPath);
    this.store = this.loadStore();
  }

  private loadOrCreateKey(keyPath: string): Buffer {
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath);
      if (raw.length !== 32) {
        throw new Error(
          `[pylon secrets] invalid key length at ${keyPath}: expected 32 bytes, got ${String(raw.length)}`,
        );
      }
      return raw;
    }
    const key = randomBytes(32);
    // Create with 0o600 in a single syscall to close the TOCTOU window
    // where another local process could read the world-readable file
    // between writeFileSync() and a follow-up chmodSync(). The explicit
    // chmod afterwards is kept as a safety net for filesystems that
    // ignore the mode argument on create (rare, but possible).
    writeFileSync(keyPath, key, { mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch { /* best-effort */ }
    return key;
  }

  private loadStore(): EncryptedStore {
    if (!existsSync(this.storePath)) return {};
    try {
      const raw = readFileSync(this.storePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') return {};
      return parsed as EncryptedStore;
    } catch {
      // Corrupted file: back it up and start fresh. Losing the decrypted
      // keys is less bad than crashing the TUI on startup, but the user
      // MUST know so they can re-enter keys — otherwise their chat
      // requests will silently start failing with auth errors.
      let backupPath = '';
      try {
        backupPath = `${this.storePath}.corrupt-${String(Date.now())}`;
        writeFileSync(backupPath, readFileSync(this.storePath), { mode: 0o600 });
      } catch { /* ignore — best effort */ }
      process.stderr.write(
        `\n[pylon secrets] ⚠  The encrypted secrets store at ${this.storePath}\n` +
        `                was corrupted and has been reset.\n` +
        (backupPath !== '' ? `                Previous contents backed up to: ${backupPath}\n` : '') +
        `                All previously saved API keys must be re-entered via\n` +
        `                /provider → a (add provider). Existing providers will fail\n` +
        `                to connect until their keys are re-entered.\n\n`,
      );
      return {};
    }
  }

  private persist(): void {
    // Explicit 0o600 mode on the encrypted store — same TOCTOU reason
    // as the key file. The AES tag protects against tampering, but we
    // still don't want casual readers browsing the ciphertext.
    writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), { mode: 0o600, encoding: 'utf-8' });
    try { chmodSync(this.storePath, 0o600); } catch { /* best-effort */ }
  }

  setSecret(value: string): string {
    const ref = makeRef();
    // Each entry gets a fresh 96-bit random IV. GCM's IV-reuse footgun
    // bites when two distinct plaintexts are encrypted under the same
    // (key, IV) pair — a single-user secrets store with ~hundreds of
    // lifetime entries has a negligible birthday collision probability
    // (roughly 1 in 2^84 for 10k entries under a random-IV scheme), so
    // we don't bother with a counter. If the use case ever scales to
    // millions of entries per user, switch to AES-GCM-SIV.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.store[ref] = {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ct.toString('hex'),
    };
    this.persist();
    return ref;
  }

  getSecret(ref: string): string | undefined {
    const entry = this.store[ref];
    if (entry === undefined) return undefined;
    try {
      const iv = Buffer.from(entry.iv, 'hex');
      const tag = Buffer.from(entry.tag, 'hex');
      const ct = Buffer.from(entry.ciphertext, 'hex');
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf-8');
    } catch (err) {
      process.stderr.write(
        `[pylon secrets] failed to decrypt ${ref}: ${String(err)}\n`,
      );
      return undefined;
    }
  }

  deleteSecret(ref: string): void {
    if (this.store[ref] === undefined) return;
    delete this.store[ref];
    this.persist();
  }

  /**
   * Delete multiple refs in a single persist() call. Used by
   * `pylon doctor prune-secrets` to avoid O(N) write amplification when
   * pruning a large orphan set.
   */
  deleteSecretsBulk(refs: string[]): number {
    let removed = 0;
    for (const ref of refs) {
      if (this.store[ref] !== undefined) {
        delete this.store[ref];
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  listRefs(): string[] {
    return Object.keys(this.store);
  }

  close(): void {
    // No open handles — writes are synchronous.
  }
}

// ─── PlaintextBackend ─────────────────────────────────────────────────────────

/**
 * Last-resort fallback when encrypted storage cannot be initialised. Keeps
 * secrets in memory only and prints a visible stderr warning every time it
 * is constructed so the user knows their keys will not survive restart and
 * will be lost with the process.
 *
 * The visible warning is on purpose: this backend should be an oddity, not
 * a silent default. If a user sees it and doesn't like it, they know to fix
 * their filesystem permissions.
 */
class PlaintextBackend implements SecretsBackend {
  readonly name = 'plaintext' as const;
  private readonly store = new Map<string, string>();

  constructor(reason: string) {
    process.stderr.write(
      `[pylon secrets] WARNING: falling back to in-memory plaintext backend (${reason}). ` +
      `API keys will be lost on exit and are NOT encrypted.\n`,
    );
  }

  setSecret(value: string): string {
    const ref = makeRef();
    this.store.set(ref, value);
    return ref;
  }

  getSecret(ref: string): string | undefined {
    return this.store.get(ref);
  }

  deleteSecret(ref: string): void {
    this.store.delete(ref);
  }

  deleteSecretsBulk(refs: string[]): number {
    let removed = 0;
    for (const ref of refs) {
      if (this.store.delete(ref)) removed += 1;
    }
    return removed;
  }

  listRefs(): string[] {
    return Array.from(this.store.keys());
  }

  close(): void {
    this.store.clear();
  }
}

// ─── KeyringBackend (dynamic @napi-rs/keyring) ────────────────────────────────

/**
 * OS keychain backend. Uses `@napi-rs/keyring` — a native module with
 * prebuilt binaries for macOS, Linux (libsecret), and Windows. Pylon does
 * not declare it as a hard dep because the install would break in CI and
 * air-gapped environments. Users who want real keychain storage opt in by
 * installing the package themselves.
 *
 * The ref format is `@secret:<hex>` (same as the other backends) but the
 * underlying store is the OS keychain keyed under the service name
 * `pylon-dev` and the account name equal to the hex portion of the ref.
 */
interface KeyringModule {
  Entry: new (service: string, account: string) => {
    setPassword(value: string): void;
    getPassword(): string | null;
    deletePassword(): boolean;
  };
}

async function tryLoadKeyring(): Promise<KeyringModule | null> {
  try {
    // The module is an OPTIONAL runtime dep — we intentionally don't declare
    // it in package.json so installs don't fail on machines without libsecret
    // or Windows Credential Manager. Using an indirect `Function` call hides
    // the specifier from TypeScript's module resolver so `tsc` doesn't need
    // the types, and from bundlers so they don't try to resolve it at build
    // time either.
    const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
    const mod: unknown = await dynamicImport('@napi-rs/keyring');
    if (mod !== null && typeof mod === 'object' && 'Entry' in mod) {
      return mod as KeyringModule;
    }
    return null;
  } catch {
    return null;
  }
}

class KeyringBackend implements SecretsBackend {
  readonly name = 'keyring' as const;
  private static readonly SERVICE = 'pylon-dev';

  constructor(private readonly keyring: KeyringModule) {}

  private accountFromRef(ref: string): string {
    return ref.slice(SECRET_REF_PREFIX.length);
  }

  setSecret(value: string): string {
    const ref = makeRef();
    const entry = new this.keyring.Entry(KeyringBackend.SERVICE, this.accountFromRef(ref));
    entry.setPassword(value);
    return ref;
  }

  getSecret(ref: string): string | undefined {
    try {
      const entry = new this.keyring.Entry(KeyringBackend.SERVICE, this.accountFromRef(ref));
      const pw = entry.getPassword();
      return pw ?? undefined;
    } catch {
      return undefined;
    }
  }

  deleteSecret(ref: string): void {
    try {
      const entry = new this.keyring.Entry(KeyringBackend.SERVICE, this.accountFromRef(ref));
      entry.deletePassword();
    } catch { /* ignore */ }
  }

  deleteSecretsBulk(refs: string[]): number {
    let removed = 0;
    for (const ref of refs) {
      try {
        const entry = new this.keyring.Entry(KeyringBackend.SERVICE, this.accountFromRef(ref));
        if (entry.deletePassword()) removed += 1;
      } catch { /* ignore individual failures */ }
    }
    return removed;
  }

  /**
   * The OS keychain API exposes per-account access but no portable
   * "list accounts under a service" operation. Pruning is a no-op against
   * keyring storage; users running on keyring backend should rely on
   * provider deletion flows to drop refs at write time.
   */
  listRefs(): null {
    return null;
  }

  close(): void {
    // Native entries are stateless.
  }
}

// ─── Backend selection & singleton ────────────────────────────────────────────

let singleton: SecretsBackend | null = null;

/**
 * Synchronous backend pick — used internally whenever the async init has
 * not yet run (tests, CLI subcommands that bypass `bin/pylon.ts`, etc.).
 * Skips the keyring probe because dynamic import is async. Starts with
 * the encrypted file backend and falls back to plaintext.
 */
function pickBackendSync(): SecretsBackend {
  const pylonDir = getPylonDir();
  try {
    mkdirSync(pylonDir, { recursive: true });
  } catch { /* handled by file backend fallback */ }
  try {
    return new EncryptedFileBackend(pylonDir);
  } catch (err) {
    return new PlaintextBackend(
      `encrypted file backend failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Pick the best available backend for this machine:
 * 1. `@napi-rs/keyring` if the module resolves → OS keychain
 * 2. EncryptedFileBackend at `~/.pylon/secrets.enc` → AES-256-GCM file
 * 3. PlaintextBackend → in-memory with visible warning
 *
 * Call this once at app startup. Subsequent calls return the same instance.
 */
export async function initSecretsBackend(): Promise<SecretsBackend> {
  if (singleton !== null) return singleton;

  const pylonDir = getPylonDir();
  try {
    mkdirSync(pylonDir, { recursive: true });
  } catch { /* handled by file backend fallback */ }

  // Attempt keyring first — opt-in via user-installed dep.
  const keyring = await tryLoadKeyring();
  if (keyring !== null) {
    try {
      // Smoke test: can we set + get + delete a dummy?
      const backend = new KeyringBackend(keyring);
      const ref = backend.setSecret('pylon-selftest');
      const got = backend.getSecret(ref);
      backend.deleteSecret(ref);
      if (got === 'pylon-selftest') {
        singleton = backend;
        return backend;
      }
    } catch {
      // keyring module is present but unusable (headless Linux without
      // libsecret, Windows without Credential Manager, etc.) — fall through
    }
  }

  singleton = pickBackendSync();
  return singleton;
}

/**
 * Synchronous accessor for the singleton backend.
 *
 * If `initSecretsBackend()` has not been awaited yet, we lazily pick a
 * sync-only backend (file or plaintext — skips keyring probing because
 * that requires async). This guarantees every call site gets a usable
 * backend without having to plumb an async-init boundary through the
 * whole app. `bin/pylon.ts` still calls the async init at startup so
 * real users get the keyring path; tests and library callers that never
 * touch the async init get the encrypted-file path.
 */
export function getSecretsBackend(): SecretsBackend {
  if (singleton === null) {
    singleton = pickBackendSync();
  }
  return singleton;
}

/**
 * Resolve an api_key column value into the cleartext secret.
 *
 * - If the value is a `@secret:` ref, resolve it through the backend.
 * - If the value is legacy plaintext, return it unchanged (the caller
 *   should consider calling `migratePlaintext` to move it into the backend).
 * - If the value is undefined / null / empty, return `undefined`.
 */
export function resolveSecret(apiKeyColumnValue: string | null | undefined): string | undefined {
  if (apiKeyColumnValue === null || apiKeyColumnValue === undefined || apiKeyColumnValue === '') {
    return undefined;
  }
  if (!isSecretRef(apiKeyColumnValue)) {
    return apiKeyColumnValue; // legacy plaintext
  }
  return getSecretsBackend().getSecret(apiKeyColumnValue);
}

/**
 * Migrate a plaintext api_key column value into the secrets backend.
 * Returns the new ref to be written back to the column.
 *
 * If the input is already a ref, it is returned unchanged — migration is
 * idempotent.
 */
export function migratePlaintext(plaintextOrRef: string): string {
  if (isSecretRef(plaintextOrRef)) return plaintextOrRef;
  return getSecretsBackend().setSecret(plaintextOrRef);
}

/** Test-only: drop the singleton so unit tests can re-pick a backend. */
export function __resetSecretsBackendForTests(): void {
  if (singleton !== null) singleton.close();
  singleton = null;
}

/** Test-only: force a specific backend (used to bypass keyring probing). */
export function __setSecretsBackendForTests(backend: SecretsBackend): void {
  singleton = backend;
}

/** Test-only: expose the internal class for direct construction in tests. */
export { EncryptedFileBackend as __EncryptedFileBackendForTests };
export { PlaintextBackend as __PlaintextBackendForTests };

// Silence the unused-import warning for unlink when the file isn't used
// through any code path (test mode). The import is kept because a future
// `close` implementation may need it.
void unlinkSync;
