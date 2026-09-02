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
| `AB40xx` | Plugin metadata and Skill source validation (`AB4000`/`AB4001`: name/version; `AB4002`–`AB4007`: Skill fields; `AB4008`–`AB4011` and `AB4013`: release identity, see below; `AB4012`: declared `plugin.logo` is missing, not a file, or outside the project). |
| `AB41xx` | Normalized model invariants (unknown targets, duplicate IDs and outputs). |
| `AB42xx` | Hook configuration and native hook sources. |
| `AB43xx` | MCP server and MCP App configuration. |
| `AB44xx` | Script configuration. |
| `AB4500` | Registered config extensions (strict finite JSON). |
| `AB46xx` | Assets and the generated-runtime floor. |
| `AB470x` | Package build `bin` configuration (`AB4706`: artifact output overlaps `dist`). |
| `AB471x` | Package build `lib` configuration (`AB4710`–`AB4715`) and declaration generation (`AB4716`; see below). |
| `AB472x` | The `tools.rsbuild` / `tools.rspack` escape hatch. |
| `AB473x` | Migration nudges (informational; see below). |
| `AB474x`/`AB4750` | Prebuilt payloads and prebuilt entries (see below). |
| `AB5000` | General CLI and adapter failures. |
| `AB60xx` | Built-artifact validation, including schema documents and referenced files (`AB6025`: a manifest-declared `logo` path is missing from the artifact or escapes the deploy tree). |
| `AB700x` | Host installation: bundle identity, host availability, scope, command failure, and collision checks. |
| `AB7010`–`AB7013` | npm prepack inventory, artifact freshness, package bin targets, and release-version agreement. |
| `AB7xxx` | Project preparation and development rebuilds. |
| `AB7300`–`AB7316` | Read-only install Doctor: host probes, installed inventory, bundle comparison and registration proof, runtime endpoint health, and durable-state inventory. |
| `AB8xxx` | Development server configuration. |
| `AB9xxx` | Eval selection, harnesses, and persisted runs. |

## npm prepack gate (`AB7010`–`AB7013`)

| Code | Meaning |
| --- | --- |
| `AB7010` | The dry-run npm inventory omits a package output, artifact manifest/file, install surface, or README. Include `dist` and the artifact directory in the package `files` allowlist. |
| `AB7011` | An on-disk artifact file no longer matches its manifest SHA-256. Rebuild and do not modify generated host packs. |
| `AB7012` | A `package.json` bin points outside the packed `dist` output (including `src/`) or names a file npm omitted. Point it at the generated `dist/bin` file. |
| `AB7013` | `package.json`, normalized plugin metadata, a host manifest, or artifact provenance reports a different release version. Make every release identity agree. |

## Declaration generation (`AB4716`)

A `lib` entry with `dts` enabled compiles its source directory as its own
TypeScript program. When that declaration emit fails, the bundler aborts with
one prose line naming only its own environment, so the framework replays
declaration emit over the same synthesized project (the consumer's own
`typescript`, the same tsconfig, `--declaration --emitDeclarationOnly`) and
reports **one `AB4716` error per recovered TypeScript diagnostic**, each
carrying the file, the `(line,column)` position, the `TS` code, and the
compiler's message, plus a `sourcePath`:

```text
[AB4716] Declaration generation for lib entry "index" failed:
  src/operations/audible.ts(79,14): TS4023: Exported variable 'audibleOperations'
  has or is using name 'CliCommandDefinition' from external module "…" but cannot be named.
```

When no diagnostic can be recovered — the project has no resolvable
`typescript`, or the replay passes because the failure was elsewhere in
declaration generation — the failure still reports as a single `AB4716`
carrying the bundler's own message. Declaration failures never fall through
to the `AB5000` catch-all, whose dev-lock meaning previously misdirected
triage.

The recovery hint names the trap these failures share: declaration-emit
errors such as `TS4023` (an exported value whose inferred type names a type
its module does not export) are invisible to `tsc --noEmit`, so a green
`typecheck` script proves nothing about them. Reproduce them with
`tsc --declaration --emitDeclarationOnly` over the lib entry source
directory.

## Release identity (`AB4001`, `AB4008`–`AB4011`, `AB4013`)

`package.json` is authoritative for release identity (issue #94): its `name`
and `version` become the `packageName` and `packageVersion` axes carried on
the project context, artifact manifests, `inspect` output, and dev status.
`plugin.name` stays the host-native slug and is never derived from the npm
package name.

`plugin.version` is **optional**. When it is omitted, the version every
surface reports — manifests, host projections, dev status, and the
`agent-bundle/meta` constant compiled into plugin code — is the `package.json`
version. When it is declared, the declared value still wins so a legacy
config never changes meaning mid-migration, and a disagreement reports the
`AB4008` **warning**. Declaring it as anything but a nonempty string is an
`AB4001` error.

A project with neither an authored `plugin.version` nor a valid `package.json`
version has no release identity. Development commands (`dev`, `inspect`,
`validate`) keep running on the labeled `0.0.0-dev.<short-revision>` fallback,
because an unpackaged scratch project is a normal development state. A
development-only fallback can never produce a release artifact, so
`agent-bundle build` alone refuses it with `AB4013`.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4001` | error | `plugin.version` is declared as something other than a nonempty string. Omit the field to derive the version from `package.json`. |
| `AB4008` | warning | A declared `plugin.version` differs from the `package.json` version. Align the two, or drop `plugin.version`. |
| `AB4009` | warning | `package.json` `name` is not a valid npm package name; the `packageName` axis is withheld. |
| `AB4010` | warning | `package.json` `version` is not a valid semantic version; the `packageVersion` axis is withheld. |
| `AB4011` | warning | `package.json` is unusable — unparsable, not a JSON object, or symlinked outside the project root. |
| `AB4013` | error (build) | `agent-bundle build` refuses a project with no release version: `plugin.version` is omitted and `package.json` declares no valid semantic version. |

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

## Route graph, state, and provider conventions (`AB4800`–`AB4822`, `AB4940`–`AB4942`)

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
artifact with `provenance.kind: 'conventional'`. A rendered module
(`src/scripts/<name>.tsx`/`.jsx`, #102 stage 3) compiles to the same
`scripts/<name>.mjs` plus a sibling `scripts/<name>-flight.mjs` react-server
worker: its async default component receives `{ argv, signal }` and renders
through the Agent renderer with the full CLI output contract (`--json`,
`--ndjson`, interactive TTY progress, piped Markdown); the framework dialect
reserves exactly `--json` and `--ndjson`, every other argument passes
through as `argv`, and the exit code derives from the final document status
(0 on `success`, 1 otherwise). Explicit `scripts` config entries keep
ordinary Node semantics regardless of extension — config always wins, and
only the conventional route contract opts into rendering. Script routes
neither pipeline can ship are hard errors (`AB4808`/`AB4809`), never silent
omissions.

Conventional `src/cli/**` routes compile into one collision-checked command
graph (#102 stages 2-3): the file path below the CLI root is the command
nesting (`src/cli/library/audit.ts` runs as `<bin> library audit`), the
static `config` export supplies `description`, `aliases`, `positionals`, and
the `exitCode` policy, and the graph feeds one framework-generated package
executable named after the plugin (`dist/bin/<plugin-name>.js`), replacing
the `src/cli.ts` convention for that project. Every command route exports
`inputSchema` and `resultSchema` zod schemas plus one async default function
receiving `{ input, signal }`, and runs inside the typed Agent request
context. A plain (`.ts`) command executes directly and writes one canonical
JSON line to stdout. A rendered (`.tsx`) command's async default Server
Component renders through the runtime dispatcher against a sibling
`dist/bin/<plugin-name>-flight.mjs` react-server worker with four output
modes: interactive TTY updates progress in place before the final document;
piped output emits exactly one final Markdown document (no partial
fallbacks); `--json` emits the canonical validated final value; `--ndjson`
emits the sequence-numbered render-event stream (an Agent Bundle CLI/script
dialect — never MCP JSON-RPC, never written to an MCP server's stdout).
Diagnostics go to stderr; machine output owns stdout. Exit codes: 0 on
success (or the validated result's integer `exitCode` under
`config.exitCode: 'result'`), 1 on execution/render failure, 2 on usage or
input-validation failure, 130/143 after SIGINT/SIGTERM. `--help`, `--json`,
`--ndjson`, and `--version` are owned by the generated shell.

The power-tier `routes.mcpCommands` option projects tools from generated MCP
servers into that same command graph. Each tool becomes
`<server> <tool>` with one optional `--input '<JSON object>'` argument;
mutation-capable tools also require the enforced `--yes` flag. Missing or
malformed `annotations.readOnlyHint` is mutation-capable by default. Include
and exclude patterns use only literal text plus `*`; every declared pattern
must match at least one eligible `<server>:<tool>` identity so misspellings
fail during compilation. Projected commands invoke the same tool render and
request-context contracts as the generated MCP server, and their `mcp`
metadata records server, tool, and confirmation provenance in `inspect`.

The argv projection of `inputSchema` is extracted statically — the module is
parsed, never executed — from a bounded zod grammar: the top level is
`z.object({ ... })` or `z.strictObject({ ... })` (optionally `.strict()`);
each property chains from `z.string()`, `z.number()`, `z.boolean()`,
`z.url()` (a string option validated as a URL at run time),
`z.enum([...string literals])`, or `z.array(<string/number/enum element>)`;
chains may add `.optional()`, `.default(<static literal>)`, and
`.describe('<string literal>')`, plus validation-only refinements the
projection accepts without interpreting (strings: `min`/`max`/`length`/
`regex`/`startsWith`/`endsWith`/`includes`; numbers: `int`/`min`/`max`/`gt`/
`gte`/`lt`/`lte`/`positive`/`nonnegative`/`negative`/`nonpositive`/`finite`/
`safe`/`multipleOf`/`step`; arrays: `min`/`max`/`length`/`nonempty`) because
the module's real zod schema still validates every input at run time. Keys
project onto kebab-case options (`maxFiles` becomes `--max-files`); booleans
are flags and must carry `.optional()` or `.default(...)`;
`config.positionals` names the keys consumed as bare arguments in order,
where only the trailing positional may be a `z.array(...)` (variadic).
Anything outside that grammar — identifier references (including shared
schema constants), unions, nested objects, transforms, coercions — raises
`AB4814` naming the offending construct.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4800` | error | An MCP server has both discovered route modules under `src/mcp/<id>/` and an existing entry claim (the conventional `src/mcp/<id>.ts` module, or a declared `entry`/`command`/`url`) without an explicit `routes.servers.<id>` mode. |
| `AB4801` | error | The conventional `src/cli.ts` entry and `src/cli/` command route modules both exist without an explicit `routes.cli` mode. |
| `AB4802` | error | Two route modules derive the same route id (for example `.ts` and `.tsx` siblings with one stem). |
| `AB4803` | error | A route path derives an unsafe identity segment (each segment must match `^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$`). |
| `AB4804` | error | A `routes` mode override is not `generated`/`custom`/`command`/`remote` for a server, or `generated`/`conventional` for the CLI. |
| `AB4805` | error | A route module exports `config` through a rejected declaration shape (`let`/`var`, destructuring, `export { config }`, a function or class, a missing initializer), or the extracted value is not an object. |
| `AB4806` | error | A route module's `config` initializer is dynamic — the message names the offending construct and position. |
| `AB4807` | retired | The stage-1 rendered-script gate. Rendered script routes ship through the Agent renderer pipeline since #102 stage 3; the code is never reused. |
| `AB4808` | error | A conventional `src/scripts/` route nests below the scripts root; conventional scripts ship as direct children only. Move it up, prefix a path segment with `_`, or declare it under `scripts` in config with a flat name. |
| `AB4809` | error | A conventional `src/scripts/` route and a configured `scripts` entry share one script identity through different files. Point the config entry at the module to claim it, or rename one of the two. |
| `AB4810` | error | A generated MCP route is missing named `inputSchema`/`resultSchema` exports or its default export is not an async function component. |
| `AB4811` | error | A generated MCP route exports `execute` or `render`; route mode accepts only the async default Server Component contract. |
| `AB4812` | error | A generated MCP App route has no non-empty static `config.resourceUri`. |
| `AB4813` | error | The command graph collides: a route is both a command module and a command group, an alias collides with a sibling command, group, or alias, an alias is unsafe or duplicated, or an explicit `bin` entry claims the generated CLI executable's name. |
| `AB4814` | error | A CLI route's `inputSchema` leaves the bounded argv grammar (the message names the offending construct and position), a key projects onto a reserved or duplicate option name, a required boolean has no flag expression, or `config.positionals` violates the positional policy. |
| `AB4815` | error | A CLI route does not satisfy the routed command contract: missing named `inputSchema`/`resultSchema` exports, a default export that is not an async function, or malformed `config.description`/`aliases`/`exitCode` fields. |
| `AB4816` | retired | The stage-2 rendered-command gate. Rendered command routes render through the dispatcher since #102 stage 3; the code is never reused. |
| `AB4817` | error | An event route requires the shared runtime for a target, but no generated MCP entry hosts that runtime and the route does not allow standalone fallback. |
| `AB4818` | error | `src/state.ts` is present but does not default-export one direct `defineState({ ... })` call, or `state` config is not the supported `false` opt-out. |
| `AB4819` | error | The state definition's `id` or `lifetime` is missing, non-literal, empty, duplicated, or outside the state lifetime vocabulary. |
| `AB4820` | error | A generated project selects `external` state lifetime; v1 generated mounting supports only `request`, `process`, and `workspace-durable` because external drivers require embedder wiring. |
| `AB4821` | error | A project state definition uses the reserved notice-ledger id `@agent-bundle/runtime/agent-notice-ledger/v1`; generated runtimes own that id for the co-mounted notice store. |
| `AB4822` | error | A `routes.mcpCommands.include` or `.exclude` pattern matches no eligible tool, or `include: []` explicitly selects none. Correct the pattern using an available `<server>:<tool>` identity listed by the diagnostic. |
| `AB4940` | error | A conventional provider module has no default export or its default export is not a function. Default-export a factory receiving `{ invocation, signal }`. |
| `AB4941` | error | Two provider filenames derive the same camel-cased provider key. Rename one file so every provider key is unique. |
| `AB4942` | error | A provider filename derives the reserved `processLifetime` key. Rename the file so its camel-cased key does not collide with the framework-owned provider. |

## Read-only Doctor durable-state inventory (`AB7316`)

`agent-bundle doctor` inventories workspace-durable SQLite stores by directory
entry and filesystem metadata only. It never opens a database or creates
SQLite lock or shared-memory files.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB7316` | warning | An installed bundle's `state/` directory or one of its `*.sqlite`, `-wal`, or `-shm` files cannot be read with filesystem metadata operations. Repair permissions and rerun Doctor; Doctor never repairs state. |

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.
