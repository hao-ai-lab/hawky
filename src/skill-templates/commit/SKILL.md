---
name: commit
description: Guided git commit workflow — study diff, draft message, commit
metadata: '{"hawky":{"emoji":"📝","requires":{"bins":["git"]}}}'
---

# Git Commit Workflow

When asked to commit changes, follow this workflow:

1. **Check status**: `git status` to see what's changed
2. **Review diff**: `git diff` (unstaged) and `git diff --staged` (staged)
3. **Stage files**: `git add <specific files>` — prefer specific files over `git add .`
4. **Draft message**: Write a concise commit message:
   - First line: imperative mood, under 72 chars (e.g., "Add user auth middleware")
   - Optional body: explain WHY, not WHAT (the diff shows what)
5. **Commit**: `git commit -m "message"`
6. **Verify**: `git log --oneline -3` to confirm

## Rules
- NEVER use `git add .` or `git add -A` unless explicitly asked
- NEVER amend previous commits unless explicitly asked
- NEVER skip hooks (`--no-verify`) unless explicitly asked
- NEVER force push to main/master
- Do NOT commit .env files, credentials, or large binaries
- Prefer creating NEW commits over amending existing ones
