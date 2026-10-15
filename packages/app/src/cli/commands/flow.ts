/**
 * headless flow command — list, validate, and run flow definitions.
 *
 * Flows live in the directory specified by config.flows.dir (default
 * ~/.uplnk/flows). Each flow is a YAML (.yaml / .yml) or JSON (.json) file
 * conforming to the FlowDef schema below.
 *
 * Actions:
 *   list             Scan the flows directory and print a table of found flows.
 *   run <name>       Load, validate, and execute the named flow via FlowEngine.
 *                    Step lifecycle goes to stderr; chat-step stream text and
 *                    the final outputs map (JSON) go to stdout.
 *   validate <name>  Load and validate the named flow, report success or errors.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { getOrCreateConfig } from '../../lib/config.js';
import type { Config } from '../../lib/config.js';
import { FlowEngine } from '../../flow/engine/FlowEngine.js';
import type { FlowEvent } from '../../flow/engine/FlowEngine.js';
import { buildAgentRunner } from '../../flow/agentRunner.js';
import { loadFlowFromFile } from '../../flow/loader.js';
// Use the same FlowDef schema the engine uses — keeping one schema prevents
// `uplnk flow validate` from passing a flow that then fails inside the engine.
import { FlowDef } from '../../flow/schema.js';
import type { FlowDef as FlowDefType } from '../../flow/schema.js';

// ── Public interface ──────────────────────────────────────────────────────────

export interface FlowCommandOptions {
  action: string;
  name?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

export async function runFlowCommand(options: FlowCommandOptions): Promise<void> {
  const configResult = getOrCreateConfig();
  if (!configResult.ok) {
    process.stderr.write(`uplnk flow: config error — ${configResult.error}\n`);
    process.exit(1);
  }
  const config = configResult.config;

  const flowsDir = expandHome(config.flows.dir);

  switch (options.action) {
    case 'list':
      await runList(flowsDir);
      break;

    case 'run':
      await runRun(flowsDir, options, config);
      break;

    case 'validate':
      await runValidate(flowsDir, options);
      break;

    default:
      process.stderr.write(
        `uplnk flow: unknown action '${options.action}'. Valid actions: list, run, validate\n`,
      );
      process.exit(1);
  }
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function runList(flowsDir: string): Promise<void> {
  if (!existsSync(flowsDir)) {
    process.stdout.write(`No flows directory found at ${flowsDir}\n`);
    process.stdout.write('Create it and add .yaml or .json flow files to get started.\n');
    return;
  }

  const entries = discoverFlowFiles(flowsDir);

  if (entries.length === 0) {
    process.stdout.write(`No flows found in ${flowsDir}\n`);
    return;
  }

  // Column widths — derive from actual content for a clean table.
  const nameW = Math.max(4, ...entries.map((e) => e.name.length));
  const fileW = Math.max(4, ...entries.map((e) => basename(e.file).length));
  const statusW = 6; // 'valid' or 'error'

  const hr = `${'─'.repeat(nameW + 2)}┼${'─'.repeat(fileW + 2)}┼${'─'.repeat(statusW + 2)}`;

  const row = (name: string, file: string, status: string) =>
    ` ${name.padEnd(nameW)} │ ${file.padEnd(fileW)} │ ${status.padEnd(statusW)} `;

  process.stdout.write(`\n ${pad('Name', nameW)} │ ${pad('File', fileW)} │ ${pad('Status', statusW)} \n`);
  process.stdout.write(hr + '\n');

  for (const entry of entries) {
    const parseResult = loadFlowFile(entry.file);
    const status = parseResult.ok ? 'valid' : 'error';
    process.stdout.write(row(entry.name, basename(entry.file), status) + '\n');
    if (!parseResult.ok) {
      process.stdout.write(`   ${parseResult.error}\n`);
    }
  }

  process.stdout.write('\n');
}

async function runRun(
  flowsDir: string,
  options: FlowCommandOptions,
  config: Config,
): Promise<void> {
  const name = requireName(options, 'run');
  const { flow, file } = loadNamedFlow(flowsDir, name);

  process.stdout.write(`Flow '${flow.name}' loaded from ${file}\n`);
  process.stdout.write(`  ${String(flow.steps.length)} step(s) defined\n`);
  if (flow.description !== undefined) {
    process.stdout.write(`  ${flow.description}\n`);
  }

  // Re-load through the canonical loader to get the LoadedFlow shape
  // (path + content hash) the engine persists to the flows table.
  const loadedFlow = loadFlowFromFile(file);

  // Agent steps delegate to the real AgentOrchestrator; see flow/agentRunner.ts
  // (including the MCP-tools TODO — flow-invoked agents run tool-less for now).
  const engine = new FlowEngine(config, { agentRunner: buildAgentRunner({ config }) });

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);

  // Step lifecycle to stderr, stream text to stdout — keeps
  // `uplnk flow run x > out.txt` clean while progress stays visible.
  let streamedThisStep = false;
  const onEvent = (event: FlowEvent): void => {
    switch (event.kind) {
      case 'step.start':
        streamedThisStep = false;
        process.stderr.write(`→ ${event.stepId ?? '?'}\n`);
        break;
      case 'step.stream':
        if (event.text !== undefined) {
          process.stdout.write(event.text);
          streamedThisStep = true;
        }
        break;
      case 'step.done':
        if (streamedThisStep) process.stdout.write('\n');
        process.stderr.write(`✓ ${event.stepId ?? '?'}\n`);
        break;
      case 'step.skip':
        process.stderr.write(`– ${event.stepId ?? '?'} (skipped)\n`);
        break;
      case 'step.retry':
        process.stderr.write(`↻ ${event.stepId ?? '?'} retrying — ${event.error ?? ''}\n`);
        break;
      case 'step.error':
        if (streamedThisStep) process.stdout.write('\n');
        process.stderr.write(`✗ ${event.stepId ?? '?'} — ${event.error ?? 'unknown error'}\n`);
        break;
      default:
        break;
    }
  };

  try {
    // TODO(flow-cli-inputs): no --input flag yet — flows relying on declared
    // defaults run fine; required inputs fail with the engine's clear message.
    const outputs = await engine.run(loadedFlow, {
      onEvent,
      signal: controller.signal,
    });

    process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const verb = controller.signal.aborted ? 'cancelled' : 'failed';
    process.stderr.write(`\nuplnk flow run: ${verb} — ${msg}\n`);
    process.exit(1);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

async function runValidate(flowsDir: string, options: FlowCommandOptions): Promise<void> {
  const name = requireName(options, 'validate');

  if (!existsSync(flowsDir)) {
    process.stderr.write(`uplnk flow: flows directory not found at ${flowsDir}\n`);
    process.exit(1);
  }

  const entries = discoverFlowFiles(flowsDir);
  const target = entries.find((e) => e.name === name);

  if (target === undefined) {
    process.stderr.write(
      `uplnk flow: no flow named '${name}' found in ${flowsDir}\n`,
    );
    process.stderr.write(
      `Available: ${entries.length > 0 ? entries.map((e) => e.name).join(', ') : '(none)'}\n`,
    );
    process.exit(1);
  }

  const result = loadFlowFile(target.file);
  if (!result.ok) {
    process.stderr.write(`uplnk flow: validation failed for '${name}':\n`);
    process.stderr.write(`  ${result.error}\n`);
    process.exit(1);
  }

  const flow = result.flow;
  process.stdout.write(`Flow '${flow.name}' is valid\n`);
  process.stdout.write(`  file: ${target.file}\n`);
  process.stdout.write(`  steps: ${String(flow.steps.length)}\n`);
  if (flow.description !== undefined) {
    process.stdout.write(`  description: ${flow.description}\n`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

interface FlowEntry {
  name: string;
  file: string;
}

function discoverFlowFiles(dir: string): FlowEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const results: FlowEntry[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') continue;
    const file = join(dir, entry);
    const name = basename(entry, ext);
    results.push({ name, file });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

type LoadResult =
  | { ok: true; flow: FlowDefType }
  | { ok: false; error: string };

function loadFlowFile(file: string): LoadResult {
  let raw: unknown;
  try {
    const content = readFileSync(file, 'utf-8');
    const ext = extname(file).toLowerCase();
    if (ext === '.json') {
      raw = JSON.parse(content);
    } else {
      // .yaml / .yml
      raw = yaml.load(content);
    }
  } catch (err) {
    return { ok: false, error: `parse error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = FlowDef.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    return { ok: false, error: `schema error: ${issues}` };
  }

  return { ok: true, flow: parsed.data };
}

/** Guard helper: ensure --name was supplied for actions that require it. */
function requireName(options: FlowCommandOptions, action: string): string {
  if (options.name === undefined || options.name.trim() === '') {
    process.stderr.write(`uplnk flow ${action}: a flow name is required. Usage: uplnk flow ${action} <name>\n`);
    process.exit(1);
  }
  return options.name;
}

/**
 * Load a flow by name from the flows directory, exiting with an error message
 * if the directory, file, or schema is invalid.
 */
function loadNamedFlow(flowsDir: string, name: string): { flow: FlowDefType; file: string } {
  if (!existsSync(flowsDir)) {
    process.stderr.write(`uplnk flow: flows directory not found at ${flowsDir}\n`);
    process.exit(1);
  }

  const entries = discoverFlowFiles(flowsDir);
  const target = entries.find((e) => e.name === name);

  if (target === undefined) {
    process.stderr.write(
      `uplnk flow: no flow named '${name}' found in ${flowsDir}\n`,
    );
    process.stderr.write(
      `Available: ${entries.length > 0 ? entries.map((e) => e.name).join(', ') : '(none)'}\n`,
    );
    process.exit(1);
  }

  const result = loadFlowFile(target.file);
  if (!result.ok) {
    process.stderr.write(`uplnk flow: invalid flow '${name}': ${result.error}\n`);
    process.exit(1);
  }

  return { flow: result.flow, file: target.file };
}
