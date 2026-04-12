# MCP Security Fixes Required
**For engineering team — do NOT merge command-exec until these are resolved**  
**Date:** 2026-04-12  
**Sign-off ref:** `internal-doc/mcp-security-signoff.md`

---

## Fix 1 — CRITICAL: Add command allowlist to `validateCommand()` in `security.ts`

Blocking condition BC-1. See FINDING-001 in the full review.

### Change required in `packages/app/src/lib/mcp/security.ts`

Add the allowlist constant near the top of the command validation section, and add the check as the first operation in `validateCommand()`.

```typescript
// Add this constant near BLOCKED_COMMAND_PATTERNS:
export const ALLOWED_COMMANDS = new Set([
  // File inspection (read-only)
  'ls', 'cat', 'head', 'tail', 'wc',
  // Search
  'find', 'grep', 'rg', 'fd',
  // Version control (read ops + safe write ops with approval)
  'git',
  // Build tools
  'tsc', 'eslint', 'prettier',
  // Package managers (no install scripts without approval)
  'npm', 'npx', 'pnpm', 'yarn',
  // Linters / formatters
  'jq',
  // EXPLICITLY NOT INCLUDED:
  // python3, node, ruby, perl, bash, sh, zsh, dash
  // curl, wget, nc, ncat, netcat, socat
  // ssh, scp, sftp, rsync
  // rm, mv, cp, chmod, chown, chgrp, ln
  // tee, dd, mkfs, fdisk, diskutil
  // sudo, su, doas
  // osascript, open (macOS automation)
  // eval, exec, source
  // docker, podman, kubectl
  // openssl, gpg, keychain
]);

// Add this helper after resolveReal():
import { execFileSync as _execFileSync } from 'node:child_process';

const ALLOWED_BIN_DIRS = [
  '/usr/bin',
  '/usr/local/bin',
  '/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/sbin',
  '/sbin',
];

function resolveBinaryPath(cmd: string): string | null {
  // If cmd is already an absolute path, use it directly.
  if (cmd.startsWith('/')) return cmd;
  try {
    const result = _execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 2000 });
    return result.trim();
  } catch {
    return null;
  }
}

function isBinaryInAllowedDir(absoluteBinPath: string): boolean {
  return ALLOWED_BIN_DIRS.some(
    (dir) => absoluteBinPath === dir + '/' + absoluteBinPath.split('/').at(-1),
  );
}
```

Then update `validateCommand()`:

```typescript
export function validateCommand(
  cmd: CommandValidation,
  policy: FileAccessPolicy,
): ValidationResult {
  // ── Step 0: Allowlist check ─────────────────────────────────────────────
  // Extract the binary name (basename only — prevents /usr/bin/rm from
  // sneaking past a check on "rm").
  const binaryBasename = cmd.command.split('/').at(-1) ?? cmd.command;
  if (!ALLOWED_COMMANDS.has(binaryBasename)) {
    return {
      allowed: false,
      reason: `Command '${binaryBasename}' is not permitted.`,
    };
  }

  // ── Step 1: Resolve binary and verify it is in a known system directory ─
  const resolvedBin = resolveBinaryPath(cmd.command);
  if (resolvedBin === null || !isBinaryInAllowedDir(resolvedBin)) {
    return {
      allowed: false,
      reason: `Command binary could not be resolved to a permitted system directory.`,
    };
  }

  // ── Step 2: Denylist patterns on the full joined command ────────────────
  const fullCommand = [cmd.command, ...cmd.args].join(' ');
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(fullCommand)) {
      return {
        allowed: false,
        reason: `Command blocked by security policy: matches dangerous pattern.`,
      };
    }
  }

  // ── Step 3: Per-argument metacharacter check ────────────────────────────
  const BLOCKED_ARG_PATTERNS: RegExp[] = [
    /[|;&`$(){}<>]/,
    /\.\.\//,
    /\/dev\/(tcp|udp)/,
  ];
  for (const arg of cmd.args) {
    for (const pattern of BLOCKED_ARG_PATTERNS) {
      if (pattern.test(arg)) {
        return {
          allowed: false,
          reason: `Argument contains blocked characters or path traversal.`,
        };
      }
    }
  }

  // ── Step 4: Working directory validation ────────────────────────────────
  if (cmd.cwd !== undefined) {
    const cwdValidation = validateFilePath(cmd.cwd, policy);
    if (!cwdValidation.allowed) {
      return {
        allowed: false,
        reason: `Working directory not allowed: ${cwdValidation.reason}`,
      };
    }
  }

  return { allowed: true };
}
```

---

## Fix 2 — HIGH: Return resolved path from `validateFilePath()` and use it for I/O

Blocking condition FB-1 (file-browse ship blocker) and part of BC-1. See FINDING-003.

### Change required in `packages/app/src/lib/mcp/security.ts`

Update the `ValidationResult` type:

```typescript
export type ValidationResult =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: string };
```

Update `validateFilePath()` to include `resolvedPath` in the success return:

```typescript
// At the end of validateFilePath(), replace:
return { allowed: true };
// With:
return { allowed: true, resolvedPath: resolved };
```

### Change required in `packages/app/src/lib/mcp/McpManager.ts`

In `buildFileReadTool.execute()`:

```typescript
const validation = validateFilePath(path, policy);
if (!validation.allowed) {
  throw new Error(`MCP_TOOL_DENIED: ${validation.reason}`);
}
// Use validation.resolvedPath for all subsequent I/O:
const canonicalPath = validation.resolvedPath;

// Size check:
const sizeCheck = (() => {
  try {
    const st = statSync(canonicalPath);  // <-- was: statSync(path)
    return st.size <= policy.maxReadBytes;
  } catch {
    return true;
  }
})();

if (!sizeCheck) {
  throw new Error(`MCP_TOOL_DENIED: File exceeds size limit.`);
}

try {
  return readFileSync(canonicalPath, 'utf-8');  // <-- was: readFileSync(path, ...)
} catch (err) {
  throw new Error(`MCP_TOOL_DENIED: Could not read the requested file.`);
  // Do not propagate err.message — it may contain the full path.
}
```

Apply the same `canonicalPath` substitution to `buildFileListTool.execute()` for the initial `validateFilePath` call and all `statSync`/`readdirSync` calls that follow.

---

## Fix 3 — MEDIUM: Cap `maxDepth` in `mcp_file_list`

Blocking condition BC-5 (partial). See FINDING-005.

### Change required in `packages/app/src/lib/mcp/McpManager.ts`

In the Zod schema for `buildFileListTool`:

```typescript
// Replace:
maxDepth: z.number().optional().describe('...'),
// With:
maxDepth: z.number().int().min(1).max(5).optional().describe('Maximum recursion depth (1–5, default: 3)'),
```

In the `execute` body:

```typescript
// After destructuring, add:
const effectiveMaxDepth = Math.min(maxDepth ?? 3, 5);
const MAX_ENTRIES = 500;

// In walk(), replace:
if (depth > maxDepth) return;
// With:
if (depth > effectiveMaxDepth) return;

// After the entries.push() call inside the loop:
if (entries.length >= MAX_ENTRIES) {
  entries.push(`(output truncated at ${MAX_ENTRIES} entries)`);
  return; // Stop walking
}
```

---

## Fix 4 — MEDIUM: Degrade LLM description in ApprovalDialog

Blocking condition BC-4. See FINDING-006.

### Change required in `packages/app/src/components/mcp/ApprovalDialog.tsx`

```tsx
// Replace the description block:
{request.description !== undefined && request.description.length > 0 && (
  <Box marginBottom={1}>
    <Text color="white">{request.description}</Text>
  </Box>
)}

// With:
{request.description !== undefined && request.description.length > 0 && (
  <Box marginBottom={1} flexDirection="column">
    <Text color="gray" dimColor>AI description (unverified — read the command below):</Text>
    <Text color="gray" dimColor italic>{request.description}</Text>
  </Box>
)}
```

Ensure the command display (`fullCommand`) appears above the description block in the render order, so the user's eyes land on the verifiable information first.

---

## Fix 5 — MEDIUM: Add rate limiting to `useMcp`

Blocking condition BC-5. See FINDING-008.

### Change required in `packages/app/src/hooks/useMcp.ts`

```typescript
const TOOL_CALL_LIMITS = {
  perConversation: 100,
} as const;

// Add inside useMcp, near pendingResolversRef:
const toolCallCountRef = useRef(0);

// Add a wrapper in the McpManager config:
// Wrap requestApproval to also enforce the rate limit at the approval gate.
// Additionally, wrap the tools returned by getAiSdkTools() to increment the counter
// and throw if the limit is exceeded:

const tools = useMemo(() => {
  const rawTools = managerRef.current!.getAiSdkTools();
  const guarded: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(rawTools)) {
    guarded[name] = {
      ...tool,
      execute: async (...args: Parameters<NonNullable<typeof tool.execute>>) => {
        toolCallCountRef.current++;
        if (toolCallCountRef.current > TOOL_CALL_LIMITS.perConversation) {
          throw new Error('MCP_TOOL_DENIED: Tool call limit for this conversation has been reached.');
        }
        return tool.execute?.(...args);
      },
    };
  }
  return guarded;
}, []);
```

### Change required in `packages/app/src/hooks/useStream.ts`

```typescript
// Line 66 — reduce maxSteps:
maxSteps: 5,  // was: 10
```

---

## Fix 6 — MEDIUM: Add append-only audit log

Blocking condition BC-6. See FINDING-007.

### New utility in `packages/app/src/lib/mcp/audit.ts` (new file)

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPylonDir } from 'pylon-db';

export interface AuditEntry {
  tool: string;
  args: Record<string, unknown>;
  result: 'allowed' | 'denied';
  detail?: string;
}

export function mcpAudit(entry: AuditEntry): void {
  try {
    mkdirSync(getPylonDir(), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    appendFileSync(join(getPylonDir(), 'mcp-audit.log'), line, 'utf-8');
  } catch {
    // Audit log failure must never block tool execution — but should be surfaced
    // as a warning in the StatusBar if possible.
  }
}
```

Call `mcpAudit()` at the start of each `execute` callback (before the validation check) and again after the validation result is known. For `mcp_command_exec`, also log the approval decision and the command exit code.

---

## Fix 7 — LOW: Generic error messages in file I/O (do not expose paths to LLM)

See FINDING-009. Apply when doing Fix 2:

In `buildFileReadTool.execute()`, the catch block should be:
```typescript
throw new Error(`MCP_TOOL_DENIED: Could not read the requested file.`);
```
Not:
```typescript
throw new Error(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
```

In `validateFilePath`, the denied-outside-root reason should be:
```typescript
reason: 'Access denied: path is outside the allowed directories.',
// Remove the list of allowedRoots from this string.
```

---

## Testing Requirements

Before re-review, the engineering team must add or update tests for:

1. `security.test.ts` — add test cases for:
   - `validateCommand` with a non-allowlisted binary (expect denied)
   - `validateCommand` with an arg containing `|` (expect denied)
   - `validateCommand` with an arg containing `../` (expect denied)
   - `validateCommand` with `python3` (expect denied)
   - `validateFilePath` returning `resolvedPath` on success

2. `McpManager` integration test (or unit test with mocked fs) — verify that `buildFileReadTool` uses the resolved path, not the raw path, for `readFileSync`.

3. `useMcp` test — verify tool call counter increments and throws at limit.
