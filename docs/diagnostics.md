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
| `AB480x` | Filesystem route conventions (#93 substrate): route-directory versus entry-file mode conflicts (`AB4800`: `src/mcp/<server>/` routes with a `src/mcp/<server>.ts` entry, `AB4801`: route-mode server also declared in `mcp.servers`, `AB4802`: `src/cli/` routes with `src/cli.ts`), `AB4803`: duplicate route ids, `AB4804`: unsafe route names. All errors: a server (and the package CLI) is in exactly one mode, and the compiler never silently chooses. |
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

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.
