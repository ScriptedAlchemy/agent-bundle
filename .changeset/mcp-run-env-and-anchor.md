---
"agent-bundle": minor
---

`mcp run` now owns the operator-environment seam the RFC #50 launchers were meant to retire, and stops fragmenting durable state per rebuild.

- The runner loads the project-root `.env` set by default (rsbuild `loadEnv` conventions: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`), with `--env-file <path>` (repeatable, replaces the conventional set) and `--no-env` overrides. A named file that cannot be read is an error.
- Launch-environment precedence is now documented and enforced, lowest to highest: manifest env, `.env` file layer, operator `process.env`. Previously manifest env was spread last and silently beat operator exports (for example `AGENT_BUNDLE_PLUGIN_ROOT`).
- Plugin-root path tokens in env values — including the injected `AGENT_BUNDLE_PLUGIN_ROOT` durable-state anchor — now expand to the resolved project root under `mcp run` instead of the ephemeral `artifact/<target>` root, so consumer state survives rebuilds. `args`/`cwd` stay artifact-rooted (the entry is the content-hashed bundle inside the artifact). `--plugin-root <path>` restores a byte-faithful copied-artifact rehearsal when wanted.
