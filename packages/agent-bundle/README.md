# agent-bundle

Compile a typed Agent Bundle configuration into portable, Codex, Claude Code, and Cursor artifacts. Node.js 22.19 or later is required.

Full documentation: [scriptedalchemy.github.io/agent-bundle](https://scriptedalchemy.github.io/agent-bundle/).

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

The artifact root defaults to `artifact` for the `agent-bundle build` and `agent-bundle prepack` commands (they also emit the npm package build into `dist/`) and to `dist` for the programmatic `build()` API; set `output: { distPath: '<path>' }` in `agent-bundle.config.ts` to relocate it (Rsbuild/Rslib naming, string shorthand only) — `--output` still wins per invocation. See [Framework mode](../../docs/framework-mode.md#output).

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
launches stdio servers from the host's own working directory and ignores stdio `cwd` at runtime,
and its placeholder-substitution table excludes `cwd`, so the Claude adapter emits no `cwd` for a
plugin-root working directory (the absolute `${CLAUDE_PLUGIN_ROOT}/mcp/...` entry path plus this
env anchor carry the guarantee). That canonical plugin-root `cwd` is the one accepted token-bearing
value on Claude; any other `cwd` that carries a path token is rejected. A server's own
`env` entries win over the injected value, so declaring
`env: { AGENT_BUNDLE_PLUGIN_ROOT: ... }` replaces the anchor. The `pluginRootEnvAnchor` export
names the variable for consumer code.

Hook `tools` accept the canonical selectors (`shell`, `file.read`, `file.write`, `mcp`, `agent`)
plus explicit host-native selectors such as `claude:WebSearch` or `codex:view_image`, which
contribute only to that host's native matcher. A hook that selects tools must leave every selected
target with at least one applicable selector, otherwise the build fails.

Codex hooks follow the release contract pinned in `codex-0.147.0.json` (`hooks.contract`). The
emitted and authored (`codex.nativeHooks`) `hooks/hooks.json` is closed to the eleven
release-documented events; `Interrupt` stays deferred until the pin moves to a release that ships
its generated schema. Native documents may use every documented `command` handler field
(`commandWindows`, `timeout`, `statusMessage`, `additionalContextLimit`, `async`) and `mcp_tool`
handlers (`server`, `tool`, `input`, `timeout`, `statusMessage`); `prompt` and `agent` handlers,
which Codex parses but skips, fail with `codex.native-hooks.handler.skipped`. Rules the host would
otherwise apply silently fail the build instead: `mcp_tool`, `async`, or a timeout above three
seconds on `SessionEnd`, `additionalContextLimit` on an event that returns no `additionalContext`,
a `matcher` on `UserPromptSubmit` or `Stop`, and a `codex:WebSearch`-style hosted-tool selector.
Hook trust (review by current hash in `/hooks`, plugin hooks skipped until trusted, managed hooks
immutable) is host-owned and is recorded as unavailable rather than claimed.

The Codex artifact is also its own repo marketplace: `.agents/plugins/marketplace.json` carries one
local `./` entry whose `category` follows the plugin's interface category and whose
`policy.installation` / `policy.authentication` default to `AVAILABLE` / `ON_INSTALL`.
`codex.marketplace` authors the picker `displayName`, the `category`, and the documented policy
values, except `installation: NOT_AVAILABLE`, which fails the build
(`codex.marketplace.policy.installation.not-installable`) because live `codex plugin add` refuses
such entries and that is exactly the command the emitted `INSTALL.md` and `installBundle()` run.
The pinned marketplace schema also admits Git root (`url`), `git-subdir`, and `npm` sources for
validating real-world marketplaces (Git and registry URLs must carry a syntactically valid
host (DNS, IPv4, or bracketed IPv6), port, and path rather than a bare scheme prefix, and
npm `version` must be a semver version, range, or dist-tag, and Git `ref` must satisfy
`git check-ref-format`), but the adapter never emits them. Personal and legacy
`.claude-plugin/marketplace.json` discovery, the `~/.codex/plugins/cache` layout, `config.toml`
enable state, `features.plugins` / `features.hooks`, inline `[hooks]` TOML, `requirements.toml`
managed hooks, `allow_managed_hooks_only`, and `restrict_to_allowed_sources` are host- or
admin-owned and are recorded in `codex-0.147.0.json` (`distribution`) with dated evidence instead of
being claimed. The overview-level plugin parts get the same treatment (`plugin.overviewSurfaces`):
optional MCP UI is `degraded` (the compiled MCP server serves `ui://` resources per the open MCP
Apps standard that ChatGPT renders, while Codex CLI renders no components and every tool stays
usable without UI), and browser extensions and scheduled task templates are `unavailable`
because no package or manifest contract publishes an authoring field for them, so nothing is
inferred.

agent-bundle also owns the npm-facing package build: `bin` entries become self-executing
`dist/bin/<name>.js` bundles (shebang, executable bit, generated `main(argv)` envelope) and the
optional `lib` entry becomes `dist/<stem>.js` with declarations (resolving `typescript` from the
project). The `src/cli.ts`, `src/index.ts`, and `src/mcp/<server-id>.ts` conventions fill these in
when the config is silent; config always wins and `bin: false` / `lib: false` opt out. An explicit
`scripts`, `hooks`, `lib`, or `mcp` entry claims the module it references out of conventional route
discovery, but a `bin` entry does not claim a `src/scripts/<name>.ts` module: the same file
ships as both `dist/bin/<name>.js` and the artifact `scripts/<name>.mjs` (the module must export
`main` or be self-executing: a `default`-only plain script is `AB4738`, and a rendered `.tsx` script
must export both its default component and `main` or it is `AB4737`; prefix a path segment with `_`
for a bin-only module). MCP server
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
| `agent-bundle install <host>` | Install a built bundle into Claude, Codex, or Cursor (`--from`, `--scope`, `--replace`/`--force`, `--mode local\|marketplace` for Cursor, and `--json` supported). Same-version content drift of an agent-bundle-managed install is replaced automatically; identical reruns are a no-op. |
| `agent-bundle doctor` | Read-only host inspection: host probes, installed inventory, and, with `--from`, the installed copy compared against the built artifact by version and content hash (`current`, `stale`, `version-mismatch`, `foreign`, `not-installed`). |
| `agent-bundle validate` | Validate project source, or an artifact with `--artifact`. |
| `agent-bundle inspect` | Inspect normalized targets and adapter plans from source, with per-target component accounting: which skills, commands, rules, hooks, MCP surfaces, and scripts each host emits and, for every omission, whether the author excluded it or the host's pinned capability judgment (`degraded`/`unavailable`/`prohibited`, with reason) ruled it out. |
| `agent-bundle inspect --bundler` | Dump the synthesized Rslib/Rsbuild configs (post-`tools`-hatch merge) for every generated output. |
| `agent-bundle mcp list` / `mcp invoke` | List or invoke one MCP tool from an artifact. |
| `agent-bundle mcp run` | Run one built stdio MCP server in the foreground, resolving its hashed entry, loading the project-root `.env` set (`--env-file`/`--no-env` to override), and expanding env state anchors to the project root (`--plugin-root` to override). Environment precedence: manifest env < `.env` files < operator `process.env`. |
| `agent-bundle hooks list` / `hooks simulate` | List generated hooks, or run one emitted wrapper. |
| `agent-bundle eval` | Run deterministic or native Claude/Codex eval suites and record a run. |
| `agent-bundle dev` | Serve the packaged developer workbench on loopback; rebuilds the `dist/` package build when its inputs change. |

`validate --artifact`, `mcp`, and `hooks` work against a built artifact with project sources deleted.

### Validate Claude bundles with Claude Code

When Claude Code is on `PATH`, artifact validation runs its validator for emitted `claude` and
unified `plugin` targets. Claude Code treats a directory that holds both `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json` as a marketplace and then never opens the plugin's hook,
skill, agent, or command files, so Agent Bundle names each manifest:

```sh
claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict
claude plugin validate <bundle-dir>/.claude-plugin/marketplace.json --strict
```

On Claude Code 2.1.259 or later both runs use `--json`; older releases are parsed from the text
report. Host errors become Agent Bundle errors (`AB6021`); host warnings remain warnings
(`AB6020`) unless `agent-bundle validate --strict` is set, and every finding names the validated
file. A missing binary is reported as an explicit informational skip (`AB6019`), never as
fabricated success. Use `--no-host-validation` when a deterministic schema-only check is required.

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

Cursor loads the copied `.cursor-plugin/plugin.json` and its manifest-declared
`hooks/hooks.json` from that directory; plugin hooks run from the plugin root
with `${CURSOR_PLUGIN_ROOT}` substituted and need no `~/.cursor/hooks.json`
entry. `--mode marketplace` instead stages a committed local marketplace
repository at `~/.cursor/agent-bundle/marketplaces/<name>` and prints the
Customize -> Plugins -> "Add Plugins from Local Repository" step that makes
Cursor manage the plugin as a marketplace install; `agent-bundle doctor --host
cursor` reports hook registration (`AB7322`), duplicate user-level delivery
(`AB7323`), and marketplace import state (`AB7324`).

Cursor installation is user-scoped. Claude also accepts `--scope project` and
`--scope local`; Codex is user-scoped. A source-free artifact root is accepted
by `--from` when it contains the selected host target directory.

### Reinstall after a same-version rebuild

Rebuilding a plugin without bumping its `version` is the normal local loop, and
every host treats it differently. `agent-bundle install` and the emitted
`install.mjs` share one replace policy:

- **Receipt.** Every Cursor copy an agent-bundle installer places carries
  `.agent-bundle-install.json` beside the plugin manifest: the plugin name,
  version, host, the sha256 content hash of the artifact tree, when it was
  installed, the exact list of files the installer owns, and the directories
  it created (the only ones it will ever prune). The receipt never
  participates in the content hash, so an installed copy hashes like the
  artifact it came from.
- **No-op.** Re-running install on an identical artifact reports
  `already-installed` and changes nothing, even with `--replace`.
- **Automatic same-version replace.** When the installed copy is an
  agent-bundle install of the same plugin at the same version but its content
  hash differs (a stale copy), install replaces it without a flag. Cursor
  replacement is in place and touches owned files only: stale owned files are
  removed, new files are renamed over their predecessors, and unowned entries
  such as workspace-durable `state/` stores survive; if a rebuilt artifact
  introduces a path an existing unowned file already occupies, replacement
  aborts before any change and names it. Claude replacement runs
  `claude plugin uninstall <plugin>@<marketplace> --scope <scope> --keep-data`
  before `marketplace add` + `install`, because Claude's `plugin update` is
  version-gated and a plain reinstall reports "already installed" while the
  cache stays stale. Codex replacement runs `codex plugin remove` before
  `marketplace add` + `add`, so files a rebuild removed do not linger.
- **`--replace` (alias `--force`).** Also replaces an agent-bundle install of
  the same plugin at a *different* version, and adopts a Cursor copy that was
  installed before receipts existed (recognised by its emitted `INSTALL.md` +
  `install.mjs` and matching manifest name). A legacy copy has no owned-file
  inventory, so adoption rewrites the files the new artifact ships and leaves
  every other file in place (operator files, files an earlier rebuild dropped,
  `state/`); those leftovers stay unowned under the new receipt, and later
  same-version rebuilds replace automatically. A byte-identical legacy copy
  under `--replace` reports `adopted` and changes no plugin file.
- **Foreign installs are always refused.** A directory under the plugin name
  that is not an agent-bundle install of this plugin fails with `AB7005` and a
  content-hash comparison (`installed <name>@<version> content <hash> vs
  artifact <name>@<version> content <hash> (same version, different content)`),
  even with `--replace`. Remove it manually.

For Claude and Codex the installed copy is located through the host's own
`plugin list --json` inventory (Claude reports the cache path; Codex confirms
the install and its pinned `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>`
layout supplies the path). When that inventory is unusable, a plain install
proceeds as before and `--replace` fails closed rather than guessing.

`agent-bundle doctor --from <bundle-dir>` reports the same comparison per host
without changing anything: the installed version and content hash versus the
built artifact, summarised as `current`, `stale (same version, different
content)` (`AB7308`), `version mismatch` (`AB7309`), `foreign install`
(`AB7321`), `not installed` (`AB7307`), or `unknown` when the host inventory
could not be read.

When package outputs ship one of those host packs, the build also emits a
package-relative installer bin. It uses the plugin name when no configured bin
claims it and `<plugin-name>-install` otherwise. Map that name to the generated
`dist/bin/*.js` file in `package.json`; consumers run
`<bin> install <host> [--scope <scope>] [--replace|--force] [--json]`. The executable locates the
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

### Development contract matrix

Projects can opt host-facing rebuild adoption into the generated contract matrix by pointing
`dev.contracts.fixtures` at a project-local module:

```ts
// agent-bundle.config.ts
export default {
  dev: {
    contracts: {
      fixtures: './contract-fixtures.ts',
      server: 'tools', // optional when the project has exactly one MCP server
    },
  },
};
```

The module default-exports the same `Record<routeId, ContractRouteFixture>` consumed by
`runContractMatrix`. Agent Bundle reloads and validates it for every prepared epoch. An invalid
module does not fail compilation: it fails that epoch's contract run with an `AB7210` diagnostic
instead. Omitting `dev.contracts` leaves the matrix off and preserves direct `artifact.available`
adoption.

For an enabled project, each published epoch is exercised through an already-open, epoch-pinned
generated stdio session at the `dev-epoch` proof level. Passing epochs atomically replace the server
behind existing live host MCP connections and refresh opted-in development host installs. Failing or
timed-out epochs remain inactive on those host-facing surfaces (`AB7211`), leaving the last passing
epoch connected and installed. On a cold start whose initial build fails, the last-good epoch the
epoch store restored is seeded through the same gate before hosts serve it; when the project no
longer prepares at all, the `dev.contracts` declaration cannot be read and the restored epoch is
adopted directly, exactly as an undeclared project would be.

The Workbench project stream emits `dev.contract.status`, and `status()` (and `/api/project/status`)
carries a `hostAdoption` snapshot — `mode` (`gated` or `direct`), the `adoptedEpochId` hosts serve,
and the latest `contracts` evaluation. The Overview page renders it as **Host adoption**: a failed
gate names the published build, the build hosts kept, and the failed check names grouped by route,
and folds the gate diagnostics into the Diagnostics table; the Logs page carries the same records.
A later passing rebuild is adopted normally. Workbench playground sessions remain independently
epoch-pinned and are not gated by this matrix.

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

The same configuration aliases `agent-bundle/meta` to a generated module
carrying the project identity the compiler pass reported (`name`,
`packageName`, `packageVersion`, `version`, exactly what a build stamps), so
source that imports it loads under the pool without a build. A pool that is
not built from `agentBundleRstest()` (or `agentBundleBrowserRstest()`) has no
such alias, and importing that source raises `AB4760`; build the pool that
reaches it from the preset too — `agentBundleRstest({ include: ['tests/unit/**/*.test.ts'] })`
— or add the alias the diagnostic names.

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

Conventional request context providers (`src/providers/*`, see
[entry conventions](../../docs/entry-conventions.md#request-context-providers-power-tier))
are mounted automatically for every manifest-backed helper — `renderRoute`,
`renderRouteEvents`, `invokeCli`, `runScript` (rendered scripts), and the
in-memory MCP helpers — exactly as the
generated request scopes mount them: discovered from the compiled manifest,
executed once per request in the same deterministic key order, handed the same
surface-specific `invocation` (`tool`, `event`, `cli`, `script`), and failing the
request closed when a factory throws. `providers.processLifetime` is scoped the
way the artifact scopes it: each `invokeCli` call, each `runScript` run, and
each `renderRoute` render is a fresh simulated executable (hit 1, new
`instanceId`), while one open
`openInMemoryMcpServer` session shares a single identity across every request
it handles, like the artifact's warm Flight worker. Pass `context.providers` to opt out: an explicit map is mounted
verbatim and no conventional provider runs, which is how a test stubs a provider
that would otherwise reach the network or the file system.

```ts
// Real providers, as the artifact would mount them.
const real = await renderRoute('tool:library/summarize', { input: { title: 'Dune' } });

// Stubbed providers: nothing under src/providers/ executes.
const stubbed = await invokeCli(['library', 'audit', './books'], {
  context: { providers: { libraryTooling: { tool: 'ffprobe 6.1' } } },
});
```

`context` (and `context.providers`) stays optional even once the generated
`.agent-bundle/routes.d.ts` augmentation declares provider keys: omitting it
runs the real providers, which is what the artifact does, while an explicit map
must carry every declared key, so a fixture cannot leave a promised value
`undefined`. Only a direct `runAgentRequest` requires `providers` in that case,
because nothing else would supply them.

The harness simulates the process identity per executable, not module
evaluation: one Rstest worker evaluates each provider module once, so
module-level state in a provider is shared across every simulated CLI
invocation, render, and in-memory server in that worker (as it is for the route
modules themselves), whereas a real artifact evaluates the module afresh in
every CLI process and Flight worker. A provider's module-level cache, counter,
or singleton is therefore only proven by the packed and projected proof levels
that spawn the artifact; a route-unit test that needs cold state should stub
the provider through `context.providers` or reset that state between calls.

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
| `script-dispatch` | `runScript`, `scriptJson`, `scriptNdjson` | a conventional `src/scripts/*` module run through its generated executable's contract: a rendered `.tsx` script through the rendered-script shell in-process (piped Markdown, explicit TTY, `--json`, `--ndjson`), a plain `.ts` script through the `main` process envelope as a Node process of its own over the source — fresh module state, real `process.exit`, its own argv, exit code, and streams — without bundling |
| `workbench-surface` | `inspectWorkbenchSurface`, `workbenchSurfaceFromRouteGraph` | what the dev server would hand the Workbench for this project — the route manifest, the grouped route catalog, the state declaration, lifecycle-replay fixtures per host, and page availability — from the same compiler pass and projection functions, with no browser and no dev server |
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

`runScript` is the same idea for the `src/scripts/*` convention. The manifest
carries every conventional script with its extension contract
(`testManifest().scripts`), and the helper runs the module through what its
generated `scripts/<name>.mjs` would do — never by bundling it: a rendered
`.tsx` script runs in-process through the same shell the executable uses,
and a plain `.ts` script runs as a Node process of its own, as the
executable does (see below):

```ts
import { runScript, scriptJson, scriptNdjson } from 'agent-bundle/test';

// script-dispatch, rendered .tsx script: `--json` / `--ndjson` are reserved by
// the framework, everything else reaches the component's `argv` prop.
const summary = await runScript('summary', ['./books', '--json']);
expect(summary.exitCode).toBe(0);
expect(scriptJson(summary)).toMatchObject({ arguments: ['./books'] });
expect(scriptNdjson(await runScript('summary', ['./books', '--ndjson'])).at(-1)?.type).toBe('complete');

// script-dispatch, plain .ts script exporting main(argv): the envelope adopts
// a numeric return as the exit code; stdout and stderr are captured.
const checksum = await runScript('checksum', ['./books']);
expect(checksum.exitCode).toBe(0);
expect(checksum.stdout).toBe('Fixture checksum: 7\n');
```

A plain script runs as a Node process of its own over the source module, so
the process contract is Node's rather than a simulation of it: every run
evaluates the module afresh (module-level state never survives between runs,
as it never survives between processes), `process.argv` is
`[node, <source>, ...argv]`, `process.exit` ends the script for real — work
queued after it never runs, whether or not the script caught the call —
process-level APIs such as `process.chdir` work and affect only the script, a
numeric `main` return goes through the real `process.exitCode` setter (`300`
reports `44`; `1.5` exits 1 with the setter's `RangeError`), a signal that
ends the process reports as `128 +` its number, and the test process's own
argv, exit code, cwd, and streams are never touched, so plain runs may overlap
each other and any other test. The builder's static export scan decides
between the `main` envelope and a self-executing module, and a non-callable
`main` fails the way the generated executable fails. The process resolves
relative `.js` specifiers to their TypeScript sources, transforms `.ts` with
Node's own type transform, lowers the `.tsx` and `.jsx` helpers a plain
script imports with the bundler's SWC — the same lowering the generated
executable was built with — and serves `agent-bundle/meta` as the identity the build stamps from the
manifest's `plugin`. Explicit `scripts:` configuration entries are bundled
entries rather than routes and stay with the packed level. A rendered script
composes the project's root layout (a script belongs to no server, so no
server layout applies) and mounts the project's conventional providers with the `script` invocation the
generated executable passes (`context.providers` substitutes a fixture map, as
everywhere); a plain script opens no request scope, so it accepts no `context`
at all. A rendered script's declared state mounts on a disposable root for
the run, as at every harness level (`renderRoute`, `invokeCli`): the
`AGENT_BUNDLE_PLUGIN_ROOT` / `.agent-bundle` anchor a `workspace-durable`
store keeps between executable runs is the packed artifact's, and the packed
level proves it; a test that needs one store across several rendered runs
passes the same `context.state` and `context.noticeLedger` bindings to each.
`stdin` pipes input to a plain script (omitted,
it reads end-of-file at once); `process.execArgv` is empty as under plain
`node`; an aborted `signal` sends SIGTERM and, should the script trap it,
kills the process after a one-second grace before the run rejects. A rendered
script's own `console` and stream writes during the run land on the
invocation's `stderr` — the generated executable forwards its render worker's
stdout and stderr there — so `stdout` holds machine output only and nothing
escapes into the test runner. `process.exit` from rendered code is that
worker's exit, never the test process's: the run fails as the executable's
shell reports it (`Generated render worker exited with code N.` on `stderr`,
exit code 1, `0` included), the call unwinds the caller, and whatever code
that catches it writes afterwards is discarded, as a worker that has exited
writes nothing. Once a rendered run's `signal` aborts, no state mount or
module load that has not begun is started on its behalf. Every `ScriptInvocation` carries
`provenance.execution` (`rendered-shell`, `main-envelope`, or
`self-executing`) beside the level.

`inspectWorkbenchSurface` answers "what would the Workbench show for this
project?" without a browser. It runs the dev server's own preparation as the
Workbench server constructs it — `development` mode for a configuration
factory that branches on `context.mode`, the selected `configPath` for both
the compiler pass and eval-suite discovery — and the same projection functions
the dev server serves — `GET /api/routes/manifest` and `GET /api/lifecycles`
byte for byte — then applies the Workbench's own grouping and navigation
rules:

```ts
import { inspectWorkbenchSurface, workbenchPageLabel } from 'agent-bundle/test';

const surface = await inspectWorkbenchSurface({ root: projectRoot });
expect(surface.catalog.groups.map((group) => group.label)).toContain('curator · Tools');
expect(surface.catalog.stateDefinition).toMatchObject({ driver: 'sqlite', lifetime: 'workspace-durable' });
expect(surface.lifecycles[0]?.targets.map((target) => target.target)).toEqual(['claude', 'codex']);
expect(surface.pages.map(workbenchPageLabel)).not.toContain('Playground');
```

`counts` are the artifact inventory the Workbench counts, derived without a
build: one instance per hook, MCP server, or script declaration per selected
target it names (a declaration whose `targets` select none of the project's
targets is emitted nowhere and counts nothing), plus the declared Skills, eval
suites, and targets. Page availability depends only on whether each count is
zero and on what the compiled graph declares. Host discovery, live MCP probes, published epochs,
and the RSC runtime page are artifact- or process-bound and are not projected
here.

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
records its unavailable non-interactive host-session surface explicitly. The
Claude and Codex legs skip when those binaries are absent, so the repository's
CI runs them on every change against the exact CLI versions pinned beside each
adapter's schema provenance (`hostCli` in `src/adapters/schemas/*/PROVENANCE.json`),
signed out and with no secrets; only the `claude -p` session and Eval smokes
remain login-gated.

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
validation. MCP Apps are not registered at this level: every app route reports
`surface-completeness` as `not-applicable` and receives no coverage or sweep
check, and app fixture entries are accepted and ignored.

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

**MCP App coverage per level.** Fixtures must cover every compiled tool, prompt,
and resource route on the server. App routes are covered at every boundary that
registers app resources — `packed-stdio`, `packed-deleted-source`,
`host-install`, and `dev-epoch` — where `surface-completeness` requires the
compiled `ui://` URI in `listResources` and `sweep` reads that resource. With
the default `apps: 'auto'` an app route needs no fixture entry: `coverage`
passes with a reason naming the auto-covered sweep. An explicit
`{ kind: 'resource' }` (or legacy `{}`) entry is always accepted, and
`apps: 'explicit'` makes a missing app entry a `coverage` failure again. At
`mcp-in-memory` apps are never registered, so `apps` has no effect there.

The `cancellation` fixture aborts the invocation after `abortAfterMs`
(default 50ms) and requires it to settle rejected. Its input must stay in
flight past that point: when the invocation settles before the abort fires
the check is `not-applicable` ("invocation completed before abort; use an
input that stays in flight"), and it only `fails` when the abort was delivered
mid-flight and the call still settled without rejecting.

Lifecycle fixtures replay
`unknown → queued → running → first-progress → repeated-progress → terminal`
over the matrix's one open client. The framework validates every phase's
structured content and rendered output, additive/closed compatibility, live
progress before settlement, journal accumulation, declared notices,
idempotent commit replay, and typed budget rejection. A caller-supplied
same-store `restart` callback adds durability evidence at that boundary;
without one the check is honestly `not-applicable`. Packed callers should wire
that callback into the existing packed journey's restart rather than creating
a second pack/build/install path. A lifecycle fixture's optional
`state.catalog` assertion pins its declared id and lifetime to the compiler
manifest used by that same mounted-state replay.

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
into the source/build tree. When the compiled manifest contains event routes,
the packed and installed-host boundaries sample the read-only event-runtime
status before and throughout sequential matrix events. The
`runtime-instance-identity` check fails if the warm `instanceId` changes, the
artifact epoch drifts, or availability degrades to `runtime-restarted` /
`runtime-unavailable`.

No matrix boundary proves browser App HTML or artifact-rebuild replay.
In-memory runs and compiled artifacts without event routes report runtime
identity as honestly `not-applicable`.

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
// App routes are auto-covered here; `{ kind: 'resource' }` names one explicitly.
await runPackedContractMatrix({
  eventRuntime: { endpointId: packedEventRuntimeEndpointId },
  session: packedSession,
  manifest: compiledManifest,
  fixtures: { /* same shape, optionally 'app:library/dashboard': { kind: 'resource' } */ },
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

A project with routed `src/cli/**` commands also ships that CLI inside every host artifact as
`<target>/bin/<plugin-name>.mjs` (plus `bin/<plugin-name>-flight.mjs` when a command renders), a
self-contained module run as `node <plugin-root>/bin/<plugin-name>.mjs <command>` — so a script
route can spawn its `../bin/<plugin-name>.mjs` sibling and a Claude skill can point at
`${CLAUDE_PLUGIN_ROOT}/bin/<plugin-name>.mjs` without a separate npm install. Every built-in target
publishes the `cli` capability that admits it; `inspect` accounts for it as a `cli` component, and
the manifest records both files with bundle provenance. The npm package bin under `dist/bin/` is
unchanged. See `docs/entry-conventions.md` for the layout and diagnostics (`AB4765`, `AB4766`).

### What gets hashed

Hash pins cover vendored external content whose ground truth lives outside this repository and can
drift: host document schemas under `src/adapters/schemas/*` (with upstream URL, commit, and SHA-256
recorded in `PROVENANCE.json`), the Agent Skills specification-derived schema pin in the manifest
`agentSkills` block, and emitted artifact files and source inputs for integrity.

Repository-owned capability tables and evidence are not hashed. Capability evidence records the
observed host version (`observedVersion`) and target, while adapters carry a monotonic
`adapterRevision`. Git already versions repository-owned content; hashing it again inside the
repository is self-referential and causes churn on every table edit.

`AgentBundleConfig` merges bundled portable, Codex, Claude, and Cursor declarations
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

## License

Apache License 2.0. The published tarball carries the repository
[LICENSE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/LICENSE) and
[NOTICE](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/NOTICE); third-party material keeps
its own notices under `dist/workbench/`.

## Contributor delivery and release gates

The public examples live at [`../../examples`](../../examples). They are private
pnpm workspaces and use only public package exports. Start with Skills Starter,
then Hooks and Scripts, then the interactive MCP App.

Run the complete local delivery gate with `pnpm check && pnpm check:release`.
`pnpm check:release` is release-only: its exact package-script components are
`pnpm pack:dry-run`, `pnpm audit:release`, and `pnpm test:packed:release`, and it does not replace
`pnpm check`. `pnpm release` runs that release gate before `changeset publish`.
Native Claude/Codex smokes stay intentionally opt-in and skipped in ordinary CI.
npm publishing is deferred until the release owner picks the final package name/scope;
pkg.pr.new previews are the interim channel, and the first npm release will use npm
package provenance (`publishConfig.provenance` is already set). `pnpm audit:release` fails if any
publishable tarball lacks `LICENSE`, `NOTICE`, or the `"license": "Apache-2.0"` manifest field.
