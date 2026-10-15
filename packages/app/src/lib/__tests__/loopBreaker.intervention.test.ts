/**
 * loopBreaker.intervention — unit tests for wrapToolsWithLoopBreaker.
 *
 * The wrapper is the execute-time guard: the 3rd consecutive identical tool
 * call (same tool name + normalized-args-hash) is blocked and replaced with
 * LOOP_BREAKER_SYNTHETIC_RESULT instead of executing. `intervene: false`
 * preserves the previous emit-only behaviour (tools pass through untouched).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  wrapToolsWithLoopBreaker,
  LOOP_BREAKER_SYNTHETIC_RESULT,
  LOOP_BREAKER_INTERVENE_THRESHOLD,
} from '../loopBreaker.js';

interface StubTool {
  description: string;
  execute?: (args: unknown, options: unknown) => unknown;
}

function makeStubTool(): { tool: StubTool; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn((args: unknown) => `ran:${JSON.stringify(args)}`);
  return { tool: { description: 'stub', execute: spy }, spy };
}

describe('wrapToolsWithLoopBreaker', () => {
  it('executes the first two identical calls normally', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });

    expect(wrapped['t']!.execute!({ q: 'x' }, {})).toBe('ran:{"q":"x"}');
    expect(wrapped['t']!.execute!({ q: 'x' }, {})).toBe('ran:{"q":"x"}');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('blocks the 3rd identical call with the synthetic result (no execution)', () => {
    const { tool, spy } = makeStubTool();
    const onIntervene = vi.fn();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool }, { onIntervene });

    wrapped['t']!.execute!({ q: 'x' }, {});
    wrapped['t']!.execute!({ q: 'x' }, {});
    const third = wrapped['t']!.execute!({ q: 'x' }, {});

    expect(third).toBe(LOOP_BREAKER_SYNTHETIC_RESULT);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(onIntervene).toHaveBeenCalledTimes(1);
    expect(onIntervene).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 't', occurrence: LOOP_BREAKER_INTERVENE_THRESHOLD }),
    );
  });

  it('keeps blocking identical repeats after the threshold', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });

    for (let i = 0; i < 5; i++) wrapped['t']!.execute!({ q: 'x' }, {});

    expect(spy).toHaveBeenCalledTimes(2); // calls 3, 4, 5 all blocked
  });

  it('resets the counter when args change', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });

    wrapped['t']!.execute!({ q: 'x' }, {});
    wrapped['t']!.execute!({ q: 'x' }, {});
    wrapped['t']!.execute!({ q: 'DIFFERENT' }, {}); // resets the run
    const backToX = wrapped['t']!.execute!({ q: 'x' }, {}); // run restarts at 1

    expect(backToX).toBe('ran:{"q":"x"}');
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('normalizes args for the identity check (key order does not matter)', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });

    wrapped['t']!.execute!({ a: 1, b: 2 }, {});
    wrapped['t']!.execute!({ b: 2, a: 1 }, {});
    const third = wrapped['t']!.execute!({ a: 1, b: 2 }, {});

    expect(third).toBe(LOOP_BREAKER_SYNTHETIC_RESULT);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('resets the counter when a different tool is called in between', () => {
    const a = makeStubTool();
    const b = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ a: a.tool, b: b.tool });

    wrapped['a']!.execute!({ q: 'x' }, {});
    wrapped['a']!.execute!({ q: 'x' }, {});
    wrapped['b']!.execute!({ q: 'x' }, {}); // breaks the run
    const fourth = wrapped['a']!.execute!({ q: 'x' }, {});

    expect(fourth).toBe('ran:{"q":"x"}');
    expect(a.spy).toHaveBeenCalledTimes(3);
    expect(b.spy).toHaveBeenCalledTimes(1);
  });

  it('intervene:false returns the tools untouched (emit-only behaviour preserved)', () => {
    const { tool, spy } = makeStubTool();
    const tools = { t: tool };
    const onIntervene = vi.fn();
    const wrapped = wrapToolsWithLoopBreaker(tools, { intervene: false, onIntervene });

    expect(wrapped).toBe(tools); // identity — nothing was wrapped

    for (let i = 0; i < 5; i++) wrapped['t']!.execute!({ q: 'x' }, {});
    expect(spy).toHaveBeenCalledTimes(5);
    expect(onIntervene).not.toHaveBeenCalled();
  });

  it('passes tools without an execute through untouched', () => {
    const noExec: StubTool = { description: 'client-side' };
    const wrapped = wrapToolsWithLoopBreaker({ t: noExec });
    expect(wrapped['t']).toBe(noExec);
  });

  it('honours a custom threshold', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool }, { threshold: 2 });

    wrapped['t']!.execute!({ q: 'x' }, {});
    const second = wrapped['t']!.execute!({ q: 'x' }, {});

    expect(second).toBe(LOOP_BREAKER_SYNTHETIC_RESULT);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never blocks calls with unhashable args', () => {
    const { tool, spy } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });
    const weird = { fn: () => 42 };

    for (let i = 0; i < 4; i++) wrapped['t']!.execute!(weird, {});
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('preserves other tool properties on the wrapped object', () => {
    const { tool } = makeStubTool();
    const wrapped = wrapToolsWithLoopBreaker({ t: tool });
    expect(wrapped['t']!.description).toBe('stub');
  });
});
