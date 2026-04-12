# Execution Log — pylon-v05

## [2026-04-12T10:30:00Z] Phase 8: QA — tests for all v0.5 features — @qa-engineer

All v0.5 feature test suites written and committed. Coverage summary:

**New test files (Phase 8):**
- `src/lib/__tests__/systemPromptTemplates.test.ts` — 16 tests covering BUILT_IN_TEMPLATES array shape, uniqueness, getTemplate() lookup (exact match, unknown id, case-sensitivity), and getDefaultTemplate() blank-slate contract.
- `src/__tests__/useSplitPane.test.ts` — 18 tests covering initial state (50/50), growArtifact (5% step, 70% cap), shrinkArtifact (5% step, 30% floor), resetWidth, and the invariant that artifact + chat always sums to 100.
- `src/components/layout/__tests__/CommandPalette.test.tsx` — 20 tests covering render (commands visible, shortcuts, descriptions, disabled commands hidden), Escape closes, Enter executes + closes in correct order, fuzzy filter (case-insensitive, backspace, no-match state), and down-arrow navigation.
- `src/screens/__tests__/ProviderSelectorScreen.test.tsx` — 13 tests covering render (names, default marker, empty state), Escape → onBack, Enter → onSelect with correct provider data, no select on empty list, cursor clamping at top and bottom.

**Pre-existing test files (referenced for completeness):**
- `src/lib/__tests__/exportConversation.test.ts` — Markdown + JSON format output, auto filename, message count.
- `src/lib/__tests__/projectContext.test.ts` — buildProjectContext: null for non-existent dir, node_modules/.git/hidden file skip, file count.
- `src/components/mcp/__tests__/ApprovalDialog.test.tsx` — Full Y/N/Escape keyboard gate tests (security gate validated).
- `src/lib/mcp/__tests__/security.test.ts` — Path traversal, blocked patterns, command validation.

**Phase 0 (<Static>) prerequisite:** DONE before this phase. Streaming performance baseline validated.

**Handoff to pylon-v10:** All phases DONE. Epic ready for archive. v0.5 feature set is test-covered and phase-gated.
