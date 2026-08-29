# agent-bundle

`agent-bundle` compiles one Agent Bundle project into portable, Codex, Claude Code, and Cursor artifacts. It discovers skills, validates a typed configuration, bundles local JavaScript/TypeScript entry points, and writes the host-specific metadata needed by each selected target.

It requires Node.js 22.19 or later.

## Quick start

Install the package in the project that owns the plugin, describe the plugin
once, and compile it for every host you target:

```sh
npm install --save-dev agent-bundle
```

No version has been published to npm yet. Until the first release is cut,
install the identical preview package CI publishes for every commit and pull
request — see [Preview packages](docs/preview-packages.md).

```ts
// agent-bundle.config.ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: { name: 'my-plugin', version: '0.1.0', description: 'One bundle, every agent host.' },
  targets: ['plugin'],
  skills: ['skills/*'],
  hooks: { sessionStart: { handler: './src/session-start.ts' } },
  mcp: { servers: { tools: { entry: './src/mcp.ts' } } },
});
```

```sh
agent-bundle dev --root .              # local workbench with live rebuilds
agent-bundle build --root . --output dist
```

`targets: ['plugin']` emits one **agent plugin bundle** at `dist/plugin/` that
installs into multiple hosts from the same root: `.claude-plugin/` (Claude
Code), `.codex-plugin/` (Codex), and `.cursor-plugin/` (Cursor) manifests over
shared `skills/`, `hooks/`, `mcp/`, `scripts/`, and `assets/` directories,
plus a generated `AGENTS.md` install matrix. Hooks compile into host-detecting
wrappers shared by Claude Code and Codex plus dedicated Cursor-codec wrappers,
so one authored hook serves all three hosts. Per-host artifacts remain
available as `claude`, `codex`, `cursor`, and `portable` targets when a
host-specific layout is required.

## Install and build

```sh
agent-bundle dev --root .
agent-bundle build --root . --output artifact
```

The implemented commands are:

- `agent-bundle build` validates source and writes an artifact.
- `agent-bundle inspect` displays the normalized source configuration and target plans.
- `agent-bundle validate` validates source; `agent-bundle validate --artifact <dir>` validates a previously built artifact without reading source configuration.
- `agent-bundle mcp list` and `agent-bundle mcp invoke` operate a local artifact MCP server.
- `agent-bundle hooks list` and `agent-bundle hooks simulate` inspect and simulate generated hooks.
- `agent-bundle dev` starts the local development server and Workbench for an
  ordinary project. Runtime remains an advanced optional extension:
  `dev.runtime.provider` selects an application-owned provider when configured.
- `agent-bundle eval` runs deterministic or native Claude/Codex eval suites and records a run.

`inspect` is intentionally a source/config-plan command; run it before source removal. Artifact-only inspection is the validation contract (`validate --artifact`).

## Install the built bundle into hosts

The compiled `dist/plugin/` directory is the installable product, and its
generated `AGENTS.md` repeats this install matrix next to the artifact:

- **Claude Code** — add the directory (or its repository) as a plugin:
  `claude plugin marketplace add <source>`.
- **Codex** — `codex plugin marketplace add <source>`; the manifest is
  `.codex-plugin/plugin.json`.
- **Cursor** — clone (or symlink) the directory to
  `~/.cursor/plugins/local/<name>`; the manifest is
  `.cursor-plugin/plugin.json`.
- **skills CLI** — `npx skills add <source> --skill <name>` consumes the
  shared `skills/` directory directly.

Per-host artifacts (`dist/claude/`, `dist/codex/`, `dist/portable/`) install
the same way into their single host. Validate any artifact after the source
project is gone with `agent-bundle validate --artifact <dir>`.

`agent-bundle dev` is available without the RSC example. Installing
`agent-bundle` does not install the example provider or React/RSC dependencies.
The optional example and Workbench architecture are documented in
[the RSC Runtime topology](docs/architecture/rsc-runtime-workbench.md). Native
evaluation evidence is example-owned, reuses an already signed-in host session
when a contributor runs it, and never accepts or stores API keys.

## Developer workbench and Agent API

`agent-bundle dev` is a loopback-only foreground session for inspecting source and published artifact
epochs, exercising artifact-bound MCP, hook, script, and native-host operations, and running evals.
It never becomes part of a generated artifact.

The same foreground session is available programmatically through the public `startDevServer`
export. It accepts the options the CLI flags map to (`root`, `port`, `open`, `agentApi`) and
resolves to a `DevServerSession` exposing the loopback `url`, a `status()` snapshot, and `close()`:

```ts
import { startDevServer } from 'agent-bundle';

const session = await startDevServer({ root: process.cwd(), port: 3100 });
console.log(session.url);
await session.close();
```

The Playground is the durable whole-plugin workflow. `script.run` is available there for trusted
local use: it selects a manifest-owned emitted script for the selected target and records its exit,
bounded stdout/stderr, cancellation, and epoch-bound evidence. Native prompts select a
server-cataloged case, fixture, host, and pinned model for that epoch; they do not accept a browser
provided command or model. Completed Playground sessions can replay or export their ordered raw
event references and promote selected durable evidence into a draft eval case.

The Hook and MCP pages also execute generated artifacts, but their independent operations do not
silently join an open Playground session. Start the operation from Playground when it must form part
of the ordered export or a promoted draft. Logs stay grouped by producer (build, diagnostics, MCP,
hook, host, and grader) with raw stdout/stderr and protocol streams available as evidence. The MCP
page opens an epoch-bound generated-server session, supports cancellation and explicit **Restart**,
and previews a compatible MCP App through that same session.

The optional Agent API exposes a fixed Streamable HTTP MCP endpoint at `/mcp` on that same foreground
URL. It is disabled by default. Enable it with `--agent-api` (or set `dev: { agentApi: true }` in the
project config) only after setting a fixed bearer secret:

```sh
AGENT_BUNDLE_AGENT_API_TOKEN='replace-with-a-secret' agent-bundle dev --agent-api --no-open --port 3100
```

`--no-agent-api` overrides config enablement. The endpoint accepts standard `Authorization: Bearer`
authentication, allows Codex clients without an `Origin` header, and rejects a browser-origin request
unless it is exactly the foreground origin. The token is read once at startup and is never logged,
persisted, or returned. A running endpoint uses the same URL and token across foreground restarts;
its stateless MCP transport lets an initialized client issue later requests when the foreground
server returns.

The API exposes exactly thirteen stable tools: `project_status`, `skills_list`, `skill_inspect`,
`artifacts_list`, `artifact_inspect`, `mcp_servers_list`, `mcp_invoke`, `hooks_list`,
`hook_simulate`, `evals_list`, `eval_run`, `eval_get`, and `diagnostics_list`. `eval_run` admits
deterministic evals only; native-harness choice is never an Agent API input. Their schemas reject
undeclared fields, so clients cannot name filesystem roots, artifact paths, commands, working
directories, environments, harnesses, or browser-authored evidence/outcomes. Omitted artifact epochs
bind atomically to the active publication; in-flight and explicitly selected epoch operations stay
pinned until they complete. A hot rebuild sends new calls to the new active epoch, while an open
generated MCP session remains bound to its original epoch until it is closed or explicitly restarted.
Host MCP catalog changes can require that host to reload its MCP connection; Agent Bundle does not
use `notifications/tools/list_changed` as a workbench HMR mechanism.

Rsbuild UI HMR is contributor-only. It runs through
`AGENT_BUNDLE_WORKBENCH_API_PROXY=<foreground-url> pnpm --filter agent-bundle-workbench dev`,
whose `packages/workbench/scripts/dev.mjs` wrapper refuses to start without the foreground API
proxy. Published `agent-bundle dev` serves prebuilt assets and live project events instead.

## Configuration

Create `agent-bundle.config.ts` at the project root. `defineConfig` is available from `agent-bundle/config` for type checking:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: {
    name: 'review-tools',
    version: '1.0.0',
    description: 'Review helpers for an agent host.',
  },
  targets: ['portable', 'codex', 'claude', 'cursor'], // or ['plugin'] for the unified multi-host bundle
  skills: ['skills/*'],
  scripts: {
    report: './src/report.ts',
    bootstrap: { entry: './scripts/bootstrap.sh', targets: ['codex', 'claude'] },
    migrate: './scripts/migrate.py',
  },
  hooks: {
    sessionStart: { handler: './src/session-start.ts' },
  },
  mcp: {
    servers: {
      local: {
        entry: './src/mcp.ts',
        apps: {
          dashboard: {
            entry: './views/dashboard.ts',
            resourceUri: 'ui://review-tools/dashboard.html',
            targets: ['portable'],
            _meta: { ui: { prefersBorder: true } },
          },
        },
      },
      remote: {
        transport: 'streamable-http',
        url: 'https://example.invalid/mcp',
      },
    },
  },
});
```

`scripts` is a record: its key is the stable output name and each value is either an entry path or `{ entry, targets? }`. JavaScript-family entries (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`) are bundled. Shell and Python entries (`.sh`, `.bash`, `.py`) are copied byte-for-byte and keep the source permission mode. Every target receives selected scripts at `scripts/<name>.mjs` for bundled entries or `scripts/<name><source-extension>` for copied entries.

Skills follow the Agent Skills directory layout and may contain references and binary assets. Local MCP server entries and hook handlers are bundled. A local MCP App may import its generated browser resource list with `import apps from 'agent-bundle/mcp-apps'`; the generated resource uses the configured `resourceUri` and metadata.

The compiler rejects unsafe output names, unsupported extensions, nonexistent or escaping source paths, unknown targets, and output collisions before it stages an artifact. It does not call Codex, Claude, or another host CLI, and it does not require API keys.

### Adapter-owned extensions

Ordinary projects need no runtime extension key. `AgentBundleConfig` explicitly
intersects the bundled portable, Codex, and Claude extension interfaces through
`AgentBundleConfigExtensions`, so packed declarations retain their author
fields. `TargetRegistry` owns each unique descriptor and adapter. Extension
values are strict finite JSON; host-specific values belong to their adapter. A
new host registers an adapter and exports/merges its interface rather than adding
a raw compiler or Runtime configuration parser. ChatGPT/OpenAI and Claude
Workbench profiles are local simulation profiles, not configuration-extension
claims.

## Artifact contract

Artifacts use stable, unhashed script output names. A representative tree is:

```text
artifact/
  agent-bundle.manifest.json
  agent-bundle.hooks.json
  portable/
    plugin.json
    scripts/<name>.mjs
    skills/<skill>/...
    mcp.json
    mcp-apps/<app>.html
  codex/
    .codex-plugin/plugin.json
    .mcp.json
    scripts/<name>.mjs
    hooks/<name>.mjs
  claude/
    .claude-plugin/plugin.json
    .mcp.json
    scripts/<name>.mjs
    hooks/<name>.mjs
  cursor/
    .cursor-plugin/plugin.json
    mcp.json
    scripts/<name>.mjs
    hooks/<name>.mjs
    skills/<skill>/...
```

`agent-bundle.manifest.json` records each emitted file's path, byte length, and SHA-256 digest. This allows `validate --artifact` and artifact operations to run after the source project is no longer present.

Portable artifacts contain portable plugin, skills, MCP, and App-resource files. Codex and Claude artifacts contain their respective native metadata and generated hook wrappers. Cursor artifacts contain the `.cursor-plugin/plugin.json` manifest, the auto-discovered `mcp.json` (Cursor's typeless server format), the flat versioned `hooks/hooks.json` with Cursor-codec wrappers, and shared skills, scripts, and assets. Terminal hosts can use normal MCP tools and resources; visual rendering of an MCP App depends on the host supporting the standard resource metadata.

## Public examples

The repository includes credential-free public example workspaces. Each
uses only the public `agent-bundle` CLI and package exports, exactly as an
external project would. The Workbench is a desktop product; these walkthroughs
and its acceptance suite use a 1440×900 desktop viewport.

| Example | Start here when you want to… | Command |
| --- | --- | --- |
| [Skills Starter](examples/skills-starter) | author a release-review Skill and deterministic evidence | `pnpm example:skills` |
| [Hooks and Scripts](examples/hooks-and-scripts) | simulate a Hook and inspect successful and blocking script traces | `pnpm example:hooks` |
| [MCP App](examples/mcp-app) | exercise a degraded service result in an interactive App and deterministic eval | `pnpm example:mcp-app` |
| [Audiobook Curator](examples/audiobook-curator) | inspect, safely prepare, and audit local audiobook media through Claude or Codex | `pnpm example:audiobook` |

Run these commands from the repository root. The filtered package command runs
inside the selected example, so `agent-bundle` infers that example directory as
its project root. `pnpm examples:check` performs every example's noninteractive
validation and build. To run a command from an example directly, first `cd` to
that example; its package-local `pnpm validate`, `pnpm build`, and `pnpm dev`
commands infer the same root.

Every Workbench starts on **Overview**, the Bundle dashboard: **Author** points
to Skills and Hooks, **Build** to Artifacts, **Exercise** to Skills, Hooks,
Playground, and MCP, and **Evaluate** to Evals and Comparisons. The pages show
different evidence rather than alternative launchers:

- **Skills** compares authored source, linked resources, generated output, and
  declared eval coverage.
- **Hooks** simulates canonical host input and replays the saved epoch-bound
  input. **Playground** runs an emitted capability and retains its durable
  trace; **Logs** exposes those producer records and raw details.
- **Artifacts** shows the selected target's emitted files and provenance.
  **Comparisons** needs two recorded eval runs before it can align outcomes.
- **MCP playground** opens an epoch-bound generated-server session, invokes
  tools, shows the protocol trace, and renders a compatible MCP App. **Evals**
  runs the selected deterministic case against checked-in fixtures.

The per-example walkthroughs record the actual initial selections and a safe
diagnostic repair loop. Wait for a completed, failed, or idle state before
capturing or judging a Workbench result; a loading/building state is not a
durable outcome.

## Contributor delivery and release gates

From this repository, run the complete local delivery gate with:

```sh
pnpm check && pnpm check:release
```

`pnpm check:release` is the release-only gate: it runs `pnpm pack:dry-run`,
`pnpm audit:release`, and `pnpm test:packed`; it does not replace `pnpm check`.

Native Claude/Codex host smokes are intentionally opt-in and stay skipped in CI. They run only on a
machine with that CLI installed and signed in — via `AGENT_BUNDLE_NATIVE_CLAUDE_SMOKE=1` /
`AGENT_BUNDLE_NATIVE_CODEX_SMOKE=1`, the packed variants `pnpm test:packed:native:claude` /
`pnpm test:packed:native:codex`, or the manually dispatched self-hosted **Native host smoke**
workflow. A skipped native smoke in CI is the intended state, not a delivery gap.

Repository-owned Chromium E2E runs independently of a connected ChatGPT Chrome extension. The
extension is for the separate final manual visual pass, not a substitute for repository or packed
consumer verification. Package versions and release PRs use Changesets. Add a changeset with
`pnpm changeset`; merges to `main` update or publish through the standard Changesets action. Pull
requests and every push to `main` publish `agent-bundle` and `@agent-bundle/rsc-runtime` canaries
through pkg.pr.new — the interim release channel while npm publishing waits on the final package
name (see [Preview packages](docs/preview-packages.md)).
