#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

rm -rf dist templates skill-templates web-dist

bun run build
cp -R src/templates templates
cp -R src/skill-templates skill-templates

(
  cd web
  bun install --frozen-lockfile
  bun run build
)
cp -R web/dist web-dist
