# Diagnostics reference

Every agent-bundle failure or nudge is one structured diagnostic: a stable
`code` (`AB` + four digits), a `severity` (`error`, `warning`, or `info`), a
`message`, and usually a `sourcePath` and a `recovery` hint. Commands exit
nonzero only when an **error** diagnostic is present; warnings and infos never
gate a build, a validation, or a dev rebuild.

## Code families

| Family | Area |
| --- | --- |
| `AB30xx` | Skill documents: Markdown parsing (`AB3000`–`AB3002`: unreadable, missing or malformed frontmatter) and rendered-skill compilation (`AB3003`: module failed to load, `AB3004`: missing/invalid default component or `frontmatter` export, `AB3005`: content outside the supported Markdown element subset). |
| `AB40xx` | Plugin metadata and Skill source validation. |
| `AB41xx` | Normalized model invariants (unknown targets, duplicate IDs and outputs). |
| `AB42xx` | Hook configuration and native hook sources. |
| `AB43xx` | MCP server and MCP App configuration. |
| `AB44xx` | Script configuration. |
| `AB4500` | Registered config extensions (strict finite JSON). |
| `AB46xx` | Assets and the generated-runtime floor. |
| `AB470x` | Package build `bin` configuration (`AB4706`: artifact output overlaps `dist`). |
| `AB471x` | Package build `lib` configuration. |
| `AB472x` | The `tools.rsbuild` / `tools.rspack` escape hatch. |
| `AB473x` | Migration nudges (informational; see below). |
| `AB474x`/`AB4750` | Prebuilt payloads and prebuilt entries (see below). |
| `AB5000` | General CLI and adapter failures. |
| `AB7xxx` | Project preparation and development rebuilds. |
| `AB8xxx` | Development server configuration. |
| `AB9xxx` | Eval selection, harnesses, and persisted runs. |

## Migration nudges (`AB4730`–`AB4735`)

The entry conventions and the framework-owned stdio lifecycle shell (RFC #50)
replaced patterns consumers previously wrote by hand. When `validate`,
`inspect`, `build`, or `dev` prepares project source and finds one of those
pre-convention patterns, it reports an **informational** nudge. Nudges are
never errors and never block anything — migrations stay optional, per the
RFC's additive-first principle. The CLI prints them in human `validate`
output and includes them in every `--json` diagnostics array.

### `AB4730` — self-connecting stdio MCP entry

A local MCP server entry module (explicit `entry:` or the conventional
`src/mcp/<server-id>.ts`) has no default export, so the build bundles it
byte-for-byte instead of wrapping it in the framework stdio lifecycle shell
(console-to-stderr guard, SIGINT/SIGTERM, stdin-EOF exit, bounded shutdown,
heartbeat). The detection is the same static default-export scan the build
uses, so the nudge and the build always agree.

Adopt: default-export a server factory from the entry module. Silence: keep
the self-connecting entry — its behavior is preserved exactly.

### `AB4731` — `src/cli.ts` shadowed by explicit `bin` config

`src/cli.ts` (or `.tsx`) exists, but the explicit `bin` configuration never
references it, so the conventional package bin is silently shadowed.
`bin: false` is a deliberate opt-out and stays silent.

Adopt: remove the explicit `bin` configuration, or point one entry at the
file. Silence: remove the file, or keep the explicit config knowingly.

### `AB4732` — `src/index.ts` shadowed by explicit `lib` config

`src/index.ts` (or `.tsx`) exists, but the explicit `lib` configuration
points elsewhere. `lib: false` is a deliberate opt-out and stays silent.

Adopt: remove the explicit `lib` configuration, or point it at the file.
Silence: remove the file, or keep the explicit config knowingly.

### `AB4733` — `src/mcp/<server-id>.ts` shadowed by explicit server config

The conventional stdio entry file exists for a declared server, but that
server names an explicit `entry`, `command`, or `url` that does not resolve
to it — a confusable state where the file on disk is not what runs.

Adopt: drop the explicit `entry`/`command`/`url` so the convention applies.
Silence: remove the shadowed file.

### `AB4734` — conventional skill shadowed by explicit `skills` config

A `skills/<name>/SKILL.md` (or rendered `SKILL.tsx`/`SKILL.ts`) directory
exists, but the explicit `skills` configuration does not cover it — the
conventional skill is silently shadowed. When config is silent, every
`skills/<name>/` directory ships by convention and this nudge never fires.

Adopt: remove the explicit `skills` configuration so the convention applies,
or add the directory to `skills`. Silence: remove the directory.

### `AB4735` — rendered skill source shadowed by hand-authored `SKILL.md`

A skill directory contains both a hand-authored `SKILL.md` and a rendered
skill source (`SKILL.tsx`/`SKILL.ts`). The authored file wins — an authored
document beats a generated one — so the component module never compiles.

Adopt: remove `SKILL.md` so the rendered skill compiles at build. Silence:
remove the component module.

## Prebuilt payloads (`AB4740`–`AB4750`)

The `payload` block and `{ prebuilt: ... }` entries (see
`docs/entry-conventions.md`) package files the framework did not compile.
The consumer's own build produces them, so their diagnostics split by
moment: configuration mistakes are validation **errors**, a payload that has
simply not been built yet is a validation **warning** that only
`agent-bundle build` escalates, and freshness is an **info** nudge.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4740` | error | The `payload` block, one entry, or its `targets` list is malformed, or a payload selects an unknown target. |
| `AB4741` | error | A payload destination is not a safe directory name, or shadows a compiler-owned artifact namespace (`assets`, `hooks`, `mcp`, `mcp-apps`, `scripts`, `skills`, root documents). |
| `AB4742` | error | A payload source escapes the project root, is not a directory, or contains another payload's source. |
| `AB4743` | warning | A declared payload directory does not exist yet or contains no files. Run the project's own build first. |
| `AB4744` | error | A `{ prebuilt: ... }` entry (MCP server or hook handler) does not resolve inside a declared payload, or its payload does not select every target the component needs. |
| `AB4745` | warning | A declared prebuilt entry file does not exist yet. Run the project's own build first. |
| `AB4746` | error | Hook `args` on a non-prebuilt handler, or arguments outside the shell-safe charset. |
| `AB4747` | error (build) | `agent-bundle build` refuses an empty or missing payload. |
| `AB4748` | error (build) | `agent-bundle build` refuses a prebuilt entry file absent from its payload. |
| `AB4749` | error (build) | A payload directory overlaps the artifact `--output` root. |
| `AB4750` | info | A payload is older than the newest project source file and may be stale; rerun the project's own build if so. |

## Route graph (`AB4800`–`AB4812`)

The route-graph compiler discovers conventional route modules
(`src/mcp/<server>/{tools,resources,prompts,apps}/*`, `src/events/*/*`,
`src/providers/*`, `src/cli/**`, `src/scripts/**`) into one immutable IR.
Discovery is not a packaging choice, so every collision is a hard **error**
and the compiler never silently picks a side. Modules that explicit
`scripts`, `hooks`, `bin`, `lib`, or `mcp` configuration references are
claimed by that declaration and never become routes — config always wins.
`agent-bundle inspect --routes` dumps the compiled graph.

Each route's `config` export is extracted statically — the module is parsed
with the TypeScript compiler, never executed — from a single top-level
`export const config = <expression>` declaration. The accepted expression
grammar is: object literals whose property names are identifiers, string
literals, or numeric literals (no computed names, spreads, shorthand
references, methods, or accessors); array literals without spreads or holes;
string literals and substitution-free template literals; numeric literals,
optionally wrapped in unary `+`/`-`; `true`, `false`, and `null`; and
`as`/`satisfies` casts, non-null assertions, and parentheses around any
accepted form. Anything else is dynamic: the route compiles with an empty
config beside a named `AB4806` error. A module without a `config` export
compiles silently with an empty config.
Generated route declarations are published at `.agent-bundle/routes.d.ts` from
the same graph. Development writes a sibling temporary file and renames it over
the prior complete declaration atomically; invalid source retains the prior
last-good file, while a successful route-free preparation removes it.

Conventional `src/scripts/` routes ship through the same pipeline as
explicit `scripts` entries (#102 stage 1): a plain module directly under
`src/scripts/` compiles to `scripts/<name>.mjs` in every selected target
artifact with `provenance.kind: 'conventional'`. Script routes that pipeline
cannot ship yet are hard errors (`AB4807`–`AB4809`), never silent omissions.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4800` | error | An MCP server has both discovered route modules under `src/mcp/<id>/` and an existing entry claim (the conventional `src/mcp/<id>.ts` module, or a declared `entry`/`command`/`url`) without an explicit `routes.servers.<id>` mode. |
| `AB4801` | error | The conventional `src/cli.ts` entry and `src/cli/` command route modules both exist without an explicit `routes.cli` mode. |
| `AB4802` | error | Two route modules derive the same route id (for example `.ts` and `.tsx` siblings with one stem). |
| `AB4803` | error | A route path derives an unsafe identity segment (each segment must match `^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$`). |
| `AB4804` | error | A `routes` mode override is not `generated`/`custom`/`command`/`remote` for a server, or `generated`/`conventional` for the CLI. |
| `AB4805` | error | A route module exports `config` through a rejected declaration shape (`let`/`var`, destructuring, `export { config }`, a function or class, a missing initializer), or the extracted value is not an object. |
| `AB4806` | error | A route module's `config` initializer is dynamic — the message names the offending construct and position. |
| `AB4807` | error | A conventional `src/scripts/` route is a rendered-script module (`.tsx`/`.jsx`); rendered scripts are not supported yet. Rename it to `.ts`, prefix a path segment with `_` to keep it private, or declare it under `scripts` in config to opt into plain bundling. |
| `AB4808` | error | A conventional `src/scripts/` route nests below the scripts root; conventional scripts ship as direct children only. Move it up, prefix a path segment with `_`, or declare it under `scripts` in config with a flat name. |
| `AB4809` | error | A conventional `src/scripts/` route and a configured `scripts` entry share one script identity through different files. Point the config entry at the module to claim it, or rename one of the two. |
| `AB4810` | error | A generated MCP route is missing named `inputSchema`/`resultSchema` exports or its default export is not an async function component. |
| `AB4811` | error | A generated MCP route exports `execute` or `render`; route mode accepts only the async default Server Component contract. |
| `AB4812` | error | A generated MCP App route has no non-empty static `config.resourceUri`. |

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.
