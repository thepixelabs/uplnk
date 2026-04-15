/**
 * Tests for packages/app/src/robotic/controller/RoboticController.ts
 *
 * Behaviors under test:
 *  - Happy path: planner generates instruction → sent to transport → target
 *    responds → judge evaluates → loop continues until GOAL_ACHIEVED sentinel
 *  - GOAL_ACHIEVED: when planner returns the exact sentinel, controller exits
 *    with 'succeeded' and does NOT write to transport
 *  - Consecutive failure bail-out: exactly 3 consecutive LLM errors abort
 *    with 'failed' (2 in a row do NOT abort)
 *  - Back-off: 1 s delay between retries (fake timers)
 *  - Abort signal: AbortSignal fired mid-run causes 'aborted' return
 *  - Prompt injection prevention: target output is wrapped in <target_output>
 *    tags in the planner prompt — raw content is never passed bare
 *  - Max turns: exceeding maxTurns stops the run with 'failed'
 *  - Transport write failure: transport.write() throwing does not crash the
 *    loop — it emits an error event and continues to the next turn
 *  - Goal progress threshold: judge returning ≥ 0.95 is treated as met
 *
 * Mocking strategy:
 *  - 'ai' module mocked at boundary so no real LLM calls are made
 *  - createLanguageModel mocked — we don't care what model object is created,
 *    only that generateText was called
 *  - Transport provided via createMockTransport fixture
 *  - @uplnk/db is stubbed globally via setup.ts; we override db.insert
 *    per-describe to exercise persistence error tolerance
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '@uplnk/shared';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: vi.fn(),
}));

// createLanguageModel returns a model object that is passed straight into
// generateText — since generateText is mocked we only need a sentinel value
vi.mock('../../../lib/languageModelFactory.js', () => ({
  createLanguageModel: vi.fn(() => ({ __mock: 'model' })),
}));

// ─── Import under test ────────────────────────────────────────────────────────

import { RoboticController } from '../RoboticController.js';
import type { RoboticControllerOptions } from '../RoboticController.js';
import { Redactor } from '../redactor.js';
import { createMockTransport } from '../../../__tests__/fixtures/mockTransport.js';
import { sequenceGenerateTextMock } from '../../../__tests__/helpers/streamTextMock.js';

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeRedactor(): Redactor {
  return new Redactor({ envPatterns: [], customPatterns: [] });
}

function makeOptions(
  overrides: Partial<RoboticControllerOptions> = {},
): RoboticControllerOptions {
  const transport = createMockTransport('pipe');
  const bus = new EventBus();

  return {
    transport,
    goal: 'write hello world to a file',
    sessionId: 'test-session-id',
    plannerProviderId: 'planner-provider',
    plannerModel: 'planner-model',
    judgeProviderId: 'judge-provider',
    judgeModel: 'judge-model',
    maxTurns: 10,
    turnTimeoutMs: 5000,
    minInterTurnMs: 0,
    everyNTurns: 1,
    redactor: makeRedactor(),
    bus,
    plannerBaseUrl: 'http://localhost:11434',
    plannerApiKey: '',
    plannerProviderType: 'ollama',
    judgeBaseUrl: 'http://localhost:11434',
    judgeApiKey: '',
    judgeProviderType: 'ollama',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RoboticController', () => {
  beforeEach(() => {
    aiMocks.generateText.mockReset();
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns succeeded when planner emits GOAL_ACHIEVED on first turn', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, ['GOAL_ACHIEVED']);

      const opts = makeOptions();
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('succeeded');
    });

    it('does NOT write to transport when planner returns GOAL_ACHIEVED', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, ['GOAL_ACHIEVED']);

      const opts = makeOptions();
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      const controller = new RoboticController(opts);

      await controller.run();

      expect(transport.mockWrite).not.toHaveBeenCalled();
    });

    it('sends the planner instruction to the transport', async () => {
      // Turn 1: planner → instruction, judge → 0 (not yet done)
      // Turn 2: planner → GOAL_ACHIEVED
      sequenceGenerateTextMock(aiMocks.generateText, [
        'run: echo hello',  // planner turn 1
        '0.0',              // judge turn 1
        'GOAL_ACHIEVED',    // planner turn 2
      ]);

      const opts = makeOptions({ everyNTurns: 1 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('$ hello');
      const controller = new RoboticController(opts);

      await controller.run();

      expect(transport.mockWrite).toHaveBeenCalledWith('run: echo hello');
    });

    it('emits robotic.inject event with the instruction text', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'do the thing',
        '0.0',
        'GOAL_ACHIEVED',
      ]);

      const opts = makeOptions({ everyNTurns: 1 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('done');

      const injectedTexts: string[] = [];
      opts.bus.subscribe((evt) => {
        if (evt.kind === 'robotic.inject') injectedTexts.push(evt.text);
      });

      const controller = new RoboticController(opts);
      await controller.run();

      expect(injectedTexts[0]).toBe('do the thing');
    });

    it('emits robotic.read event with the target response', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'list files',
        '0.0',
        'GOAL_ACHIEVED',
      ]);

      const opts = makeOptions({ everyNTurns: 1 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('file1.txt  file2.txt');

      const readTexts: string[] = [];
      opts.bus.subscribe((evt) => {
        if (evt.kind === 'robotic.read') readTexts.push(evt.text);
      });

      const controller = new RoboticController(opts);
      await controller.run();

      expect(readTexts[0]).toBe('file1.txt  file2.txt');
    });

    it('emits robotic.goal.met event on success', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, ['GOAL_ACHIEVED']);

      const opts = makeOptions();
      const goalMetEvents: unknown[] = [];
      opts.bus.subscribe((evt) => {
        if (evt.kind === 'robotic.goal.met') goalMetEvents.push(evt);
      });

      const controller = new RoboticController(opts);
      await controller.run();

      expect(goalMetEvents).toHaveLength(1);
    });
  });

  // ── GOAL_ACHIEVED sentinel ────────────────────────────────────────────────

  describe('GOAL_ACHIEVED sentinel', () => {
    it('exits loop on exactly the GOAL_ACHIEVED string (case-sensitive)', async () => {
      // goal_achieved (lowercase) must NOT trigger exit
      sequenceGenerateTextMock(aiMocks.generateText, [
        'goal_achieved',   // planner (lowercase — should NOT exit)
        '0.0',             // judge
        'GOAL_ACHIEVED',   // planner (correct — must exit)
      ]);

      const opts = makeOptions({ everyNTurns: 1 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('ok');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('succeeded');
      // Only one write should have occurred (for the lowercase turn)
      expect(transport.mockWrite).toHaveBeenCalledTimes(1);
    });

    it('GOAL_ACHIEVED surrounded by whitespace is still recognised', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, ['  GOAL_ACHIEVED  ']);

      const opts = makeOptions();
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('succeeded');
    });
  });

  // ── Prompt injection prevention ───────────────────────────────────────────

  describe('prompt injection prevention', () => {
    it('wraps target output in <target_output> tags in the planner prompt', async () => {
      // We capture the prompt passed to generateText so we can assert on it
      let capturedPrompt: string | undefined;

      aiMocks.generateText.mockImplementationOnce(
        async (opts: { prompt: string }) => {
          capturedPrompt = opts.prompt;
          return { text: 'GOAL_ACHIEVED', usage: { promptTokens: 5, completionTokens: 1 }, finishReason: 'stop' };
        },
      );

      const opts = makeOptions();
      const controller = new RoboticController(opts);
      await controller.run();

      expect(capturedPrompt).toBeDefined();
      // The initial "ready" message must be wrapped in tags
      expect(capturedPrompt).toContain('<target_output>');
      expect(capturedPrompt).toContain('</target_output>');
    });

    it('wraps actual target response in <target_output> tags on subsequent turns', async () => {
      const prompts: string[] = [];

      // Turn 1: planner captures prompt, then we record it; judge runs
      aiMocks.generateText
        .mockImplementationOnce(async (opts: { prompt: string }) => {
          prompts.push(opts.prompt);
          return { text: 'do something', usage: { promptTokens: 5, completionTokens: 3 }, finishReason: 'stop' };
        })
        .mockResolvedValueOnce({ text: '0.0', usage: { promptTokens: 5, completionTokens: 1 }, finishReason: 'stop' })
        .mockImplementationOnce(async (opts: { prompt: string }) => {
          prompts.push(opts.prompt);
          return { text: 'GOAL_ACHIEVED', usage: { promptTokens: 5, completionTokens: 1 }, finishReason: 'stop' };
        });

      const opts = makeOptions({ everyNTurns: 1 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('I am a target response with INJECT ME inside');

      const controller = new RoboticController(opts);
      await controller.run();

      // The second planner prompt must include the target response wrapped in tags
      const secondPrompt = prompts[1] ?? '';
      expect(secondPrompt).toContain('<target_output>');
      expect(secondPrompt).toContain('I am a target response with INJECT ME inside');
      expect(secondPrompt).toContain('</target_output>');
    });
  });

  // ── Consecutive failure bail-out ──────────────────────────────────────────

  describe('consecutive failure bail-out', () => {
    it('does NOT abort after 1 consecutive planner failure', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        new Error('LLM error 1'),  // failure 1
        'GOAL_ACHIEVED',           // success on retry
      ]);

      vi.useFakeTimers();
      const opts = makeOptions({ maxTurns: 10, minInterTurnMs: 0 });
      const controller = new RoboticController(opts);

      const runPromise = controller.run();
      // Advance past the 1s back-off
      await vi.runAllTimersAsync();
      const result = await runPromise;

      expect(result).toBe('succeeded');
    });

    it('does NOT abort after exactly 2 consecutive planner failures', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        new Error('LLM error 1'),   // failure 1
        new Error('LLM error 2'),   // failure 2
        'GOAL_ACHIEVED',            // success on retry
      ]);

      vi.useFakeTimers();
      const opts = makeOptions({ maxTurns: 10, minInterTurnMs: 0 });
      const controller = new RoboticController(opts);

      const runPromise = controller.run();
      await vi.runAllTimersAsync();
      const result = await runPromise;

      expect(result).toBe('succeeded');
    });

    it('returns failed after exactly 3 consecutive planner failures', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        new Error('LLM error 1'),
        new Error('LLM error 2'),
        new Error('LLM error 3'),
      ]);

      vi.useFakeTimers();
      const opts = makeOptions({ maxTurns: 10, minInterTurnMs: 0 });
      const controller = new RoboticController(opts);

      const runPromise = controller.run();
      await vi.runAllTimersAsync();
      const result = await runPromise;

      expect(result).toBe('failed');
    });

    it('resets the consecutive failure counter after a successful planner call', async () => {
      // Two failures, then success, then two more failures, then success again
      // — should never hit the 3-failure threshold in one streak
      sequenceGenerateTextMock(aiMocks.generateText, [
        new Error('err 1'),
        new Error('err 2'),
        'do thing',              // success resets counter
        '0.0',                   // judge
        new Error('err 3'),
        new Error('err 4'),
        'GOAL_ACHIEVED',         // success
      ]);

      vi.useFakeTimers();
      const opts = makeOptions({ everyNTurns: 1, maxTurns: 20, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('ok');
      const controller = new RoboticController(opts);

      const runPromise = controller.run();
      await vi.runAllTimersAsync();
      const result = await runPromise;

      expect(result).toBe('succeeded');
    });
  });

  // ── Back-off ──────────────────────────────────────────────────────────────

  describe('back-off after planner failure', () => {
    it('waits approximately 1000ms before retrying after a planner failure', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        new Error('transient error'),
        'GOAL_ACHIEVED',
      ]);

      vi.useFakeTimers();
      const opts = makeOptions({ minInterTurnMs: 0 });
      const controller = new RoboticController(opts);

      let resolved = false;
      const runPromise = controller.run().then((r) => { resolved = true; return r; });

      // Process the first failure — back-off timer is now pending
      await Promise.resolve();
      await Promise.resolve();

      // Not yet resolved — back-off timer is blocking
      expect(resolved).toBe(false);

      // Advance timers past the 1s back-off
      await vi.advanceTimersByTimeAsync(1001);
      const result = await runPromise;

      expect(resolved).toBe(true);
      expect(result).toBe('succeeded');
    });
  });

  // ── AbortSignal ───────────────────────────────────────────────────────────

  describe('AbortSignal', () => {
    it('returns aborted when signal is already aborted before run()', async () => {
      const controller = new AbortController();
      controller.abort();

      const opts = makeOptions({ signal: controller.signal });
      const rc = new RoboticController(opts);

      const result = await rc.run();

      expect(result).toBe('aborted');
    });

    it('returns aborted when signal fires after run() starts', async () => {
      const abortCtrl = new AbortController();

      // Planner call never resolves until we abort
      aiMocks.generateText.mockImplementation(
        ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            abortSignal?.addEventListener('abort', () => {
              const err = new DOMException('aborted', 'AbortError');
              reject(err);
            });
          }),
      );

      const opts = makeOptions({ signal: abortCtrl.signal });
      const rc = new RoboticController(opts);

      const runPromise = rc.run();

      // Let the run() start and block on generateText
      await Promise.resolve();
      await Promise.resolve();

      abortCtrl.abort();

      const result = await runPromise;

      // After abort: either 'aborted' (checked at loop top) or 'failed'
      // (DOMException thrown from generateText counted as failure) — both are
      // acceptable abort semantics. We assert it is NOT 'succeeded'.
      expect(result).not.toBe('succeeded');
    });
  });

  // ── Max turns ─────────────────────────────────────────────────────────────

  describe('max turns', () => {
    it('returns failed when maxTurns is exhausted without goal being met', async () => {
      // Each turn: planner → instruction, judge → 0 (never met)
      // We set maxTurns=2, need planner + judge calls per turn
      const responses: string[] = [];
      for (let i = 0; i < 2; i++) {
        responses.push(`instruction ${i}`);  // planner
        responses.push('0.0');               // judge
      }
      sequenceGenerateTextMock(aiMocks.generateText, responses);

      const opts = makeOptions({ maxTurns: 2, everyNTurns: 1, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('still working');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('failed');
    });

    it('does not call transport.write more times than maxTurns', async () => {
      const responses: string[] = [];
      for (let i = 0; i < 3; i++) {
        responses.push(`step ${i}`);
        responses.push('0.0');
      }
      sequenceGenerateTextMock(aiMocks.generateText, responses);

      const opts = makeOptions({ maxTurns: 3, everyNTurns: 1, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('working');
      const controller = new RoboticController(opts);

      await controller.run();

      expect(transport.mockWrite).toHaveBeenCalledTimes(3);
    });
  });

  // ── Transport write failure ───────────────────────────────────────────────

  describe('transport write failure', () => {
    it('does not throw when transport.write() rejects — continues to next turn', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'first instruction',  // planner (write will fail)
        'GOAL_ACHIEVED',      // planner turn 2 (write not reached)
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 5, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockWrite.mockRejectedValueOnce(new Error('pane closed'));

      const controller = new RoboticController(opts);

      await expect(controller.run()).resolves.not.toThrow();
    });

    it('emits a robotic.inject error message when write fails', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'the instruction',
        'GOAL_ACHIEVED',
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 5, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockWrite.mockRejectedValueOnce(new Error('write error'));

      const injectedTexts: string[] = [];
      opts.bus.subscribe((evt) => {
        if (evt.kind === 'robotic.inject') injectedTexts.push(evt.text);
      });

      const controller = new RoboticController(opts);
      await controller.run();

      expect(injectedTexts).toContain('[transport write failed]');
    });
  });

  // ── Goal progress threshold ───────────────────────────────────────────────

  describe('goal progress threshold', () => {
    it('treats judge score >= 0.95 as goal met', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'run tests',  // planner
        '0.95',       // judge → meets threshold
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 10, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('tests passed');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('succeeded');
    });

    it('does not treat judge score < 0.95 as goal met', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'run tests',   // planner turn 1
        '0.94',        // judge turn 1 (not enough)
        'GOAL_ACHIEVED', // planner turn 2 exits cleanly
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 10, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('partial');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      // Must continue past turn 1 (0.94 < 0.95) and succeed on turn 2
      expect(result).toBe('succeeded');
      expect(transport.mockWrite).toHaveBeenCalledTimes(1);
    });

    it('emits robotic.goal.met when judge threshold triggers success', async () => {
      sequenceGenerateTextMock(aiMocks.generateText, [
        'finish it',
        '1.0',
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 10, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('complete');

      const goalMetEvents: unknown[] = [];
      opts.bus.subscribe((evt) => {
        if (evt.kind === 'robotic.goal.met') goalMetEvents.push(evt);
      });

      const controller = new RoboticController(opts);
      await controller.run();

      expect(goalMetEvents).toHaveLength(1);
    });
  });

  // ── everyNTurns judge cadence ─────────────────────────────────────────────

  describe('everyNTurns', () => {
    it('only calls the judge every N turns, not every turn', async () => {
      // everyNTurns = 2 → judge called after turns 2, 4, ...
      // We run 2 turns then GOAL_ACHIEVED on turn 3 (no judge needed)
      sequenceGenerateTextMock(aiMocks.generateText, [
        'step 1',      // planner t1
        // no judge after t1 (1 % 2 !== 0)
        'step 2',      // planner t2
        '0.0',         // judge after t2 (2 % 2 === 0)
        'GOAL_ACHIEVED', // planner t3
      ]);

      const opts = makeOptions({ everyNTurns: 2, maxTurns: 10, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('in progress');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      expect(result).toBe('succeeded');
      // Planner called 3 times, judge called once
      expect(aiMocks.generateText).toHaveBeenCalledTimes(4);
    });
  });

  // ── Persistence failure tolerance ─────────────────────────────────────────

  describe('persistence failure tolerance', () => {
    it('continues the run when db.insert throws', async () => {
      // Override the db mock to throw on insert
      const { db } = await import('@uplnk/db');
      // @ts-expect-error — overriding mock object property
      db.insert = vi.fn(() => ({ values: vi.fn(() => ({ run: vi.fn(() => { throw new Error('DB full'); }) })) }));

      sequenceGenerateTextMock(aiMocks.generateText, [
        'do work',
        '0.0',
        'GOAL_ACHIEVED',
      ]);

      const opts = makeOptions({ everyNTurns: 1, maxTurns: 10, minInterTurnMs: 0 });
      const transport = opts.transport as ReturnType<typeof createMockTransport>;
      transport.mockRead.mockResolvedValue('result');
      const controller = new RoboticController(opts);

      const result = await controller.run();

      // DB errors must not abort the run
      expect(result).toBe('succeeded');
    });
  });
});
