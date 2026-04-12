---
epic: pylon-v05
phases:
  - id: 0
    title: "P0: Wrap completed messages in <Static> in MessageList — streaming perf regression"
    persona: staff-engineer
    status: DONE
    priority: P0
    depends_on: []
    blocks: [7, 8]
    estimate: "0.5-1d"
    notes: "RETROACTIVE P0 added by CTO review 2026-04-12. DONE: MessageList.tsx now uses Ink <Static> for committed messages. Full documentation in component JSDoc."
  - id: 1
    title: "Artifacts side-panel: resizable panel with keyboard toggle"
    persona: staff-engineer
    status: DONE
    cto_notes: "Landed without Phase 0 <Static> fix. Split-pane layout compounds per-frame render cost — Phase 0 will validate no regression introduced here."
  - id: 2
    title: "Project context mode: --project flag, indexes file structure into system prompt"
    persona: staff-engineer
    status: DONE
    cto_notes: "Verify token-budget ceiling (conservative 4KB) + file-count cap is enforced to protect small-model context windows. File as P2 follow-up if not."
  - id: 3
    title: "Multi-provider profiles: DB-backed provider configs, /provider command"
    persona: nexus
    status: DONE
    priority: P1
    depends_on: []
    parallelizable_with: [0, 7]
  - id: 4
    title: "Conversation branching: fork at any message"
    persona: staff-engineer
    status: DONE
    priority: P2
    depends_on: [5]
  - id: 5
    title: "System prompt templates: Code Reviewer, Refactoring Partner, Debug Assistant"
    persona: staff-engineer
    status: DONE
    blocks: [4]
  - id: 6
    title: "Export: /export command -> Markdown, JSON"
    persona: staff-engineer
    status: DONE
  - id: 7
    title: "Keyboard-first navigation: Ctrl+K command palette"
    persona: staff-engineer
    status: DONE
    priority: P3
    depends_on: []
    parallelizable_with: [0, 3]
  - id: 8
    title: "QA: tests for all v0.5 features (CONTINUOUS + end-of-sprint regression)"
    persona: qa-engineer
    status: DONE
    priority: P1
    depends_on: [0]
---

## Context & Objective

v0.5 feature set. Depends on pylon-v01-complete epic being fully done.
Reference: chatty/reports/05-product-architecture.md section 2,
06-system-architecture-v2.md

## CTO Review (2026-04-12)

Post-v0.1 strategic review surfaced one **P0 defect**: `MessageList.tsx` does not use
Ink's `<Static>` component for completed messages. CTO v2 §2.4 explicitly prescribes
`<Static>` for chat history — without it, each ~33ms stream flush triggers Ink to
re-reconcile and diff the entire history. Phases 1, 2, 4, 5, 6 shipped before this
review and are marked DONE; the split-pane artifacts layout and project-context work
compound the per-frame cost.

A new **Phase 0** has been added as a retroactive P0 fix. It gates Phase 8
(end-of-sprint perf regression — baseline is invalid without the fix) and is a
precondition for shipping Phase 4 (branching adds re-render surface).

Dependency annotations, priority levels, and CTO notes added to every phase.
Full critical path, parallel streams, and decision gates:
`internal-doc/v05-critical-path.md`
Strategic review: `internal-doc/cto-v01-review.md`

### Parallel streams
- **Stream A (staff-engineer, critical path):** Phase 0 -> Phase 4 (in flight) -> Phase 7
- **Stream B (nexus):** providerRef refactor -> Phase 3 (in flight)
- **Stream C (devops, separate epic):** `better-sqlite3` prebuilt binaries CI matrix + `pylon doctor` native module check
- **Stream D (qa-engineer):** Phase 8 — blocked on Phase 0
