# agent-bundle

Compile a typed Agent Bundle configuration into portable, Codex, Claude Code, and Cursor artifacts. Node.js 22.19 or later is required.

```sh
npm install --save-dev agent-bundle
agent-bundle dev --root .
agent-bundle build --root . --output artifact
```

The package supports source `inspect`, source or artifact `validate`, local artifact MCP list/invoke, artifact hook list/simulate, and ordinary local development:

```sh
agent-bundle dev --root .
```

`inspect` reads source configuration; use `validate --artifact artifact` for source-free artifact validation. `dev.runtime.provider` is an advanced optional extension: a normal project starts the dev server and Workbench without loading an RSC provider.

Generated executables target Node.js 22.12 or newer by default. `runtime: { node: '24.0' }` raises
that floor (it can never be lowered), and the selected floor is recorded as `runtime.node` in the
artifact manifest.

Files under a root `assets/` directory copy byte-for-byte into every target artifact's `assets/`
directory. Top-level `assets` replaces that convention with explicit entries: literal file paths,
whole directories, or globs, all resolved from the project root. Entries outside `assets/` keep
their project-relative path under the artifact's `assets/` directory.

Every emitted stdio MCP server entry carries an `AGENT_BUNDLE_PLUGIN_ROOT` environment variable
holding the plugin install root in the target's native spelling: `${CLAUDE_PLUGIN_ROOT}` on Claude
Code, `${PLUGIN_ROOT}` on portable, `${CURSOR_PLUGIN_ROOT}` on Cursor, and `./` on Codex, resolved
against the entry's plugin-root `cwd`. Codex has no path-token interpolation, so a Codex stdio
server without a plugin-root working directory omits the anchor; source-built (`entry:`) servers
always have one on every target. Server runtime code should resolve persistent state and bundled
assets against this anchor rather than the process working directory: Claude Code currently
launches stdio servers from the host's own working directory and ignores the emitted `cwd` field
(the Claude adapter still emits `cwd: "${CLAUDE_PLUGIN_ROOT}"` as documented, schema-valid
future-proofing). A server's own `env` entries win over the injected value, so declaring
`env: { AGENT_BUNDLE_PLUGIN_ROOT: ... }` replaces the anchor. The `pluginRootEnvAnchor` export
names the variable for consumer code.

Hook `tools` accept the canonical selectors (`shell`, `file.read`, `file.write`, `mcp`, `agent`)
plus explicit host-native selectors such as `claude:WebSearch` or `codex:view_image`, which
contribute only to that host's native matcher. A hook that selects tools must leave every selected
target with at least one applicable selector, otherwise the build fails.

agent-bundle also owns the npm-facing package build: `bin` entries become self-executing
`dist/bin/<name>.js` bundles (shebang, executable bit, generated `main(argv)` envelope) and the
optional `lib` entry becomes `dist/<stem>.js` with declarations (resolving `typescript` from the
project). The `src/cli.ts`, `src/index.ts`, and `src/mcp/<server-id>.ts` conventions fill these in
when the config is silent; config always wins and `bin: false` / `lib: false` opt out. MCP server
entries that default-export a server factory are wrapped in the framework stdio lifecycle shell
(console-to-stderr guard with raw stdout restored for protocol frames, SIGINT 130 / SIGTERM 143,
stdin-EOF exit 0, bounded shutdown, heartbeat), also available directly from
`agent-bundle/mcp-entry`. `tools.rsbuild` / `tools.rspack` is the single bundler escape hatch,
merged last into every synthesized config and bounded by the artifact invariant assertions. See
the repository's `docs/entry-conventions.md` for the full contract.

## Commands

| Command | Purpose |
| --- | --- |
| `agent-bundle build` | Build a validated artifact from source, plus the declared `dist/` package build. |
| `agent-bundle validate` | Validate project source, or an artifact with `--artifact`. |
| `agent-bundle inspect` | Inspect normalized targets and adapter plans from source. |
| `agent-bundle inspect --bundler` | Dump the synthesized Rslib/Rsbuild configs (post-`tools`-hatch merge) for every generated output. |
| `agent-bundle mcp list` / `mcp invoke` | List or invoke one MCP tool from an artifact. |
| `agent-bundle mcp run` | Run one built stdio MCP server in the foreground, resolving its hashed entry, loading the project-root `.env` set (`--env-file`/`--no-env` to override), and expanding env state anchors to the project root (`--plugin-root` to override). Environment precedence: manifest env < `.env` files < operator `process.env`. |
| `agent-bundle hooks list` / `hooks simulate` | List generated hooks, or run one emitted wrapper. |
| `agent-bundle eval` | Run deterministic or native Claude/Codex eval suites and record a run. |
| `agent-bundle dev` | Serve the packaged developer workbench on loopback; rebuilds the `dist/` package build when its inputs change. |

`validate --artifact`, `mcp`, and `hooks` work against a built artifact with project sources deleted.

## Developer workbench

`agent-bundle dev` serves a loopback-only prebuilt workbench. It shows project
overview and diagnostics, Skill documents, artifact tree and provenance with epoch comparison, an
artifact-bound MCP playground with the raw protocol trace, a hook playground that runs the emitted
wrapper, a durable ordered Playground trace with replay and export, and eval runs and comparisons.

The same session is available programmatically through the public `startDevServer` export, which
accepts the options the CLI flags map to (`root`, `port`, `open`, `agentApi`) and resolves to a
`DevServerSession` exposing the loopback `url`, a `status()` snapshot, and `close()`:

```ts
import { startDevServer } from 'agent-bundle';

const session = await startDevServer({ root: process.cwd(), port: 3100 });
console.log(session.url);
await session.close();
```

`script.run` is a production-mounted, trusted-local Playground operation. It runs only the selected
manifest-owned emitted script for the selected target, in a managed workspace, and preserves bounded
stdout/stderr, exit, cancellation, and raw event references. Native prompts choose a server catalog
selection — case, fixture, host, and pinned model — for the selected epoch rather than accepting a
browser-supplied command or model.

Only actions started in Playground join its ordered durable trace. Hook and MCP page operations remain
independent even when a Playground session is open. Use Playground to replay/export raw evidence or
promote selected durable outcome/assertion evidence into a draft eval case. The Logs page groups
concise events and raw stdout/stderr/protocol streams by producer: normalization, build, diagnostics,
MCP, hook, host trial, and grader.

MCP sessions bind `{ epochId, target, serverName }` when opened and never move to a new epoch
automatically. Use **Restart MCP session** to respawn that generated server on its selected epoch;
open a new session to use a newly published epoch. Compatible MCP Apps preview through the same bound
session. A host may need an explicit MCP reload when a server's catalog changes —
`notifications/tools/list_changed` is not UI HMR.

### Optional Agent API

The Agent API is a separate, authenticated Streamable HTTP MCP endpoint for a Codex client. It is
off by default and is mounted only at `/mcp` on the existing loopback foreground server:

```sh
AGENT_BUNDLE_AGENT_API_TOKEN='replace-with-a-secret' agent-bundle dev --agent-api --no-open --port 3100
```

`dev: { agentApi: true }` enables it from configuration; `--no-agent-api` overrides that setting.
Startup fails before serving if the endpoint is enabled without `AGENT_BUNDLE_AGENT_API_TOKEN`.
The fixed token is read once, never logged/persisted/returned, and is required as standard
`Authorization: Bearer` authentication. Clients may omit `Origin`; a supplied origin must exactly
match the foreground URL. The endpoint is absent when disabled.

It has exactly thirteen fixed, ordered tools: `project_status`, `skills_list`, `skill_inspect`,
`artifacts_list`, `artifact_inspect`, `mcp_servers_list`, `mcp_invoke`, `hooks_list`,
`hook_simulate`, `evals_list`, `eval_run`, `eval_get`, and `diagnostics_list`. `eval_run` is limited
to deterministic harnesses; it cannot select native hosts. Tool schemas reject
undeclared root/path/command/cwd/environment/harness/evidence/outcome fields. Artifact-backed calls
may name an epoch id; otherwise they atomically lease the active epoch, so a hot rebuild sends later
calls to the new epoch while an admitted call remains pinned to its original epoch. The stateless
transport lets an initialized client issue later requests at the same fixed URL when the foreground
server returns.

Contributor UI HMR is separate from a published workbench: start it only with a running foreground
server, for example

```sh
AGENT_BUNDLE_WORKBENCH_API_PROXY=http://127.0.0.1:3100 pnpm --filter agent-bundle-workbench dev
```

`packages/workbench/scripts/dev.mjs` requires that proxy URL. Published `agent-bundle dev` serves
prebuilt assets and project events; it does not run an Rsbuild development server.

## Evaluation

Eval suites are typed modules discovered by convention:

```ts
import { defineEvalSuite, expectExitCode } from 'agent-bundle/eval';
```

Every assertion resolves to `pass`, `fail`, or `inconclusive`, and declares the minimum evidence it
accepts. An assertion that needs stronger evidence than the harness produced is inconclusive, never
silently passed. Fewer than three trials is reported as smoke evidence rather than a reliability
number, and comparison rows are only aligned when case, fixture, semantic grader identity, harness,
host CLI version, invocation, and model all match.

An optional semantic grader is configured with one pinned Claude model:

```ts
evals: {
  semanticGrader: { harness: 'claude', model: 'claude-sonnet-4-5' },
}
```

It runs only with `agent-bundle eval --harness claude` for Claude-pinned cases. After the primary
trace is usable and deterministic graders finish, Agent Bundle makes one server-owned, plugin-free
Claude grading call. Its fixed result id is `claude-semantic`; its request, raw stream, stderr, and
canonical provenance are retained with the trial artifacts. A malformed or failed semantic grader
leaves the trial inconclusive rather than becoming plugin evidence.

The Eval page admits a selected run, reports live progress, and can cancel it through the run
lifecycle. Each trial exposes its persisted raw evidence when present, plus recorded CLI,
invocation, grader, and usage provenance. Comparison cells show recorded provenance and usage and
only include aligned case, fixture, harness, invocation, host/model, CLI, and grader facets;
unmatched facets are labeled non-comparable or unverified. Trial duration is persisted; provider
token usage is shown only when the native stream reported it.

## Authentication

This package never accepts, requests, injects, or persists a model-provider API key. Native Claude and
Codex harnesses use an already installed signed-in CLI after provider-key environment variables are
removed. Native smoke tests are opt-in; Codex Skill-activation evidence is inferred, not observed.
Browser-supplied native models and credentials are refused, and raw HTML, JSX/MDX, and Mermaid in
Skill Markdown are inert in the workbench renderer.

Top-level `scripts` is a record of stable output names to an entry path or `{ entry, targets? }`. JavaScript/TypeScript entries bundle to `scripts/<name>.mjs`; `.sh`, `.bash`, and `.py` entries copy byte-for-byte while preserving source modes. The generated `agent-bundle.manifest.json` records file digests for stable artifact validation.

`AgentBundleConfig` merges bundled portable, Codex, and Claude declarations
through `AgentBundleConfigExtensions`. `TargetRegistry` owns the unique
extension descriptor and adapter for each target. Ordinary projects need no
extension key; extension values are strict finite JSON and host-specific values
stay in their adapter. Add a host by registering an adapter and exporting/merging
its interface instead of adding raw compiler or Runtime parsing. ChatGPT/OpenAI
and Claude Workbench simulation profiles are not configuration-extension claims.

The package publishes no example RSC provider, host credentials, or native-host
evaluation integration. See the repository's
[optional RSC Runtime topology](../../docs/architecture/rsc-runtime-workbench.md)
for the explicit example-owned boundary.

For a manual authenticated local smoke, complete each CLI's normal interactive sign-in first, then
verify a supported non-prerelease CLI and run the native harness you intend to exercise from an
Agent Bundle project with eval suites. Claude Code must be at least `2.1.232`; Codex must be at
least `0.147.0`:

```sh
claude --version
agent-bundle eval --harness claude --trials 1

codex --version
agent-bundle eval --harness codex --trials 1
```

Each Codex trial sets a temporary `CODEX_HOME` and copies only the installed CLI's opaque
`auth.json` into it. Your normal Codex home, configuration, and installed-plugin state are not used
as trial state and are left unchanged.

Native authenticated smokes are excluded from default and ordinary local test runs. After normal
interactive sign-in, the manually dispatched trusted self-hosted CI workflow runs the corresponding
installed-tarball smoke with its existing subscription session and no workflow secrets:

```sh
pnpm test:packed:native:claude
pnpm test:packed:native:codex
```

Each command builds and installs one production-only tarball, removes provider API-key and
credential-shaped environment values, and fails if the selected host's normal home state changes.
Do not add provider API keys to the project configuration or use them as a fallback for either
harness.

## Limitations

- Development snapshots and exports written by pre-0.1 builds before the unversioned durable-record
  cutover are not migrated. Rebuild artifacts and discard those preview Eval and Playground records
  before upgrading; current readers reject the superseded shapes instead of guessing at compatibility.
- The workbench binds to loopback only and is a foreground development session, not a hosted service.
- Native Claude and Codex harnesses require those CLIs to be installed and signed in. A missing,
  incompatible, or unauthenticated CLI is reported as a harness failure, distinct from a plugin
  failure. Their live smoke tests are opt-in and are not part of an ordinary test run.
- Codex exposes no authoritative Skill-activation event, so Codex activation evidence is `inferred`
  and is never reported as `observed`.
- Comparison facets that a run did not record — semantic grader identity, host CLI version, invocation — are
  labeled unverified rather than assumed aligned.
- Semantic grading requires a native Claude harness and a signed-in Claude Code session; deterministic
  and Codex selections are refused when it is configured.
- Raw HTML, JSX/MDX, and Mermaid in Skill Markdown are inert in the workbench renderer.

Third-party notices, including the vendored MCP Inspector snapshot's license and provenance, ship in
the published package.

## Contributor delivery and release gates

The public examples live at [`../../examples`](../../examples). They are private
pnpm workspaces and use only public package exports. Start with Skills Starter,
then Hooks and Scripts, then the interactive MCP App.

Run the complete local delivery gate with `pnpm check && pnpm check:release`.
`pnpm check:release` is release-only: its exact package-script components are
`pnpm pack:dry-run`, `pnpm audit:release`, and `pnpm test:packed`, and it does not replace
`pnpm check`.
Native Claude/Codex smokes stay intentionally opt-in and skipped in ordinary CI.
npm publishing is deferred until the release owner picks the final package name/scope and
license; pkg.pr.new previews are the interim channel, and the first npm release will use npm
package provenance (`publishConfig.provenance` is already set).
