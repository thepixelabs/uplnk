/**
 * Plugin loader — reads all installed plugins from ~/.uplnk/plugins/ at startup
 * and adds them to the MCP server list.
 *
 * Called from bin/uplnk.ts after config load, before App render.
 * Returns McpServerConfig[] to be merged with any user-configured servers.
 */

import { join } from 'node:path';
import { getUplnkDir } from 'uplnk-db';
import { PluginRegistry } from './registry.js';
import type { McpServerConfig } from '../mcp/McpManager.js';

/**
 * Load all installed community plugin MCP server configs.
 *
 * Returns an empty array if the plugins directory doesn't exist yet
 * (i.e. no plugins have ever been installed).
 */
export function loadPluginConfigs(): McpServerConfig[] {
  const pluginsDir = join(getUplnkDir(), 'plugins');
  const registry = new PluginRegistry(pluginsDir);
  return registry.toMcpServerConfigs();
}
