---
'agent-bundle': minor
---

Derive validated `packageName`/`packageVersion` from the project's `package.json` into the project identity (issue #94 stages 1-2). Both axes now flow through the normalized model metadata, `ProjectContext`, artifact manifests, inspect output, and dev status DTOs (source status and artifact epochs); `plugin.version` still authors the native plugin version but the package version is authoritative for release identity and a mismatch never silently wins. Projects without a package version keep a clearly labeled `0.0.0-dev` development fallback in displays. New warning diagnostics: AB4008 (`plugin.version` differs from the package version), AB4009 (invalid npm package name), AB4010 (invalid package semver), AB4011 (unusable package.json).
