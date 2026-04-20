/**
 * MutexRegistry — advisory per-tool-name lock used inside a multi-agent room
 * to guard genuinely side-effecting tools against concurrent invocation by
 * sibling agents (e.g. two agents both calling `mcp_command_exec` or
 * `mcp_git_commit` in the same turn).
 *
 * Policy: `reject` — the second caller receives a TOOL_BUSY error instead of
 * queueing. Queueing hides the race instead of surfacing it; in practice we
 * prefer the model to see a clear error and decide how to proceed.
 *
 * The lock is process-global and best-effort: it does not coordinate with
 * outside-of-uplnk code that also touches the same resources.
 */

const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  'mcp_command_exec',
  'mcp_git_commit',
  'mcp_git_stage',
]);

export class MutexRegistry {
  private readonly held = new Map<string, string>(); // toolName → holderId

  isProtected(toolName: string): boolean {
    return PROTECTED_TOOLS.has(toolName);
  }

  /** Attempt to acquire a lock. Returns true if acquired, false if busy. */
  tryAcquire(toolName: string, holderId: string): boolean {
    if (!PROTECTED_TOOLS.has(toolName)) return true;
    if (this.held.has(toolName)) return false;
    this.held.set(toolName, holderId);
    return true;
  }

  release(toolName: string, holderId: string): void {
    if (this.held.get(toolName) === holderId) {
      this.held.delete(toolName);
    }
  }

  /** Currently-held locks, for inspection. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.held);
  }
}

/**
 * Wrap a tool's execute() so it acquires the mutex before running and releases
 * it on resolution/rejection. Non-protected tools pass through untouched.
 *
 * The return shape mirrors the AI SDK Tool's execute signature but stays typed
 * as `unknown` since we handle Tool<any,any> uniformly.
 */
export function withMutex<T>(
  registry: MutexRegistry,
  toolName: string,
  holderId: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!registry.isProtected(toolName)) return run();
  const ok = registry.tryAcquire(toolName, holderId);
  if (!ok) {
    return Promise.reject(
      new Error(
        `TOOL_BUSY: ${toolName} is currently in use by another agent in this room turn. Try again after the other agent releases it.`,
      ),
    );
  }
  return run().finally(() => registry.release(toolName, holderId));
}
