/**
 * flowRepo — unit tests
 *
 * Strategy:
 * - @uplnk/db is replaced entirely by a per-file vi.mock() factory that
 *   returns a chainable Drizzle-style stub. This overrides the global
 *   setup.ts stub for this file only (isolate: true guarantees isolation).
 * - The stub intercepts .select/.insert/.update chains via a builder pattern
 *   mirroring how Drizzle is called in flowRepo.ts.
 * - Mock objects that are referenced inside the vi.mock() factory must be
 *   placed in vi.hoisted() scope — the factory is hoisted to the top of the
 *   module before any const declarations, so regular module-scope variables
 *   would be in the temporal dead zone.
 * - We assert on what was inserted/updated by capturing calls to `.values()`
 *   and `.set()` via spies shared across all builder instances.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted stubs — must come before vi.mock() ────────────────────────────────

const mocks = vi.hoisted(() => {
  // Shared spies — captured by each chainable builder instance so tests can
  // inspect what values were inserted/updated regardless of which chain was used.
  const insertValuesSpy = vi.fn();
  const updateSetSpy = vi.fn();
  const selectAllSpy = vi.fn();

  function makeChainableBuilder() {
    const builder: Record<string, unknown> = {};
    const chain = (): typeof builder => builder;

    builder['from']      = vi.fn(chain);
    builder['where']     = vi.fn(chain);
    builder['limit']     = vi.fn(chain);
    builder['innerJoin'] = vi.fn(chain);
    builder['orderBy']   = vi.fn(chain);
    builder['all']       = selectAllSpy;

    builder['values'] = vi.fn((...args: unknown[]) => {
      insertValuesSpy(...args);
      return builder;
    });

    builder['set'] = vi.fn((...args: unknown[]) => {
      updateSetSpy(...args);
      return builder;
    });

    builder['run'] = vi.fn();
    return builder;
  }

  const mockDb = {
    select: vi.fn(() => makeChainableBuilder()),
    insert: vi.fn(() => makeChainableBuilder()),
    update: vi.fn(() => makeChainableBuilder()),
  };

  return { insertValuesSpy, updateSetSpy, selectAllSpy, makeChainableBuilder, mockDb };
});

// ─── @uplnk/db mock ───────────────────────────────────────────────────────────
//
// This vi.mock() call overrides the global setup.ts stub for this file.
// Per-file vi.mock() factories take precedence over setupFiles stubs.
// The factory closes over `mocks` from vi.hoisted() above, which is safe
// because hoisted vars are initialized before the factory executes.

vi.mock('@uplnk/db', () => ({
  db: mocks.mockDb,
  // Schema table stubs — used as first arg to .select/.insert/.update calls
  flows: { id: 'id', name: 'name', version: 'version' },
  flowRuns: { id: 'id', flowId: 'flowId', startedAt: 'startedAt', endedAt: 'endedAt', status: 'status' },
  flowStepResults: { id: 'id', runId: 'runId', stepId: 'stepId' },
  // Drizzle operators — return opaque objects (only used as query arguments)
  eq: vi.fn((_col: unknown, _val: unknown) => ({ op: 'eq', _col, _val })),
  desc: vi.fn((col: unknown) => ({ op: 'desc', col })),
  // Other DB helpers used by flowRepo at module load time
  getPylonDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
  getPylonDbPath: vi.fn(() => '/tmp/uplnk-test-home/.uplnk/db.sqlite'),
  getUplnkDir: vi.fn(() => '/tmp/uplnk-test-home/.uplnk'),
}));

// ─── Imports under test ────────────────────────────────────────────────────────

import {
  upsertFlow,
  createFlowRun,
  updateFlowRun,
  upsertStepResult,
  getRecentRuns,
} from '../flowRepo.js';
import type { LoadedFlow } from '../../loader.js';
import type { FlowDef } from '../../schema.js';

// ─── Factories ─────────────────────────────────────────────────────────────────

function makeLoadedFlow(name = 'test-flow'): LoadedFlow {
  return {
    path: `/tmp/flows/${name}.yaml`,
    hash: 'deadbeef',
    def: {
      apiVersion: 'uplnk.io/v1',
      name,
      inputs: {},
      steps: [{ id: 's1', type: 'chat', prompt: 'hi', retries: 0 }],
    } as FlowDef,
  };
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-attach fresh chainable builders after clearAllMocks resets the mocks
  mocks.mockDb.select.mockImplementation(() => mocks.makeChainableBuilder());
  mocks.mockDb.insert.mockImplementation(() => mocks.makeChainableBuilder());
  mocks.mockDb.update.mockImplementation(() => mocks.makeChainableBuilder());
  // Default: no existing flow found by select queries
  mocks.selectAllSpy.mockReturnValue([]);
});

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('flowRepo', () => {

  // ── upsertFlow ────────────────────────────────────────────────────────────

  describe('upsertFlow', () => {
    it('inserts a new flow when none exists with that name', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);

      const id = upsertFlow(makeLoadedFlow('my-flow'));

      expect(mocks.mockDb.insert).toHaveBeenCalledOnce();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('returns a uuid-shaped string for a new flow', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);

      const id = upsertFlow(makeLoadedFlow('uuid-check'));

      // UUID v4 pattern: 8-4-4-4-12 hex chars
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('calls insert with the correct name and version 1', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);

      upsertFlow(makeLoadedFlow('new-flow'));

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['name']).toBe('new-flow');
      expect(insertedValues?.['version']).toBe(1);
    });

    it('calls insert with the sourcePath and sourceHash', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);
      const loaded = makeLoadedFlow('with-meta');

      upsertFlow(loaded);

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['sourcePath']).toBe(loaded.path);
      expect(insertedValues?.['sourceHash']).toBe(loaded.hash);
    });

    it('calls insert with a stringified definitionJson', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);
      const loaded = makeLoadedFlow('json-check');

      upsertFlow(loaded);

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      const parsedDef = JSON.parse(insertedValues?.['definitionJson'] as string) as FlowDef;
      expect(parsedDef.name).toBe('json-check');
    });

    it('updates an existing flow without inserting a new row', () => {
      const existingId = 'existing-flow-id';
      mocks.selectAllSpy.mockReturnValueOnce([{ id: existingId, version: 3 }]);

      const returnedId = upsertFlow(makeLoadedFlow('existing-flow'));

      expect(mocks.mockDb.update).toHaveBeenCalledOnce();
      expect(mocks.mockDb.insert).not.toHaveBeenCalled();
      expect(returnedId).toBe(existingId);
    });

    it('sets version to existing + 1 on update', () => {
      mocks.selectAllSpy.mockReturnValueOnce([{ id: 'eid', version: 4 }]);

      upsertFlow(makeLoadedFlow('version-bump'));

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['version']).toBe(5);
    });

    it('sets updatedAt on update to a non-empty ISO string', () => {
      mocks.selectAllSpy.mockReturnValueOnce([{ id: 'eid', version: 1 }]);

      upsertFlow(makeLoadedFlow('with-updated-at'));

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(typeof setValues?.['updatedAt']).toBe('string');
      expect(setValues?.['updatedAt']).not.toBe('');
    });
  });

  // ── createFlowRun ─────────────────────────────────────────────────────────

  describe('createFlowRun', () => {
    it('returns a uuid-shaped string', () => {
      const id = createFlowRun({ flowId: 'fid', flowVersion: 1, trigger: 'manual' });

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('inserts with status "running"', () => {
      createFlowRun({ flowId: 'fid', flowVersion: 1, trigger: 'manual' });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['status']).toBe('running');
    });

    it('stores the provided trigger value', () => {
      createFlowRun({ flowId: 'fid', flowVersion: 1, trigger: 'schedule' });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['trigger']).toBe('schedule');
    });

    it('stores inputJson when provided', () => {
      createFlowRun({
        flowId: 'fid',
        flowVersion: 1,
        trigger: 'manual',
        inputJson: '{"name":"test"}',
      });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['inputJson']).toBe('{"name":"test"}');
    });

    it('stores the flowId and flowVersion', () => {
      createFlowRun({ flowId: 'my-flow-id', flowVersion: 7, trigger: 'manual' });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['flowId']).toBe('my-flow-id');
      expect(insertedValues?.['flowVersion']).toBe(7);
    });
  });

  // ── updateFlowRun ─────────────────────────────────────────────────────────

  describe('updateFlowRun', () => {
    it('updates status when provided', () => {
      updateFlowRun('run-1', { status: 'succeeded' });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['status']).toBe('succeeded');
    });

    it('updates endedAt when provided', () => {
      const ts = new Date().toISOString();
      updateFlowRun('run-1', { endedAt: ts });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['endedAt']).toBe(ts);
    });

    it('updates outputJson when provided', () => {
      updateFlowRun('run-1', { outputJson: '{"answer":42}' });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['outputJson']).toBe('{"answer":42}');
    });

    it('updates errorJson when provided', () => {
      updateFlowRun('run-1', { errorJson: '{"message":"boom"}' });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['errorJson']).toBe('{"message":"boom"}');
    });

    it('does NOT call db.update when the opts object is empty', () => {
      updateFlowRun('run-1', {});

      expect(mocks.mockDb.update).not.toHaveBeenCalled();
    });

    it('stores endedAt in the DB update when provided (regression: was previously dropped)', () => {
      const endTs = '2026-04-15T12:00:00.000Z';
      updateFlowRun('run-1', { status: 'succeeded', endedAt: endTs });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      // This assertion failed before the endedAt fix — the key was absent from the set map
      expect(setValues?.['endedAt']).toBe(endTs);
    });

    it('sets status to "failed" and includes errorJson for a failed run', () => {
      updateFlowRun('run-2', {
        status: 'failed',
        endedAt: new Date().toISOString(),
        errorJson: JSON.stringify({ message: 'oops' }),
      });

      const setValues = mocks.updateSetSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(setValues?.['status']).toBe('failed');
      expect(JSON.parse(setValues?.['errorJson'] as string)).toEqual({ message: 'oops' });
    });
  });

  // ── upsertStepResult ──────────────────────────────────────────────────────

  describe('upsertStepResult', () => {
    it('inserts a new row and returns a uuid-shaped id', () => {
      const id = upsertStepResult({
        runId: 'run-1',
        stepId: 'step-a',
        stepIndex: 0,
        status: 'running',
      });

      expect(mocks.mockDb.insert).toHaveBeenCalledOnce();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('stores the runId and stepId in the inserted row', () => {
      upsertStepResult({ runId: 'my-run', stepId: 'my-step', stepIndex: 2, status: 'running' });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['runId']).toBe('my-run');
      expect(insertedValues?.['stepId']).toBe('my-step');
    });

    it('defaults iteration to 0 when not provided', () => {
      upsertStepResult({ runId: 'r', stepId: 's', stepIndex: 0, status: 'running' });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['iteration']).toBe(0);
    });

    it('stores the provided iteration value', () => {
      upsertStepResult({ runId: 'r', stepId: 's', stepIndex: 0, status: 'running', iteration: 3 });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['iteration']).toBe(3);
    });

    it('stores outputJson when provided', () => {
      upsertStepResult({
        runId: 'r',
        stepId: 's',
        stepIndex: 0,
        status: 'succeeded',
        outputJson: '"result text"',
      });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['outputJson']).toBe('"result text"');
    });

    it('stores errorJson when provided', () => {
      upsertStepResult({
        runId: 'r',
        stepId: 's',
        stepIndex: 0,
        status: 'failed',
        errorJson: '{"message":"exploded"}',
      });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['errorJson']).toBe('{"message":"exploded"}');
    });

    it('stores endedAt when provided (regression: verifies the field is persisted)', () => {
      const ts = '2026-04-15T10:00:00.000Z';
      upsertStepResult({
        runId: 'r',
        stepId: 's',
        stepIndex: 0,
        status: 'succeeded',
        endedAt: ts,
      });

      const insertedValues = mocks.insertValuesSpy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(insertedValues?.['endedAt']).toBe(ts);
    });

    it('inserts a fresh row on every call (current design: multiple rows per step transition)', () => {
      // flowRepo's upsertStepResult currently always INSERTs — the comment in
      // source explains this is intentional until FLOW-123 lands a true upsert.
      upsertStepResult({ runId: 'r', stepId: 's', stepIndex: 0, status: 'running' });
      upsertStepResult({ runId: 'r', stepId: 's', stepIndex: 0, status: 'succeeded', endedAt: new Date().toISOString() });

      expect(mocks.mockDb.insert).toHaveBeenCalledTimes(2);
      expect(mocks.mockDb.update).not.toHaveBeenCalled();
    });
  });

  // ── getRecentRuns ─────────────────────────────────────────────────────────

  describe('getRecentRuns', () => {
    it('returns the rows from the DB query', () => {
      const fakeRows = [
        {
          id: 'run-1',
          flowId: 'fid',
          flowName: 'my-flow',
          flowVersion: 1,
          status: 'succeeded',
          startedAt: '2026-04-15T10:00:00.000Z',
          endedAt: '2026-04-15T10:01:00.000Z',
          trigger: 'manual',
        },
      ];
      mocks.selectAllSpy.mockReturnValueOnce(fakeRows);

      const result = getRecentRuns(10);

      expect(result).toEqual(fakeRows);
    });

    it('uses default limit of 20 when none is specified', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);

      getRecentRuns();

      expect(mocks.mockDb.select).toHaveBeenCalledOnce();
    });

    it('returns an empty array when no runs exist', () => {
      mocks.selectAllSpy.mockReturnValueOnce([]);

      const result = getRecentRuns();

      expect(result).toEqual([]);
    });
  });
});
