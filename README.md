# agent-bundle

agent-bundle compiles an agent plugin — skills, hooks, MCP servers, and scripts, described by one typed config — into installable artifacts for Claude Code, Codex, and Cursor, plus a portable layout. You write the plugin once; the compiler emits each host's manifests and wrappers.

Requires Node.js 22.19 or later.

## Install

Nothing is published to npm yet (the `agent-bundle` name on npm currently belongs to an unrelated project). Until the first release, install the preview tarballs CI publishes for every commit and pull request:

```sh
npm i -D https://pkg.pr.new/ScriptedAlchemy/agent-bundle/agent-bundle@<sha-or-pr>
```

Use a PR number or the SHA of a commit whose package-preview run succeeded (every green `main` commit has one). See [Preview packages](docs/preview-packages.md) for pinning and details.

## Quick start

The fastest start is the scaffolder — it prompts for a name, a template
(`minimal`, `mcp-server`, or `cli-tool`), and the host targets, then emits a
project that already passes its own `check`:

```sh
npx https://pkg.pr.new/ScriptedAlchemy/agent-bundle/create-agent-bundle@<sha-or-pr> my-plugin
```

(`npm create agent-bundle` once npm releases exist. See the
[create-agent-bundle README](packages/create-agent-bundle/README.md) for
templates and flags.)

Or describe the plugin by hand in `agent-bundle.config.ts` at the project root:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: { name: 'my-plugin', version: '0.1.0', description: 'What it does.' },
  targets: ['plugin'],
  skills: ['skills/*'],
  hooks: { sessionStart: { handler: './src/session-start.ts' } },
  mcp: { servers: { tools: { entry: './src/mcp.ts' } } },
});
```

Then build, or work interactively:

```sh
npx agent-bundle build --root . --output dist   # write installable artifacts
npx agent-bundle dev --root .                   # local workbench with live rebuilds
```

`targets: ['plugin']` emits one multi-host bundle at `dist/plugin/`: `.claude-plugin/`, `.codex-plugin/`, and `.cursor-plugin/` manifests over shared `skills/`, `hooks/`, `mcp/`, and `scripts/` directories. The bundle's generated `AGENTS.md` explains how to install it into each host. Per-host layouts are available as the `claude`, `codex`, `cursor`, and `portable` targets.

Claude Code language servers are declared under `claude.lspServers`; the `claude` target and the Claude half of `plugin` emit the record as plugin-root `.lsp.json`. Agent Bundle expands path tokens only in `command`, `args`, `env`, and `workspaceFolder`, and it does not include the language-server binary — install that separately so the declared command is available on `PATH`. Codex, Cursor, and the portable format do not currently receive this host-scoped configuration.

The same config also owns the npm package build — no second bundler config, bin shims, or hand-rolled stdio lifecycles. `bin` and `lib` entries (or the conventions `src/cli.ts`, `src/index.ts`, and `src/mcp/<server-id>.ts`) emit executable `dist/bin/<name>.js` bundles and a library output alongside the host artifacts; an MCP entry that default-exports a server factory runs under a framework-owned stdio lifecycle; `tools.rsbuild` / `tools.rspack` is the one bundler escape hatch. [Entry conventions](docs/entry-conventions.md) is the full contract, and [Framework mode](docs/framework-mode.md) is the whole authoring model on one screen: structure in config and conventions (`skills/<name>/SKILL.md` ships with no declaration at all), JSX only where something is rendered.

## Commands

- `build` — validate the project and write an artifact (plus the `bin`/`lib` package build when declared)
- `validate` — check project source, or a built artifact with `--artifact <dir>`
- `inspect` — show the normalized configuration and per-target plans; `--bundler` dumps the synthesized bundler configs (post-`tools`-hatch merge)
- `dev` — serve the local development workbench and rebuild the `dist/` package build when its inputs change
- `mcp list` / `mcp invoke` / `mcp run` — list, invoke, or run an artifact's MCP servers locally
- `hooks list` / `hooks simulate` — inspect and simulate generated hooks
- `eval` — run eval suites against a built artifact

When validating a built `claude` or unified `plugin` target, Agent Bundle uses the installed
Claude Code developer toolchain in addition to its pinned schemas. Use
`agent-bundle validate --artifact dist --strict` in CI; Claude's `--strict` findings remain
warnings locally unless Agent Bundle strict mode is requested. If `claude` is absent, validation
reports an explicit informational skip. For the install-free development loop, run
`claude --plugin-dir dist/claude plugin list --json` after building.

The [package README](packages/agent-bundle/README.md) is the full reference: configuration semantics, the workbench, the optional Agent API, evals, and limitations.

## Examples

| Example | What it shows | Run |
| --- | --- | --- |
| [Skills Starter](examples/skills-starter) | author a release-review skill with deterministic evidence | `pnpm example:skills` |
| [Hooks and Scripts](examples/hooks-and-scripts) | simulate a hook and inspect script traces | `pnpm example:hooks` |
| [MCP App](examples/mcp-app) | an interactive MCP App with a deterministic eval | `pnpm example:mcp-app` |
| [Audiobook Curator](examples/audiobook-curator) | a real media-management plugin for Claude or Codex | `pnpm example:audiobook` |

Run these from the repository root. `pnpm examples:check` validates and builds every example noninteractively.

## Development

`pnpm check` runs the local delivery gate (build, unit and integration tests, lint, typecheck); `pnpm check:release` adds the packaging gates. `pnpm check:local-ci` mirrors the full hosted CI gate — the three-Node verify matrix plus the examples, release, and micro-eval jobs — in parallel local worktrees, and is the merge gate for the local-merge workflow described in [docs/local-ci.md](docs/local-ci.md). Versioning goes through Changesets. Native Claude/Codex host smokes are opt-in and intentionally skipped in CI. The Workbench architecture and the optional RSC runtime are documented in [docs/architecture/rsc-runtime-workbench.md](docs/architecture/rsc-runtime-workbench.md).

## Status

Pre-release. The final npm package name and license are not yet chosen; pkg.pr.new previews are the release channel until then.
