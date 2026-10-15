---
name: my-agent
description: |
  Describe when to use this agent. Be specific — the orchestrator reads this to decide
  when to invoke automatically. Include example phrases that would trigger it.

  <example>
  Context: User wants to review code quality
  user: "@my-agent please review the auth module"
  assistant: "I'll review the auth module for correctness, security, and clarity."
  <commentary>
  Direct @mention with a clear task.
  </commentary>
  </example>

  <example>
  Context: Agent was delegated a task
  user: "review the changes in packages/db"
  assistant: "Reviewing the database changes now."
  <commentary>
  Delegated by another agent without explicit @mention.
  </commentary>
  </example>

# ── Model ────────────────────────────────────────────────────────────────────
# model: inherit        # 'inherit' uses the root conversation's model
                        # or any provider model id (e.g. 'qwen2.5-coder:7b', 'llama3.1:8b')
# provider: ollama      # optional explicit provider override
# temperature: 0.7      # 0.0–2.0; omit to inherit
# effort: medium        # low | medium | high | max

# ── Tool access ──────────────────────────────────────────────────────────────
# tools: [mcp_file_read, mcp_file_list, mcp_rag_search]   # omit = inherit all tools from parent
# toolsDeny: [mcp_command_exec]                            # deny specific tools even if inherited
# Claude-Code-style names (Read, Grep, Glob, Edit, Write, Bash) are accepted
# in user/project agent files via a compatibility alias map, with a warning.

# ── Skills ───────────────────────────────────────────────────────────────────
# skills: [skill-name]        # load skill bodies into system prompt

# ── Delegation ───────────────────────────────────────────────────────────────
# agents: []                  # [] = cannot delegate; ['*'] = any agent; ['agent-a'] = specific
# maxDepth: 2                 # max nesting depth for sub-delegations
# handoffs:
#   - label: "Run Tests"
#     agent: tester
#     prompt: "Run the test suite against the changes above"
#     send: result

# ── Memory ───────────────────────────────────────────────────────────────────
# memory: none              # none | project | user | local

# ── UI ───────────────────────────────────────────────────────────────────────
# color: blue               # blue | cyan | green | yellow | magenta | red | or hex
# icon: 🔍                  # single emoji shown in AgentCard

# ── Invocation ───────────────────────────────────────────────────────────────
# userInvocable: true       # false = only other agents can invoke this
# maxTurns: 10              # max inner reasoning steps
# timeoutMs: 600000         # 10 minutes

# ── Auto-invoke (uplnk-only) ─────────────────────────────────────────────────
# autoInvoke:
#   - on: file-change
#     pattern: "src/auth/**"
#   - on: keyword
#     pattern: "security|vulnerability"
---

You are a [role description]. [One sentence on your primary purpose.]

## Responsibilities

- [What you do]
- [What you focus on]
- [What you deliver]

## Process

1. [Step one]
2. [Step two]
3. [Step three]

## Output Format

[Describe what your responses look like — structure, length, style.]

## What You Do Not Do

- [Scope boundary]
- [Scope boundary]
