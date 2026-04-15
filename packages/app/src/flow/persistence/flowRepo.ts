import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { db } from '@uplnk/db';
import { flows, flowRuns, flowStepResults } from '@uplnk/db';
import type { LoadedFlow } from '../loader.js';

// ─── Flow definitions ─────────────────────────────────────────────────────────

/**
 * Upsert a flow definition by name. Returns the row id.
 * Increments version on each update so flow_runs can reference the version
 * that was active when they ran.
 */
export function upsertFlow(loaded: LoadedFlow): string {
  const existing = db
    .select({ id: flows.id, version: flows.version })
    .from(flows)
    .where(eq(flows.name, loaded.def.name))
    .limit(1)
    .all();

  if (existing.length > 0 && existing[0] !== undefined) {
    const { id, version } = existing[0];
    db.update(flows)
      .set({
        sourcePath: loaded.path,
        sourceHash: loaded.hash,
        definitionJson: JSON.stringify(loaded.def),
        version: version + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(flows.id, id))
      .run();
    return id;
  }

  const id = randomUUID();
  db.insert(flows)
    .values({
      id,
      name: loaded.def.name,
      version: 1,
      sourcePath: loaded.path,
      sourceHash: loaded.hash,
      definitionJson: JSON.stringify(loaded.def),
    })
    .run();
  return id;
}

// ─── Flow runs ────────────────────────────────────────────────────────────────

export interface CreateFlowRunOpts {
  flowId: string;
  flowVersion: number;
  trigger: string;
  inputJson?: string;
}

export function createFlowRun(opts: CreateFlowRunOpts): string {
  const id = randomUUID();
  db.insert(flowRuns)
    .values({
      id,
      flowId: opts.flowId,
      flowVersion: opts.flowVersion,
      trigger: opts.trigger,
      status: 'running',
      inputJson: opts.inputJson,
    })
    .run();
  return id;
}

export interface UpdateFlowRunOpts {
  status?: string;
  endedAt?: string;
  outputJson?: string;
  errorJson?: string;
}

export function updateFlowRun(id: string, update: UpdateFlowRunOpts): void {
  const set: Record<string, unknown> = {};
  if (update.status !== undefined) set['status'] = update.status;
  if (update.endedAt !== undefined) set['endedAt'] = update.endedAt;
  if (update.outputJson !== undefined) set['outputJson'] = update.outputJson;
  if (update.errorJson !== undefined) set['errorJson'] = update.errorJson;

  if (Object.keys(set).length === 0) return;

  db.update(flowRuns).set(set).where(eq(flowRuns.id, id)).run();
}

// ─── Step results ─────────────────────────────────────────────────────────────

export interface UpsertStepResultOpts {
  runId: string;
  stepId: string;
  stepIndex: number;
  iteration?: number;
  status: string;
  endedAt?: string;
  inputJson?: string;
  outputJson?: string;
  errorJson?: string;
  messageId?: string;
}

/**
 * Record a step result. Despite the name, this currently always INSERTs a
 * new row — the FlowEngine calls it once per state transition (running,
 * then succeeded/failed/skipped) so multiple rows per step are intentional
 * in the current design. Queries that want the latest state should join
 * `MAX(started_at) GROUP BY (run_id, step_id, iteration)` or migrate the
 * schema to add a UNIQUE(run_id, step_id, iteration) and switch this to
 * a real onConflictDoUpdate.
 *
 * Follow-up: see FLOW-123 — DB migration to make this a true upsert.
 */
export function upsertStepResult(opts: UpsertStepResultOpts): string {
  const id = randomUUID();
  db.insert(flowStepResults)
    .values({
      id,
      runId: opts.runId,
      stepId: opts.stepId,
      stepIndex: opts.stepIndex,
      iteration: opts.iteration ?? 0,
      status: opts.status,
      endedAt: opts.endedAt,
      inputJson: opts.inputJson,
      outputJson: opts.outputJson,
      errorJson: opts.errorJson,
      messageId: opts.messageId,
    })
    .run();
  return id;
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export interface FlowRunWithName {
  id: string;
  flowId: string;
  flowName: string;
  flowVersion: number;
  status: string;
  startedAt: string;
  endedAt: string | null;
  trigger: string;
}

export function getRecentRuns(limit = 20): FlowRunWithName[] {
  const rows = db
    .select({
      id: flowRuns.id,
      flowId: flowRuns.flowId,
      flowName: flows.name,
      flowVersion: flowRuns.flowVersion,
      status: flowRuns.status,
      startedAt: flowRuns.startedAt,
      endedAt: flowRuns.endedAt,
      trigger: flowRuns.trigger,
    })
    .from(flowRuns)
    .innerJoin(flows, eq(flowRuns.flowId, flows.id))
    .orderBy(desc(flowRuns.startedAt))
    .limit(limit)
    .all();

  return rows;
}
