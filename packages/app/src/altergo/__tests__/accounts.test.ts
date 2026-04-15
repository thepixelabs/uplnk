/**
 * Tests for packages/app/src/altergo/accounts.ts
 *
 * listAltergoAccounts discovers accounts from the directory structure and
 * infers providers from which dot-directories are present. getActiveAccount
 * reads from state.json or last_session.json.
 *
 * Strategy: real filesystem I/O via createFakeAltergoHome — the functions
 * only use synchronous node:fs calls and no DB interaction.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFakeAltergoHome } from '../../__tests__/fixtures/altergoHome.js';
import { listAltergoAccounts, getActiveAccount } from '../accounts.js';

// ─── listAltergoAccounts ──────────────────────────────────────────────────────

describe('listAltergoAccounts', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns empty array when altergoHome does not contain an accounts/ directory', () => {
    const result = listAltergoAccounts('/no/such/path');
    expect(result).toEqual([]);
  });

  it('returns empty array when accounts/ directory is empty', () => {
    // accountsDir is created by createFakeAltergoHome but is empty
    expect(listAltergoAccounts(fake.home)).toEqual([]);
  });

  it('returns one account when a single account directory is present', () => {
    fake.addAccount('alice', ['claude-code']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('alice');
  });

  it('includes the absolute path to the account directory', () => {
    fake.addAccount('alice', ['claude-code']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.path).toBe(join(fake.home, 'accounts', 'alice'));
  });

  it('discovers claude-code provider from .claude dot-directory', () => {
    fake.addAccount('alice', ['claude-code']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.providers).toContain('claude-code');
  });

  it('discovers gemini provider from .gemini dot-directory', () => {
    fake.addAccount('bob', ['gemini']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.providers).toContain('gemini');
  });

  it('lists multiple providers for one account that has both .claude and .gemini', () => {
    fake.addAccount('charlie', ['claude-code', 'gemini']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.providers).toContain('claude-code');
    expect(accounts[0]!.providers).toContain('gemini');
  });

  it('returns empty providers array for an account with no recognised dot-directories', () => {
    fake.addAccount('dave', []); // no providers

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.providers).toEqual([]);
  });

  it('discovers codex provider from .codex dot-directory', () => {
    fake.addAccount('eve', ['codex']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.providers).toContain('codex');
  });

  it('discovers copilot provider from .copilot dot-directory', () => {
    fake.addAccount('frank', ['copilot']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts[0]!.providers).toContain('copilot');
  });

  it('returns multiple accounts and sorts them alphabetically by name', () => {
    fake.addAccount('zara', ['claude-code']);
    fake.addAccount('alice', ['gemini']);
    fake.addAccount('mike', ['claude-code', 'gemini']);

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.name)).toEqual(['alice', 'mike', 'zara']);
  });

  it('skips non-directory entries inside accounts/', () => {
    fake.addAccount('alice', ['claude-code']);
    // Write a plain file into accounts/ — should be skipped
    writeFileSync(join(fake.accountsDir, 'not-a-directory.txt'), 'hello', 'utf-8');

    const accounts = listAltergoAccounts(fake.home);

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe('alice');
  });
});

// ─── getActiveAccount ─────────────────────────────────────────────────────────

describe('getActiveAccount', () => {
  let fake = createFakeAltergoHome();

  afterEach(() => {
    fake.cleanup();
    fake = createFakeAltergoHome();
  });

  it('returns null when neither state.json nor last_session.json exists', () => {
    expect(getActiveAccount(fake.home, 'claude-code')).toBeNull();
  });

  it('returns the account name for the matching provider key in state.json', () => {
    fake.setActiveAccount('claude-code', 'alice');

    expect(getActiveAccount(fake.home, 'claude-code')).toBe('alice');
  });

  it('returns null when provider key is absent from state.json', () => {
    fake.setActiveAccount('gemini', 'bob');

    expect(getActiveAccount(fake.home, 'claude-code')).toBeNull();
  });

  it('returns the flat "account" field when provider key is absent', () => {
    writeFileSync(
      join(fake.home, 'state.json'),
      JSON.stringify({ account: 'default-user' }),
      'utf-8',
    );

    expect(getActiveAccount(fake.home, 'claude-code')).toBe('default-user');
  });

  it('prefers the provider-specific key over the flat account field', () => {
    writeFileSync(
      join(fake.home, 'state.json'),
      JSON.stringify({ 'claude-code': 'specific-user', account: 'fallback-user' }),
      'utf-8',
    );

    expect(getActiveAccount(fake.home, 'claude-code')).toBe('specific-user');
  });

  it('falls back to last_session.json when state.json is absent', () => {
    writeFileSync(
      join(fake.home, 'last_session.json'),
      JSON.stringify({ 'claude-code': 'legacy-user' }),
      'utf-8',
    );

    expect(getActiveAccount(fake.home, 'claude-code')).toBe('legacy-user');
  });

  it('skips a malformed state.json and returns null', () => {
    writeFileSync(join(fake.home, 'state.json'), 'not valid json {{{', 'utf-8');

    expect(getActiveAccount(fake.home, 'claude-code')).toBeNull();
  });

  it('skips state.json if its top-level value is not an object (e.g. an array)', () => {
    writeFileSync(join(fake.home, 'state.json'), JSON.stringify(['alice', 'bob']), 'utf-8');

    expect(getActiveAccount(fake.home, 'claude-code')).toBeNull();
  });

  it('correctly reads gemini account from state.json', () => {
    fake.setActiveAccount('gemini', 'gemini-user');

    expect(getActiveAccount(fake.home, 'gemini')).toBe('gemini-user');
  });

  it('can hold multiple provider entries simultaneously', () => {
    fake.setActiveAccount('claude-code', 'claude-user');
    fake.setActiveAccount('gemini', 'gemini-user');

    expect(getActiveAccount(fake.home, 'claude-code')).toBe('claude-user');
    expect(getActiveAccount(fake.home, 'gemini')).toBe('gemini-user');
  });
});
