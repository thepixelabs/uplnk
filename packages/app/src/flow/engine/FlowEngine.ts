/**
 * FlowEngine — executes a FlowDef step by step.
 *
 * Design decisions:
 * - No React dependency: this is a plain async class so it can be used in
 *   headless mode (uplnk flow run) as well as the TUI.
 * - Events are emitted via a simple callback so the TUI hook can wire them
 *   to React state without coupling the engine to Ink.
 * - The condition evaluator (expr.ts) intentionally avoids eval/Function.
 * - step timeouts are enforced via AbortSignal.timeout — no manual timers.
 */

import { streamText } from 'ai';
import { db, getDefaultProvider, getProviderById } from '@uplnk/db';
import { resolveSecret } from '../../lib/secrets.js';
import { createLanguageModel } from '../../lib/languageModelFactory.js';
import type { Config } from '../../lib/config.js';
import {
  upsertFlow,
  createFlowRun,
  updateFlowRun,
  upsertStepResult,
} from '../persistence/flowRepo.js';
import type { LoadedFlow } from '../loader.js';
import { evaluateCondition, resolveExpression, interpolate } from './expr.js';
import type {
  FlowDef,
  ChatStep,
  ToolStep,
  AnyStepType,
  ConditionStepType,
  LoopStepType,
} from '../schema.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type FlowEventKind =
  | 'flow.start'
  | 'flow.done'
  | 'flow.error'
  | 'step.start'
  | 'step.done'
  | 'step.skip'
  | 'step.error'
  | 'step.stream'   // incremental LLM token
  | 'step.retry';

export interface FlowEvent {
  kind: FlowEventKind;
  runId: string;
  stepId?: string;
  stepIndex?: number;
  iteration?: number;
  text?: string;          // for step.stream
  output?: unknown;       // for step.done
  error?: string;         // for step.error / flow.error
  outputs?: Record<string, unknown>; // for flow.done
}

export interface FlowRunOptions {
  inputs?: Record<string, unknown>;
  onEvent?: (event: FlowEvent) => void;
  signal?: AbortSignal;
}

export interface FlowContext {
  runId: string;
  variables: Record<string, unknown>;
  inputs: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  iteration: number;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class FlowEngine {
  constructor(private readonly config: Config) {}

  /**
   * Run a flow to completion. Returns the evaluated output map.
   * Throws on fatal errors (missing provider, top-level abort).
   */
  async run(
    loadedFlow: LoadedFlow,
    opts: FlowRunOptions = {},
  ): Promise<Record<string, unknown>> {
    const flow = loadedFlow.def;
    const { inputs = {}, onEvent, signal } = opts;

    // Resolve & validate inputs against the flow's declared inputs schema
    const resolvedInputs = this.resolveInputs(flow, inputs);

    // Persist flow definition and create a run record
    const flowId = upsertFlow(loadedFlow);
    const runId = createFlowRun({
      flowId,
      flowVersion: 1,
      trigger: 'manual',
      inputJson: JSON.stringify(resolvedInputs),
    });

    const ctx: FlowContext = {
      runId,
      variables: {},
      inputs: resolvedInputs,
      stepOutputs: {},
      iteration: 0,
    };

    const emit = (event: Omit<FlowEvent, 'runId'>): void => {
      onEvent?.({ ...event, runId });
    };

    emit({ kind: 'flow.start' });

    try {
      await this.executeSteps(flow.steps as AnyStepType[], ctx, opts);

      // Evaluate output expressions
      const finalOutputs = this.evaluateOutputs(flow, ctx);

      updateFlowRun(runId, {
        status: 'succeeded',
        endedAt: new Date().toISOString(),
        outputJson: JSON.stringify(finalOutputs),
      });

      emit({ kind: 'flow.done', outputs: finalOutputs });
      return finalOutputs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      updateFlowRun(runId, {
        status: signal?.aborted ? 'cancelled' : 'failed',
        endedAt: new Date().toISOString(),
        errorJson: JSON.stringify({ message: msg }),
      });

      emit({ kind: 'flow.error', error: msg });
      throw err;
    }
  }

  // ─── Step dispatch ──────────────────────────────────────────────────────────

  private async executeSteps(
    steps: AnyStepType[],
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      await this.executeStep(step, i, ctx, opts);
    }
  }

  private async executeStep(
    step: AnyStepType,
    stepIndex: number,
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<void> {
    const { onEvent, signal } = opts;

    // Honour AbortSignal before each step
    if (signal?.aborted) throw new Error('Flow cancelled');

    // Evaluate `when` guard — skip step if expression is falsy
    if (step.when !== undefined && step.when.trim() !== '') {
      const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
      const shouldRun = evaluateCondition(step.when, exprCtx);
      if (!shouldRun) {
        onEvent?.({ kind: 'step.skip', runId: ctx.runId, stepId: step.id, stepIndex, iteration: ctx.iteration });
        upsertStepResult({ runId: ctx.runId, stepId: step.id, stepIndex, iteration: ctx.iteration, status: 'skipped' });
        return;
      }
    }

    const emit = (event: Omit<FlowEvent, 'runId'>): void => {
      onEvent?.({ ...event, runId: ctx.runId });
    };

    let retryCount = 0;
    const maxRetries = step.retries ?? 0;

    while (true) {
      emit({ kind: 'step.start', stepId: step.id, stepIndex, iteration: ctx.iteration });
      upsertStepResult({ runId: ctx.runId, stepId: step.id, stepIndex, iteration: ctx.iteration, status: 'running' });

      try {
        let output: unknown;

        // Build a per-step abort signal that respects the parent signal and
        // the step's own timeout (if any).
        let stepSignal = signal;
        if (step.timeoutMs !== undefined) {
          const timeoutController = new AbortController();
          const timeoutId = setTimeout(() => timeoutController.abort(new Error(`Step ${step.id} timed out after ${step.timeoutMs}ms`)), step.timeoutMs);
          if (signal !== undefined) {
            signal.addEventListener('abort', () => timeoutController.abort(signal.reason));
          }
          stepSignal = timeoutController.signal;
          // We'll clear the timeout after the step resolves
          try {
            output = await this.dispatchStep(step, ctx, { ...opts, signal: stepSignal });
          } finally {
            clearTimeout(timeoutId);
          }
        } else {
          output = await this.dispatchStep(step, ctx, opts);
        }

        // Store output in context
        ctx.stepOutputs[step.id] = output;
        if ('outputVar' in step && step.outputVar !== undefined) {
          ctx.variables[step.outputVar] = output;
        }

        upsertStepResult({
          runId: ctx.runId,
          stepId: step.id,
          stepIndex,
          iteration: ctx.iteration,
          status: 'succeeded',
          endedAt: new Date().toISOString(),
          outputJson: JSON.stringify(output),
        });

        emit({ kind: 'step.done', stepId: step.id, stepIndex, iteration: ctx.iteration, output });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (retryCount < maxRetries) {
          retryCount++;
          emit({ kind: 'step.retry', stepId: step.id, stepIndex, iteration: ctx.iteration, error: msg });
          // Exponential back-off: 500ms, 1000ms, 2000ms...
          await sleep(500 * Math.pow(2, retryCount - 1));
          continue;
        }

        upsertStepResult({
          runId: ctx.runId,
          stepId: step.id,
          stepIndex,
          iteration: ctx.iteration,
          status: 'failed',
          endedAt: new Date().toISOString(),
          errorJson: JSON.stringify({ message: msg }),
        });

        emit({ kind: 'step.error', stepId: step.id, stepIndex, iteration: ctx.iteration, error: msg });
        throw err;
      }
    }
  }

  private async dispatchStep(
    step: AnyStepType,
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<unknown> {
    switch (step.type) {
      case 'chat':
        return this.executeChatStep(step as ChatStep, ctx, opts);
      case 'tool':
        return this.executeToolStep(step as ToolStep, ctx, opts);
      case 'condition':
        return this.executeConditionStep(step as ConditionStepType, ctx, opts);
      case 'loop':
        return this.executeLoopStep(step as LoopStepType, ctx, opts);
      default: {
        const _never: never = step;
        throw new Error(`Unknown step type: ${(_never as { type: string }).type}`);
      }
    }
  }

  // ─── Chat step ──────────────────────────────────────────────────────────────

  private async executeChatStep(
    step: ChatStep,
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<string> {
    const { onEvent, signal } = opts;

    // Resolve provider — step.provider → config.headless.defaultProvider → DB default
    const providerConfig = this.resolveProvider(step.provider);

    const modelId =
      step.model ??
      providerConfig.defaultModel ??
      this.config.defaultModel ??
      'qwen2.5:7b';

    const apiKey = resolveSecret(providerConfig.apiKey) ?? '';

    const langModel = createLanguageModel({
      providerType: providerConfig.providerType,
      baseURL: providerConfig.baseUrl,
      apiKey,
      modelId,
    });

    const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
    const prompt = interpolate(step.prompt, exprCtx);
    const system = step.system !== undefined ? interpolate(step.system, exprCtx) : undefined;

    const messages: Array<{ role: 'user' | 'system'; content: string }> = [];
    if (system !== undefined) {
      messages.push({ role: 'system', content: system });
    }
    messages.push({ role: 'user', content: prompt });

    let accumulated = '';

    const streamOpts: Parameters<typeof streamText>[0] = {
      model: langModel,
      messages,
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    };

    const { fullStream } = streamText(streamOpts);

    for await (const event of fullStream) {
      if (signal?.aborted) break;
      if (event.type === 'text-delta') {
        accumulated += event.textDelta;
        onEvent?.({
          kind: 'step.stream',
          runId: ctx.runId,
          stepId: step.id,
          text: event.textDelta,
        });
      }
      if (event.type === 'error') {
        throw event.error instanceof Error ? event.error : new Error(String(event.error));
      }
    }

    return accumulated;
  }

  // ─── Tool step ──────────────────────────────────────────────────────────────

  private async executeToolStep(
    step: ToolStep,
    ctx: FlowContext,
    _opts: FlowRunOptions,
  ): Promise<unknown> {
    // Tool steps are a forward-looking placeholder. For now we support a small
    // set of built-in tools. External MCP tools would be wired here once the
    // flow engine has a McpManager reference.
    const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };

    // Interpolate all string values in args
    const resolvedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step.args)) {
      resolvedArgs[k] = typeof v === 'string' ? interpolate(v, exprCtx) : v;
    }

    if (step.tool.startsWith('builtin:')) {
      return this.executeBuiltinTool(step.tool.slice('builtin:'.length), resolvedArgs);
    }

    throw new Error(
      `Tool "${step.tool}" is not supported yet. Only builtin: tools are available in this release.`,
    );
  }

  private async executeBuiltinTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
      case 'http': {
        // Simple HTTP fetch — requires config.flows.allowHttpStep
        if (!this.config.flows.allowHttpStep) {
          throw new Error('HTTP tool is disabled. Set flows.allowHttpStep: true in config.');
        }
        const url = String(args['url'] ?? '');
        if (!url) throw new Error('builtin:http requires args.url');

        // Enforce HTTP allowlist when configured
        if (this.config.flows.httpAllowlist.length > 0) {
          const allowed = this.config.flows.httpAllowlist.some((pattern) => {
            try { return new URL(url).hostname.endsWith(pattern.replace(/^\*\./, '')); }
            catch { return false; }
          });
          if (!allowed) {
            throw new Error(`URL ${url} is not in flows.httpAllowlist`);
          }
        }

        const method = String(args['method'] ?? 'GET').toUpperCase();
        const headers = (args['headers'] as Record<string, string>) ?? {};
        const body = args['body'] !== undefined ? JSON.stringify(args['body']) : undefined;

        const fetchOpts: RequestInit = {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          signal: AbortSignal.timeout(30_000),
        };
        if (body !== undefined) fetchOpts.body = body;

        const res = await fetch(url, fetchOpts);

        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
      }

      default:
        throw new Error(`Unknown builtin tool: ${name}`);
    }
  }

  // ─── Condition step ─────────────────────────────────────────────────────────

  private async executeConditionStep(
    step: ConditionStepType,
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<null> {
    const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
    const result = evaluateCondition(step.expr, exprCtx);

    const branch = result ? step.then : (step.else ?? []);
    if (branch.length > 0) {
      await this.executeSteps(branch, ctx, opts);
    }

    return null;
  }

  // ─── Loop step ──────────────────────────────────────────────────────────────

  private async executeLoopStep(
    step: LoopStepType,
    ctx: FlowContext,
    opts: FlowRunOptions,
  ): Promise<null> {
    const { signal } = opts;
    const maxIter = step.maxIterations ?? 100;
    let iterCount = 0;

    if (step.kind === 'while') {
      const expr = step.expr ?? 'false';
      const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
      while (evaluateCondition(expr, exprCtx)) {
        if (signal?.aborted) throw new Error('Flow cancelled');
        if (iterCount >= maxIter) throw new Error(`Loop "${step.id}" exceeded maxIterations (${maxIter})`);

        const loopCtx: FlowContext = { ...ctx, iteration: iterCount };
        await this.executeSteps(step.body, loopCtx, opts);
        // Merge step outputs back into parent context
        Object.assign(ctx.stepOutputs, loopCtx.stepOutputs);
        Object.assign(ctx.variables, loopCtx.variables);

        iterCount++;
      }
    } else {
      // forEach
      const itemsExpr = step.items ?? '[]';
      const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
      const resolved = resolveExpression(itemsExpr, exprCtx);
      const items = Array.isArray(resolved) ? resolved : [];

      for (const item of items) {
        if (signal?.aborted) throw new Error('Flow cancelled');
        if (iterCount >= maxIter) throw new Error(`Loop "${step.id}" exceeded maxIterations (${maxIter})`);

        const loopCtx: FlowContext = {
          ...ctx,
          iteration: iterCount,
          variables: {
            ...ctx.variables,
            // Expose the current item under the configured alias (default: 'item')
            [step.as ?? 'item']: item,
          },
        };

        await this.executeSteps(step.body, loopCtx, opts);
        // Merge step outputs back into parent context
        Object.assign(ctx.stepOutputs, loopCtx.stepOutputs);
        // Intentionally do NOT merge loopCtx.variables — the loop variable
        // is scoped to the iteration; other variable mutations do propagate.
        for (const [k, v] of Object.entries(loopCtx.variables)) {
          if (k !== (step.as ?? 'item')) ctx.variables[k] = v;
        }

        iterCount++;
      }
    }

    return null;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private resolveProvider(providerIdHint?: string) {
    // Priority: explicit step.provider → config.headless.defaultProvider → DB default
    const id = providerIdHint ?? this.config.headless?.defaultProvider;

    if (id !== undefined) {
      const row = getProviderById(db, id);
      if (row !== undefined) return row;
      // Fall through to default if the named provider isn't found
    }

    const def = getDefaultProvider(db);
    if (def !== undefined) return def;

    throw new Error(
      'No provider configured. Add a provider via the TUI or config.json.',
    );
  }

  private resolveInputs(
    flow: FlowDef,
    provided: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [name, spec] of Object.entries(flow.inputs ?? {})) {
      if (provided[name] !== undefined) {
        resolved[name] = provided[name];
      } else if (spec.default !== undefined) {
        resolved[name] = spec.default;
      } else if (spec.required) {
        throw new Error(`Required input "${name}" was not provided for flow "${flow.name}"`);
      }
    }

    // Pass through any extra inputs the caller provided
    for (const [k, v] of Object.entries(provided)) {
      if (resolved[k] === undefined) resolved[k] = v;
    }

    return resolved;
  }

  private evaluateOutputs(
    flow: FlowDef,
    ctx: FlowContext,
  ): Record<string, unknown> {
    if (flow.outputs === undefined) return ctx.stepOutputs;

    const exprCtx = { stepOutputs: ctx.stepOutputs, inputs: ctx.inputs, variables: ctx.variables };
    const out: Record<string, unknown> = {};

    for (const [varName, exprStr] of Object.entries(flow.outputs)) {
      out[varName] = resolveExpression(exprStr, exprCtx);
    }

    return out;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
