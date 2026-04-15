import { useState, useCallback, useEffect } from 'react';
import type { Config } from '../lib/config.js';
import { detectAltergo, getAltergoHome } from '../altergo/detect.js';
import { listAltergoAccounts } from '../altergo/accounts.js';
import type { AltergoAccount } from '../altergo/accounts.js';
import { getAllSessions } from '../altergo/sessions/index.js';
import type { UnifiedSession } from '../altergo/sessions/index.js';
import { importSession, importAllSessions } from '../altergo/importer.js';
import { launchAltergoAccount } from '../altergo/launcher.js';

export interface AltergoState {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  accounts: AltergoAccount[];
  sessions: UnifiedSession[];
  loading: boolean;
  error?: string;
  /** Set of sourcePaths currently being imported */
  importing: Set<string>;
}

const INITIAL_STATE: AltergoState = {
  installed: false,
  accounts: [],
  sessions: [],
  loading: true,
  importing: new Set(),
};

/**
 * Hook that manages altergo detection, account listing, session discovery,
 * session import, and launching.
 *
 * All file-system operations that might block are run via setTimeout(0) so
 * the Ink render loop stays responsive. The hook is safe to use even when
 * altergo is not installed — all calls degrade gracefully.
 */
export function useAltergo(config: Config) {
  const [state, setState] = useState<AltergoState>(INITIAL_STATE);

  const refresh = useCallback(() => {
    setState((s) => {
      const next = { ...s, loading: true };
      delete next.error;
      return next;
    });

    // Defer to the next tick so the loading indicator renders before we block
    setTimeout(() => {
      try {
        const binaryName = config.altergo?.binary ?? 'altergo';
        const info = detectAltergo(binaryName);
        const altergoHome = getAltergoHome(config.altergo?.home);

        if (!info.installed) {
          setState({
            installed: false,
            accounts: [],
            sessions: [],
            loading: false,
            importing: new Set(),
          });
          return;
        }

        const accounts = listAltergoAccounts(altergoHome);
        const accountNames = accounts.map((a) => a.name);
        const sessions = getAllSessions(altergoHome, accountNames);

        const next: AltergoState = {
          installed: true,
          accounts,
          sessions,
          loading: false,
          importing: new Set(),
        };
        if (info.binaryPath !== undefined) next.binaryPath = info.binaryPath;
        if (info.version !== undefined) next.version = info.version;
        setState(next);
      } catch (err) {
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }, 0);
  }, [config.altergo?.binary, config.altergo?.home]);

  /**
   * Import a single session. Marks the session as importing, runs the import,
   * then clears the mark. The sessions list is not re-scanned — just the
   * importing set changes so the UI can show a spinner.
   */
  const importOne = useCallback(async (session: UnifiedSession) => {
    setState((s) => ({
      ...s,
      importing: new Set([...s.importing, session.sourcePath]),
    }));
    try {
      await importSession(session);
    } catch {
      // Errors are surfaced implicitly — the importing indicator clears
    } finally {
      setState((s) => {
        const next = new Set(s.importing);
        next.delete(session.sourcePath);
        return { ...s, importing: next };
      });
    }
  }, []);

  /**
   * Import all sessions for a specific account. Marks all affected source
   * paths as importing, then runs importAllSessions for just that account.
   */
  const importAll = useCallback(
    async (account: string) => {
      const altergoHome = getAltergoHome(config.altergo?.home);
      const accountSessions = state.sessions.filter((s) => s.account === account);
      const paths = new Set(accountSessions.map((s) => s.sourcePath));

      setState((s) => ({
        ...s,
        importing: new Set([...s.importing, ...paths]),
      }));

      try {
        await importAllSessions(altergoHome, [account]);
      } catch {
        // importAllSessions already handles per-session errors internally
      } finally {
        setState((s) => {
          const next = new Set(s.importing);
          for (const p of paths) next.delete(p);
          return { ...s, importing: next };
        });
      }
    },
    [config.altergo?.home, state.sessions],
  );

  /**
   * Launch an altergo account. The launch is fire-and-forget when detached
   * (the default). A missing binary is silently ignored — the UI should
   * gate this on state.installed.
   */
  const launch = useCallback(
    (account: string, provider?: string) => {
      if (!state.installed || state.binaryPath === undefined) return;
      try {
        launchAltergoAccount(state.binaryPath, account, provider, {
          detach: config.altergo?.launchDetach ?? true,
        });
      } catch {
        // Validation errors from launchAltergoAccount — caller can add error
        // handling if needed, but we swallow here to keep the TUI alive
      }
    },
    [state.installed, state.binaryPath, config.altergo?.launchDetach],
  );

  // Detect and load on mount
  useEffect(() => {
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    refresh,
    importSession: importOne,
    importAll,
    launch,
  };
}
