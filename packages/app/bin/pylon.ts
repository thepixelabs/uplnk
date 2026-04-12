#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { App } from '../src/index.js';
import { WORDMARK } from '../src/lib/colors.js';
import { runMigrations } from 'pylon-db';

// Synchronous handlers so nothing is missed regardless of crash type.
// Check /tmp/pylon-crash.log after reproducing the bug.
const logCrash = (label: string, err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  try { appendFileSync('/tmp/pylon-crash.log', `\n--- ${label} ${new Date().toISOString()} ---\n${msg}\n`); } catch {}
};
process.on('uncaughtException',    (err) => { logCrash('UNCAUGHT', err);   process.exit(1); });
process.on('unhandledRejection',   (err) => { logCrash('REJECTION', err);  process.exit(1); });

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model:                   { type: 'string',  short: 'm' },
    provider:                { type: 'string',  short: 'p' },
    conversation:            { type: 'string',  short: 'c' },
    theme:                   { type: 'string',  short: 't' },
    project:                 { type: 'string',  short: 'P' },
    help:                    { type: 'boolean', short: 'h' },
    version:                 { type: 'boolean', short: 'v' },
    plugin:                  { type: 'string' },
    'confirm-command-exec':  { type: 'boolean' },
  },
  allowPositionals: true,
});

if (values.version) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const pkg = require('../package.json') as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

if (values.help) {
  console.log(`
${WORDMARK}  —  terminal LLM developer assistant

USAGE
  pylon [command] [options]

COMMANDS
  chat            Start or resume a conversation (default)
  doctor          Run preflight checks
  config          Open config in $EDITOR
  conversations   List saved conversations

PLUGIN COMMANDS
  --plugin install <url-or-json>   Install a community MCP plugin
  --plugin list                    List installed plugins
  --plugin remove <id>             Uninstall a plugin by ID

OPTIONS
  -m, --model         Model name (e.g. llama3.2, qwen2.5-coder:7b)
  -p, --provider      Provider ID from config
  -c, --conversation  Resume conversation by ID
  -t, --theme         Color theme: dark (default) or light
  -P, --project       Project directory to index into context
  -h, --help          Show this help
  -v, --version       Show version
  `);
  process.exit(0);
}

const [subcommand] = positionals;

if (subcommand === 'doctor') {
  const { runDoctor } = await import('../src/lib/doctor.js');
  await runDoctor();
  process.exit(0);
}

// ─── config subcommand ────────────────────────────────────────────────────────
if (subcommand === 'config') {
  if (values['confirm-command-exec'] === true) {
    // BC-3 (FINDING-004): interactive confirmation stamps commandExecConfirmedAt
    // so the runtime knows the user deliberately enabled command execution.
    const { getOrCreateConfig: getConfig, saveConfig } = await import('../src/lib/config.js');
    const cfgResult = getConfig();
    if (!cfgResult.ok) {
      process.stderr.write(
        `\npylon: CONFIG_INVALID — ${cfgResult.error}\n` +
        `Fix or delete ~/.pylon/config.json and try again.\n\n`,
      );
      process.exit(1);
    }
    const cfg = cfgResult.config;
    const confirmedAt = new Date().toISOString();
    const updatedConfig = {
      ...cfg,
      mcp: {
        ...cfg.mcp,
        commandExecEnabled: true,
        commandExecConfirmedAt: confirmedAt,
      },
    };
    saveConfig(updatedConfig);
    process.stdout.write(
      `\npylon: commandExecEnabled confirmed at ${confirmedAt}\n` +
      `Command execution is now enabled.\n\n`,
    );
    process.exit(0);
  }

  // Unknown config flag
  process.stderr.write(
    `pylon config: unknown option. Available options:\n` +
    `  --confirm-command-exec   Confirm interactive consent for mcp.commandExecEnabled\n`,
  );
  process.exit(1);
}

// ─── Plugin commands (one-shot, no TUI) ──────────────────────────────────────
if (values.plugin !== undefined) {
  const { join } = await import('node:path');
  const { getPylonDir } = await import('pylon-db');
  const { PluginRegistry, PluginManifestSchema } = await import(
    '../src/lib/plugins/registry.js'
  );

  const pluginsDir = join(getPylonDir(), 'plugins');
  const registry = new PluginRegistry(pluginsDir);
  const pluginAction = values.plugin;
  const [pluginArg] = positionals;

  if (pluginAction === 'list') {
    const installed = registry.list();
    if (installed.length === 0) {
      console.log('No plugins installed.');
    } else {
      console.log(`Installed plugins (${installed.length}):\n`);
      for (const p of installed) {
        console.log(`  ${p.id}@${p.version}  —  ${p.displayName}`);
        console.log(`    ${p.description}`);
        if (p.homepage !== undefined) {
          console.log(`    ${p.homepage}`);
        }
        console.log('');
      }
    }
    process.exit(0);
  }

  if (pluginAction === 'remove') {
    if (pluginArg === undefined) {
      process.stderr.write('Usage: pylon --plugin remove <id>\n');
      process.exit(1);
    }
    try {
      await registry.uninstall(pluginArg);
      console.log(`Plugin "${pluginArg}" uninstalled.`);
    } catch (err) {
      process.stderr.write(`pylon: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (pluginAction === 'install') {
    if (pluginArg === undefined) {
      process.stderr.write('Usage: pylon --plugin install <manifest-url-or-json>\n');
      process.exit(1);
    }

    let rawManifest: unknown;

    // Detect if the argument is a URL or inline JSON
    if (pluginArg.startsWith('http://') || pluginArg.startsWith('https://')) {
      // Fetch manifest from URL
      process.stdout.write(`Fetching manifest from ${pluginArg} ...\n`);
      const { default: https } = await import('node:https');
      const { default: http } = await import('node:http');
      const client = pluginArg.startsWith('https://') ? https : http;
      rawManifest = await new Promise<unknown>((resolve, reject) => {
        client.get(pluginArg, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown);
            } catch (e) {
              reject(new Error(`Failed to parse manifest JSON from URL: ${String(e)}`));
            }
          });
          res.on('error', reject);
        }).on('error', reject);
      });
    } else {
      // Try inline JSON
      try {
        rawManifest = JSON.parse(pluginArg) as unknown;
      } catch {
        process.stderr.write(
          `pylon: "--plugin install" argument must be a URL or valid JSON manifest.\n`,
        );
        process.exit(1);
      }
    }

    // Validate with Zod before installing
    const parsed = PluginManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      process.stderr.write(
        `pylon: Invalid plugin manifest:\n` +
        parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n') +
        '\n',
      );
      process.exit(1);
    }

    await registry.install(parsed.data);
    console.log(`Plugin "${parsed.data.id}" (${parsed.data.displayName} v${parsed.data.version}) installed.`);
    process.exit(0);
  }

  process.stderr.write(
    `pylon: Unknown plugin action "${pluginAction}". Use: install | list | remove\n`,
  );
  process.exit(1);
}

// Apply theme flag before rendering — must happen before config load
// so that PYLON_THEME is available to the color system at init time.
if (values.theme === 'light') {
  process.env['PYLON_THEME'] = 'light';
} else if (values.theme === 'dark') {
  process.env['PYLON_THEME'] = 'dark';
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

runMigrations();

// Load config here — before render — so a corrupt config file causes a clean
// exit with a human-readable error rather than a React render crash.
// C4 fix: arch-critical-fixes Phase 1.
const { getOrCreateConfig } = await import('../src/lib/config.js');
const configResult = getOrCreateConfig();
if (!configResult.ok) {
  process.stderr.write(
    `\npylon: CONFIG_INVALID — ${configResult.error}\n` +
    `Fix or delete ~/.pylon/config.json and try again.\n\n`,
  );
  process.exit(1);
}

// BC-3 (FINDING-004): warn when commandExecEnabled=true but the user never ran
// pylon config --confirm-command-exec.  A config file dropped silently (e.g.
// by a malicious package postinstall) must not enable command execution without
// explicit user consent.  The flag is enforced again in useMcp/McpManager, but
// an early stderr warning ensures the user sees it at startup.
if (
  configResult.config.mcp.commandExecEnabled === true &&
  (configResult.config.mcp.commandExecConfirmedAt === undefined ||
    configResult.config.mcp.commandExecConfirmedAt.trim() === '')
) {
  process.stderr.write(
    `WARNING: mcp.commandExecEnabled is set but was not confirmed interactively. ` +
    `Command execution is disabled until you run: pylon config --confirm-command-exec\n`,
  );
}

// Non-blocking update check — runs in background, prints notice after TUI exits.
// checkForUpdate respects PYLON_NO_UPDATE=1, CI=true, and the 24h cache.
const updateCheckPromise = import('../src/lib/selfUpdate.js').then(({ checkForUpdate }) =>
  checkForUpdate({
    packageName: configResult.config.updates.packageName,
    enabled: configResult.config.updates.enabled,
  }).catch(() => null),
);

const { waitUntilExit } = render(
  React.createElement(App, {
    ...(values.model !== undefined ? { initialModel: values.model } : {}),
    ...(values.provider !== undefined ? { initialProvider: values.provider } : {}),
    ...(values.conversation !== undefined ? { resumeConversationId: values.conversation } : {}),
    ...(values.theme === 'light' || values.theme === 'dark' ? { theme: values.theme } : {}),
    ...(values.project !== undefined ? { projectDir: values.project } : {}),
    subcommand: subcommand ?? 'chat',
    config: configResult.config,
  }),
  { exitOnCtrlC: false },
);

try {
  await waitUntilExit();
} catch (err) {
  // Ink rejects waitUntilExit when its internal error boundary catches a
  // React render error. The error has already been displayed via Ink's
  // ErrorOverview. Write it to stderr so tsx can surface it, then exit.
  const { appendFileSync } = await import('node:fs');
  const stamp = new Date().toISOString();
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  appendFileSync('/tmp/pylon-crash.log', `\n--- ${stamp} ---\n${msg}\n`);
  process.stderr.write(`\npylon crashed — see /tmp/pylon-crash.log\n`);
  process.exit(1);
}

// Print update notice after TUI exits (doesn't interrupt the session).
const updateResult = await updateCheckPromise;
if (updateResult?.updateAvailable) {
  process.stdout.write(
    `\n  pylon ${updateResult.latestVersion} is available (you have ${updateResult.currentVersion}).\n` +
    `  Run: ${updateResult.updateCommand}\n\n`,
  );
}

process.exit(0);
