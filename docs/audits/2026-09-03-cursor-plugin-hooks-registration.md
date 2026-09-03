# Cursor plugin hook registration and marketplace-style install — #407 evidence

Date: 2026-09-03. Observed desktop client: Cursor 3.18.25 stable (Linux x64,
`/usr/share/cursor`, workbench commit `280eca2911f1774689696e5f1efa5a4f97a87af3`),
run as an isolated instance (dedicated `HOME=/tmp/cursor-407/iso/home`,
dedicated `--user-data-dir`, Xvfb display, workspace `/tmp/cursor-407/iso/ws`).
Observed Agent CLI: `cursor-agent 2026.08.31-4057e58`. Issue #407 was filed
against Cursor **3.16.21** running from `~/.cursor-server` (the remote-server
build); that build is not installed on this machine and could not be
re-observed.

This note is the source of truth behind the `install cursor --mode` change,
the Doctor `AB7322`–`AB7324` findings, and the #407 closing comment. Every
claim about Cursor cites the live documentation retrieved on 2026-09-02/03 or
a recorded observation.

## 1. What the live Cursor documentation says

| Claim | Source | Quote |
| --- | --- | --- |
| Hooks are a Cursor Plugin component, not an Agent Plugins one | https://cursor.com/docs/plugins | "**Hooks** \| Cursor Plugins \| Automation scripts triggered by events" and "**Cursor Plugins**: plugins with a `.cursor-plugin/plugin.json` manifest, which add rules, agents, commands, hooks, and variables" |
| Plugins are one of three hook sources | https://cursor.com/docs/hooks | "Define hooks in `hooks.json` files at the project or user level, or install them through plugins from **Customize**." |
| User hooks run from `~/.cursor/`, project hooks from the project root; plugin working directory is not documented | https://cursor.com/docs/hooks#configuration | "**Project hooks** (`.cursor/hooks.json` in a repository): Run from the **project root**" / "**User hooks** (`~/.cursor/hooks.json`): Run from `~/.cursor/`" (no plugin row) |
| Hook precedence and merge | https://cursor.com/docs/hooks#configuration | "All matching hooks from every source run; when responses conflict, higher-priority sources take precedence during merge" / "Priority order (highest to lowest): Enterprise → Team → Project → User" |
| `${CURSOR_PLUGIN_ROOT}` is expanded in plugin-delivered commands | https://cursor.com/docs/hooks (beforeMCPExecution) | "`command` is the launch string from the server's config and can differ between installs: relative paths, `${CURSOR_PLUGIN_ROOT}` expansion, or an HTTP transport" |
| Cloud agents ignore user-level hooks | https://cursor.com/docs/hooks | "User-level hooks (`~/.cursor/hooks.json`) are not available in cloud agents." |
| Local plugin test location and the load condition | https://cursor.com/docs/plugins#test-plugins-locally | "Before you publish, put either plugin format in `~/.cursor/plugins/local`" … "After a reload, Cursor discovers plugins in this folder if local plugin imports are allowed." … "If a marketplace plugin with the same name is already installed, that install takes precedence over the local copy." |
| Marketplace plugins are Git repositories; the install surface is Customize | https://cursor.com/docs/plugins#installing-plugins | "Plugins are distributed as Git repositories and submitted through the Cursor team." … "1. Open **Customize** in the sidebar. 2. Find the plugin you want to use. 3. Select **Install** and choose a project or user scope." |
| Team marketplaces are a paid feature and import from GitHub | https://cursor.com/docs/plugins#add-a-team-marketplace | "Team marketplaces are available on Teams and Enterprise plans." … "3. Follow the instructions to create a marketplace from scratch, or use "Import from Repo" if importing from GitHub." |
| Install modes | https://cursor.com/docs/plugins#plugin-installation-modes | "**Default Off**: Developers can find the plugin and choose whether to install it." / "**Default On**: The plugin is installed by default, but developers can opt out." / "**Required**: The plugin is always installed and cannot be uninstalled." |
| Multi-plugin repository manifest | https://cursor.com/docs/reference/plugins#cursor-multi-plugin-repositories | "A single Git repository can contain multiple plugins using a **marketplace manifest**. Place it at `.cursor-plugin/marketplace.json` in the repository root." Required fields: `name` "(kebab-case)", `owner` "`name` (required), `email` (optional)", `plugins` "(max 500)"; resolution: "The parser looks for `my-plugin/.cursor-plugin/plugin.json`". |
| The only documented install deeplink is for MCP servers | https://cursor.com/docs/plugins#mcp-apps-deeplinks, https://cursor.com/docs/reference/deeplinks | "`cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG`"; the deeplinks reference lists only `prompt`, `command`, and `rule` deeplinks — no plugin or marketplace install deeplink exists. |
| Agent CLI loads local plugin directories and now runs their hooks | https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/changelog (August 11, 2026 release) | "`--plugin-dir <path>` \| Load a local plugin directory (can be specified multiple times)" and "**Plugin hooks run from installed plugins.** Hooks defined by installed plugins, including those loaded with `--plugin-dir`, now execute and refresh when plugins reload." |
| Agent CLI marketplace verbs | `cursor-agent plugin marketplace --help` (2026.08.31-4057e58) | "add [options] <gitUrl>  Add a plugin marketplace from a git repository URL" / "list" / "remove" / "update"; there is no `plugin install` verb. |
| Desktop changelog | https://cursor.com/changelog (rendered 2026-09-03) | The rendered page lists Aug 13 – Sep 2, 2026 entries (Builds, Origin, Cloud Agents, Self-hosted machines) and contains no plugin or hooks entry; older entries are not server-rendered and were not reachable through the fetch tool. |

The CLI changelog entry dated **August 11, 2026** ("Plugin hooks run from
installed plugins … now execute") is the one dated vendor statement that
plugin-delivered hooks had been a Cursor-side gap that was fixed after the
3.16 timeframe reported in #407.

## 2. Ground truth: tracedecay (local, works) versus the emitted pack

Both plugins were read-only inputs. `~/.cursor/hooks.json` does not exist on
this machine.

| Aspect | `~/.cursor/plugins/local/tracedecay` (known working) | `cursor` target emitted by agent-bundle (`/tmp/cursor-407/probe-pack`, built from `examples/hooks-and-scripts`-style config) | Delta |
| --- | --- | --- | --- |
| Manifest | `.cursor-plugin/plugin.json` with `"hooks": "hooks/hooks.json"`, `"mcpServers": "mcp.json"`, `rules`, `skills`, `agents`, `commands`, `version: 0.1.0-beta.37` | `.cursor-plugin/plugin.json` with `"hooks": "./hooks/hooks.json"`, `name`, `displayName`, `description`, `version` | `./` prefix only; both resolve to `hooks/hooks.json` |
| Hooks envelope | `{ "version": 1, "hooks": { … } }` | `{ "version": 1, "hooks": { … } }` | none |
| Events | `afterFileEdit`, `afterShellExecution`, `postToolUse`, `preCompact`, `sessionEnd`, `sessionStart`, `stop`, `workspaceOpen` | `preToolUse`, `postToolUse`, `sessionStart`, `stop` | subset; same names |
| Command form | absolute binary: `'/home/zack/.local/bin/tracedecay' hook-cursor-post-tool-use` | `node "${CURSOR_PLUGIN_ROOT}/hooks/after-tool-log-6bd3fb25.mjs"` | ours relies on `${CURSOR_PLUGIN_ROOT}` expansion |
| Matchers | none | `"matcher": "^Shell$"` on pre/postToolUse | ours adds matchers |
| `timeout` | 5 / 30 s | none | none needed |
| `loop_limit` | none | none | none |
| Script executable bit / shebang | n/a (binary) | `.mjs` files, mode 0664, no shebang, invoked through `node` | not required because the command names the interpreter |
| MCP | `mcp.json` `{ command: "/home/zack/.local/bin/tracedecay", args: ["serve", "--path", "${workspaceFolder}"], type: "stdio" }` | `mcp.json` with `${CURSOR_PLUGIN_ROOT}` in args/env | equivalent |

Conclusion: there is no structural difference that Cursor's documented or
observed loader treats differently. Both shapes fired on 3.18.25 (section 3),
so the emitter was **not** changed to a different hooks shape. The
`hooks/hooks.json` document, `version: 1`, `${CURSOR_PLUGIN_ROOT}` commands,
and `^Shell$` matchers stay the primary emitted contract.

## 3. Evidence matrix — isolated Cursor 3.18.25 desktop instance

Setup (`/tmp/cursor-407/iso-setup.sh`): the same marker-logging script was
registered at three locations for the same events — `~/.cursor/hooks.json`
(user), `<ws>/.cursor/hooks.json` (project, trusted workspace), and a
plugin-scoped `~/.cursor/plugins/local/hooks-probe/hooks/hooks.json` using
`"${CURSOR_PLUGIN_ROOT}/hooks/hook-log.sh"` — plus the agent-bundle emitted
pack installed as `~/.cursor/plugins/local/ab-hooks-probe`. An agent chat in
the Agents window ran a shell tool call (`cat probe.txt`) and finished; markers
were appended to `/tmp/cursor-407/iso/markers/events.jsonl` (51 lines).

| Format | Hook location | Surface | Event | Fired? | Recorded `cwd` |
| --- | --- | --- | --- | --- | --- |
| user `hooks.json` | `~/.cursor/hooks.json` | IDE Agents window | workspaceOpen | yes (1) | `~/.cursor` |
| user `hooks.json` | `~/.cursor/hooks.json` | IDE Agents window | preToolUse / beforeShellExecution / afterShellExecution / postToolUse | yes (3 each) | `~/.cursor` |
| user `hooks.json` | `~/.cursor/hooks.json` | IDE Agents window | stop | yes (2) | `~/.cursor` |
| project `hooks.json` | `<ws>/.cursor/hooks.json` | IDE Agents window | preToolUse / beforeShellExecution / afterShellExecution / postToolUse | yes (3 each) | `<ws>` |
| project `hooks.json` | `<ws>/.cursor/hooks.json` | IDE Agents window | stop | yes (2) | `<ws>` |
| Cursor Plugin (hand-written probe) | `~/.cursor/plugins/local/hooks-probe` manifest hooks | IDE Agents window | preToolUse / beforeShellExecution / afterShellExecution / postToolUse | yes (3 each) | plugin root |
| Cursor Plugin (hand-written probe) | plugin manifest hooks | IDE Agents window | stop | yes (2) | `<ws>` |
| **Cursor Plugin (agent-bundle emitted `cursor` target)** | `~/.cursor/plugins/local/ab-hooks-probe` manifest hooks, `node "${CURSOR_PLUGIN_ROOT}/hooks/*.mjs"` | IDE Agents window | preToolUse (`^Shell$`) | **yes** (`CURSOR_PLUGIN_ROOT` = plugin root) | plugin root |
| **Cursor Plugin (agent-bundle emitted)** | same | IDE Agents window | postToolUse (`^Shell$`) | **yes** | plugin root |
| **Cursor Plugin (agent-bundle emitted)** | same | IDE Agents window | stop | **yes** | `<ws>` |
| Cursor Plugin (both) | plugin manifest hooks | IDE Agents window | sessionStart | not observed in this run (the chat session pre-dated the plugin reload; user/project sessionStart were also not observed in the same window) | — |
| Cursor Plugin, `tracedecay` | `~/.cursor/plugins/local/tracedecay` | host IDE (maintainer's daily instance) | afterShellExecution, postToolUse, stop, sessionStart, … | works per maintainer statement (ground truth) | — |
| Agent Plugins (`portable` target, root `plugin.json`) | n/a | any | any | no — the format has no hooks component (docs §1) | — |
| any | any | Agent CLI (`cursor-agent`) | any | not observed: the CLI required Cursor authentication unavailable to the isolated run; the vendor CLI changelog (Aug 11, 2026) states plugin hooks now execute in the CLI | — |

Read-out: on Cursor 3.18.25 the emitted pack's plugin-scoped hooks fire for
tool events and `stop` exactly like the hand-written probe and tracedecay,
without any `~/.cursor/hooks.json` entry. Plugin hook commands execute with
`cwd` = the plugin root and `${CURSOR_PLUGIN_ROOT}` substituted, so
`${CURSOR_PLUGIN_ROOT}`-relative commands are the correct form (and the one
also used by official marketplace plugins such as `cursor-public/continual-learning`:
`"command": "bun run ${CURSOR_PLUGIN_ROOT}/hooks/continual-learning-stop.ts"`).

### Root-cause assessment for #407

The report is not reproducible on the current stable desktop build. The
evidence points to a Cursor-side, build-specific gap rather than the emitted
shape:

- #407 observed the gap on **3.16.21 in `~/.cursor-server`** (remote server
  build) and saw the same gap on tracedecay ("only `sessionStart` … every other
  declared event: 0"), which today fires normally on the same machine.
- Cursor's own CLI changelog (August 11, 2026) records "Plugin hooks run from
  installed plugins … now execute", i.e. plugin hook execution was fixed
  vendor-side in that window.
- In the 3.18.25 workbench bundle, plugin hooks are gated by
  `thirdPartyExtensibilityEnabled` and the `enable_cc_plugin_import` flag
  (`/tmp/cursor-407/glass-pluginhooks.txt`); both default to enabled on this
  build. A build or account where either was off would load the plugin (rules,
  skills, MCP) yet deliver no plugin hooks — matching the #407 symptom.

Because the emitted shape is correct and now proven, the framework does **not**
write `~/.cursor/hooks.json`. Doing so would run every hook twice on fixed
builds ("All matching hooks from every source run"), is unavailable to cloud
agents, and would have to hard-code absolute plugin paths. Instead Doctor
proves registration (`AB7322`) and flags duplicate delivery (`AB7323`) so the
silent-failure mode #407 describes is detectable.

## 4. Marketplace layout study (read-only, this machine)

Sources: `~/.cursor/plugins/marketplaces/**`, `~/.cursor/plugins/cache/**`,
and a copied `state.vscdb` from the real user-data-dir.

- Marketplace repositories are cloned under
  `~/.cursor/plugins/marketplaces/<host>/<owner>/<repo>/<commit-sha>/`
  (e.g. `github.com/anthropics/claude-plugins-official/1a2f18b0…`); a
  `_staging` directory sits alongside.
- Installed plugin bytes live under
  `~/.cursor/plugins/cache/<marketplace-slug>/<plugin-id>/<commit-sha>/` with an
  empty `.cache-complete` receipt next to `.cursor-plugin/`, e.g.
  `cache/cursor-public/continual-learning/45c66fde…/.cache-complete`. The
  agent-worker bundle confirms the layout constants (`plugins/cache`,
  `.cache-complete`, path = `[root, sanitize(marketplaceSlug), sanitize(pluginId), version]`).
- The install registry is not a file: `state.vscdb` holds
  `cursor.plugins.installedIds.no-team|<workspace-uri>` and
  `…|no-workspace` values containing **server-assigned numeric plugin ids**
  (`[{"id":"677","sources":["user"]}, …]`). Which plugins are enabled is
  resolved against the account's dashboard state; the local cache is a
  projection of that server decision. There is no local manifest or receipt
  that can be written to make Cursor treat a directory as marketplace-installed.
- Official plugins on this machine use exactly the emitted shape:
  `.cursor-plugin/plugin.json` with `"hooks": "./hooks/hooks.json"` and
  `${CURSOR_PLUGIN_ROOT}` commands.

## 5. Install strategies evaluated (maintainer's preference order)

| # | Strategy | Result |
| --- | --- | --- |
| 1 | Official deeplink or CLI that installs a plugin from a marketplace/Git URL | No plugin/marketplace install deeplink is documented (§1). `cursor-agent plugin marketplace add <gitUrl>` requires a **hosted** Git URL and CLI authentication: `add /tmp/cursor-407/mkt-repo` and `add file:///tmp/cursor-407/mkt-repo` both failed with `Failed to resolve git ref "HEAD" for https:///tmp/cursor-407.git … Could not resolve host: tmp` (`/tmp/cursor-407/cli-mkt-add.txt`). Usable only for published packs. |
| 2 | Register the pack in a marketplace Cursor can consume | A local Git repository with `.cursor-plugin/marketplace.json` is the exact input of Customize → Plugins → **"Add Plugins from Local Repository"** (workbench `importLocalMarketplace` / `parseGitHubRepoForPluginsLocally`). The flow is a native folder picker plus an Install click and could not be driven unattended under Xvfb (GTK dialog did not accept synthesized input). This is the marketplace-style path the installer now prepares. |
| 3 | Replicate marketplace-installed state directly | Not viable: enabled-plugin identity is server-side (§4); writing `plugins/cache/**` + `.cache-complete` without a matching server id is not honoured and would be undone by the next dashboard sync. |

Decision implemented in this change:

- `agent-bundle install cursor --mode marketplace`, the generated installer
  bin, and the emitted `install.mjs --mode marketplace` stage a committed Git
  repository at `~/.cursor/agent-bundle/marketplaces/<name>` (marketplace
  `<name>-marketplace`, plugin source `plugins/<name>`), print the commit and
  the exact Customize step, and are idempotent (`already-installed` with the
  same commit). They fail closed with `AB7002` when `git` is missing,
  `AB7003` for bundles without `.cursor-plugin/plugin.json` or with nested
  `.git` metadata (which `git add` would record as an empty gitlink), and
  `AB7005` on version/content collisions (plugin copy or the generated
  `marketplace.json` differing, or a working tree that is not what HEAD
  commits — checked with `git status --porcelain --untracked-files=all
  --ignored=matching`). The commit is made byte-faithful: the repository is
  initialised with `--object-format=sha1` (Git ≥ 2.29), `.git/info/attributes`
  disables `text`/`eol`/`filter`/`ident`/`working-tree-encoding` for every
  path (a bundle-shipped `.gitattributes` or global `core.autocrlf` would
  otherwise rewrite bytes into the index while `git status` stayed clean),
  `git add` runs with `core.autocrlf=false`, and after the commit every blob
  id from `git ls-tree -r -z HEAD` is compared with `sha1("blob <len>\0" +
  bytes)` of the staged file — any drift fails closed with `AB7004` and the
  staging directory is discarded. The manifest's plugin entry carries only the
  pinned `marketplace.schema.json` fields (`name`, `source`, `description`;
  `additionalProperties: false`) — the version lives in the copied
  `plugins/<name>/.cursor-plugin/plugin.json`. Cursor then owns the install
  (cached under `plugins/cache/<marketplace>/<name>/<version>`, managed in
  Customize, not badged `Local`); Doctor treats only that marketplace's cache
  partition as proof of import.
- `--mode local` (default) keeps the proven safe copy into
  `~/.cursor/plugins/local/<name>`. It remains the default because it is the
  only path that loads without a UI step and its hooks are proven to fire (§3);
  marketplace mode is one Customize click away from the same outcome and is
  the recommended distribution shape once a pack is published.
- `agent-bundle doctor --host cursor` reports `AB7322` (hook registration
  `registered`/`stale`/`missing`), `AB7323` (duplicate or unparsable
  `~/.cursor/hooks.json`), and `AB7324` (staged marketplace imported or still
  awaiting the Customize step; `doctor --from` resolves a marketplace-mode
  bundle to its staged copy). Import proof requires Cursor's `.cache-complete`
  receipt for the staged HEAD commit in that marketplace's cache partition,
  and the staged repository itself is verified read-only through `git
  cat-file -e <HEAD>^{commit}` and `git --no-optional-locks status` (a missing
  commit object or a dirty tree is `corrupt`, never `registered`).

## 6. Automated proof added

- `tests/install.test.ts`: marketplace staging layout and git call sequence,
  idempotent re-run with real `git`, content and version collisions,
  missing-`git` fail-closed, mode rejection for non-Cursor hosts, CLI
  `--mode` pass-through and human output.
- `tests/doctor.test.ts`: `AB7322` registered → duplicate (`AB7323`) →
  unparsable user hooks → stale → missing (quoted paths, interpreter script
  operands, non-script plugin-relative arguments); plugins without hooks;
  `AB7324` unregistered → registered (receipted cache match for the staged
  commit) → drifted → corrupt (manifest/plugin schema, unlisted or misnamed
  plugin, bad HEAD, missing commit object, dirty tree, missing `.git`), with
  stray files in the staging or cache roots ignored.
- `tests/host-install-proof.test.ts` / `packed-host-install-proof.test.ts`
  (`pnpm test:host-install:build`): the built fixture installed into an
  isolated Cursor home now also asserts `hooksRegistration:
  { events: ['sessionStart'], state: 'registered', userHooksJson: 'absent' }`
  and runs the emitted `install.mjs --mode marketplace` twice (`Staged`, then
  `Already staged` with the same commit) and Doctor's `AB7324` guidance.

## 7. Product feedback recorded for Cursor

Text filed as the #407 discrepancy note (URL: https://cursor.com/docs/hooks):
"The hooks documentation lists working directories for project, user,
enterprise, and team hooks but not for plugin-delivered hooks; observed on
3.18.25 they run from the plugin root with `${CURSOR_PLUGIN_ROOT}` expanded.
On 3.16.21 (remote server build) plugin-declared `preToolUse`/`postToolUse`/
`stop` hooks did not execute while the same commands in `~/.cursor/hooks.json`
did; the CLI changelog of August 11, 2026 records a fix for plugin hooks in
the CLI. Please document the plugin hook working directory and the minimum
build that delivers plugin hooks for tool events, and expose a
non-interactive `cursor-agent plugin marketplace add` for local repositories
(`file://`) so packs can be marketplace-installed without the Customize
folder picker."
