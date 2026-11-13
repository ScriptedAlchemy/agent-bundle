# Native OpenCode V2 Target Design

## Intent

Add `opencode` as a first-class built-in Agent Bundle projection, selectable with
`targets: ['opencode']` or `--target opencode`, so one authored plugin can emit a
real OpenCode V2 package and install it through the existing author CLI and
package-bound lifecycle entrypoint. The initial downstream consumer is
movie-library: convention-discovered MCP servers and skills must load without
manually copying skills.

## Evidence and constraints

The authoritative host is the installed `@opencode/cli` V2 **2.2.6**, not the
legacy `@opencode-ai` 1.x factory API. The matching public
`@opencode/plugin@2.2.6` package defines `Plugin.define({ id, setup(ctx) })`.
Transforms register MCP, skills, and commands; domain hooks include tool
`execute.before`/`execute.after`, session `prompt`/`experimental.idle`, and
permission `evaluate`. Current V2 documentation establishes local plugin package
loading from `.opencode/plugins/`, the `opencode.json(c)` `plugins` array, native
skills/commands/agents, and V2 MCP config. All acceptance must use isolated
temporary config/home roots.

Generated executables remain standalone. The only external runtime dependency of
an emitted OpenCode package is the host SDK, pinned exactly to
`@opencode/plugin@2.2.6` and declared in its own package manifest. Compile
evidence, emitted-module policy, manifest identity, and packed-consumer checks
remain unchanged.

## Approaches

1. **Native self-contained V2 package (chosen).** Emit
   `.opencode/plugins/<name>/{package.json,index.js,...}` plus a minimal
   `.opencode/opencode.json`. `setup` derives its package root from
   `import.meta.url`, registers capabilities, and spawns the already-compiled
   hook wrappers with V2-native envelope conversion. Project/user lifecycle
   installs copy just that package directory, where OpenCode auto-discovers it.
   This supports relocation and avoids editing unrelated host configuration.
2. **Copied portable skills plus config.** Rejected: it is exactly the manual
   compatibility workaround the request rules out and cannot deliver V2 hooks.
3. **Legacy V1 factory hook object.** Rejected: V2 does not run that API and it
   would not load through the actual 2.2.6 host.

## Artifact and runtime

- Public `OpenCodeHostConfig` is initially empty except for native lifecycle
  options only if evidence requires them; do not invent manifest metadata.
- The package entrypoint registers MCP from an internal validated server table,
  converting canonical stdio/remote entries to V2 `local`/`remote` transforms.
  It registers skills with V2 skill transforms and commands with V2 command
  transforms, preserving command descriptions and prompt text.
- Config hooks and semantic event routes are emitted only for evidenced V2
  surfaces: prompt submission, tool before/after/failure, stop through
  `experimental.idle`, and permission evaluation only where its native fields
  map honestly. Session start/end, agent lifecycle, workspace-open, compaction
  after, and other missing events remain unavailable. In particular,
  movie-library's `session/start` route is not claimed.
- MCP Apps remain generated resources but OpenCode has no evidenced App display
  surface at this pin; no UI support is advertised. Rules and authored agents
  are unavailable until native lowering is explicitly implemented.
- `mcpRuntime` reads the internal table for existing CLI/dev proxy flows; V2
  transforms resolve plugin/workspace/data roots at load time.
- Artifact validation uses the official pinned config schema plus local strict
  schemas for the native package manifest and internal server table. Every
  document and production module is reachable from the registry and emitted
  entrypoint.

## Lifecycle and development

`install|uninstall|doctor opencode` and package-bound `agent-bundle/install`
support project and user scopes. Installation copies only the native plugin
package, with the same content comparison, replacement, and receipt ownership
boundaries as other directory hosts. It never calls global `opencode plugin
add`, starts a shared service, or edits the user's normal configuration.

`dev --install-host opencode` uses the same stable bundle and development MCP
proxy rewrite as other native targets. Doctor reads host version and receipted
placement/content, and marks host registration/enablement/activation unavailable
unless a read-only V2 surface proves them.

## Verification

TDD covers registration, native document emission, MCP lowering and path roots,
skill/command transforms, supported/unsupported hook behavior, lifecycle
receipts, and the public API/scaffolder union. Integration and packed tests run
the generated package through the actual V2 loader in an isolated home, inspect
plugin/skill/MCP registration, execute a supported hook and MCP flow, and verify
the package-bound installer. Full build, typecheck, lint, unit, integration,
packed, and en/zh docs gates are required, with one patch changeset for each
publishable package changed (the task authorizes exactly one total changeset).
