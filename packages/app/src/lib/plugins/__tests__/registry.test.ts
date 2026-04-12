/**
 * Unit tests for PluginRegistry.
 *
 * Uses real fs I/O against a temp directory so we test actual file round-trips
 * without mocking — same pattern as config.test.ts and file-browse-write.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry, PluginManifestSchema, type PluginManifest } from '../registry.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const sampleManifest: PluginManifest = {
  id: 'uplnk-plugin-github',
  displayName: 'GitHub',
  description: 'GitHub MCP integration for Uplnk',
  version: '1.0.0',
  mcpServer: {
    command: 'npx',
    args: ['-y', 'uplnk-plugin-github'],
  },
};

const manifestWithEnv: PluginManifest = {
  id: 'uplnk-plugin-linear',
  displayName: 'Linear',
  description: 'Linear issue tracker MCP integration',
  version: '0.2.1',
  mcpServer: {
    command: 'npx',
    args: ['-y', 'uplnk-plugin-linear'],
    env: { LINEAR_API_KEY: 'placeholder' },
  },
  requiredEnvVars: ['LINEAR_API_KEY'],
  homepage: 'https://example.com/uplnk-plugin-linear',
};

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let tmpDir: string;
  let pluginsDir: string;
  let registry: PluginRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'uplnk-plugin-test-'));
    pluginsDir = join(tmpDir, 'plugins');
    registry = new PluginRegistry(pluginsDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── install() ──────────────────────────────────────────────────────────────

  describe('install()', () => {
    it('writes a JSON file to the plugins directory', async () => {
      await registry.install(sampleManifest);

      const filePath = join(pluginsDir, 'uplnk-plugin-github.json');
      expect(existsSync(filePath)).toBe(true);
    });

    it('written file contains valid JSON matching the manifest', async () => {
      await registry.install(sampleManifest);

      const filePath = join(pluginsDir, 'uplnk-plugin-github.json');
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      const result = PluginManifestSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('uplnk-plugin-github');
        expect(result.data.displayName).toBe('GitHub');
        expect(result.data.mcpServer.command).toBe('npx');
        expect(result.data.mcpServer.args).toEqual(['-y', 'uplnk-plugin-github']);
      }
    });

    it('creates the plugins directory if it does not exist', async () => {
      expect(existsSync(pluginsDir)).toBe(false);
      await registry.install(sampleManifest);
      expect(existsSync(pluginsDir)).toBe(true);
    });

    it('overwrites an existing plugin file on re-install', async () => {
      await registry.install(sampleManifest);
      const updated: PluginManifest = { ...sampleManifest, version: '2.0.0' };
      await registry.install(updated);

      const filePath = join(pluginsDir, 'uplnk-plugin-github.json');
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      expect((raw as Record<string, unknown>)['version']).toBe('2.0.0');
    });

    it('stores env and requiredEnvVars fields when present', async () => {
      // Suppress the stderr warning about missing LINEAR_API_KEY
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        await registry.install(manifestWithEnv);
      } finally {
        process.stderr.write = originalWrite;
      }

      const filePath = join(pluginsDir, 'uplnk-plugin-linear.json');
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      const result = PluginManifestSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.mcpServer.env).toEqual({ LINEAR_API_KEY: 'placeholder' });
        expect(result.data.requiredEnvVars).toEqual(['LINEAR_API_KEY']);
        expect(result.data.homepage).toBe('https://example.com/uplnk-plugin-linear');
      }
    });
  });

  // ─── uninstall() ────────────────────────────────────────────────────────────

  describe('uninstall()', () => {
    it('removes the plugin JSON file', async () => {
      await registry.install(sampleManifest);
      const filePath = join(pluginsDir, 'uplnk-plugin-github.json');
      expect(existsSync(filePath)).toBe(true);

      await registry.uninstall('uplnk-plugin-github');
      expect(existsSync(filePath)).toBe(false);
    });

    it('throws when the plugin is not installed', async () => {
      await expect(registry.uninstall('nonexistent-plugin')).rejects.toThrow(
        'Plugin "nonexistent-plugin" is not installed',
      );
    });
  });

  // ─── list() ─────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns an empty array when no plugins are installed', () => {
      expect(registry.list()).toEqual([]);
    });

    it('returns an empty array when the plugins directory does not exist', () => {
      const freshRegistry = new PluginRegistry(join(tmpDir, 'nonexistent'));
      expect(freshRegistry.list()).toEqual([]);
    });

    it('returns all installed plugin manifests', async () => {
      // Suppress stderr warnings
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        await registry.install(sampleManifest);
        await registry.install(manifestWithEnv);
      } finally {
        process.stderr.write = originalWrite;
      }

      const manifests = registry.list();
      expect(manifests).toHaveLength(2);
      const ids = manifests.map((m) => m.id).sort();
      expect(ids).toEqual(['uplnk-plugin-github', 'uplnk-plugin-linear']);
    });

    it('skips non-JSON files in the plugins directory', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(join(pluginsDir, 'README.txt'), 'ignore me');
      await registry.install(sampleManifest);

      const manifests = registry.list();
      expect(manifests).toHaveLength(1);
      expect(manifests[0]?.id).toBe('uplnk-plugin-github');
    });

    it('skips malformed JSON files with a stderr warning', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(join(pluginsDir, 'bad-plugin.json'), '{ not valid json }');

      const warnings: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: unknown) => {
        warnings.push(String(chunk));
        return true;
      };
      try {
        const manifests = registry.list();
        expect(manifests).toHaveLength(0);
        expect(warnings.some((w) => w.includes('bad-plugin.json'))).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    it('skips plugin files that fail Zod validation', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      // Valid JSON but missing required fields
      writeFileSync(
        join(pluginsDir, 'invalid-plugin.json'),
        JSON.stringify({ id: 'bad', displayName: 'Bad' }),
        'utf-8',
      );

      const warnings: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: unknown) => {
        warnings.push(String(chunk));
        return true;
      };
      try {
        const manifests = registry.list();
        expect(manifests).toHaveLength(0);
        expect(warnings.some((w) => w.includes('invalid-plugin.json'))).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  // ─── get() ──────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns the manifest for an installed plugin', async () => {
      await registry.install(sampleManifest);
      const manifest = registry.get('uplnk-plugin-github');
      expect(manifest).toBeDefined();
      expect(manifest?.id).toBe('uplnk-plugin-github');
    });

    it('returns undefined for a plugin that is not installed', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  // ─── toMcpServerConfigs() ────────────────────────────────────────────────────

  describe('toMcpServerConfigs()', () => {
    it('returns an empty array when no plugins are installed', () => {
      expect(registry.toMcpServerConfigs()).toEqual([]);
    });

    it('converts a plugin manifest to a McpServerConfig correctly', async () => {
      await registry.install(sampleManifest);

      const configs = registry.toMcpServerConfigs();
      expect(configs).toHaveLength(1);

      const config = configs[0];
      expect(config).toBeDefined();
      if (config === undefined) return;

      expect(config.id).toBe('plugin:uplnk-plugin-github');
      expect(config.name).toBe('GitHub');
      expect(config.type).toBe('stdio');
      expect(config.command).toBe('npx');
      expect(config.args).toEqual(['-y', 'uplnk-plugin-github']);
      // No env on this manifest
      expect(config.env).toBeUndefined();
    });

    it('includes env in McpServerConfig when the plugin manifest has env', async () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        await registry.install(manifestWithEnv);
      } finally {
        process.stderr.write = originalWrite;
      }

      const configs = registry.toMcpServerConfigs();
      expect(configs).toHaveLength(1);

      const config = configs[0];
      expect(config).toBeDefined();
      if (config === undefined) return;

      expect(config.id).toBe('plugin:uplnk-plugin-linear');
      expect(config.env).toEqual({ LINEAR_API_KEY: 'placeholder' });
    });

    it('prefixes the id with "plugin:" to namespace plugin servers', async () => {
      await registry.install(sampleManifest);
      const configs = registry.toMcpServerConfigs();
      expect(configs[0]?.id).toBe('plugin:uplnk-plugin-github');
    });

    it('converts multiple installed plugins to separate configs', async () => {
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = () => true;
      try {
        await registry.install(sampleManifest);
        await registry.install(manifestWithEnv);
      } finally {
        process.stderr.write = originalWrite;
      }

      const configs = registry.toMcpServerConfigs();
      expect(configs).toHaveLength(2);
    });
  });

  // ─── PluginManifestSchema (Zod validation) ───────────────────────────────────

  describe('PluginManifestSchema validation', () => {
    it('accepts a valid minimal manifest', () => {
      const result = PluginManifestSchema.safeParse(sampleManifest);
      expect(result.success).toBe(true);
    });

    it('accepts a full manifest with optional fields', () => {
      const result = PluginManifestSchema.safeParse(manifestWithEnv);
      expect(result.success).toBe(true);
    });

    it('rejects a manifest with a missing required id field', () => {
      const { id: _id, ...withoutId } = sampleManifest;
      const result = PluginManifestSchema.safeParse(withoutId);
      expect(result.success).toBe(false);
    });

    it('rejects a manifest with an invalid id (uppercase letters)', () => {
      const result = PluginManifestSchema.safeParse({
        ...sampleManifest,
        id: 'MyPlugin',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a manifest with an empty displayName', () => {
      const result = PluginManifestSchema.safeParse({
        ...sampleManifest,
        displayName: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects a manifest with a missing mcpServer field', () => {
      const { mcpServer: _mcp, ...withoutMcp } = sampleManifest;
      const result = PluginManifestSchema.safeParse(withoutMcp);
      expect(result.success).toBe(false);
    });

    it('rejects a manifest with an empty mcpServer.command', () => {
      const result = PluginManifestSchema.safeParse({
        ...sampleManifest,
        mcpServer: { command: '', args: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a manifest with an invalid homepage URL', () => {
      const result = PluginManifestSchema.safeParse({
        ...sampleManifest,
        homepage: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('rejects completely invalid JSON input', () => {
      const result = PluginManifestSchema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('rejects a string instead of an object', () => {
      const result = PluginManifestSchema.safeParse('{"id":"test"}');
      expect(result.success).toBe(false);
    });

    it('accepts a manifest with an empty args array', () => {
      const result = PluginManifestSchema.safeParse({
        ...sampleManifest,
        mcpServer: { command: 'my-tool', args: [] },
      });
      expect(result.success).toBe(true);
    });
  });

  // ─── install() — Zod validation failure ───────────────────────────────────────

  describe('install() — Zod validation failure', () => {
    it('throws a ZodError when given an invalid manifest object', async () => {
      // Cast to bypass TypeScript's static type check — we want to test runtime validation
      const badManifest = {
        id: 'MyPlugin', // uppercase — fails regex
        displayName: 'Bad',
        description: 'Bad plugin',
        version: '1.0.0',
        mcpServer: { command: 'x', args: [] },
      } as unknown as import('../registry.js').PluginManifest;

      await expect(registry.install(badManifest)).rejects.toThrow();
    });

    it('does not write a file when Zod validation fails', async () => {
      const badManifest = {
        id: '',
        displayName: '',
        description: '',
        version: '',
        mcpServer: { command: '', args: [] },
      } as unknown as import('../registry.js').PluginManifest;

      try {
        await registry.install(badManifest);
      } catch {
        // expected
      }

      // No file should have been written
      expect(existsSync(pluginsDir)).toBe(false);
    });
  });

  // ─── get() — corrupted file ───────────────────────────────────────────────────

  describe('get() — corrupted or invalid file', () => {
    it('returns undefined when the plugin file contains invalid JSON', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      const { join: pjoin } = await import('node:path');
      writeFileSync(pjoin(pluginsDir, 'bad-plugin.json'), '{ not valid json }', 'utf-8');

      const result = registry.get('bad-plugin');
      expect(result).toBeUndefined();
    });

    it('returns undefined when the plugin file fails schema validation', async () => {
      mkdirSync(pluginsDir, { recursive: true });
      const { join: pjoin } = await import('node:path');
      writeFileSync(pjoin(pluginsDir, 'partial-plugin.json'), JSON.stringify({ id: 'partial-plugin' }), 'utf-8');

      const result = registry.get('partial-plugin');
      expect(result).toBeUndefined();
    });
  });
});
