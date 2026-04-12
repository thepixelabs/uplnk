/**
 * PluginRegistry — install/uninstall/list community MCP plugin manifests.
 *
 * Plugins are stored as individual JSON files in ~/.uplnk/plugins/<id>.json.
 * Each file contains a validated PluginManifest. At startup, all manifests
 * are loaded and converted to McpServerConfig entries so McpManager can
 * connect to them alongside the built-in servers.
 *
 * Design decisions:
 * - Zod validates the manifest before writing to disk (no corrupt state).
 * - `install()` warns on missing required env vars but does NOT block install;
 *   the user may set the env var later.
 * - File I/O uses synchronous Node fs APIs to keep the interface simple;
 *   async is only used for `install()` to allow HTTP manifest fetching.
 * - `toMcpServerConfigs()` returns configs compatible with McpServerConfig in
 *   McpManager.ts (stdio transport only — plugins run as child processes).
 */

import {
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig } from '../mcp/McpManager.js';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

export const PluginManifestSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, {
    message: 'Plugin ID must be lowercase alphanumeric with hyphens only',
  }),
  displayName: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  mcpServer: McpServerSchema,
  requiredEnvVars: z.array(z.string()).optional(),
  homepage: z.string().url().optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ─── PluginRegistry ───────────────────────────────────────────────────────────

export class PluginRegistry {
  constructor(private readonly pluginsDir: string) {}

  /**
   * Install a plugin from a PluginManifest object.
   *
   * Validates the manifest with Zod before writing. Warns to stderr if any
   * required env vars are missing, but proceeds with installation.
   *
   * Throws if Zod validation fails or the file cannot be written.
   */
  async install(manifest: PluginManifest): Promise<void> {
    // Validate through Zod — throws ZodError on bad input
    const validated = PluginManifestSchema.parse(manifest);

    // Warn about missing required env vars (non-blocking)
    if (validated.requiredEnvVars !== undefined && validated.requiredEnvVars.length > 0) {
      const missing = validated.requiredEnvVars.filter(
        (v) => process.env[v] === undefined || process.env[v] === '',
      );
      if (missing.length > 0) {
        process.stderr.write(
          `[pylon-plugins] WARNING: Plugin "${validated.id}" requires the following ` +
          `env vars that are not currently set: ${missing.join(', ')}\n` +
          `Set them before starting pylon for the plugin to work correctly.\n`,
        );
      }
    }

    mkdirSync(this.pluginsDir, { recursive: true });
    const filePath = join(this.pluginsDir, `${validated.id}.json`);
    writeFileSync(filePath, JSON.stringify(validated, null, 2), 'utf-8');
  }

  /**
   * Uninstall a plugin by ID.
   * Throws if the plugin is not installed.
   */
  async uninstall(id: string): Promise<void> {
    const filePath = join(this.pluginsDir, `${id}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Plugin "${id}" is not installed`);
    }
    unlinkSync(filePath);
  }

  /**
   * List all installed plugins.
   * Files that fail Zod validation are skipped with a stderr warning.
   */
  list(): PluginManifest[] {
    if (!existsSync(this.pluginsDir)) {
      return [];
    }

    let entries: string[];
    try {
      entries = readdirSync(this.pluginsDir);
    } catch {
      return [];
    }

    const manifests: PluginManifest[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = join(this.pluginsDir, entry);
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
        const result = PluginManifestSchema.safeParse(raw);
        if (result.success) {
          manifests.push(result.data);
        } else {
          process.stderr.write(
            `[pylon-plugins] WARNING: Skipping malformed plugin file "${entry}": ` +
            `${result.error.errors.map((e) => e.message).join('; ')}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `[pylon-plugins] WARNING: Could not read plugin file "${entry}": ${String(err)}\n`,
        );
      }
    }
    return manifests;
  }

  /**
   * Get a single installed plugin by ID, or undefined if not installed.
   */
  get(id: string): PluginManifest | undefined {
    const filePath = join(this.pluginsDir, `${id}.json`);
    if (!existsSync(filePath)) {
      return undefined;
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      const result = PluginManifestSchema.safeParse(raw);
      return result.success ? result.data : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Convert all installed plugins to McpServerConfig entries.
   * Compatible with McpManager.connect() — uses stdio transport.
   */
  toMcpServerConfigs(): McpServerConfig[] {
    return this.list().map((manifest): McpServerConfig => {
      const cfg: McpServerConfig = {
        id: `plugin:${manifest.id}`,
        name: manifest.displayName,
        type: 'stdio',
        command: manifest.mcpServer.command,
        args: manifest.mcpServer.args,
      };
      if (manifest.mcpServer.env !== undefined) {
        cfg.env = manifest.mcpServer.env;
      }
      return cfg;
    });
  }
}
