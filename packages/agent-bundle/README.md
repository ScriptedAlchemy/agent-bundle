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
merged last into every synthesized config and bounded by the artifact invariant assertions.

Projects that own their compilation entirely declare prebuilt payloads instead: the top-level
`payload` block names already-built directory trees the build packages byte-for-byte at stable
paths, and `entry: { prebuilt: './dist/…' }` (MCP servers) or
`handler: { prebuilt: './dist/…' }` plus shell-safe `args` (hooks) point the generated host
manifests at files inside those payloads without compiling them. Payload files carry the
`prebuilt` manifest file kind and hash into the project revision. See the repository's
`docs/entry-conventions.md` for the full contract.

## Commands

| Command | Purpose |
| --- | --- |
| `agent-bundle build` | Build a validated artifact from source, plus the declared `dist/` package build. |
| `agent-bundle prepack` | Run the release build, dry-run npm packing without scripts, and verify packaged outputs, artifact hashes, bins, and versions (`--output` and `--json` supported). |
| `agent-bundle install <host>` | Install a built bundle into Claude, Codex, or Cursor (`--from`, `--scope`, and `--json` supported). |
| `agent-bundle validate` | Validate project source, or an artifact with `--artifact`. |
| `agent-bundle inspect` | Inspect normalized targets and adapter plans from source. |
| `agent-bundle inspect --bundler` | Dump the synthesized Rslib/Rsbuild configs (post-`tools`-hatch merge) for every generated output. |
| `agent-bundle mcp list` / `mcp invoke` | List or invoke one MCP tool from an artifact. |
| `agent-bundle mcp run` | Run one built stdio MCP server in the foreground, resolving its hashed entry, loading the project-root `.env` set (`--env-file`/`--no-env` to override), and expanding env state anchors to the project root (`--plugin-root` to override). Environment precedence: manifest env < `.env` files < operator `process.env`. |
| `agent-bundle hooks list` / `hooks simulate` | List generated hooks, or run one emitted wrapper. |
| `agent-bundle eval` | Run deterministic or native Claude/Codex eval suites and record a run. |
| `agent-bundle dev` | Serve the packaged developer workbench on loopback; rebuilds the `dist/` package build when its inputs change. |

`validate --artifact`, `mcp`, and `hooks` work against a built artifact with project sources deleted.

### Validate Claude bundles with Claude Code

Artifact validation runs `claude plugin validate <bundle-dir> --strict` for emitted `claude`
and unified `plugin` targets when Claude Code is on `PATH`. Host errors become Agent Bundle
errors; host warnings remain warnings unless `agent-bundle validate --strict` is set. A missing
binary is reported as an explicit informational skip, never as fabricated success. Use
`--no-host-validation` when a deterministic schema-only check is required.

CI should use strict validation:

```sh
agent-bundle validate --artifact dist --strict
```

During development, load a built target without installing it and verify registration:

```sh
claude --plugin-dir dist/claude plugin list --json
```

## Distribute and install bundles

Every built target directory contains a generated `INSTALL.md` with commands
that use the bundle's real plugin and marketplace names. Claude and Codex
targets always include local marketplace manifests, so their public CLIs can
install the emitted directory directly:

```sh
agent-bundle install claude --from artifact/claude --scope user
agent-bundle install codex --from artifact/codex
```

The installer delegates to `claude plugin marketplace add` /
`claude plugin install` and `codex plugin marketplace add` /
`codex plugin add`; it fails with a typed diagnostic when the selected host
binary is unavailable. Cursor has no non-interactive install verb, so Cursor,
portable, and composite targets include `install.mjs`, which safely copies the
bundle into `~/.cursor/plugins/local/<name>` without overwriting collisions:

```sh
agent-bundle install cursor --from artifact/cursor
# or, from the emitted target directory:
node ./install.mjs
```

Cursor installation is user-scoped. Claude also accepts `--scope project` and
`--scope local`; Codex is user-scoped. A source-free artifact root is accepted
by `--from` when it contains the selected host target directory.

When package outputs ship one of those host packs, the build also emits a
package-relative installer bin. It uses the plugin name when no configured bin
claims it and `<plugin-name>-install` otherwise. Map that name to the generated
`dist/bin/*.js` file in `package.json`; consumers run
`<bin> install <host> [--scope <scope>] [--json]`. The executable locates the
artifact directory beside the installed package, so it works from
`node_modules` regardless of the current directory. No npm lifecycle performs
an installation.

## Developer workbench

`agent-bundle dev` serves a loopback-only prebuilt workbench. It shows project
overview and diagnostics, Skill documents, artifact tree and provenance with epoch comparison, an
artifact-bound MCP playground with the raw protocol trace, a hook playground that runs the emitted
wrapper, a durable ordered Playground trace with replay and export, and eval runs and comparisons.

The same session is available programmatically through the public `startDevServer` export, which
accepts the options the CLI flags map to (`root`, `port`, `open`, `agentApi`, `installHosts`) and resolves to a
`DevServerSession` exposing the loopback `url`, a `status()` snapshot, and `close()`:

```ts
import { startDevServer } from 'agent-bundle';

const session = await startDevServer({ root: process.cwd(), port: 3100 });
console.log(session.url);
await session.close();
```

Pass `--install-host <claude|codex|cursor>` more than once to install development variants into
the selected hosts:

```sh
agent-bundle dev --install-host cursor --install-host claude
```

The first successful epoch uses the ordinary host installer. Claude and Codex therefore register
the plugin normally and read its files from their host-owned
`plugins/cache/<marketplace>/<plugin>/<version>` directory; Cursor reads
`~/.cursor/plugins/local/<plugin>`. The installed root contains
`.agent-bundle-dev.json` with schema version `1`, the project root, host, and installed epoch.
Its MCP document always launches
the framework CLI through the running dev server's Node executable as
`agent-bundle dev proxy --root <projectRoot> --server <serverName> --target <host>`;
rebuilds never replace that stable command with an epoch path, and host process `PATH` contents do
not affect whether the project-local framework can be spawned.

Each later `artifact.available` event copies the new target into an immutable installed generation.
Top-level directories switch by atomic symlink (or Windows junction) rename and top-level files by
atomic sibling-file rename, so a host sees an old or new complete entry and no synchronized
directory disappears between generations. A failed publication rolls pointers back to the prior
generation and emits an `AB7202` diagnostic on `dev.host.sync`; a failed build emits no
`artifact.available`, so the last-good install is unchanged. Re-sync writes the host cache directly
and does not invoke the Claude or Codex CLI again.

Stopping the dev server leaves the marked development install in place. Hooks and Skills remain on
disk, while the stable proxy command fails closed until that project dev server is running again.

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

Workbench MCP sessions bind `{ epochId, target, serverName }` when opened and never move to a new
epoch automatically. Use **Restart MCP session** to respawn that generated server on its selected
epoch; open a new session to use a newly published epoch. Compatible MCP Apps preview through the
same bound session.

### Live host MCP proxy

During development, a host can keep one stdio MCP process connected while `agent-bundle dev`
rebuilds the generated server behind it. Configure the host's MCP server command as:

```json
{
  "command": "agent-bundle",
  "args": [
    "dev",
    "proxy",
    "--root",
    "/absolute/path/to/plugin",
    "--server",
    "tools"
  ]
}
```

The proxy discovers the loopback server through the project's development lock and connects to the
stable Streamable HTTP endpoint at `/mcp/host/<serverName>`. `--target` defaults to `portable`;
`--url http://127.0.0.1:<port>` overrides discovery. The endpoint is intentionally unauthenticated
because the development server binds only to loopback and is not exposed beyond the local machine. Successful
rebuilds keep the stdio connection open, route new calls to the active epoch, allow admitted calls
to finish against their original epoch, and forward MCP catalog change notifications. If the epoch
or development server disappears, the proxy fails closed with an MCP error and an `AB8024` or
`AB8025` diagnostic. A generated server that crashes is not silently respawned within the same
epoch; calls remain failed until a successful rebuild swaps in a newly primed epoch session.

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

## Testing routes

Route modules are tested through the framework, not through a hand-written
bundler configuration. Two subpaths ship that harness, and both are opt-in:
`@rstest/core` and `react` are optional peer dependencies, so a project that
never tests routes installs neither. Rendering also needs
`@agent-bundle/runtime`, which the project already owns whenever it has route
modules — the generated entries import it the same way.

`agent-bundle/rstest` is the configuration helper. It compiles the project once
— the same route-graph compilation the build performs, with no artifact build —
and returns a plain Rstest configuration object carrying the test manifest,
the route loaders, React's `react-server` resolution, and the automatic JSX
runtime:

```ts
// rstest.route-unit.config.ts
import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

export default defineConfig(await agentBundleRstest());
```

Route-unit tests default to `tests/route-unit/**/*.test.{ts,tsx}` and need
their own Rstest run, because rendering a route requires Node's `react-server`
condition for the whole worker process. Keep them out of the project's ordinary
`rstest` run.

`agent-bundle/test` holds the helpers. `renderRoute` executes a route — by
compiled route id, or by importing the module directly — through the real
renderer and the real request store, and resolves to the final Agent Document:

```ts
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

const { document } = await renderRoute('tool:library/summarize', {
  context: {
    invocation: { id: 'run-1' },
    workspace: { source: 'native', state: 'available', value: { root: '/tmp/library' } },
  },
  input: { title: 'Dune' },
});

expectDocument(document).toHaveStatus('success').toContainMarkdown('Dune').toHaveValue({ chapters: 24 });
```

`renderRoute` accepts `input`, `args` (CLI routes), request-`context`
overrides — including a `context.progress` reporter — render `limits`, and a
`signal`; it returns the document, the request-scoped progress the route
reported, the resolved provenance, and the route's own `resultSchema`-parsed
value. Progress is recorded whether or not the caller supplies a reporter of
its own. `testManifest()` exposes the
compiled route inventory, so a suite can iterate every route in process rather
than paying for a build per route. Every failure — an unknown route, a refused
route kind, a rejected input, a render error — names the route id, the target
kind, and the module provenance.

Matchers over the Agent Document contracts: `toHaveStatus`, `toContainMarkdown`,
`toContainText`, `toHaveValue`, `toHaveError`, and `toHaveNodeKinds`.

This is the route-unit proof level, and only that: it proves a route module
renders to the document it claims. It is not evidence about the MCP transport,
a packed artifact, or a browser surface.

### Proof levels

The levels are separate on purpose. Each helper stamps the level it carried
into its provenance and prints it in every failure, because a pass at one level
is never a receipt for another.

| level | helpers | what it proves |
| --- | --- | --- |
| `route-unit` | `renderRoute`, `renderRouteEvents` | a route module renders to the document (and render-event stream) it claims |
| `mcp-in-memory` | `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`, `getMcpPrompt`, `listMcpSurface`, `runContractMatrix` | the real generated MCP server's protocol contract, over the SDK's in-memory transport |
| `cli-dispatch` | `invokeCli`, `cliJson`, `cliNdjson` | a plain or rendered argv vector resolved and run through the routed CLI's own shell, including rendered Markdown, explicit TTY, JSON, and NDJSON modes, in-process |
| `packed-stdio` | `openPackedMcpServer`, `runPackedContractMatrix` | a built artifact's generated entry running as a real process over stdio |
| `packed-deleted-source` | `removeProjectSource`, `openPackedMcpServer({ deletedSource })`, `runPackedContractMatrix` | the packed stdio process still runs after project source and configuration are removed and verified absent |
| `host-install` | `openInstalledHostMcpServer`, `runInstalledHostContractMatrix` | a built bundle staged into an isolated host root, discovered in the emitted host format, and spawned from the installed layout |

```ts
import { cliJson, cliNdjson, expectEvents, invokeCli, invokeMcpTool } from 'agent-bundle/test';

// mcp-in-memory: the generated server projects the document to protocol content.
const call = await invokeMcpTool('summarize', { input: { title: 'Dune' } });
expect(call.structuredContent).toEqual({ chapters: 24 });

// cli-dispatch, plain .ts route: resolve argv, execute, and map the exit code.
const run = await invokeCli(['library', 'audit', './books', '--max-files', '8']);
expect(run.exitCode).toBe(0);
expect(cliJson(run)).toMatchObject({ scanned: 8 });

// cli-dispatch, rendered .tsx route: exercise the shell's rendered output modes.
const rendered = await invokeCli(['library', 'report', './books', '--ndjson']);
const events = cliNdjson(rendered);
expect(events.at(-1)?.type).toBe('complete');

const tty = await invokeCli(['library', 'report', './books'], { tty: true });
expect(tty.stdout).toContain('\r\u001B[2K');
```

`expectEvents` asserts over a render-event stream. `toContainSequence` is
sequence-tolerant — an extra `progress` or `replace` frame is legal and cannot
turn a passing render red — while a missing frame, a reordering, or a regressed
ordinal still fails; `toHaveMonotonicSequence`, `toCompleteOnce`,
`toHaveProgress`, and `toHaveNoErrors` cover the rest of the contract.

Only `packed-stdio` and its strictly stronger `packed-deleted-source` upgrade
are process evidence, and they are deliberately expensive: pack once, install
once, build once, remove and verify source once, spawn once, and iterate every
per-route assertion inside that one session. The deleted-source journey also
reads the embedded MCP App resource from the generated server; it does not
prove native-host install or dispatch, or an install mode that copies the
artifact elsewhere. `host-install` is separate installed-layout process
evidence: its deterministic adapter-simulator lane is unconditional, available
Claude and Codex binaries also prove their public install paths, and Cursor
records its unavailable non-interactive host-session surface explicitly.

### Contract matrix (`runContractMatrix` / `runPackedContractMatrix` / `runInstalledHostContractMatrix`)

The contract matrix is the framework-owned generated-plugin wire-contract suite.
Three entry points share one implementation; boundary differences are explicit
capability flags, not forked check logic. The project supplies only fixtures —
valid inputs, a declared `resultCompat` policy for every in-memory tool route,
optional `previousResults` payloads, optional `cancellation` cases, and an
optional deterministic lifecycle transition driver with declarative
expectations.

**`runContractMatrix` (`mcp-in-memory`)** opens one real MCP client against
the real generated server over the SDK's in-memory transport and runs the full
matrix. It proves: wire surface completeness against the compiler manifest,
fixture coverage, successful-path invocation sweeps, JSON serialized round-trip
through each tool route's own `resultSchema`, declared additive/closed compat
behavior on serialized payloads, acceptance of previous-server payloads under
the current schema, rejection of negative inputs derived from the advertised
`listTools` input JSON Schema, and mid-flight cancellation hygiene. In-memory
transport may pass structured values without serialization; the matrix closes
that gap with an explicit `JSON.parse(JSON.stringify(...))` round-trip before
validation. MCP Apps are reported as not-applicable for surface registration
because the in-memory level does not register them.

**`runPackedContractMatrix` (`packed-stdio` / `packed-deleted-source`)** runs
against an already-open packed session (the single packed journey owns session
open/close). It proves process stdio evidence for surface completeness
(including compiled MCP App resource URIs in `listResources`), fixture coverage,
successful-path sweeps, advertised input-schema rejection, and client-side
cancellation hygiene. It cannot load project route modules — source may be
deleted and verified absent — so serialized-round-trip, compat-probe, and
version-skew (including their per-lifecycle-phase variants) are reported
`not-applicable` with an honest reason. The packed
server validates every tool result through its bundled `resultSchema` before
returning; a successful sweep invocation is that evidence.

Lifecycle fixtures replay
`unknown → queued → running → first-progress → repeated-progress → terminal`
over the matrix's one open client. The framework validates every phase's
structured content and rendered output, additive/closed compatibility, live
progress before settlement, journal accumulation, declared notices,
idempotent commit replay, and typed budget rejection. A caller-supplied
same-store `restart` callback adds durability evidence at that boundary;
without one the check is honestly `not-applicable`. Packed callers should wire
that callback into the existing packed journey's restart rather than creating
a second pack/build/install path.

**`runInstalledHostContractMatrix` (`host-install`)** runs against an
already-open session from `openInstalledHostMcpServer`. The opener reads the
host's emitted MCP document from the installed root, verifies the manifest,
component/resource/hook paths and artifact file digests, spawns that installed
command, and observes the running version from the live MCP `initialize`
result. Its report records source, built-artifact, installed-artifact, and
running-process versions separately and fails closed when any value is missing
or differs. Metadata records the host binary version when observed, adapter
revision, manifest/schema digest, and framework version. Module-backed checks
remain honestly not-applicable because loading project modules would cross back
into the source/build tree.

No matrix boundary proves browser App HTML, artifact-rebuild replay,
state-lifetime catalog identity, or running-process identity beyond what the
live MCP session reports; deeper runtime-instance introspection depends on
#269.

When the advertised input schema declares `additionalProperties: false`, plain
`z.object` tool routes may still strip unknown keys without a protocol failure.
The negative-inputs check records that tolerance when other generated negatives
still prove rejection paths.

```ts
import {
  openInstalledHostMcpServer,
  runContractMatrix,
  runInstalledHostContractMatrix,
  runPackedContractMatrix,
} from 'agent-bundle/test';

await runContractMatrix({
  fixtures: {
    'tool:library/summarize': {
      input: { title: 'Dune' },
      resultCompat: 'additive',
      previousResults: [{ chapters: 24 }],
    },
  },
});

// Packed: pass an already-open session and a manifest compiled before source removal.
await runPackedContractMatrix({
  session: packedSession,
  manifest: compiledManifest,
  fixtures: { /* same shape */ },
});

await using installedSession = await openInstalledHostMcpServer({
  artifactRoot,
  host: 'claude',
  installedRoot,
  manifest: compiledManifest,
  server: 'library',
});
await runInstalledHostContractMatrix({
  fixtures: { /* same shape */ },
  manifest: compiledManifest,
  session: installedSession,
});
```

A failing matrix throws one aggregated `AgentTestError` with code
`contract-violation`, naming every failing route, check, and the proof-level
label the run actually carried.

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

### What gets hashed

Hash pins cover vendored external content whose ground truth lives outside this repository and can
drift: host document schemas under `src/adapters/schemas/*` (with upstream URL, commit, and SHA-256
recorded in `PROVENANCE.json`), the Agent Skills specification-derived schema pin in the manifest
`agentSkills` block, and emitted artifact files and source inputs for integrity.

Repository-owned capability tables and evidence are not hashed. Capability evidence records the
observed host version (`observedVersion`) and target, while adapters carry a monotonic
`adapterRevision`. Git already versions repository-owned content; hashing it again inside the
repository is self-referential and causes churn on every table edit.

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
`pnpm pack:dry-run`, `pnpm audit:release`, and `pnpm test:packed:release`, and it does not replace
`pnpm check`. `pnpm release` runs that release gate before `changeset publish`.
Native Claude/Codex smokes stay intentionally opt-in and skipped in ordinary CI.
npm publishing is deferred until the release owner picks the final package name/scope and
license; pkg.pr.new previews are the interim channel, and the first npm release will use npm
package provenance (`publishConfig.provenance` is already set).
