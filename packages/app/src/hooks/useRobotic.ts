import { useState, useCallback, useRef } from 'react';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, roboticSessions, getProviderById, getDefaultProvider } from '@uplnk/db';
import { EventBus } from '@uplnk/shared';
import type { UplnkEvent } from '@uplnk/shared';
import { resolveSecret } from '../lib/secrets.js';
import { detectBestTransport } from '../robotic/transport/detect.js';
import { TmuxTransport } from '../robotic/transport/TmuxTransport.js';
import { PtyTransport } from '../robotic/transport/PtyTransport.js';
import { PipeTransport } from '../robotic/transport/PipeTransport.js';
import { RoboticController } from '../robotic/controller/RoboticController.js';
import { Redactor } from '../robotic/controller/redactor.js';
import { resolveTarget } from '../robotic/targets/Target.js';
import type { Config } from '../lib/config.js';
import type { Transport } from '../robotic/transport/Transport.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RoboticTurn {
  direction: 'uplnk->target' | 'target->uplnk';
  content: string;
  turn: number;
  timestamp: Date;
}

export interface RoboticState {
  sessionId: string | null;
  status: 'idle' | 'connecting' | 'running' | 'paused' | 'done' | 'error';
  target: string;
  goal: string;
  turns: RoboticTurn[];
  currentInstruction: string;
  /** 0..1 — updated by the judge LLM every everyNTurns turns */
  goalProgress: number;
  error?: string;
}

export interface UseRoboticResult {
  state: RoboticState;
  start: (opts: { target: string; goal: string; pane?: string }) => Promise<void>;
  abort: () => void;
  pause: () => void;
}

const INITIAL_STATE: RoboticState = {
  sessionId: null,
  status: 'idle',
  target: '',
  goal: '',
  turns: [],
  currentInstruction: '',
  goalProgress: 0,
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRobotic(config: Config): UseRoboticResult {
  const [state, setState] = useState<RoboticState>(INITIAL_STATE);

  const controllerRef = useRef<RoboticController | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(
    async (opts: { target: string; goal: string; pane?: string }) => {
      // Guard: robotic mode must be explicitly enabled
      if (!config.robotic?.enabled) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'Robotic mode is disabled. Set robotic.enabled = true in config.',
        }));
        return;
      }

      const sessionId = randomUUID();
      abortRef.current = new AbortController();

      setState({
        sessionId,
        status: 'connecting',
        target: opts.target,
        goal: opts.goal,
        turns: [],
        currentInstruction: '',
        goalProgress: 0,
      });

      // ── Persist session row ──────────────────────────────────────────────
      const transportKind = detectBestTransport(config.robotic.transport ?? 'auto');
      try {
        db.insert(roboticSessions).values({
          id: sessionId,
          target: opts.target,
          transport: transportKind,
          goal: opts.goal,
          status: 'running',
        }).run();
      } catch {
        // Non-fatal — UI still works without the row
      }

      // ── Create transport ─────────────────────────────────────────────────
      const targetConfig = resolveTarget(opts.target, config.robotic.targets);
      let transport: Transport;

      if (transportKind === 'tmux') {
        // Default pane: first available pane id, or let user specify
        const paneId = opts.pane ?? (process.env['TMUX_PANE'] ?? '%0');
        transport = new TmuxTransport({ pane: paneId });
      } else if (transportKind === 'pty') {
        const [cmd, ...args] = targetConfig.launch;
        transport = new PtyTransport(cmd ?? 'claude', args);
      } else {
        const [cmd, ...args] = targetConfig.launch;
        transport = new PipeTransport(cmd ?? 'claude', args);
      }

      transportRef.current = transport;

      try {
        await transport.start();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, status: 'error', error: msg }));
        updateSessionStatus(sessionId, 'failed');
        return;
      }

      // ── Resolve planner + judge providers ───────────────────────────────
      const judgeConfig = config.robotic.judge;

      // Judge provider — look up by id in DB, fall back to default
      const judgeProviderRow =
        getProviderById(db, judgeConfig.provider) ?? getDefaultProvider(db);

      if (judgeProviderRow === undefined) {
        setState((prev) => ({
          ...prev,
          status: 'error',
          error: 'No provider configured. Add one via /add-provider.',
        }));
        updateSessionStatus(sessionId, 'failed');
        await transport.close();
        return;
      }

      const judgeApiKey = resolveSecret(judgeProviderRow.apiKey) ?? '';

      // Use the same provider for planner unless a separate one is configured.
      // (The spec uses plannerProvider/plannerModel but config only has judge.*)
      const plannerProviderRow = judgeProviderRow;
      const plannerApiKey = judgeApiKey;

      // ── Set up event bus ─────────────────────────────────────────────────
      const bus = new EventBus();
      bus.subscribe((event: UplnkEvent) => {
        if (event.kind === 'robotic.inject') {
          setState((prev) => ({
            ...prev,
            currentInstruction: event.text,
            turns: [
              ...prev.turns,
              {
                direction: 'uplnk->target',
                content: event.text,
                turn: event.turn,
                timestamp: new Date(),
              },
            ],
          }));
        } else if (event.kind === 'robotic.read') {
          setState((prev) => ({
            ...prev,
            turns: [
              ...prev.turns,
              {
                direction: 'target->uplnk',
                content: event.text,
                turn: event.turn,
                timestamp: new Date(),
              },
            ],
          }));
        } else if (event.kind === 'robotic.turn') {
          setState((prev) => ({ ...prev, goalProgress: event.goalProgress }));
        } else if (event.kind === 'robotic.goal.met') {
          setState((prev) => ({ ...prev, status: 'done', goalProgress: 1 }));
        }
      });

      // ── Create redactor ──────────────────────────────────────────────────
      const redactOpts = config.robotic.redact ?? { envPatterns: [], customPatterns: [] };
      const redactor = new Redactor({
        envPatterns: redactOpts.envPatterns,
        customPatterns: redactOpts.customPatterns,
      });

      // ── Create controller ────────────────────────────────────────────────
      const controller = new RoboticController({
        transport,
        goal: opts.goal,
        sessionId,
        plannerProviderId: plannerProviderRow.id,
        plannerModel: judgeConfig.model,
        judgeProviderId: judgeProviderRow.id,
        judgeModel: judgeConfig.model,
        maxTurns: config.robotic.maxTurns,
        turnTimeoutMs: config.robotic.turnTimeoutMs,
        minInterTurnMs: config.robotic.minInterTurnMs,
        everyNTurns: judgeConfig.everyNTurns,
        redactor,
        bus,
        plannerBaseUrl: plannerProviderRow.baseUrl,
        plannerApiKey,
        plannerProviderType: plannerProviderRow.providerType,
        judgeBaseUrl: judgeProviderRow.baseUrl,
        judgeApiKey,
        judgeProviderType: judgeProviderRow.providerType,
        signal: abortRef.current.signal,
      });

      controllerRef.current = controller;

      setState((prev) => ({ ...prev, status: 'running' }));

      // ── Run (async — does not block the React render loop) ───────────────
      controller.run().then((result) => {
        const finalStatus = result === 'succeeded' ? 'done' : result === 'aborted' ? 'idle' : 'error';
        setState((prev) => ({
          ...prev,
          status: finalStatus,
          ...(result === 'failed' ? { error: 'Goal not achieved within turn limit.' } : {}),
        }));
        updateSessionStatus(sessionId, result === 'succeeded' ? 'succeeded' : result === 'aborted' ? 'aborted' : 'failed');
        void transport.close();
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, status: 'error', error: msg }));
        updateSessionStatus(sessionId, 'failed');
        void transport.close();
      });
    },
    [config],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    const sessionId = state.sessionId;
    if (sessionId !== null) updateSessionStatus(sessionId, 'aborted');
    void transportRef.current?.close();
    setState((prev) => ({ ...prev, status: 'idle', error: 'Aborted by user' }));
  }, [state.sessionId]);

  const pause = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => ({ ...prev, status: 'paused' }));
  }, []);

  return { state, start, abort, pause };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateSessionStatus(
  sessionId: string,
  status: 'running' | 'succeeded' | 'failed' | 'aborted',
): void {
  try {
    db.update(roboticSessions)
      .set({
        status,
        ...(status !== 'running' ? { endedAt: new Date().toISOString() } : {}),
      })
      .where(eq(roboticSessions.id, sessionId))
      .run();
  } catch {
    // Non-fatal — session status is informational
  }
}
