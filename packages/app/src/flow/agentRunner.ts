/**
 * buildAgentRunner — constructs the FlowEngine's injected `agentRunner`
 * dependency from the real AgentOrchestrator.
 *
 * Both call sites — the headless CLI (`uplnk flow run`) and the TUI
 * FlowRunnerScreen — share this factory so agent steps behave identically in
 * both surfaces. The orchestrator is assembled the same way ChatScreen does
 * it (registry + modelFactory + eventBus + skill/memory registries), with one
 * deliberate gap:
 *
 * TODO(flow-mcp): `rootTools` defaults to {} because MCP tools require the
 * approval flow that only ChatScreen currently renders (useMcp +
 * pendingApproval UI). Until a flow-side approval surface exists, agents
 * invoked from flows run tool-less unless the caller passes `rootTools`.
 */

import { db, getDefaultProvider, getProviderById } from '@uplnk/db';
import type { Tool } from 'ai';
import { AgentOrchestrator } from '../lib/agents/orchestrator.js';
import { getAgentRegistry } from '../lib/agents/registry.js';
import { getGlobalAgentEventBus } from '../lib/agents/eventBus.js';
import { getSkillRegistry } from '../lib/skills/registry.js';
import { getMemoryRegistry, MemoryStore } from '../lib/memory/index.js';
import { createLanguageModel } from '../lib/languageModelFactory.js';
import { resolveSecret } from '../lib/secrets.js';
import type { Config } from '../lib/config.js';
import type { AgentRunner } from './engine/FlowEngine.js';

export interface BuildAgentRunnerOptions {
  config: Config;
  /** Project dir for project-local agent/skill/memory definitions (.uplnk/…). */
  projectDir?: string;
  /**
   * Root tool set inherited by invoked agents. Defaults to none — see
   * TODO(flow-mcp) above.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rootTools?: Record<string, Tool<any, any>>;
}

export function buildAgentRunner(opts: BuildAgentRunnerOptions): AgentRunner {
  const { config, projectDir, rootTools = {} } = opts;

  const registryOpts = projectDir !== undefined ? { projectDir } : undefined;
  const registry = getAgentRegistry(registryOpts);
  const skillRegistry = getSkillRegistry(registryOpts);
  const memoryRegistry = getMemoryRegistry(registryOpts);
  const memoryStore = new MemoryStore(registryOpts);
  const eventBus = getGlobalAgentEventBus();

  // Provider resolution mirrors FlowEngine.resolveProvider: explicit id first
  // (agent frontmatter `provider:` or config.headless.defaultProvider), then
  // the DB default provider row.
  const resolveProviderRow = (providerIdHint?: string) => {
    const id = providerIdHint ?? config.headless?.defaultProvider;
    if (id !== undefined) {
      const row = getProviderById(db, id);
      if (row !== undefined) return row;
      // Fall through to default if the named provider isn't found
    }
    const def = getDefaultProvider(db);
    if (def !== undefined) return def;
    throw new Error('No provider configured. Add a provider via the TUI or config.json.');
  };

  const orchestrator = new AgentOrchestrator({
    registry,
    modelFactory: (spec) => {
      const providerRow = resolveProviderRow(spec.provider);
      // 'inherit' has no parent model in a flow run — resolve the same
      // fallback chain FlowEngine's chat steps use.
      const modelId =
        spec.model !== 'inherit'
          ? spec.model
          : providerRow.defaultModel ?? config.defaultModel ?? 'qwen2.5:7b';
      return createLanguageModel({
        providerType: providerRow.providerType,
        baseURL: providerRow.baseUrl,
        apiKey: resolveSecret(providerRow.apiKey) ?? '',
        modelId,
      });
    },
    rootTools,
    eventBus,
    skillRegistry,
    memoryRegistry,
    memoryStore,
    // Loop-breaker intervention policy (defaults to intervene:true when the
    // config key is absent — e.g. older test fixtures).
    ...(config.loopBreaker !== undefined ? { loopBreaker: config.loopBreaker } : {}),
  });

  return async ({ agentName, prompt, model, abortSignal }) => {
    const agent = registry.get(agentName);
    if (agent === undefined) {
      const available = registry.list().map((a) => a.name).join(', ');
      throw new Error(
        `Unknown agent "${agentName}". Available agents: ${available !== '' ? available : '(none)'}`,
      );
    }

    // Step-level model override — clone the def rather than mutate the
    // registry's cached instance.
    const effectiveAgent = model !== undefined ? { ...agent, model } : agent;

    const result = await orchestrator.run({
      agent: effectiveAgent,
      userPrompt: prompt,
      signal: abortSignal ?? new AbortController().signal,
    });

    return { summary: result.finalText, runId: result.invocationId };
  };
}
