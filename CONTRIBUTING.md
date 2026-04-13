# Contributing to uplnk

uplnk is Apache 2.0 licensed and uses a [Developer Certificate of Origin (DCO)](https://developercertificate.org/). By submitting a pull request you certify that you have the right to contribute the code under those terms. Sign off each commit with `git commit -s`.

---

## Prerequisites

| Tool | Minimum version | Notes |
|---|---|---|
| Node.js | 20 | Check with `node --version` |
| pnpm | 9 | `npm install -g pnpm` |
| Ollama | any | [ollama.com](https://ollama.com) — needed to run the app locally |

The repo uses pnpm workspaces. Do not use `npm` or `yarn` — lockfile conflicts will block CI.

---

## Dev setup

```bash
# 1. Clone
git clone https://github.com/thepixelabs/uplnk.git
cd uplnk

# 2. Install dependencies (all packages)
pnpm install

# 3. Start Ollama (in a separate terminal if not running as a service)
ollama serve
ollama pull llama3.2

# 4. Run the app in dev mode
pnpm dev
```

`pnpm dev` runs `tsx bin/uplnk.ts` inside `packages/app` with TypeScript executed directly — no build step needed during development. Changes to source files take effect on the next invocation.

To run with specific flags:

```bash
pnpm --filter uplnk-dev dev -- --model qwen2.5-coder:7b --theme light
```

---

## Project structure

```
uplnk/
├── packages/
│   ├── app/          # uplnk-dev — the Ink TUI application and CLI entry point
│   │   ├── bin/
│   │   │   └── uplnk.ts          # CLI arg parsing, migrations, Ink render()
│   │   └── src/
│   │       ├── components/       # React/Ink UI components
│   │       │   ├── artifacts/    # ArtifactPanel — side-pane code viewer
│   │       │   ├── chat/         # ChatInput, MessageList, StreamingMessage
│   │       │   ├── layout/       # Header, StatusBar, ErrorBanner
│   │       │   └── mcp/          # ApprovalDialog for command-exec consent
│   │       ├── hooks/            # useStream, useConversation, useArtifacts,
│   │       │                     # useMcp, useModelSelector
│   │       ├── lib/
│   │       │   ├── colors.ts     # Terminal color system (dark + light themes)
│   │       │   ├── config.ts     # ~/.uplnk/config.json read/write + Zod schema
│   │       │   ├── doctor.ts     # uplnk doctor preflight checks
│   │       │   ├── errors.ts     # Error normalisation → UplnkError
│   │       │   ├── syntax.ts     # Code block syntax highlighting
│   │       │   └── mcp/
│   │       │       ├── McpManager.ts   # MCP child-process lifecycle + tool registry
│   │       │       └── security.ts     # Path allowlist + command validation
│   │       └── screens/          # ChatScreen, ModelSelectorScreen,
│   │                             # ConversationListScreen
│   ├── db/           # uplnk-db — Drizzle ORM schema, migrations, queries
│   │   ├── migrations/           # SQL migration files
│   │   └── src/
│   │       ├── schema.ts         # Drizzle table definitions
│   │       ├── queries.ts        # Typed query helpers
│   │       ├── client.ts         # better-sqlite3 singleton
│   │       └── migrate.ts        # runMigrations() called at startup
│   └── shared/       # uplnk-shared — types shared across packages
│       └── src/
│           ├── errors.ts         # UplnkError type + error codes
│           └── index.ts
├── pnpm-workspace.yaml
└── package.json      # Root — lint, typecheck, test scripts
```

The dependency direction is strictly: `app` → `db`, `app` → `shared`, `db` → `shared`. `shared` has no internal dependencies.

---

## Running tests

```bash
# All packages, single run
pnpm test

# Watch mode (reruns on file changes)
pnpm test:watch

# Specific package
pnpm --filter uplnk-dev test
```

Tests use [Vitest](https://vitest.dev/). Unit tests live alongside source files in `__tests__/` subdirectories (e.g., `packages/app/src/lib/__tests__/`). Integration tests use a separate config (`vitest.integration.config.ts`) and are not run in CI by default — run them manually before submitting changes to streaming or MCP code.

Type-checking runs separately from tests:

```bash
pnpm typecheck
```

---

## Commit message format

uplnk uses [Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <short summary>

[optional body]

[optional footer — include Signed-off-by here]
```

**Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`

**Scopes:** `app`, `db`, `shared`, `mcp`, `streaming`, `config`, `doctor`, `ci`

Examples:

```
feat(streaming): add 33ms flush interval to reduce React reconciler work
fix(mcp): respect allowedPaths when listing directories recursively
docs(readme): add keyboard shortcut table
chore(deps): upgrade drizzle-orm to 0.45.0
```

Keep the summary line under 72 characters. Use the body to explain *why*, not *what* — the diff shows what changed.

---

## PR process

1. **Open an issue first** for anything non-trivial. Describe the problem and proposed approach before writing code. This avoids wasted effort.

2. **Branch from `main`:**
   ```bash
   git checkout -b feat/your-feature-name
   ```

3. **Keep PRs small and focused.** One logical change per PR. If your change touches both the streaming layer and the UI, split it into two PRs.

4. **Before submitting:**
   ```bash
   pnpm typecheck   # must pass with zero errors
   pnpm lint        # must pass with zero errors
   pnpm test        # all tests must pass
   uplnk doctor     # must show all checks green on your machine
   ```

5. **Fill in the PR template.** Describe what changed, why, and how you tested it. Include a short terminal recording or screenshot for UI changes.

6. **Sign your commits:**
   ```bash
   git commit -s -m "feat(app): your change"
   ```

7. A maintainer will review within a few business days. Expect feedback. Address comments with new commits — do not force-push during review.

---

## Reporting bugs

Open a GitHub issue. Include:

- Output of `uplnk doctor`
- Output of `uplnk --version`
- Your OS and terminal emulator
- Steps to reproduce
- Contents of `/tmp/uplnk-crash.log` (if a crash occurred)

Do not include API keys, file contents with sensitive data, or private conversation history in issue reports.
