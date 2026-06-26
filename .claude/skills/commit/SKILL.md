---
name: commit
description: >-
  Create a hawky commit that credits every human contributor via Co-authored-by
  trailers (added manually) and BLOCKS any AI/bot co-author (Claude, Codex,
  noreply@anthropic.com, github-actions, dependabot). Trigger whenever the user
  asks to commit, stage, or "save" changes in this repo.
---

# commit

Enforce the hawky COMMIT POLICY (see AGENTS.md) on every commit.

## Workflow

1. **Stage** the intended changes (`git add -p` or explicit paths). Do not blind `git add .`.
2. **Pick the author** = the owner of the area changed (see AGENTS.md "author_by_area").
   Default to the current `git config user.*` if the change is cross-cutting.
3. **Assemble Co-authored-by trailers** MANUALLY for every OTHER human who contributed to
   the change. One `Co-authored-by:` line per human, using their `Name <email>`.
4. **Run the guard** `scripts/check_commit.sh "<subject>" "<body>"` — it fails the commit if
   any trailer or the author is an AI/bot
   (regex: `claude|codex|anthropic|copilot|github-actions|dependabot|\bbot\b|\[bot\]`).
5. **Commit** with conventional `type(scope): summary`, the body, and the trailers.

## Safety rules

- NEVER add an AI/bot as author or `Co-authored-by`. This is the top guard, enforced by
  `scripts/check_commit.sh`.
- Trailers go at the END of the message, one per line, blank line before the block.

## Trailer block format

```
<subject>

<body>

Co-authored-by: Hao Zhang <zhisbug@users.noreply.github.com>
Co-authored-by: Junda Chen <32371474+GindaChen@users.noreply.github.com>
...all other humans who contributed...
```

## Scripts

- `scripts/check_commit.sh` — pre-commit guard (AI/bot-coauthor block).
  Exit non-zero blocks the commit. Wire it as a `pre-commit` / `commit-msg` hook too.
