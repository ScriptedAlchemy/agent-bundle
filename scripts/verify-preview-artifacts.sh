#!/usr/bin/env bash
# Fail unless pkg.pr.new serves every publishable package for one commit.
set -euo pipefail

sha=${1:-${GITHUB_SHA:-}}
if [ -z "$sha" ]; then
  echo "::error::A commit SHA is required to verify pkg.pr.new previews."
  exit 1
fi

attempts=${PREVIEW_ATTEMPTS:-8}
delay=${PREVIEW_RETRY_SECONDS:-15}
missing=()
for dir in \
  packages/agent-bundle \
  packages/rsc-runtime \
  packages/rsc-markdown-stream \
  packages/create-agent-bundle
do
  name=$(node -p "JSON.parse(require('node:fs').readFileSync('$dir/package.json','utf8')).name")
  if [ -z "$name" ] || [ "$name" = undefined ]; then
    echo "::error::$dir/package.json has no package name to verify."
    exit 1
  fi
  url="https://pkg.pr.new/ScriptedAlchemy/agent-bundle/${name}@${sha}"
  found=false
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsSL -o /dev/null "$url" 2>/dev/null; then
      found=true
      break
    fi
    echo "attempt $attempt/$attempts: $url not available yet"
    [ "$attempt" -lt "$attempts" ] && sleep "$delay"
  done
  if $found; then
    echo "preview $url"
  else
    missing+=("$url")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing pkg.pr.new previews: ${missing[*]}"
  exit 1
fi
