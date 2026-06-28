---
name: commit
description: >-
  Create a hawky commit that credits every human contributor via Co-authored-by
  trailers using GitHub handles and GitHub noreply email addresses, and BLOCKS
  any AI/bot co-author (Claude, Codex, noreply@anthropic.com, github-actions,
  dependabot). Trigger whenever the user asks to commit, stage, or "save"
  changes in this repo.
---

# commit

Enforce the hawky COMMIT POLICY (see AGENTS.md) on every commit.

## Workflow

1. **Stage** the intended changes (`git add -p` or explicit paths). Do not blind `git add .`.
2. **Pick the author** from the current `git config user.*` unless the user explicitly asks
   for another human author. Do not invent or infer a missing author mapping.
3. **Assemble Co-authored-by trailers** MANUALLY for every OTHER human who contributed to
   the change. One `Co-authored-by:` line per human, using their GitHub handle and
   GitHub noreply email: `github-handle <id+github-handle@users.noreply.github.com>`.
   If the noreply address is unknown, stop and ask instead of using a personal email.
4. **Run the guard from the repo root**: `scripts/check_commit.sh "<subject>" "<body>"`.
   It fails the commit if any trailer or the author is an AI/bot
   (regex: `claude|codex|anthropic|copilot|github-actions|dependabot|\bbot\b|\[bot\]`).
5. **Commit** with conventional `type(scope): summary`, the body, and the trailers.

## Safety rules

- NEVER add an AI/bot as author or `Co-authored-by`. This is the top guard, enforced by
  `scripts/check_commit.sh`.
- Use GitHub handle + GitHub noreply email for human authors and co-authors. Do not use
  personal email addresses in commit author metadata or `Co-authored-by` trailers.
- Trailers go at the END of the message, one per line, blank line before the block.

## Trailer block format

```
<subject>

<body>

Co-authored-by: zhisbug <zhisbug@users.noreply.github.com>
Co-authored-by: GindaChen <32371474+GindaChen@users.noreply.github.com>
...all other humans who contributed...
```

## Scripts

- `scripts/check_commit.sh` — canonical pre-commit guard (AI/bot-coauthor block).
  Exit non-zero blocks the commit. `.claude/skills/commit/scripts/check_commit.sh`
  is only a compatibility wrapper.
