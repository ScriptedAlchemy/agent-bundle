#!/usr/bin/env bash
# Release packages: fail unless every publishable package.json version resolves
# on npm. Retries cover registry replication lag right after `changeset publish`.
set -euo pipefail

attempts=${REGISTRY_ATTEMPTS:-8}
delay=${REGISTRY_RETRY_SECONDS:-15}
missing=()
for dir in \
  packages/agent-bundle \
  packages/rsc-runtime \
  packages/rsc-markdown-stream \
  packages/create-agent-bundle
do
  name=$(node -p "JSON.parse(require('node:fs').readFileSync('$dir/package.json','utf8')).name")
  version=$(node -p "JSON.parse(require('node:fs').readFileSync('$dir/package.json','utf8')).version")
  if [ -z "$name" ] || [ -z "$version" ] || [ "$version" = undefined ]; then
    echo "::error::$dir/package.json has no name/version to verify."
    exit 1
  fi
  found=false
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if [ "$(npm view "$name@$version" version 2>/dev/null || true)" = "$version" ]; then
      found=true
      break
    fi
    echo "attempt $attempt/$attempts: $name@$version not on npm yet"
    [ "$attempt" -lt "$attempts" ] && sleep "$delay"
  done
  if $found; then
    echo "registry $name@$version"
  else
    missing+=("$name@$version")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Not on npm: ${missing[*]}. The tree says these versions shipped; the registry disagrees (publishing disabled, token missing, or changeset publish failed)."
  exit 1
fi
