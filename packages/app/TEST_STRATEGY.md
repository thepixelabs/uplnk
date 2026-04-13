# Uplnk Test Strategy

Audience: qa-engineer, staff-engineer, devops.
Scope: `packages/app` (Ink/React TUI). Sibling packages (`db`, `shared`, `catalog`, `providers`) have their own suites and are out of scope for this document.
Status of suite at audit time: **48 files passing, 1 file failing, 1112 / 1113 individual tests passing**. `pnpm test:integration` is **broken** — it references `vitest.integration.config.ts` which does not exist.

---

## 1. Audit Snapshot

### 1.1 Test runner configuration

- Vitest 2.1, `environment: 'node'` (correct — Ink renders to stdout, not DOM).
- `setupFiles: src/__tests__/setup.ts` — globally stubs `node:os.homedir()` to `/tmp/uplnk-test-home` and replaces `@uplnk/db` with in-memory `vi.fn()` shims so no test ever touches a real SQLite file or `~/.uplnk` directory. **Good baseline; keep it.**
- Workspace package aliases resolve sibling packages from source — no pre-build required.
- v8 coverage with per-path thresholds (security/errors at 95/90, hooks at 75/70, components at 70/65). **The thresholds are present but no CI gate reports were observed; coverage is collected but no one is failing on regressions.**
- `isolate: true` — prevents per-file `vi.mock()` cross-pollination. Keep.

### 1.2 Currently failing test

```
src/lib/rag/__tests__/indexer.test.ts > getAllEmbeddedChunks filters out chunks with null embedding
ReferenceError: and is not defined
```

This is **the H3 hotfix surfacing as a real defect**. `indexer.ts` imports `and` from `drizzle-orm` but the test mocks `drizzle-orm` (or imports a stub via the global `@uplnk/db` mock) such that `and` resolves to `undefined`. The implementation is also functionally wrong — see §4 H3.

### 1.3 Broken integration suite

`packages/app/package.json` defines:

```
"test:integration": "vitest run --config vitest.integration.config.ts"
```

The config file is absent. **No integration tests are currently runnable.** This is a critical infrastructure gap — every test in the suite runs with mocked DB, mocked fs, mocked `ai.streamText`. We have **zero** end-to-end confidence that the wiring between hooks, drizzle, SQLite, and Ink components actually works. See §5.

### 1.4 Coverage map (high level)

| Area | File count | Coverage assessment |
|---|---|---|
| Hooks | 3 (useStream, useConversation, useMcp.merge / useMcp.ratelimit) | useStream good, useConversation good, useMcp partial. **Missing:** useArtifacts, useSplitPane covered. **No** dedicated tests for useWorkflow or useNetworkScan. |
| Lib (pure) | modelRouter, languageModelFactory, roles, syntax, networkScanner, fileMention, projectContext, secrets, exportConversation, doctor.* — all well-tested | Strong. modelRouter has 36 tests across complexity branches. |
| MCP | security (×2), McpManager (×2), McpManager.audit, McpManager.ratelimit, file-browse-write, git | Decent surface coverage. **Gaps:** transport-death recovery (onclose/onerror), HTTP transport path, command-exec child spawn integration, audit log rotation. |
| RAG | embedder, watcher, indexer, rag-security | indexer test exists but the production code is broken (H3). Watcher tests use mocked `node:fs`. **No real SQLite-backed integration test.** |
| Workflows | workflowEngine (5 tests) | Smoke level. Anchor phase + tool path largely untested. |
| Plugins | registry | OK. |
| Screens | ConversationListScreen, ProviderSelectorScreen, AddProviderScreen.edit, ChatScreen.fork | **No tests for RelayRunScreen, NetworkScanScreen, RelayPickerScreen, RelayEditorScreen.** Critical for H1. |
| Components | ChatInput (×3), MarkdownMessage (×2), CommandPalette, ApprovalDialog, ArtifactPanel | Component layer broadly covered for the hot path. |

### 1.5 Source/test ratio for the load-bearing files

| File | LOC | Direct test? | Notes |
|---|---|---|---|
| `hooks/useStream.ts` | 266 | Yes (rich) | Solid. Persist cadence + abort path covered. |
| `hooks/useConversation.ts` | 88 | Yes | OK. Does **not** test the `addMessageWithId` + `updateMessageInState` pair against the duplicate-row regression (H2). |
| `lib/modelRouter.ts` | 148 | Yes (36) | Strong. |
| `lib/mcp/McpManager.ts` | ~700 (split read) | Partial — audit + ratelimit + manager basics | Transport death, HTTP path, child crash recovery untested. |
| `lib/mcp/servers/command-exec.ts` | ~80 | **No** | Only the `validateCommand` boundary in McpManager is tested — the actual child server is not exercised at all. |
| `lib/rag/indexer.ts` | 400 | Yes (chunkText + Indexer) | The single failing test sits here. The bug is real. |
| `lib/workflows/workflowEngine.ts` | 200+ | Yes (5 tests, scout-only happy path) | Anchor phase, tool injection, mid-stream abort during anchor are uncovered. |

---

## 2. Critical Paths With Zero or Weak Coverage

Prioritised by user-facing impact for DevOps / staff-engineer personas (the target buyer).

| Rank | Path | User impact when it breaks | Current coverage |
|---|---|---|---|
| **P0** | RAG `getAllEmbeddedChunks` returns null-embedding rows | Search returns garbage hits → user trusts wrong code → wrong answers | Test exists and **fails** (H3) |
| **P0** | ChatScreen incremental-persist flow creates two assistant rows | Chat history shows duplicated answers; export/fork pollutes downstream | **No assertion** on `messages.length === 1` (H2) |
| **P0** | Relay/Scan screen routing in `index.tsx` | New flagship feature literally cannot be reached from the keyboard | **No** route — `Screen` union has 6 values, neither relay nor scan |
| **P1** | MCP transport death (stdio child crash) | Tool calls hang, no recovery, requires app restart | None |
| **P1** | command-exec subprocess actually executing under approval gate | Sandbox bypass → arbitrary command execution | Validation tested in isolation; end-to-end not |
| **P1** | useStream + useConversation + ChatScreen as a trio under real SQLite | The single most important user flow in the entire app | None (every test mocks at least one of them) |
| **P2** | workflowEngine anchor phase + tool injection + abort-mid-anchor | Relay feature produces wrong output / hangs | 5 tests, scout-only |
| **P2** | RAG indexer against a real temp directory + real SQLite | Indexing silently corrupts on edge filenames | All node:fs mocked |
| **P2** | useMcp full lifecycle (connect → tools → close) | Tool palette empty when servers actually start | Only merge + ratelimit unit-level |
| **P3** | NetworkScanScreen consent dance | Scans a subnet without explicit consent → legal/compliance risk | None |

---

## 3. Recommended Test Layers

The current suite is **almost entirely unit tests with module mocks**. That's the wrong shape for a CLI app whose value is "the local-first wiring works".

### 3.1 Target shape (Testing Trophy, not Pyramid)

For an Ink CLI that talks to SQLite + child processes + stdin/stdout, the highest-ROI layer is **integration**, not unit. Pure functions are easy to verify by reading; the bugs live at the seams. Recommended split:

| Layer | % of effort | What lives here |
|---|---|---|
| Static (TS, eslint) | 5% | Type-level invariants — already in place |
| Unit | 30% | Pure functions: modelRouter, chunkText, security validators, syntax, parsers. Tight, fast, no mocks. |
| **Integration** | **55%** | Hooks + real SQLite (in-memory or temp file), real fs in a tmpdir, real child processes for MCP servers, ink-testing-library for screens. **This is where new investment goes.** |
| E2E | 10% | A handful of pty-driven smoke tests through `bin/uplnk.ts` that prove the binary boots, opens a chat, and round-trips one mocked-LLM exchange. |

### 3.2 Why integration over more unit tests

- The H2 duplicate-row regression cannot be caught by either `useConversation.test.ts` or `useStream.test.ts` in isolation — it lives in how `ChatScreen` orchestrates them with `insertMessage`. Only a screen-level integration test against a real (in-memory) DB will catch it.
- The H3 RAG bug is a SQL filter that JS-side `.filter()` masks. Only a test against a real `better-sqlite3` instance with seeded null-embedding rows reveals whether the WHERE clause is right.
- The H1 routing bug is a missing case in a discriminated union — caught only by a test that drives the command palette and asserts the rendered screen.

### 3.3 Concrete infrastructure to add

1. **Restore `vitest.integration.config.ts`.** Same alias block as `vitest.config.ts`, but:
   - `include: ['src/**/*.integration.test.{ts,tsx}']`
   - `setupFiles: ['src/__tests__/integration-setup.ts']` — a setup that does **not** mock `@uplnk/db` and instead opens a fresh `:memory:` SQLite and runs migrations per test file.
   - `pool: 'forks'` — child processes for MCP integration tests deserve isolation.
   - `testTimeout: 15000` — child spawn is slow.
2. **Tmpdir helper** (`src/__tests__/helpers/tmpdir.ts`): create + cleanup a unique tmp directory per test for fs-touching integration tests.
3. **In-memory DB helper** (`src/__tests__/helpers/db.ts`): `openTestDb()` returning a real Drizzle instance against `better-sqlite3(':memory:')` with migrations applied. Reuse across rag, conversation, workflow integration tests.
4. **Ink screen harness** (`src/__tests__/helpers/renderScreen.tsx`): wraps `ink-testing-library`'s `render` with a context provider preloading config + DB so screen tests don't each re-implement boilerplate.

---

## 4. Hotfix Test Cases

### H1 — Relay/Scan screen routing

**Defect**: `index.tsx` line 15 declares `type Screen = 'chat' | 'model-selector' | 'conversations' | 'provider-selector' | 'add-provider' | 'edit-provider'`. Neither `'relay'` nor `'network-scan'` are members. The components `RelayRunScreen` and `NetworkScanScreen` exist but are unreachable.

**Tests to write** (integration, against `<App />` via ink-testing-library):

1. `index.routing.test.tsx > opens RelayRunScreen when /relay command palette item is selected` — render `<App />`, open palette with the configured key, select the relay entry, assert `lastFrame()` contains a string unique to `RelayRunScreen` (e.g., `"Scout"` or `"Anchor"` headers).
2. `index.routing.test.tsx > opens NetworkScanScreen when /scan is invoked` — same shape, assert a header unique to `NetworkScanScreen`.
3. `index.routing.test.tsx > pressing Escape from RelayRunScreen returns to chat` — verifies the existing escape handler still picks up the new screen states.
4. **Type-level guard**: `index.routing.test-d.ts` (vitest `expectTypeOf`) asserting the `Screen` union includes `'relay'` and `'network-scan'`. This catches future removals at compile time.

Acceptance: all four pass; `Screen` union is updated; both `setCurrentScreen('relay')` and `setCurrentScreen('network-scan')` compile.

### H2 — Duplicate assistant row regression (`messages.length === 1` after stream)

**Defect**: `ChatScreen.tsx` lines 195–198 explicitly comment that incremental persistence inserts an assistant row to SQLite (via `insertMessage`), and the post-stream `addMessage` path inserts a **second** row. The `useConversation` hook now exposes `addMessageWithId` + `updateMessageInState` for the state-only update — the bug is that ChatScreen has not been migrated to the state-only path.

**Tests to write** (integration, real in-memory DB, ink-testing-library):

1. `ChatScreen.persistence.integration.test.tsx > after a complete stream the conversation has exactly one assistant message`
   - Open in-memory DB, seed an empty conversation.
   - Render `<ChatScreen conversationId={…} />` with `streamText` mocked to yield 3 deltas then end.
   - Drain ticks until `status === 'done'`.
   - Assert `getMessages(db, conversationId).filter(m => m.role === 'assistant').length === 1`.
2. `> the surviving row's content equals the full streamed text` — guards against the inverse fix where we drop the persisted partial.
3. `> after a SIGKILL-style abort mid-stream the conversation has exactly one assistant message with the partial text` — abort the stream after the first delta, assert `length === 1` and `content === 'first chunk'`.
4. `> after an error mid-stream the conversation has exactly one assistant message with the partial text and no error sentinel rows`.
5. `> React state messages array length matches DB row count` — render-time invariant; catches drift between `setMessages` and `insertMessage`.

Acceptance: tests 1 and 2 currently FAIL on `main` (proves the regression), pass after the fix.

### H3 — RAG WHERE clause (no null-embedding rows returned)

**Defect**: `indexer.ts` `getAllEmbeddedChunks()` builds an `and(...)` with an always-true placeholder `eq(ragChunks.filePath, ragChunks.filePath)` then JS-side `.filter(c => c.embedding !== null)`. Two problems:
- Functional: relies on JS filter — on a 1M-chunk repo this loads the entire table into memory before discarding.
- Bug: the existing test fails with `ReferenceError: and is not defined` — `and` is imported but the test environment apparently shadows it via the drizzle mock OR (more likely) the per-file mock chain leaves `and` undefined when the function is called. Either way, the production code does not actually use the SQL WHERE clause.

**Tests to write** (integration, real in-memory SQLite via the new helper):

1. `indexer.integration.test.ts > getAllEmbeddedChunks omits rows with null embedding`
   - Open real in-memory DB, run migrations.
   - Insert 3 rag_chunks: two with non-null embedding blobs, one with `embedding: null`.
   - Call `new Indexer(db, null).getAllEmbeddedChunks()`.
   - Assert `result.length === 2` and `result.every(r => r.embedding !== null)`.
2. `> generated SQL contains "embedding IS NOT NULL"` — snapshot or string-assert against `db.select().from(...).where(isNotNull(ragChunks.embedding)).toSQL().sql`. Locks the implementation to a SQL filter, not a JS filter.
3. `> with 10k seeded chunks the call returns in < 100ms` — guards against the JS-filter regression slipping back in.
4. `> chunks with zero-length Buffer embedding are still considered embedded` — empty buffer is **not** null; document the boundary explicitly.

Acceptance: existing failing unit test is replaced by these integration tests; the implementation switches to `.where(isNotNull(ragChunks.embedding))`.

---

## 5. Sprint 1 Feature Test Cases

### S1-A — Token counter

**Components to test**: an as-yet-unwritten token counter module (no `lib/tokenCounter.ts` exists today; `lib/tokens.ts` is unrelated design tokens). Strategy assumes the qa-engineer is given a function-level spec like:

```
estimateTokens(text: string): number
getContextWindow(modelId: string): number
sumConversationTokens(messages: Message[]): number
```

**Unit tests** (pure, no mocks):

1. `tokenCounter.test.ts > estimateTokens > returns 0 for empty string`
2. `> uses chars/4 heuristic for ASCII (e.g. "hello world" → 3)` — locks the documented heuristic.
3. `> handles multi-byte UTF-8 by character count, not byte count` — guards against a `Buffer.byteLength` regression that would over-count Japanese.
4. `> approximation is within ±15% of OpenAI tiktoken cl100k_base on a 100-sample corpus` — property-style assertion against a fixture file. This is the **only** test that meaningfully validates "accuracy".
5. `getContextWindow > returns the correct window for known models (gpt-4o, claude-3.5, llama3.2:3b)` — table-driven.
6. `> returns a documented default (e.g. 8192) for unknown modelIds` — never throws.
7. `> defaults to the smallest reasonable window, not the largest` — wrong direction here causes silent context overflow.
8. `sumConversationTokens > returns the sum of estimateTokens over all message contents`
9. `> includes role overhead per message (4 tokens) per the OpenAI cost model` — if the spec calls for it.
10. `> ignores tool-call message parts that have no text content` — boundary.

**Integration test** (one is enough): rendering `<StatusBar />` with a 50-message conversation and asserting the token-budget percentage matches `sumConversationTokens / getContextWindow` to within 1%.

### S1-B — `/compact` slash command

**Components**: a new `/compact` command handler that summarises the current conversation via the active model, then replaces the message array.

**Unit tests** (mock `streamText`):

1. `compact.test.ts > calls streamText with a system prompt that includes the messages to summarise`
2. `> writes the summary as a single new assistant message and removes the original messages from React state`
3. `> preserves the most recent N messages (per spec) and only summarises older ones` — table-driven boundary.
4. `> on streamText error, leaves the original message array unchanged (rollback)` — **this is the test that justifies the feature existing**. Without it, `/compact` is a "delete my history" button.
5. `> on user-initiated abort mid-summary, no messages are deleted` — the rollback path must trigger on `AbortError`, not just thrown errors.
6. `> the new summary message has role: 'system' or 'assistant' per spec, never 'user'` — locks the contract.

**Integration test** (real in-memory DB):

7. `compact.integration.test.ts > after a successful /compact, getMessages returns exactly the preserved tail + the new summary row` — verifies DB and React state agree.
8. `> after a failed /compact, getMessages returns the original rows untouched` — the rollback test where it actually matters.

### S1-C — Message scrollback

**Components**: a new scroll-state hook (`useScrollback` or similar) plus changes to `ChatScreen` for arrow-key handling and "follow new messages" behaviour.

**Unit tests** (`renderHook` via ink wrapper):

1. `useScrollback.test.ts > initial state: scrollOffset === 0, isFollowing === true`
2. `> arrow-up increments scrollOffset and sets isFollowing to false`
3. `> arrow-down decrements scrollOffset; reaching offset 0 re-enables isFollowing`
4. `> page-up / page-down move by viewport height, not 1`
5. `> when isFollowing is true, a new message resets the offset to 0 (auto-scroll)`
6. `> when isFollowing is false, a new message does NOT change the offset` — **the regression-prevention test**. Without this, scrolling up to read history yanks you back down on every token.
7. `> jumping to bottom (End key) re-enables isFollowing`
8. `> scrollOffset is clamped to [0, max(0, totalLines - viewportHeight)]` — boundary.

**Integration test**:

9. `ChatScreen.scrollback.integration.test.tsx > scrolling up while a new assistant message streams in keeps the user's view stable` — render, simulate up-arrow, dispatch streaming deltas, assert `lastFrame()` does NOT contain the new tokens (they are below the viewport).

### S1-D — Artifact save-to-file

**Components**: a save action on `ArtifactPanel` that writes the artifact body to a file and copies the path to the clipboard.

**Unit tests** (mock `node:fs/promises` and the clipboard module):

1. `artifactSave.test.ts > calls fs.writeFile with the resolved target path and the artifact content as utf-8`
2. `> the resolved path includes the artifact's language extension (.ts, .py, .md)` — table-driven.
3. `> writes inside the configured save directory, not cwd, not /tmp` — security: the path resolution must honour user config.
4. `> rejects paths that escape the save directory (../../../etc/passwd)` — path traversal guard. Even in a friendly action, never write outside the sandbox.
5. `> on fs.writeFile error, surfaces a UplnkError with code FILE_WRITE_FAILED and does not call clipboard.write`
6. `> on success, calls clipboard.write exactly once with the absolute path of the written file`
7. `> on clipboard.write failure, the file is still written and the error is surfaced as a non-fatal warning` — the file write is the load-bearing operation; clipboard is best-effort.
8. `> file is written with mode 0o644, not 0o600` — predictable for downstream tools. Or whatever the spec says — assert it explicitly.
9. `> existing file with the same name is not silently overwritten without a numeric suffix` — guards against destroying user work. Spec-dependent; if "overwrite" is the intended behaviour, write the inverse test.

**Integration test**:

10. `ArtifactPanel.save.integration.test.tsx > pressing the save key writes a real file to a tmpdir and the file content matches the artifact body byte-for-byte` — uses the tmpdir helper, no fs mock, real `fs.promises.writeFile`. This is the only test that verifies the wiring end-to-end.

---

## 6. Test Infrastructure Gaps

### 6.1 Mocking strategy issues

- **Global `@uplnk/db` mock is too coarse.** `setup.ts` stubs every export with `vi.fn()`. Tests that need DB behaviour either re-mock locally (extra boilerplate) or — worse — silently pass with no actual DB call. The H3 failure is direct evidence: the test ran, the production function exploded, and the noise of 1112 other passing tests almost hid it. Recommend splitting into two setup files:
  - `setup.ts` (default, current behaviour).
  - `setup.realdb.ts` (loaded by integration config) that opens `:memory:` SQLite and runs migrations.
- **`drizzle-orm` is implicitly mocked via `@uplnk/db`.** When a source module imports `and`, `eq`, `isNotNull` directly from `drizzle-orm`, the global mock chain can leave them undefined. Recommend the integration setup imports the real drizzle-orm and asserts in a sanity check that `typeof and === 'function'`.
- **`ai.streamText` mocking pattern is duplicated** in `useStream.test.ts`, `workflowEngine.test.ts`, and (presumably) future tests. Extract to `src/__tests__/helpers/mockStreamText.ts` with a builder API: `mockStream({ deltas: ['a', 'b'], usage: {...}, error?: Error, abortAfter?: number })`. Reduces drift and the surface area where each test invents its own fake event shape.
- **Over-mocking in `McpManager` tests.** Both `node:child_process` and the SDK transports are stubbed, which means we test "does the McpManager call the right mocks in the right order", not "does the McpManager actually launch a child". Replace at least one test with a child-process integration test that spawns `node -e "process.stdin.on('data', d => process.stdout.write(d))"` and exercises the real stdio transport round-trip.

### 6.2 DB test fixture gaps

- No fixture builder for conversations + messages + rag_chunks. Hand-rolled inserts in each test create drift on schema changes. Recommend `src/__tests__/helpers/factories.ts` exporting `makeConversation()`, `makeMessage()`, `makeRagChunk()` — small, opinionated, returns objects ready to insert.
- No way to seed a "realistic" 100-message conversation for performance assertions (token counter §S1-A test 4, scrollback §S1-C test 9). Add a `seedConversation(db, n)` helper.

### 6.3 Ink rendering test approach

- ink-testing-library is used in 14 files but the patterns diverge: some use `lastFrame()`, some snapshot, some assert via `result.frames`. Recommend documenting the canonical pattern in `src/__tests__/README.md`:
  - **Always** `lastFrame()` + substring assertion. Snapshots on Ink output are brittle (one new icon character invalidates the snapshot, with no diagnostic value).
  - **Never** assert on intermediate frames except in dedicated streaming tests — they are a flakiness vector.
  - **Always** `cleanup()` in `afterEach` (some files do, some don't).
- For renderHook-style tests, the project has invented `renderHookViaInk` three different ways (useStream, useConversation, useArtifacts). Extract to `src/__tests__/helpers/renderHookViaInk.tsx` and migrate. Reduces the failure modes by one.

### 6.4 The missing integration suite

This is the single biggest infrastructure gap. Until `vitest.integration.config.ts` exists and is wired to CI, every "integration test" the QA engineer writes will live in the unit suite under the global mock setup, which **defeats the purpose**. Reconstructing this config is a precondition to any of the H1/H2/H3 tests above being meaningful.

---

## 7. Flakiness Risks

### 7.1 Existing tests with flake potential

- **`useStream.test.ts`** uses real timers and `setTimeout(..., 50)` to wait one flush interval. On a loaded CI box this can race — the flush interval is 33 ms and the wait is 50 ms, leaving 17 ms of headroom. Under `vitest --pool=threads` with parallel workers, this margin shrinks. **Action**: bump `waitForFlush` to 100 ms, or — better — switch to `vi.useFakeTimers({ toFake: ['setInterval'] })` and advance explicitly. The file's preamble argues against fake timers, but `toFake` lets you fake only the timers under test.
- **MCP audit log tests** write to a real (temp) file via `appendFileSync` — file system contention across parallel workers can interleave or fail under macOS's slower atomic-rename path. **Action**: scope the audit-log path per worker with `process.env.VITEST_WORKER_ID`.
- **Ink keyboard tests** (`ChatInput`, `CommandPalette`) are timing-sensitive on input dispatch. The existing `tick()` pattern is fragile when stdin events queue across React state batches. The `useStream.test.ts` preamble already documents that single vs double-tick matters per file, which is a smell. **Action**: adopt one canonical helper that flushes the React + Ink reconciler deterministically (`await new Promise(r => setImmediate(() => setImmediate(r)))` is the safe form for input tests).
- **`secrets.test.ts`** is generating real noise during the run (the "encrypted secrets store … was corrupted and has been reset" log lines). That output is from a code path being exercised — not a failure — but it indicates the test is exercising the corruption recovery branch and writing/deleting real files in `/var/folders`. If two workers pick the same path, one will corrupt the other. **Action**: confirm tmpdir paths are unique per test (the `wt3JZu` / `qSeFws` suffixes suggest yes), and silence the log via a logger spy so we don't have to read it on every CI run.

### 7.2 Environment-dependent risks

- `process.env['UPLNK_THEME']` is read at module load by `lib/tokens.ts`. Any test that imports `tokens.ts` after another test has set this env will see stale values because of `isolate: true`'s module re-init quirks. **Action**: never set `UPLNK_THEME` from a test. Theme-sensitive rendering should be tested via prop injection, not env mutation.
- `os.homedir()` is mocked globally — but `node:os` import is sometimes shadowed when a test imports a module that calls `homedir()` before the mock is applied. The setup file mocks via `vi.mock('node:os', …)` which is hoisted, so this should be safe **as long as no test file calls `vi.unmock('node:os')`**. Add an eslint rule (or a CI grep) forbidding `vi.unmock('node:os')`.
- Integration tests, once introduced, **must not** rely on a system `git` binary being present — `MCP git` server tests should either mock `child_process` or skip when `which git` fails. CI hosts vary.

### 7.3 The single highest-flake risk going forward

Mid-stream abort tests (H2 test 3, S1-B test 5, S1-C test 9). Aborting an async generator while the React reconciler is mid-flush is the most common source of "passes locally, fails on CI" in Ink apps. Recommend every abort test:
1. Awaits the stream to a known checkpoint (e.g. after the second delta) before calling `abort()`.
2. Drains ticks until status changes — never `setTimeout`.
3. Asserts on the **final** state, not intermediate frames.
4. Cleans up barrier promises in a `finally` block.

---

## 8. Summary of Recommended Actions (for qa-engineer hand-off)

1. **Restore** `vitest.integration.config.ts` and a real-DB setup file. Block all H1/H2/H3 tests on this.
2. **Write** the H1, H2, H3 tests per §4. H2 and H3 should fail on `main`; H1 will fail to compile until the routing is added.
3. **Build** `helpers/{tmpdir,db,renderHookViaInk,renderScreen,mockStreamText,factories}.ts`. These are the foundation — without them every Sprint 1 test will reinvent infrastructure.
4. **Write** Sprint 1 tests per §5 in this order: S1-D (lowest risk, isolated), S1-A (pure functions), S1-C (hook + integration), S1-B (DB + rollback — the highest-value tests in the sprint).
5. **Fix the flake risks** in §7.1 in parallel with new test work — they will start firing as soon as the suite gets bigger.
6. **Do not** chase coverage percentage. The current 1112-test suite already has more lines than is justified by the bugs it catches. Prefer deleting a redundant unit test for every integration test added.

End of strategy.
