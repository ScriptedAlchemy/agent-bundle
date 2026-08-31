---
"agent-bundle": minor
---

agent-bundle owns the build (RFC #50 Phase 1): one `agent-bundle.config.ts` now produces the npm package build alongside host artifacts, with framework-owned entry lifecycles and one bundler escape hatch.

- `bin` config (or the `src/cli.ts` convention) emits self-executing `dist/bin/<name>.js` bundles with a shebang, executable bit, and a generated `main(argv)` process envelope; artifact Scripts whose module exports `main` receive the same envelope.
- `lib` config (or the `src/index.ts` convention) emits a single-entry ESM library build with declarations, resolving `typescript` and tsconfig compiler options from the project.
- MCP server entries that default-export a server factory are wrapped in the new framework stdio lifecycle shell — console-to-stderr guard with raw stdout restored for protocol frames, SIGINT 130 / SIGTERM 143, stdin-EOF exit 0, bounded shutdown race, heartbeat — also public as `agent-bundle/mcp-entry`. Self-connecting entries keep their behavior byte for byte. The `src/mcp/<server-id>.ts` convention supplies the entry for servers naming no `entry`, `command`, or `url`.
- `tools.rsbuild` / `tools.rspack` is the single blessed bundler escape hatch, merged last into every synthesized config (scripts, MCP entries, hooks, MCP Apps, package build) and still bounded by the artifact invariant assertions.
- `agent-bundle mcp run --server <name> --target <target>` runs one built stdio server in the foreground, resolving its content-hashed generated entry from the target manifest.
