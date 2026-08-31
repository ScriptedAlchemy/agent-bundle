# Entry conventions and the framework-owned package build

agent-bundle is the build product for agent plugins the way Rslib is for
libraries: one `agent-bundle.config.ts`, one CLI, framework-owned entry
lifecycles, and a single blessed escape hatch into the bundler. This document
is the contract for the package build (`bin` / `lib`), the entry-file
conventions, the generated entry shells, and the `tools` escape hatch.

## The package build

`agent-bundle build` always emits host artifacts. When the project declares
`bin`/`lib` (or provides them by convention), the CLI build also produces the
node-consumable package build under `dist/` — the outputs `package.json`
`bin` and `exports` point at:

| Config | Output | Notes |
| --- | --- | --- |
| `bin: { '<name>': './src/cli.ts' }` | `dist/bin/<name>.js` | Self-executing ESM bundle, `#!/usr/bin/env node` shebang, executable bit. |
| `lib: { entry: './src/index.ts', dts: true }` | `dist/<stem>.js` + `dist/**/*.d.ts` | Single-entry ESM profile, node target, es2022 syntax. |

- The package build runs only for `agent-bundle build` (CLI, or
  `build({ packageOutputs: true })` through the API). Programmatic artifact
  operations — temporary artifacts, the dev workbench, evals — never write
  `dist/`.
- Outputs are staged and published atomically, and their provenance
  (bytes, SHA-256, sorted project-relative source inputs) is reported on the
  build result exactly like artifact files.
- `dist` is a mandatory-ignored directory: package outputs never enter
  project source snapshots or skill/asset discovery.
- An artifact `--output` that overlaps `dist` is rejected (`AB4706`).
- The `lib` profile is deliberately thin. A package that needs a multi-format
  library matrix (UMD, multiple entries, per-format tsconfig) has outgrown the
  profile and genuinely wants Rslib — that is the one case where a second
  bundler config remains, by choice.

### Declarations

`lib.dts` defaults to `true`. Declaration generation resolves `typescript`
from the project (add it as a devDependency) and compiles the lib entry's
source directory as its own program: compiler options come from the project
`tsconfig.json` (via `extends`), `rootDir` is pinned to the entry's directory,
and only that subtree is included — test files never fail or pollute the
package build. Declarations land flat under `dist/`, one `.d.ts` per source
module.

## Entry-file conventions

Conventions fill the config when it is silent; config always wins. Discovered
entries carry `provenance.kind: 'conventional'` in the normalized model.

| Convention | Meaning | Opt out |
| --- | --- | --- |
| `src/cli.ts` | Package bin named after `plugin.name` (skipped when the name is not a safe output name). | `bin: false` |
| `src/index.ts` | Library output with declarations. | `lib: false` |
| `src/mcp/<server-id>.ts` | Stdio entry for the declared MCP server `<server-id>` that names no `entry`, `command`, or `url`. | Declare `entry` explicitly |

Conventions match `.ts` and `.tsx` files exactly.

## Generated entry shells

The framework provides the entry files consumers used to write by hand
(react-router's provided-entry trick). Every generated shell imports the
consumer module by absolute path and is bundled through the same Rslib
synthesis and invariant assertions as all generated executables.

### The executable envelope (bin + Scripts)

A `bin` entry — or an artifact `Script` — whose module exports `main` (or a
default function for bin entries) receives the generated process envelope:

```ts
// src/cli.ts — the whole CLI entry a consumer writes
export const main = async (argv: readonly string[]): Promise<number> => {
  // ...
  return 0;
};
```

The envelope awaits `main(process.argv.slice(2))`, adopts a numeric return as
the process exit code, and lets an escaped rejection surface through Node's
top-level failure path (stack to stderr, exit code 1). Self-executing modules
(no `main` export) bundle directly, byte for byte — existing Scripts keep
their behavior.

### The stdio MCP lifecycle shell

An MCP server entry that **default-exports a server factory** is served under
the framework lifecycle:

```ts
// src/mcp/curator.ts — the whole stdio entry a consumer writes
import { createRscMcpServer } from '@agent-bundle/rsc-runtime/plugin';
import { application } from '../application.js';

export default () => createRscMcpServer(application, 'curator');
```

The generated shell provides, in order: console-to-stderr redirection before
the consumer module evaluates, the factory call, raw `process.stdout.write`
restored for protocol frames, `StdioServerTransport` construction and
connect, SIGINT → exit 130, SIGTERM → exit 143, stdin EOF → exit 0 (so the
client can respawn), transport-close → exit 0, a 5-second bounded shutdown
race against wedged transports, and heartbeat/activity logging on stderr
(5-minute interval, 60-second activity throttle, labeled with the server
name).

Self-connecting entries — modules that construct and connect a transport at
top level without a default export — keep today's behavior byte for byte.

The same lifecycle is public API for hand-rolled entries:

```ts
import { redirectConsoleToStderr, runStdioServer } from 'agent-bundle/mcp-entry';
```

Export detection is a static scan of the entry source (comment-, string-, and
template-safe). The generated shells re-verify the export shape at runtime
with a clear error.

## `tools` — THE escape hatch

`tools.rsbuild` (an Rsbuild environment-config fragment) and `tools.rspack`
(an Rspack config object, mutator function, or array — Rslib semantics) merge
**last** into every bundler config agent-bundle synthesizes: artifact scripts,
MCP entries, hook wrappers, MCP App views, and the package build. This mirrors
Rslib's user-config-highest priority and Rspress's `builderConfig` position,
and it is the reason a consumer never needs a second bundler config file.

The hatch is bounded: the framework invariant hook runs after the consumer's
`tools.rspack`, and the resolved-config assertions still run after the merge.
A hatch value that breaks an artifact contract (async chunks, output roots,
self-containment) fails the build with a hard diagnostic instead of silently
overriding the contract. The hatch customizes *how code compiles*, never
*what the artifact promises*.

## `agent-bundle mcp run`

```sh
agent-bundle mcp run --server <name> --target <target> [--artifact <path>]
  [--env-file <path>]... [--no-env] [--plugin-root <path>]
```

Runs one built stdio MCP server in the foreground with inherited stdio: the
content-hashed generated entry is resolved from the target's MCP manifest
(the job previously solved with bash launchers parsing `mcp.json`), path
tokens are resolved through the target adapter, and the child's exit code is
forwarded (SIGINT/SIGTERM forward to the child). Without `--artifact`, a
temporary artifact is built first.

### Launch environment

The runner loads the project-root `.env` set by default — rsbuild's `loadEnv`
conventions (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`, with
`--mode` selecting the variants), the same files `createRslib` reads for the
same consumers at build time — so operator credentials configured for the
plugin reach a bare `mcp run` without a wrapper script. `--env-file <path>`
(repeatable, Node's `--env-file` dialect, later files win) replaces the
conventional set with exactly the named files, and `--no-env` skips the layer
entirely; a named file that cannot be read is an error, never a silent skip.

The child environment is composed from three layers. This table is the
canonical precedence order (highest wins):

| Precedence | Layer | Contents |
| --- | --- | --- |
| 3 (highest) | Operator `process.env` | The real environment `mcp run` was started with. An exported variable always wins. |
| 2 | `.env` file layer | The conventional project-root set, or the explicit `--env-file` list in order. Fills gaps only; never beats an exported variable. |
| 1 (lowest) | Manifest env | Entries declared in the server config plus the injected plugin-root anchor, path tokens expanded. |

### Durable-state anchors

Under `mcp run` the artifact is an ephemeral build product, so both
durable-state anchors point at the project root: state anchored on the
plugin-data token persists under `.agent-bundle/mcp-run/<target>/<server>`,
and plugin-root tokens in *env values* — including the injected
`AGENT_BUNDLE_PLUGIN_ROOT` anchor — expand to the project root itself.
Targets without token interpolation (Codex serializes the anchor as a `./`
path) re-anchor their relative env values against the same durable root.
`args` and `cwd` stay artifact-rooted (the first argument is the
content-hashed bundle inside the target root). `--plugin-root <path>`
overrides the env-anchor root, e.g. point it at `artifact/<target>` for a
byte-faithful rehearsal of a copied-artifact launch; under a host install the
anchor still means the durable install root, exactly as before.
