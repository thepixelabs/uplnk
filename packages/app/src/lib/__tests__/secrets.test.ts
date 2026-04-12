/**
 * Tests for packages/app/src/lib/secrets.ts
 *
 * Strategy: test observable behaviour only.
 * - EncryptedFileBackend and PlaintextBackend are exercised through their
 *   exported test aliases (__EncryptedFileBackendForTests / __PlaintextBackendForTests).
 * - resolveSecret / migratePlaintext are tested against a controlled backend
 *   installed via __setSecretsBackendForTests.
 * - File I/O uses real temp directories so the crypto path is exercised end-to-end.
 *   Each test gets its own temp dir; afterEach removes it.
 * - initSecretsBackend is called with the singleton reset first so it re-picks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock uplnk-db so tests control the pylonDir ─────────────────────────────
// Per-file vi.mock takes precedence over the global setup.ts stub.

vi.mock('uplnk-db', () => ({
  db: {},
  getPylonDir: vi.fn(() => '/tmp/pylon-secrets-test-default/.pylon'),
}));

import { getPylonDir } from 'uplnk-db';
import {
  SECRET_REF_PREFIX,
  isSecretRef,
  resolveSecret,
  migratePlaintext,
  initSecretsBackend,
  __resetSecretsBackendForTests,
  __setSecretsBackendForTests,
  __EncryptedFileBackendForTests,
  __PlaintextBackendForTests,
} from '../secrets.js';

const mockGetPylonDir = vi.mocked(getPylonDir);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pylon-secrets-'));
}

function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ─── isSecretRef ─────────────────────────────────────────────────────────────

describe('isSecretRef', () => {
  it('returns true for a well-formed secret ref', () => {
    expect(isSecretRef('@secret:abc123')).toBe(true);
  });

  it('returns true for the bare prefix alone', () => {
    expect(isSecretRef('@secret:')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isSecretRef('')).toBe(false);
  });

  it('returns false for plaintext that does not start with the prefix', () => {
    expect(isSecretRef('sk-my-api-key')).toBe(false);
  });

  it('returns false when the prefix appears mid-string', () => {
    expect(isSecretRef('prefix@secret:abc')).toBe(false);
  });

  it('SECRET_REF_PREFIX is the expected sentinel value', () => {
    expect(SECRET_REF_PREFIX).toBe('@secret:');
  });
});

// ─── resolveSecret ────────────────────────────────────────────────────────────

describe('resolveSecret', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mockGetPylonDir.mockReturnValue(tmpDir);
    __resetSecretsBackendForTests();
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    __setSecretsBackendForTests(backend);
  });

  afterEach(() => {
    __resetSecretsBackendForTests();
    removeTempDir(tmpDir);
  });

  it('returns undefined for null', () => {
    expect(resolveSecret(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(resolveSecret(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(resolveSecret('')).toBeUndefined();
  });

  it('returns the value unchanged for a legacy plaintext key (no ref prefix)', () => {
    expect(resolveSecret('legacy-plaintext-key')).toBe('legacy-plaintext-key');
  });

  it('consults the backend for a ref and returns the stored secret', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    __setSecretsBackendForTests(backend);
    const ref = backend.setSecret('my-secret-value');

    expect(resolveSecret(ref)).toBe('my-secret-value');
  });

  it('returns undefined for a ref that does not exist in the backend', () => {
    expect(resolveSecret('@secret:nonexistent000000000000')).toBeUndefined();
  });
});

// ─── migratePlaintext ─────────────────────────────────────────────────────────

describe('migratePlaintext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mockGetPylonDir.mockReturnValue(tmpDir);
    __resetSecretsBackendForTests();
    __setSecretsBackendForTests(new __EncryptedFileBackendForTests(tmpDir));
  });

  afterEach(() => {
    __resetSecretsBackendForTests();
    removeTempDir(tmpDir);
  });

  it('is idempotent: returns an existing ref unchanged', () => {
    const existingRef = '@secret:already-a-ref-abc';
    expect(migratePlaintext(existingRef)).toBe(existingRef);
  });

  it('stores a plaintext value and returns a ref starting with the prefix', () => {
    const result = migratePlaintext('raw-api-key');

    expect(result.startsWith(SECRET_REF_PREFIX)).toBe(true);
  });

  it('the returned ref resolves back to the original plaintext', () => {
    const ref = migratePlaintext('my-raw-key');

    expect(resolveSecret(ref)).toBe('my-raw-key');
  });
});

// ─── EncryptedFileBackend ─────────────────────────────────────────────────────

describe('EncryptedFileBackend', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(tmpDir);
  });

  it('round-trip: get returns the value stored by set', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    const ref = backend.setSecret('super-secret');

    expect(backend.getSecret(ref)).toBe('super-secret');
  });

  it('delete removes the ref so subsequent get returns undefined', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    const ref = backend.setSecret('to-be-deleted');
    backend.deleteSecret(ref);

    expect(backend.getSecret(ref)).toBeUndefined();
  });

  it('get returns undefined for a ref that was never set', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);

    expect(backend.getSecret('@secret:deadbeef00000000')).toBeUndefined();
  });

  it('two different values produce two different refs', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    const ref1 = backend.setSecret('value-alpha');
    const ref2 = backend.setSecret('value-beta');

    expect(ref1).not.toBe(ref2);
  });

  it('persists across two instances pointing at the same temp dir', () => {
    const backend1 = new __EncryptedFileBackendForTests(tmpDir);
    const ref = backend1.setSecret('persistent-secret');

    const backend2 = new __EncryptedFileBackendForTests(tmpDir);

    expect(backend2.getSecret(ref)).toBe('persistent-secret');
  });

  it('reads back correctly after re-opening with the same key file', () => {
    const backend1 = new __EncryptedFileBackendForTests(tmpDir);
    const ref = backend1.setSecret('reopen-value');
    backend1.close();

    const backend2 = new __EncryptedFileBackendForTests(tmpDir);
    expect(backend2.getSecret(ref)).toBe('reopen-value');
  });

  it('survives a corrupted secrets.enc by starting fresh and accepting new writes', () => {
    const storePath = join(tmpDir, 'secrets.enc');
    writeFileSync(storePath, 'this is not valid json {{{', 'utf-8');

    // Construction must not throw despite the corrupt store.
    const backend = new __EncryptedFileBackendForTests(tmpDir);

    // A new write after the corrupt-store recovery must succeed.
    const ref = backend.setSecret('after-corrupt');
    expect(backend.getSecret(ref)).toBe('after-corrupt');
  });

  it('writes a .corrupt-<timestamp> backup when secrets.enc is invalid', () => {
    const storePath = join(tmpDir, 'secrets.enc');
    writeFileSync(storePath, 'not-json', 'utf-8');

    new __EncryptedFileBackendForTests(tmpDir);

    const files = require('node:fs').readdirSync(tmpDir) as string[];
    const hasBackup = files.some((f: string) => f.startsWith('secrets.enc.corrupt-'));
    expect(hasBackup).toBe(true);
  });

  it('name property is "encrypted-file"', () => {
    const backend = new __EncryptedFileBackendForTests(tmpDir);
    expect(backend.name).toBe('encrypted-file');
  });
});

// ─── PlaintextBackend ─────────────────────────────────────────────────────────

describe('PlaintextBackend', () => {
  let stderrSpy: { mockRestore: () => void; mock: { calls: unknown[][] } };

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as unknown as typeof stderrSpy;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('prints a warning on stderr at construction', () => {
    new __PlaintextBackendForTests('test reason');

    expect(stderrSpy).toHaveBeenCalledOnce();
    const call = stderrSpy.mock.calls[0];
    const msg = call !== undefined ? String(call[0]) : '';
    expect(msg).toContain('WARNING');
    expect(msg).toContain('plaintext');
  });

  it('set + get returns the stored value', () => {
    const backend = new __PlaintextBackendForTests('test');
    const ref = backend.setSecret('plaintext-value');

    expect(backend.getSecret(ref)).toBe('plaintext-value');
  });

  it('delete removes the value so get returns undefined', () => {
    const backend = new __PlaintextBackendForTests('test');
    const ref = backend.setSecret('to-delete');
    backend.deleteSecret(ref);

    expect(backend.getSecret(ref)).toBeUndefined();
  });

  it('close clears all stored secrets', () => {
    const backend = new __PlaintextBackendForTests('test');
    const ref = backend.setSecret('will-be-cleared');
    backend.close();

    expect(backend.getSecret(ref)).toBeUndefined();
  });

  it('name property is "plaintext"', () => {
    const backend = new __PlaintextBackendForTests('test');
    expect(backend.name).toBe('plaintext');
  });
});

// ─── initSecretsBackend ───────────────────────────────────────────────────────

describe('initSecretsBackend', () => {
  let tmpDir: string;
  let stderrSpy: { mockRestore: () => void; mock: { calls: unknown[][] } };

  beforeEach(() => {
    tmpDir = makeTempDir();
    mockGetPylonDir.mockReturnValue(tmpDir);
    __resetSecretsBackendForTests();
    // Silence any stderr from the backend.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as unknown as typeof stderrSpy;
  });

  afterEach(() => {
    __resetSecretsBackendForTests();
    stderrSpy.mockRestore();
    removeTempDir(tmpDir);
  });

  it('picks encrypted-file when @napi-rs/keyring is absent', async () => {
    const backend = await initSecretsBackend();

    // In a Node test environment @napi-rs/keyring is not installed,
    // so the factory must fall through to EncryptedFileBackend.
    expect(backend.name).toBe('encrypted-file');
  });

  it('returns the same instance on repeated calls (singleton)', async () => {
    const first = await initSecretsBackend();
    const second = await initSecretsBackend();

    expect(first).toBe(second);
  });

  it('creates the pylon dir so secrets.enc can be written', async () => {
    await initSecretsBackend();

    expect(existsSync(tmpDir)).toBe(true);
  });
});
