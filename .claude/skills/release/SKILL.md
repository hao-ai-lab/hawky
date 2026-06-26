---
name: release
description: >-
  Cut a hawky release: bump version, generate a clean human-attributed changelog,
  tag, and publish the three artifacts (npm CLI, web build, iOS archive). Enforces
  the same guard as commit (no AI/bot attribution in tag or changelog). Trigger
  when the user says "cut a release / publish / tag a version / ship hawky vX.Y.Z".
---

# release

Ship a versioned hawky release across CLI, web, and iOS.

## Workflow

1. **Pre-flight**: clean working tree, on `main`, full test suites green
   (`bun test`; `web` + `web-ios` vitest; iOS `xcodebuild test` if signing is set up).
2. **Version**: bump `package.json` (root + playgrounds) and the iOS marketing version in
   `ios/project.yml`; keep them in sync.
3. **Changelog**: `scripts/changelog.sh <prev-tag> <new-tag>` groups commits by conventional
   type and lists per-section human contributors. It STRIPS any AI/bot trailer.
4. **Commit** the bump + changelog via the `commit` skill.
5. **Tag**: annotated tag `vX.Y.Z`.
6. **Publish**:
   - npm: `npm publish` (package name `hawky`),
   - web: `bun run build` in `web/` and deploy `web/dist`,
   - iOS: `xcodebuild archive -scheme hawky` -> export -> upload.
7. **GitHub Release**: `gh release create vX.Y.Z --repo hao-ai-lab/hawky` with the changelog;
   verify the release URL resolves.

## Safety rules

- Changelog credits humans only — strip every AI/bot trailer.
- Confirm `--repo hao-ai-lab/hawky` (multi-remote safety) before `gh release create`.
- Verify each published artifact exists (npm version live, web deploy reachable, release URL
  200) before reporting done.

## Scripts

- `scripts/changelog.sh <from> <to>` — conventional-commit changelog with human attribution,
  AI/bot trailers stripped.
