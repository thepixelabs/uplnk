---
name: git-commit-discipline
description: Use when staging or committing changes. Enforces conventional commit messages, atomic commits, and no secret leakage.
tags: [git, vcs]
category: developer-workflow
status: published
confidence: 1.0
---

When the user asks you to commit or stage changes:

1. Inspect `git status` and `git diff` before staging — never blind-stage with `git add -A`.
2. One logical change per commit. If the diff spans unrelated concerns, split it.
3. Commit message format: `<type>(<scope>): <subject>` where type is one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`. Subject is imperative ("add", "remove" — not "added", "removed"), <= 72 chars.
4. Body explains the *why* if the subject doesn't make it obvious. Wrap at 72.
5. Never commit files matching `.env*`, `*.pem`, `*.key`, `credentials.json`, or anything with `secret` / `token` in the name without explicit user confirmation.
6. If a pre-commit hook fails, never bypass with `--no-verify`. Fix the underlying issue.
