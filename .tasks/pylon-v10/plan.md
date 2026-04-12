---
epic: pylon-v10
phases:
  - id: 1
    title: "MCP Phase 2: write operations (file creation/editing with approval gates)"
    persona: nexus
    status: DONE
    notes: "mcp_file_write and mcp_file_patch added to file-browse.ts. Security wrappers in McpManager with approval gates. applyUnifiedDiff() handles unified diff format. 15 unit tests in file-browse-write.test.ts."
  - id: 2
    title: "Git integration: diffs, stage changes, AI-generated commit messages"
    persona: staff-engineer
    status: DONE
    notes: "servers/git.ts with mcp_git_status, mcp_git_diff, mcp_git_stage, mcp_git_commit. BUILTIN_GIT_ID sentinel. wrapGitTools() with validateRepoPath + approval gates for mutating ops. gitEnabled flag in McpManagerConfig."
  - id: 3
    title: "Full RAG: local embeddings of codebase, incremental re-indexing"
    persona: nexus
    status: DONE
    notes: "lib/rag/embedder.ts (Ollama/OpenAI embedding, fallback when unconfigured), lib/rag/indexer.ts (512-token chunks with 64-token overlap, .gitignore-aware, binary skip), lib/rag/watcher.ts (chokidar-backed or fs.watch, 1s debounce), servers/rag.ts (mcp_rag_search + mcp_rag_index). DB: migration 0002 adds rag_chunks table (id/file_path/chunk_index/content/embedding BLOB/indexed_at). McpManager: BUILTIN_RAG_ID, ragEnabled flag, wrapRagTools() with allowed-root validation for mcp_rag_index. Config: rag.enabled + rag.embed fields. 4 test files in lib/rag/__tests__/ (embedder, indexer, watcher, rag-security)."
  - id: 4
    title: "Multi-model orchestration: route by task complexity"
    persona: nexus
    status: DONE
    notes: "ModelRouter class in modelRouter.ts with pure-local classifyComplexity() (simple/moderate/complex tiers). Config schema extended with optional modelRouter field. useStream.ts SendOptions gains modelOverride?: LanguageModel. ChatScreen instantiates ModelRouter from config and passes model overrides per-request. Header shows '(router)' suffix when routing active. ModelSelectorScreen gets routerEnabled prop. 36 unit tests in modelRouter.test.ts covering all tiers, edge cases, disabled fallback, and turn-count threshold."
  - id: 5
    title: "Inline diff view: accept/reject per hunk"
    persona: staff-engineer
    status: DONE
    notes: "ArtifactPanel.tsx rewritten with LCS-based diff (lcsLineDiff), hunk model (buildHunks/applyHunks), HunkView component. a/r/A/R/Enter/j/k controls. onApply prop wired in ChatScreen via updateArtifact."
  - id: 6
    title: "Plugin/extension system: community MCP tools"
    persona: staff-engineer
    status: DONE
    notes: "PluginRegistry in registry.ts (Zod-validated manifests, install/uninstall/list/get/toMcpServerConfigs). loader.ts reads ~/.pylon/plugins/ at startup. --plugin install/list/remove CLI flags in bin/pylon.ts. 35 unit tests in plugins/__tests__/registry.test.ts — all pass."
  - id: 7
    title: "Auto-update: self-update mechanism"
    persona: staff-engineer
    status: DONE
    notes: "selfUpdate.ts with checkForUpdate() + performUpdate(). 24h cache at ~/.pylon/update-check.json. Detects npm/yarn/pnpm. Updates field in Config schema. Non-blocking startup check in bin/pylon.ts prints notice after TUI exits. 12 unit tests."
  - id: 8
    title: "QA: full v1.0 test coverage"
    persona: qa-engineer
    status: DONE
    notes: "943 tests / 35 test files / 0 TypeScript errors in test files. Added: git.test.ts (24 tests — all 4 tools via McpServer.prototype spy), ArtifactPanel expanded (16 new tests — accept/reject hunks, A/R all, onApply callback, diff toggle), selfUpdate expanded (7 new tests — performUpdate(), detectPackageManager for all 3 PMs), embedder expanded (13 new tests — embedBatch, empty data[], json parse throw, empty embedding[]), indexer expanded (6 new tests — read failure, embedder integration, deleteFile, getChunksForFile, getAllEmbeddedChunks), watcher expanded (5 new tests — onIndexed not called when skipped, error swallowing, stop() closes chokidar), plugins/registry expanded (5 new tests — Zod validation failure, corrupted file). Pre-existing TS errors in ArtifactPanel.tsx (3 unused vars) noted but not introduced by this phase."
---

## Context & Objective

v1.0 feature set. Depends on pylon-v05 epic being fully done.
Reference: chatty/reports/05-product-architecture.md section 3
