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
| `AB43xx` | MCP server and MCP App configuration (`AB4340`: a declaration for a route-generated server redeclares `entry`/`command`/`url`; see below). |
| `AB44xx` | Script configuration. |
| `AB4500` | Registered config extensions (strict finite JSON). |
| `AB46xx` | Assets and the generated-runtime floor. |
| `AB470x` | Package build `bin` configuration (`AB4706`: artifact output overlaps `dist`; `AB4707`–`AB4709`: `output.distPath` shape, root escape, reserved namespace). |
| `AB471x` | Package build `lib` configuration (`AB4710`–`AB4715`) and declaration generation (`AB4716`; see below). |
| `AB472x` | The `tools.rsbuild` / `tools.rspack` escape hatch. |
| `AB473x` | Migration nudges (informational; see below). |
| `AB474x`/`AB4750` | Prebuilt payloads and prebuilt entries (see below). |
| `AB4760` | The published `agent-bundle/meta` identity module evaluated outside every compiled surface and outside the Rstest presets (see below). |
| `AB4765`–`AB4766` | Artifact-hosted routed CLI: a target without the `cli` capability omits `bin/<name>.mjs`; a host-emitted file collides with it (see below). |
| `AB490x`/`AB492x` | Conventional host components (#100 stage 2): rules `src/rules/*.mdc` (`AB4900`–`AB4906`) and commands `src/commands/*.md` (`AB4920`–`AB4926`); see below. |
| `AB5000` | General CLI and adapter failures. |
| `AB60xx` | Built-artifact validation, including schema documents and referenced files (`AB6011`/`AB6012`: a target's required pinned-schema document is missing or invalid; `AB6025`: a manifest-declared `logo` path is missing from the artifact or escapes the deploy tree; `AB6034`: emitted Skill Markdown has no instruction body; `AB6035`–`AB6038`: Agent Plugins portable validation, see below). |
| `AB700x` | Host installation: bundle identity, host availability, scope, command failure, and collision checks (`AB7005`: version collision, pre-receipt content collision, or foreign install; see below). |
| `AB7010`–`AB7013` | npm prepack inventory, artifact freshness, package bin targets, and release-version agreement. |
| `AB7200`–`AB7202`, `AB7210`–`AB7211` | Development rebuilds and live host surfaces: rebuild admission and phase failures, development host install sync, and the dev-epoch contract gate (see below). |
| `AB7xxx` | Project preparation and development rebuilds. |
| `AB7300`–`AB7321` | Read-only install Doctor: host probes, installed inventory, bundle comparison and registration proof, runtime endpoint health and identity, durable-state inventory, static bytes-at-rest validation, and foreign-install detection (`AB7321`; see below). |
| `AB8200`–`AB8209` | Workbench development runtime routes (`/api/runtime/**`): `AB8200` development runtime provider configuration, load, or lifecycle failure, `AB8201` runtime/session/run not available, `AB8202` invalid route path, `AB8203` invalid request shape, `AB8204` stale runtime generation or MCP session revision (409), `AB8205` runtime request could not be completed, `AB8206` Workbench runtime client failure, `AB8207` Agent Document decoding needs the optional `@agent-bundle/runtime` peer (503), `AB8208` stored Flight could not be decoded as an Agent Document (409), `AB8209` decoded Agent Document over the 16 MiB budget (413) or an invalid document response. |
| `AB8210`–`AB8214` | Workbench semantic lifecycle replay routes (`/api/lifecycles`, `/api/lifecycles/replays`): `AB8210` invalid path, `AB8211` malformed replay request or native envelope (400, carries the shared validator message), `AB8212` replay unavailable or could not be completed, `AB8213` stale manifest binding (409; the page repairs it with refresh → explicit re-run), `AB8214` replay over the 16 MiB budget (413). |
| `AB8215`–`AB8218` | Workbench read-only host discovery route. |
| `AB8219`–`AB8223` | Workbench live MCP probe route (user-initiated, read-only initialize + tools/list): `AB8219` invalid path, `AB8220` invalid request/method, `AB8221` probe target not found, `AB8222` response over the 16 MiB budget, `AB8223` probe unavailable. |
| `AB8233`–`AB8235` | Workbench browser-side strict decoders rejecting a dev-server response: `AB8233` lifecycle replay, `AB8234` host discovery, `AB8235` MCP probe report. |
| `AB8024`–`AB8025` | Live host MCP proxy: epoch drift behind a host connection and dev-server unavailability (see below). |
| `AB8xxx` | Development server configuration. |
| `AB9xxx` | Eval selection, harnesses, and persisted runs. |

## Cursor built-artifact validation (`AB6026`–`AB6029`)

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB6026` | info | Every Cursor host-validation report states that Cursor publishes no plugin-validate devtools verb and names the vendored schema pin used for local validation. | Review the pinned Cursor schema provenance before changing the local validator contract. |
| `AB6027` | error | A required generated Cursor document is missing or a present plugin, marketplace, MCP, or hooks document is unreadable, invalid JSON, or rejected by its pinned schema. | Repair the generated Cursor JSON document so it satisfies the vendored pinned schema, then rebuild. |
| `AB6028` | error | Generated bytes violate pinned Cursor loader evidence: manifest-candidate precedence selects a fallback manifest, a symlink resolves outside the bundle, or `CURSOR_PLUGIN_ROOT` appears outside loader-substituted fields. | Repair the generated Cursor layout, token locations, or symlinks to match the pinned loader evidence, then rebuild. |
| `AB6029` | info / warning | The Cursor Agent version probe is unavailable (`ENOENT`, info) or cannot complete successfully (warning). Local pinned-schema validation still runs. | Install Cursor Agent or repair `cursor-agent --version` when local CLI version evidence is required, then rerun artifact validation. |

## Codex host validation (`AB6030`–`AB6033`)

Codex 0.147.0 publishes plugin installation commands but no plugin-validation
developer tool. Agent Bundle therefore validates built Codex JSON documents
against its vendored pinned schemas and treats the app-server schema generator
as a separate drift signal, never as a substitute plugin contract.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6030` | info | The Codex CLI is unavailable, or the installed Codex release publishes no plugin validation command. | Install Codex and put it on `PATH`; until Codex publishes a validator, use the vendored pinned-schema diagnostics. |
| `AB6031` | info / warning (error in strict mode) | The app-server schema-generation verb is unavailable, or its live output is missing or differs from the pinned generated hook schemas. | Review the attributable host schema source and update the pinned revision only when Codex publishes the matching contract. |
| `AB6032` | error | A required Codex bundle document is missing, unreadable, invalid JSON, or fails its vendored pinned schema. | Repair the named `.codex-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, or marketplace document and rebuild. |
| `AB6033` | error | A bounded Codex version or schema-generation command could not start, failed, timed out, exceeded 1 MiB of output, or produced unreadable output. | Verify `codex --version` and `codex app-server generate-json-schema --out <dir>` complete successfully, then rerun validation. |

## Agent Skills emitted spec lint (`AB6034`)

Agent Bundle evaluated `@skill-tools/core@0.2.2` on 2026-09-02 and found a
genuine Agent Skills utility whose lint is nevertheless lower fidelity than
the pinned specification contract. Its parser does not pin a specification
revision, misses closed-frontmatter rules already enforced here, and contains
an internally inconsistent description-length warning. The package is not a
runtime dependency; the one missing mandatory rule it identified is enforced
locally against emitted bytes.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6034` | error | An emitted `SKILL.md` has valid YAML frontmatter but no Markdown instruction body after it. The pinned Agent Skills specification requires frontmatter followed by Markdown content. | Add Markdown instructions after the Skill frontmatter, then rebuild the artifact. |

## Agent Plugins portable validation (`AB6035`–`AB6038`)

The `portable` target is the [Agent Plugins open standard](https://agent-plugins.org/specification)
(specification 1.0.0) adapter. Its contract is pinned in
`packages/agent-bundle/src/adapters/schemas/portable/PROVENANCE.json` (schema
hashes, specification repository commit, retrieval and re-verification dates).
The standard publishes machine-readable schemas plus normative text the schemas
cannot express; the text wins on conflict, so validation runs both lanes and
never spawns a client CLI (the standard publishes no reference validator).

Validation happens at three moments, all fail-closed:

1. **Plan time** (`agent-bundle build`/`validate`): the emitted `plugin.json`
   and `mcp.json` are validated against the pinned schemas before they are
   written (`portable.schema.plugin`, `portable.schema.mcp`), authored manifest
   metadata is checked field by field (`portable.manifest.<field>.invalid`),
   MCP path tokens are refused where the standard forbids them
   (`portable.mcp.token.*`), and the normative MCP rules the schemas cannot
   express are applied to each server as it will be written
   (`portable.mcp.{command,cwd,env,url,headers}.standard`: command form, cwd
   containment, env-key placeholders, URL form, header names/values/casing).
   These target-scoped codes are errors, so a standard-invalid server never
   reaches an artifact.
2. **Artifact time** (`agent-bundle build`, `validate --artifact`): the generic
   target-contract pass reports a missing required document as `AB6011` and a
   pinned-schema rejection as `AB6012`, and the Agent Plugins byte lane below
   (`AB6035`–`AB6037`) runs over every tree emitted by the built-in portable
   adapter, so a standard-invalid layout fails the ordinary build before
   publication (a tree already carrying a symlink or other unsupported entry
   is reported as `AB6013` and never read by this lane).
   `validate --artifact --host-validation` additionally returns the same lane
   as a `portable` host validation report with the `AB6038` provenance note.
3. **Installed bytes** (`agent-bundle doctor`): a Cursor local plugin whose root
   `plugin.json` declares an Agent Plugins `$schema` is validated with the same
   byte lane and reported under `AB7320` (an error marks the entry `corrupt`).

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6035` | error | The root `plugin.json` is missing, or a present `plugin.json`/`mcp.json` is unreadable, not valid JSON, or rejected by its pinned Agent Plugins 1.0.0 schema (closed manifest fields, plugin name constraints, reserved `PLUGIN_ROOT`/`PLUGIN_DATA` env keys, closed server variants). | Repair the generated Agent Plugins document so it satisfies the pinned 1.0.0 schema, then rebuild. |
| `AB6036` | error | A normative-text rule the schemas cannot express is violated: `plugin.json` and `mcp.json` declare different Agent Plugins versions (§10.1); a stdio `command` is neither a bare executable name nor a bundled plugin-relative `./` file, or carries a placeholder (§7.2.1); a `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}` `cwd` escapes its root after resolution (§4.1/§7.2.1); a remote `url` is not an absolute HTTP(S) URL, carries user information or a fragment, uses plain HTTP against a non-loopback host, or carries a placeholder; header names are invalid, repeat under different casing, or carry placeholders, or a header value contains anything other than visible ASCII, space, horizontal tab, or obs-text bytes (§7.2.1, RFC 9110 §5.5); an `env` key carries a placeholder (§9.2); `skills/` or `mcp.json` is present with the wrong filesystem kind (§6.2); or a `skills/<name>/` directory has no regular `SKILL.md` (§7.1). | Repair the generated portable layout or MCP entry to satisfy the Agent Plugins 1.0.0 normative text, then rebuild. |
| `AB6037` | error | A symlink inside the plugin resolves outside the plugin root, or cannot be resolved at all (§4.1 containment). | Replace the escaping symlink with a file or a link that resolves inside the plugin root, then rebuild. |
| `AB6038` | info | Every portable host-validation report states that Agent Plugins publishes no reference validator and names the pinned schema provenance (specification repository commit, retrieval and re-verification dates) used for local validation. | Review the pinned Agent Plugins provenance before changing the local validator contract. |

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

`plugin.version` is **deprecated and optional**. New projects declare the
release version only in `package.json`; removal of the compatibility field
follows the normal breaking-change policy rather than a fixed window. When it
is omitted, the version every surface reports — manifests, host projections,
dev status, and the `agent-bundle/meta` constant compiled into plugin code —
is the `package.json` version. When it is declared, the declared value still
wins so a legacy config never changes meaning mid-migration, and a
disagreement reports the `AB4008` **warning**. Declaring it as anything but a
nonempty string is an `AB4001` error.

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

## Migration nudges and convention claims (`AB4730`–`AB4738`)

The entry conventions and the framework-owned stdio lifecycle shell (RFC #50)
replaced patterns consumers previously wrote by hand. When `validate`,
`inspect`, `build`, or `dev` prepares project source and finds one of those
pre-convention patterns, it reports a migration diagnostic. `AB4730`–`AB4735`
are **informational** nudges and never block anything. `AB4736`–`AB4738` are
errors: the removed top-level authored-document locations are no longer
discovered, and a conventional script whose `bin` entry would run an export
the artifact script ignores cannot ship on both surfaces, so the compiler
refuses to omit or misbuild them silently. The CLI prints these in
human `validate` output and includes them in every `--json` diagnostics array.

Which explicit config keys *claim* a conventional module out of discovery is
tabulated in `docs/entry-conventions.md` ("Which config keys claim a
conventional module"). In short: `scripts`, `hooks`, `lib`, and `mcp` entries
claim the module they reference; a `bin` entry claims every conventional
module **except** a safely named direct `src/scripts/<name>` child, which
keeps shipping as an artifact script beside the bin because the two outputs
are disjoint and both envelopes run the same `main`. That dual-surface shape
is intentional and raises no diagnostic.

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

A `src/skills/<name>/SKILL.md` (or rendered `SKILL.tsx`/`SKILL.ts`) directory
exists, but the explicit `skills` configuration does not cover it — the
conventional skill is silently shadowed. When config is silent, every
`src/skills/<name>/` directory ships by convention and this nudge never fires.

Adopt: remove the explicit `skills` configuration so the convention applies,
or add the directory to `skills`. Silence: remove the directory.

### `AB4735` — rendered skill source shadowed by hand-authored `SKILL.md`

A skill directory contains both a hand-authored `SKILL.md` and a rendered
skill source (`SKILL.tsx`/`SKILL.ts`). The authored file wins — an authored
document beats a generated one — so the component module never compiles.

Adopt: remove `SKILL.md` so the rendered skill compiles at build. Silence:
remove the component module.

### `AB4736` — legacy top-level authored document location

A document still matches a removed top-level convention:
`skills/<name>/SKILL.md` (or rendered `SKILL.tsx`/`SKILL.ts`),
`commands/*.md`, or `rules/*.mdc`. These locations are no longer discovered,
and every unignored legacy document is reported as an error. A top-level
skill covered by explicit `skills` configuration is claimed and stays valid;
commands and rules have no equivalent override.

Recover: move the document under `src/skills/`, `src/commands/`, or
`src/rules/`. Explicit `skills` paths remain valid anywhere. Published
artifact paths remain `skills/`, `commands/`, and `rules/`.

### `AB4737` — rendered script claimed as a package bin entry lacks `main` or the component

An explicit `bin` entry references a conventional rendered script
(`src/scripts/<name>.tsx` or `.jsx`) that does not export **both** an async
default Server Component and a named `main`. The component check is the
route compiler's own static scan — the default export must be an async
function, so `export default {}` does not count; a default re-exported from
another module (`export { default } from './component.tsx'`) cannot be judged
statically and is accepted (the rendered worker still verifies it at run
time). A plain `src/scripts/<name>.ts` module
ships happily on both surfaces — the npm bin envelope calls its `main(argv)`
and the artifact script is the same bundle — but a rendered script's default
export is an async Server Component the Agent renderer drives with
`{ argv, signal }` props. The bin envelope prefers a named `main` export and
only falls back to the default export, so without `main` it would call that
component as `main(argv)` and produce a bin that renders nothing; without the
default component, the bin works but `scripts/<name>.mjs` fails at run time
with no component to render. The compiler refuses either shape instead of
emitting a broken surface beside a working one. A rendered script that
exports both serves both surfaces and is not gated. The message names every
`bin` entry referencing the module and which export is missing.

Recover: export both an async default Server Component and a named
`main(argv)` from the module; point the `bin` entry at a plain module that exports `main`;
rename the script to `.ts` so one plain module ships as both the bin and the
artifact script; or prefix a path segment with `_` (`src/scripts/_name.tsx`)
to keep the module out of script discovery and bin-only.

### `AB4738` — plain script claimed as a package bin entry runs only as the bin

An explicit `bin` entry references a conventional plain script
(`src/scripts/<name>.ts`) that exports a `default` but no named `main`. Both
the bin envelope and the artifact-script envelope wrap a `main(argv)` export
and bundle a self-executing module (no `main`, no `default`) byte for byte,
so those shapes run identically on both surfaces. Only the bin envelope falls
back to invoking a default export: the artifact `scripts/<name>.mjs` would
merely define the function and exit, so a successful build would publish an
inert script beside a working bin. The detection is the same static export
scan the package build uses. The message names every `bin` entry referencing
the module.

Recover: export a named `main(argv)` so both surfaces run the same entry;
make the module self-executing (drop the default export and run at top
level); or prefix a path segment with `_` (`src/scripts/_name.ts`) to keep
the module out of script discovery and bin-only.

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

## Build-time identity outside the compiler (`AB4760`)

`agent-bundle/meta` (see `docs/entry-conventions.md`) is a reserved specifier
the compiler replaces in every compiled surface with the project's exact
`{ name, packageName, packageVersion, version }`. The published
`dist/meta.js` module behind that specifier therefore never carries an
identity of its own: every binding — `name`, `version`, `packageName`,
`packageVersion`, `meta`, and the default export — throws this diagnostic at
module evaluation, so a module that reaches it fails on import rather than
observing a fabricated identity. The thrown value is an `Error` named
`AgentBundleMetaUnavailableError` whose `code`, `recovery`, and structured
`diagnostic` fields carry the same data the message prints, so a bare `node`
process and a test runner both show the fix. The importing module is not
observable from a module evaluated through ESM linking, so the message names
the situation, not a file; the runner's own "failed to load" line names the
file.

Unit tests are the common way to reach it (issue #386): a plain Rstest pool
imports a source module that imports `agent-bundle/meta`, no compiled surface
replaced the specifier, and every test that touches that module fails at
import. `agentBundleRstest()` and `agentBundleBrowserRstest()` prevent this by
aliasing the specifier to `.agent-bundle/test/meta.mjs`, generated from the
same compiler pass. When that pass produced no plugin model (the configuration
could not be loaded or normalized) there is no identity to stamp, so the
aliased module throws the same `AB4760` naming the compiler diagnostics and
the recovery "fix them, then rerun Rstest" — the manifest's placeholder
identity is never served as a real one.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4760` | error | A module evaluated the published `agent-bundle/meta` outside a surface Agent Bundle compiles — typically a unit test pool not built from the Rstest preset, or a hand-run script importing plugin source. | Run the test under `agentBundleRstest()` or `agentBundleBrowserRstest()` from `agent-bundle/rstest` (pass `include` to cover a plain unit pool), or compile the surface with `agent-bundle build`. In a custom test runner, alias `agent-bundle/meta` (`resolve.alias`, exact match) to a module with the named exports `{ name, packageName, packageVersion, version, meta }` — `meta` the frozen object of the other four, exported as both the named binding and the default export — computed from the project's `agent-bundle.config.ts` plugin name and `package.json` version; the `.agent-bundle/test/meta.mjs` module `agentBundleRstest()` writes is that module. |

## Artifact-hosted routed CLI (`AB4765`–`AB4766`)

A generated-mode `src/cli/**` surface compiles into the npm package bin
(`dist/bin/<name>.js`) **and** into every host artifact whose adapter
publishes a supported `cli` capability, as `bin/<plugin-name>.mjs` (plus
`bin/<plugin-name>-flight.mjs` when any command renders). Every built-in
target hosts it; the two codes cover a target that does not and a host file
that claims the same path. See “The routed CLI shell” in
`docs/entry-conventions.md` for the layout and the sibling-path convention.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4765` | warning | The project has a routed CLI but a selected target's adapter publishes no supported `cli` capability, so that artifact ships no `bin/<name>.mjs`. Skills, hooks, and scripts in that artifact cannot invoke the routed CLI. `inspect` lists the same omission as an `unsupported-capability` skip of the `cli` component. Publish the capability (with a `cliBin` artifact layout) on the adapter, or keep references to the bin out of that target's surfaces. |
| `AB4766` | error (build) | A target plan already emits `bin/<name>.mjs` or `bin/<name>-flight.mjs` (for example a Claude `claude.bin` directory shipping a file of that name), compared case-insensitively because those are one file on macOS and Windows. The routed CLI owns those paths, so the build refuses instead of choosing. Rename or remove the host-emitted file, or set `bin: false` to keep it and drop the routed CLI executable. |

## Config beside a route-generated MCP server (`AB4340`)

A `mcp.servers.<id>` block for a server the route graph compiles in
`generated` mode augments that server (`env`, `args`, `targets`, `apps`,
`transport: 'stdio'`) — see the precedence table in
[Entry conventions](entry-conventions.md#config-beside-a-route-generated-mcp-server).
The local-entry field rules apply to it unchanged (`AB4305`, `AB4308`–`AB4312`,
`AB432x`), and it never triggers `AB4304` or `AB4322`: the route modules are
its entry.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4340` | error | A declaration for a route-generated server sets `entry`, `command`, or `url` while `routes.servers.<id>` is `generated`. The routes already compile this server, so a second entry claim has no reading the compiler could honor. Remove the field to keep the generated server (the other fields still apply), or set the mode to `custom`, `command`, or `remote` to serve the declared entry and omit the routes. Without an explicit mode the same collision is `AB4800`. |

## Conventional host components: rules and commands (`AB4900`–`AB4906`, `AB4920`–`AB4926`)

Conventional `src/rules/*.mdc` documents compile to the Rule IR (closed
frontmatter: `description`, `globs`, `alwaysApply`, plus the bundle-only
`targets` key that is peeled before emission) and `src/commands/*.md`
documents compile to the Command IR (closed frontmatter: `description`,
`argumentHint`, `allowedTools`, `model`, `disableModelInvocation`, plus
`targets`). Each host lowers only the surfaces its pinned capability table
supports; a document without `targets` is emitted where supported and
accounted as `skipped` with the host's judgment elsewhere (see
`agent-bundle inspect`), while a document that explicitly names a host without
the surface is a build error — unsupported components fail before artifact
publication rather than shipping as a broken half. Identity paths are
canonicalized so the model digest is root-independent.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4900` | error | A conventional rule file cannot be read. | Make the `.mdc` file readable, or remove it from `src/rules/`. |
| `AB4901` | error | Rule YAML frontmatter is invalid. | Repair the YAML between the `---` fences. |
| `AB4902` | error | Rule frontmatter declares a field outside `description`, `globs`, `alwaysApply`, `targets`. | Remove the field; host-specific rule metadata is not part of the closed contract. |
| `AB4903` | error | A rule frontmatter field has the wrong shape (`description` string, `globs` nonempty string or array, `alwaysApply` boolean, `targets` array of target names). | Fix the field's value. |
| `AB4904` | error | A rule's `targets` names a target that is not registered or not selected for the project. | Name only selected targets, or select that target in `targets`. |
| `AB4905` | error | A rule explicitly targets a host whose `rules` capability is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). | Drop that host from the rule's `targets`; only Cursor publishes a rules surface. |
| `AB4906` | error | Two rule files share a name. | Rename one file so every rule name is unique. |
| `AB4920` | error | A conventional command file cannot be read. | Make the `.md` file readable, or remove it from `src/commands/`. |
| `AB4921` | error | Command YAML frontmatter is invalid. | Repair the YAML between the `---` fences. |
| `AB4922` | error | Command frontmatter declares a field outside `description`, `argumentHint`, `allowedTools`, `model`, `disableModelInvocation`, `targets`. | Remove the field; per-host frontmatter is regenerated from the validated fields at lowering time. |
| `AB4923` | error | A command frontmatter field has the wrong shape (`allowedTools` nonempty string or array, string fields, `disableModelInvocation` boolean, `targets` array of target names). | Fix the field's value. |
| `AB4924` | error | A command's `targets` names a target that is not registered or not selected for the project. | Name only selected targets, or select that target in `targets`. |
| `AB4925` | error | A command explicitly targets a host whose `commands` capability is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). | Drop that host from the command's `targets`; Cursor and Claude publish command surfaces, Codex and portable do not. |
| `AB4926` | error | Two command files share a name. | Rename one file so every command name is unique. |

## Route graph, state, and provider conventions (`AB4800`–`AB4825`, `AB4940`–`AB4942`)

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
accepted form. Two constrained reference forms are accepted for string
values, so an MCP App's `resourceUri` never has to be repeated as a literal
in every tool that opens it:

- **A `const` string-literal identifier.** A top-level `const X = '<literal>'`
  (optionally `as const`) declared in the route module, or an
  `export const X = '<literal>'` of a module reached through a *relative*
  import (`import { X } from '../constants'`; `.ts`/`.tsx` resolution,
  `.js`-style specifiers map onto their TypeScript source, index modules
  resolve) inside the project root. The sibling module is parsed, never
  executed, and only that one hop is followed: the exported const's
  initializer must itself be a string literal. Because the identifier is a
  real import, the same value is available at run time (for example in
  `Agent.Result metadata`).
- **`appResourceUri('<app>')`** imported from `agent-bundle/routes`. The
  compiler resolves the reference to the target App route's static
  `config.resourceUri` while compiling the graph. The App must belong to the
  referencing route's own generated server — a generated server registers
  exactly its own Apps, so another server's URI could never be read through
  it. References are `'<app>'`, `'<server>/<app>'`,
  `'app:<server>/<app>'`, or a module path relative to the referencing file
  (`'../apps/dashboard'`, with or without its `.ts`/`.tsx` extension — a
  `.js`/`.jsx` spelling maps onto the TypeScript source, and any other suffix
  is part of the App name). The argument may be a
  string literal or a const identifier of the first form. An unknown
  reference — another server's App, an App whose own `resourceUri` is not a
  static string, or any reference from a non-MCP route — is `AB4826`, and the
  route compiles with the empty config beside it. Routes of a server that is
  not generated (`custom`/`command`/`remote`, or an `AB4800` conflict) never
  ship their config, so their references are left as authored rather than
  reported. Whether referenced or
  written as a literal, an advertised `_meta.ui.resourceUri` must name an App
  the server builds for every target it ships to (`AB4828` otherwise). At run time the helper returns the reference unchanged: generated
  servers read the compiled config, never the module's evaluated `config`, so
  use the const form when the URI is also needed inside the component.

Anything else — any other identifier, a call, a package import, a relative
import that leaves the project or does not export a string-literal const —
is dynamic: the route compiles with an empty config beside a named `AB4806`
error whose recovery names both reference forms. A module without a `config`
export compiles silently with an empty config.

An MCP App route's `config.template` resolves **relative to the route
module**, the way its imports do (`template: './dashboard.html'`). The older
project-root-relative form (`'./src/mcp/<server>/apps/dashboard.html'`) is
still accepted, without a diagnostic, while it is the only interpretation
that names an existing file. When both interpretations name different
existing files, or neither exists, `AB4827` names both candidate paths; the
fix is to make the path route-relative. The IR keeps the authored path (so the
graph digest stays machine-independent) and the normalized model carries the
resolved absolute file. Config-declared Apps (`mcp.servers.<server>.apps`)
keep resolving `entry` and `template` from the project root, where the config
file lives.
Generated route declarations are published at `.agent-bundle/routes.d.ts` from
the same graph. Development writes a sibling temporary file and renames it over
the prior complete declaration atomically; invalid source retains the prior
last-good file, while a successful route-free, provider-free preparation
removes it. Beside `AgentBundleRoutes`, a graph with conventional providers
declares `AgentBundleProviders` (`ProviderKey`, `ProviderValue<Key>`) — each
camel-cased key mapped to its factory's awaited return type, in execution
order — and augments `@agent-bundle/runtime`'s `AgentProviderValues` so
`(await agent()).providers.<key>` observes that type in projects whose
TypeScript program includes the file. Provider-free graphs emit no
augmentation, so the declaration never references a module the project has no
reason to depend on.

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
| `AB4806` | error | A route module's `config` initializer is dynamic — the message names the offending construct and position, and the recovery names the two accepted reference forms (a top-level `const` string literal declared locally or `export const`-ed by a relative sibling module, and `appResourceUri('<app>')` from `agent-bundle/routes`). |
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
| `AB4823` | error | An event route declares an event outside the v1 event vocabulary. |
| `AB4824` | error | An event route selects an unknown target or requires an event capability that the selected target does not support. |
| `AB4825` | error | An event route's `config.targets` is not a nonempty array of nonempty target names. |
| `AB4826` | error | A route's static `config` calls `appResourceUri('<app>')` with a reference that matches no App route of the route's own generated server with a static `config.resourceUri`: an unknown name, another server's App (a generated server registers only its own Apps), or a reference from a non-MCP route. The message names the cause and lists the server's known App route ids; reference the App as `'<app>'`, `'<server>/<app>'`, `'app:<server>/<app>'`, or a relative module path. |
| `AB4827` | error | An MCP App route's `config.template` is ambiguous or missing: both the route-relative and the project-root-relative interpretation name different existing files, or neither exists. The message names both candidate paths; templates resolve relative to the route module, so rewrite the path as `'./<file>.html'` beside the route. |
| `AB4828` | error | A generated MCP route advertises `_meta.ui.resourceUri` of an App on its server (through `appResourceUri()` or a literal) that is not built for every target the server ships to, because the App's `config.targets` (or a config-declared App's `targets`) is narrower. Widen the App's targets or restrict `mcp.servers.<server>.targets`. |
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

## Read-only runtime identity introspection (`AB7317`–`AB7318`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB7317` | info | A live event runtime implements the older strict protocol and does not expose runtime identity. Restart it after upgrading Agent Bundle. |
| `AB7318` | error | A live event runtime became unavailable, timed out, or returned an invalid status response during the bounded read-only identity probe. Inspect or restart the runtime, then rerun Doctor. |

## Read-only Doctor static validation (`AB7319`–`AB7320`)

Doctor reuses the pinned, process-free host document and loader validators.
These checks read installed or supplied bundle bytes only; they never invoke a
host CLI, repair a bundle, or perform a live protocol exchange.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7319` | error | A host tree resolved from `doctor --from` violates its pinned document schemas or process-free loader rules. The message retains the originating build-validator code and detail. | Rebuild that host bundle from valid source bytes, then rerun Doctor. |
| `AB7320` | error / info | Error when a `.cursor-plugin/plugin.json` install violates Cursor's pinned document schemas or token-location rules, when a root `plugin.json` install that declares an Agent Plugins `$schema` violates the pinned Agent Plugins 1.0.0 contract (`AB6035`–`AB6037`, retained in the message), or when any local plugin contains a symlink that escapes `~/.cursor/plugins/local`; the inventory entry is reported as `corrupt`. Info naming the contract applied to an Agent Plugins install, or stating that a `.claude-plugin/plugin.json` (or schema-less root `plugin.json`) install has no Cursor-side pinned static document contract; loader-recognized entries remain `installed`. | Reinstall an invalid Cursor plugin, rebuild an invalid portable bundle, or repair an escaping symlink. For other manifest flavors, use that ecosystem's validator when static document proof is required. |

## Install replacement and Doctor install comparison (`AB7005`, `AB7307`–`AB7309`, `AB7321`)

`agent-bundle install <host>` and the emitted standalone `install.mjs` share one
replace policy, and `agent-bundle doctor --from <bundle-dir>` reports the same
verdict read-only. Every Cursor copy an agent-bundle installer places carries an
install receipt, `.agent-bundle-install.json`, beside the plugin manifest:

```json
{
  "contentHash": "<sha256 over path\\0bytes\\0 for every owned file>",
  "files": [".cursor-plugin/plugin.json", "INSTALL.md", "install.mjs", "..."],
  "format": "agent-bundle-install-receipt/1",
  "host": "cursor",
  "installedAt": "2026-09-03T08:00:00.000Z",
  "plugin": "<plugin name>",
  "version": "<plugin version>"
}
```

The receipt never participates in the content hash. Ownership of an existing
destination is decided as **receipt** (a receipt naming this plugin), **legacy**
(no receipt, but the emitted `INSTALL.md` + `install.mjs` and a manifest with
this plugin's name — a copy installed before receipts existed), or **foreign**
(anything else). Claude and Codex copies are located through the host's own
`plugin list --json` inventory; the host owns those copies, so replacement runs
`claude plugin uninstall --keep-data` + `install` or `codex plugin remove` +
`add`.

| Installed copy | `install` | `install --replace` (alias `--force`) | Doctor |
| --- | --- | --- | --- |
| Identical content (receipt / host-managed) | `already-installed` no-op | `already-installed` no-op | `current` |
| Identical content (legacy) | `already-installed` no-op | `adopted` — receipt written, no plugin file changes | `current` |
| Receipt / host-managed, same version, different content | replaced automatically (`replaced`) | replaced | `stale` — `AB7308` warning |
| Receipt / host-managed, different version | `AB7005` version collision | replaced | `version-mismatch` — `AB7309` warning |
| Legacy, different content | `AB7005` content collision | replaced and adopted (receipt written) | `stale` — `AB7308` warning, recovery names `--replace` |
| Foreign directory | `AB7005` foreign install | `AB7005` foreign install | `foreign` — `AB7321` warning |
| Nothing installed | installed | installed | `not-installed` — `AB7307` info |

Every `AB7005`, `AB7308`, `AB7309`, and `AB7321` message carries the comparison
`installed <name>@<version> content <hash> vs artifact <name>@<version> content
<hash> (same version, different content | different version | same content)`.
Cursor replacement is in place and touches owned files only: stale owned files
are removed and their empty directories pruned, staged files are renamed over
their predecessors, and the receipt lands last. Entries the installer does not
own — notably workspace-durable `state/` stores — are never removed or
rewritten; when a rebuilt artifact introduces a path that an existing unowned
entry already occupies, replacement aborts before any change (`AB7004`,
"Refusing to overwrite unowned files") and names the colliding paths. Receipt
file lists are validated as strict POSIX-relative paths (no backslashes, no
`..`/`.`/empty segments, no drive letters) before they can drive a deletion; a
receipt that fails validation reads as absent.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7005` | error | `install` refused an existing destination: a different installed version without `--replace`, a legacy pre-receipt copy with different content without `--replace`, or a foreign directory (refused even with `--replace`). | Re-run with `--replace` for the first two cases; remove a foreign directory manually. |
| `AB7321` | warning | Doctor found a directory at the Cursor install path that is not an agent-bundle install of this plugin: no receipt naming it and no emitted install surface with a matching manifest, or a receipt naming another plugin. The message carries the installed-versus-artifact content-hash comparison. | Remove the foreign directory manually before installing; `--replace` refuses foreign installs by design. |

## Live development into hosts (`AB7200`–`AB7202`, `AB7210`–`AB7211`, `AB8024`–`AB8025`)

`agent-bundle dev` keeps a host's one stdio MCP process connected while it
swaps the generated plugin behind it (`dev proxy`), re-syncs opted-in
development installs (`--install-host`) on every adopted epoch, and — when a
project declares `dev.contracts` — gates host-facing adoption on the
development contract matrix. Every failure on that path is a structured
diagnostic; none of them silently changes what a host serves. A failing gate
is not a build failure: the epoch publishes to the Workbench playground, and
the Overview page's **Host adoption** section names both the published and the
host-facing build together with the failed checks.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7200` | error | A development rebuild could not be admitted: the coordinator is closed, closing, or not yet started. | Restart `agent-bundle dev`; no epoch changed. |
| `AB7201` | error | The prepare, lint, or artifact phase of a development rebuild threw instead of reporting diagnostics. The message names the phase and the underlying error. | Fix the named failure and save again; the last-good epoch stays active. |
| `AB7202` | error | Publishing a new epoch into an installed development host (`claude`, `codex`, or `cursor`) failed. Pointers were rolled back to the previous generation and the failure was published on `dev.host.sync`. | Repair the host cache path or permissions named in the message; the next successful epoch re-syncs. |
| `AB7210` | error | `dev.contracts` is malformed, its `fixtures` module escapes the project root, cannot be loaded, or default-exports something other than route-id keyed `ContractRouteFixture` objects. Reported on `dev.contract.status` for the affected epoch; compilation is unaffected. | Correct `dev.contracts` or the fixture module and rebuild; host surfaces keep the last passing epoch meanwhile. |
| `AB7211` | error | The development contract matrix failed or could not complete for a published epoch. The message carries the aggregated `contract-violation` detail; `dev.contract.status` lists the failed check names grouped by route. That epoch is never adopted by live host connections or development installs. | Fix the failing route or fixture and rebuild; a passing epoch is adopted normally. |
| `AB8024` | error (MCP) | The epoch a live host connection was serving vanished from the epoch store mid-session. The connection is invalidated and the typed MCP error carries `{ code, epochId }`. | Reconnect from the host; the proxy binds to the currently adopted epoch. |
| `AB8025` | error (MCP) | `agent-bundle dev proxy` found no running development server for the project (cold start or shutdown), so the host-facing connection fails closed rather than serving stale bytes. | Start `agent-bundle dev` for that project root; installed hooks and Skills remain in place. |

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.
