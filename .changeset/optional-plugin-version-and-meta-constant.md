---
"agent-bundle": patch
---

Make `plugin.version` optional and derive it from `package.json`, so a packaged plugin declares its release version once. A declared value that is not a nonempty string still reports `AB4001`, and a declared value that disagrees with `package.json` still reports the `AB4008` warning. Development keeps the labeled `0.0.0-dev` fallback, while `agent-bundle build` now refuses a project with no release version at all with the new `AB4013` error, so a development fallback can never reach a release artifact.

Add the `agent-bundle/meta` build-time identity module. Every compiled plugin surface — script, CLI, MCP entry, hook, and package bundles plus browser MCP App bundles — resolves it to the exact `{ name, version, packageName, packageVersion }` reported by artifact manifests, `inspect`, and dev status, so plugins can delete hand-written `src/lib/version.ts` shims. Types ship with the package export; outside Agent Bundle compilation the module throws instead of reporting a fabricated identity.
