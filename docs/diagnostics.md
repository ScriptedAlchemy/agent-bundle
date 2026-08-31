# Diagnostics reference

Every agent-bundle failure or nudge is one structured diagnostic: a stable
`code` (`AB` + four digits), a `severity` (`error`, `warning`, or `info`), a
`message`, and usually a `sourcePath` and a `recovery` hint. Commands exit
nonzero only when an **error** diagnostic is present; warnings and infos never
gate a build, a validation, or a dev rebuild.

## Code families

| Family | Area |
| --- | --- |
| `AB30xx` | Skill Markdown parsing (missing or malformed frontmatter). |
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
| `AB5000` | General CLI and adapter failures. |
| `AB7xxx` | Project preparation and development rebuilds. |
| `AB8xxx` | Development server configuration. |
| `AB9xxx` | Eval selection, harnesses, and persisted runs. |

## Migration nudges (`AB4730`–`AB4733`)

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

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.
