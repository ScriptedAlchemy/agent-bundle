---
'agent-bundle': patch
---

Derive validated `packageName`/`packageVersion` from the project's `package.json` into the project identity (issue #94 stages 1-2). Both axes now flow through the normalized model metadata, `ProjectContext`, artifact manifests, inspect output, and dev status DTOs; projects without a package version keep a clearly labeled development fallback in displays. New warning diagnostics: AB4008 (`plugin.version` differs from the package version), AB4009 (invalid npm package name), AB4010 (invalid package semver), AB4011 (unparsable package.json).
