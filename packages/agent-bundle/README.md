# agent-bundle

Compile a typed Agent Bundle configuration into portable, Codex, and Claude Code artifacts. Node.js 22.19 or later is required.

```sh
npm install --save-dev agent-bundle
agent-bundle build --output artifact
```

Top-level `scripts` is a record of stable output names to an entry path or `{ entry, targets? }`. JavaScript/TypeScript entries bundle to `scripts/<name>.mjs`; `.sh`, `.bash`, and `.py` entries copy byte-for-byte while preserving source modes. The generated `agent-bundle.manifest.json` records file digests for stable artifact validation.

Generated executables target Node.js 22.12 or newer by default. `runtime: { node: '24.0' }` raises
that floor (it can never be lowered), and the selected floor is recorded as `runtime.node` in the
artifact manifest.

Files under a root `assets/` directory copy byte-for-byte into every target artifact's `assets/`
directory. Top-level `assets` replaces that convention with explicit entries: literal file paths,
whole directories, or globs, all resolved from the project root. Entries outside `assets/` keep
their project-relative path under the artifact's `assets/` directory.

Hook `tools` accept the canonical selectors (`shell`, `file.read`, `file.write`, `mcp`, `agent`)
plus explicit host-native selectors such as `claude:WebSearch` or `codex:view_image`, which
contribute only to that host's native matcher. A hook that selects tools must leave every selected
target with at least one applicable selector, otherwise the build fails.

## Commands

| Command | Purpose |
| --- | --- |
| `agent-bundle build` | Build a validated artifact from source. |
| `agent-bundle validate` | Validate project source, or an artifact with `--artifact`. |
| `agent-bundle inspect` | Inspect normalized targets and adapter plans from source. |
| `agent-bundle mcp list` / `mcp invoke` | List or invoke one MCP tool from an artifact. |
| `agent-bundle hooks list` / `hooks simulate` | List generated hooks, or run one emitted wrapper. |
| `agent-bundle eval` | Run deterministic or native Claude/Codex eval suites and record a run. |
| `agent-bundle dev` | Serve the packaged developer workbench on loopback. |

`inspect` reads source configuration. `validate --artifact`, `mcp`, and `hooks` are source-free: they
work against a built artifact with the project sources deleted.

## Developer workbench

`agent-bundle dev` serves a prebuilt, desktop-focused workbench on loopback only. It shows project
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
transport works at the same fixed URL after a foreground restart without reconnecting the official
MCP client.

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
only include aligned case, fixture, invocation, host/model, CLI, and grader facets; unmatched facets
are labeled non-comparable or unverified. Duration and provider usage are shown only when the native
stream reported them and remain part of the stored run provenance.

## Authentication

This package never accepts, requests, injects, or persists a model-provider API key, and there is no
configuration field for one. The native Claude and Codex harnesses run the CLI already installed on
your machine and rely on its existing signed-in subscription/session; provider API-key environment
variables are removed from the child environment before that CLI is launched.

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
`pnpm test:spot-check` is the fast end-to-end confidence gate: it builds, validates, and runs
one deterministic eval against the checked-in micro fixture through the real CLI, with no native
host and no opt-in environment gate. Native Claude/Codex smokes stay intentionally opt-in and
skipped in ordinary CI.
Publication is deliberately not scripted here: the release owner must decide the npm package
name/scope, license, and `publishConfig` before publishing.
