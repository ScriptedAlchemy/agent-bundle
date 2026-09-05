# agent-bundle

## 0.2.0

### Minor Changes

- 66f8598: Stop auto-approving tool calls from a pass-through `tool/before` result. A `tool/before` event route (or a config-declared `beforeTool` hook) that returns `outcome: 'continue'`, no `value`, or only `Agent.Context` no longer projects `hookSpecificOutput.permissionDecision: "allow"` on Claude Code and Codex; it writes no decision (and no output at all when there is no context or rewrite), so the host's own permission prompt applies. `permission/request` likewise answers only on an explicit decision. The route result vocabulary gains the explicit decisions `outcome: 'allow'` and `outcome: 'ask'` for `tool/before` (`allow` also for `permission/request`) — projected as `permissionDecision: allow | ask` on Claude and Codex and `permission: allow` on Cursor, where `ask` fails closed because Cursor documents it as unenforced — and `reason` on `tool/before` now requires a decision. A `updatedInput` rewrite returned with `continue` is delivered without a decision on Claude and Codex, so the host evaluates its permission rules against the rewritten input; return `outcome: 'allow'` to keep auto-approving a rewrite. This is a minor (breaking) bump because plugins that relied on the implicit approval must now say `allow` explicitly; the previous behavior let any `tool/before` route matching `Bash` bypass the permission prompt for every shell command in the session. Fixes #461 (#481)
- 55026f0: Give every event route a canonical, per-family `canonical.payload` beside the raw `native` envelope (`AgentEventRouteProps<E>`): the fields at least two hosts report — `toolName`, `toolInput`, `toolUseId`, `toolResponse`, `sessionId` (Claude and Codex `session_id`, Cursor `conversation_id`), `transcriptPath`, `cwd`, `model`, `permissionMode`, `agentId`/`agentType`, `agentTranscriptPath`, `prompt`, `reason`, `source`, `trigger`, `error`/`isInterrupt`, `lastAssistantMessage`, and `reentry` (Claude and Codex `stop_hook_active`, Cursor `loop_count > 0`) — each delivered as `{ value, nativeKey }` naming the host key it was read from, and absent when the host did not send it, never fabricated. Cursor's `tool_output` JSON string is parsed into `toolResponse` (kept as the string when it is not valid JSON); the Claude-only `model-switch/before` and `model-switch/after` families admitted by the 2.1.260 re-pin carry `fromModel`, `toModel`, `requestedModel`, and `source`. Where a family is also a config hook handler event, `canonical.payload` uses the same field names as `HookEvent<E>` (`reentry` is the one renaming of `stopHookActive`). Type a route to its family (`AgentEventRouteProps<'tool/after'>`) and `payload` narrows to that family's fields, in the route and in the generated `.agent-bundle/routes.d.ts` that `renderRoute` reads; `AgentEventCanonicalIdentity<E>` gains the same parameter. The per-family table ships as `agentEventPayloadFields`, the per-host key table as `agentEventPayloadNativeKeys` (with `AgentEventPayload`, `AgentEventPayloadField`, `AgentEventPayloadFieldName`, `AgentEventPayloadNativeKey`, and `agentEventPayloadFieldKinds`), and each pinned capability table mirrors its host's mapping under `hooks.eventRoutes.<event>.payload`, so the generated events reference documents field × host → native key per family. `agent-bundle/test` gains `createEventRouteInput(event, native, { host })`, which validates a host envelope and builds the `{ canonical, native }` input the harness takes, payload included; the Workbench Lifecycles view lists the mapped payload beside the canonical identity. `native` is unchanged, `idempotencyKey` still hashes only the envelope, and a route typed with the bare `AgentEventRouteProps` keeps working with every field optional. Breaking for one shape of consumer code: `payload` is a required property of `AgentEventCanonicalIdentity`, so a test or harness that constructs the identity by hand no longer compiles until it adds one — build the input with `createEventRouteInput` instead. (#466)
- 62b69c0: Emit one composite plugin root: `agent-bundle build` writes a single directory at the artifact output and `targets` (`claude`, `codex`, `cursor`, `portable`; default `portable`) selects which host projections it carries, so there is no `artifact/<host>` partition — host manifests sit in their dotfolders at the root (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `plugin.json`), Codex and Cursor hook/MCP documents move beside their manifests (`.codex-plugin/hooks.json`, `.codex-plugin/mcp.json`, `.cursor-plugin/hooks.json`, `.cursor-plugin/mcp.json`; `AB6027`, `AB6032`, and `AB7320` name those paths), and `skills/`, `hooks/`, `mcp/`, `scripts/`, `bin/`, and `INSTALL.md` are emitted once, with `install.mjs` beside them whenever `cursor` or `portable` is selected. A hook shared by several selected hosts compiles to `hooks/<name>.<host>.mjs` per host, each wrapper baking its own host, so generated hook wrappers no longer read `AGENT_BUNDLE_HOOK_HOST`; compiled MCP entries, scripts, and CLI bins are attributed to the sorted composite identity (`claude+codex`), and reordering `targets` yields byte-identical output. Remove the `plugin` target: `targets: ['plugin']` and `--target plugin` fail with `AB4100`, the generated `AGENTS.md` is gone, `create-agent-bundle --target` accepts only the four hosts, and the advanced-registry hooks `TargetAdapter.lowersConfigExtensions`, `TargetRegistry.lowersConfigExtension()`, and `NormalizationTargetRegistry.lowersConfigExtension()` are removed. Two selected projections planning one path with different bytes fail with `AB4103`; a command or rule scoped to a subset of the selected hosts that another selected host discovers conventionally (`commands/`, `rules/`) fails with `AB4105`; a selection that mixes an adapter registered on an advanced `TargetRegistry` with any other target fails with `AB4106` — `validate`, `inspect`, and `build` report all three on the same composite root. `agent-bundle install <host> --from <root>` and `doctor --from <root>` read the host manifest directly under the root (no `<root>/<host>` lookup; `AB7001` when it is absent), `mcp run`, `serve-app`, and `dev proxy --target <host>` resolve that host's MCP document in the same root, the `agent-bundle/test` `openInstalledHostMcpServer` harness reads the composite root as every host's bundle root, the warm event runtime's endpoint is identified by the artifact alone (its epoch and root directory, never the selection) with the invoking host carried on each hook request, each selected host reaching it through the first generated MCP server its own MCP document lists, the composite root's `INSTALL.md`/`install.mjs`, the `AB4106` refusal, and `--host-validation` judge the shipped host adapters by identity (an advanced `TargetRegistry` adapter named like a built-in host earns no install surface and is held to no host validator; `TargetRegistry.builtInHost()`/`builtInHosts()` expose the judgment), and `agentBundleBrowserRstest()` compiles every MCP App once for the project's whole selection while its `target` option names the host each app mounts as (default: the app's first declared target the project selects), `inspect --bundler` reports `distPath.root` as `<output>` with root-relative output paths and the composite identity as `target`, and the dev server, Workbench, and eval harnesses stage the composite root as one epoch (#578)
- 512ddaa: Add the `web` config key to expose declared MCP Apps in a browser: `web.apps` selects `<server>/<app>` entries already under `mcp.servers.<id>.apps`, `web.open` is `browser` or `never` (default `never`), and invalid exposure reports `AB4341`. When `web` is configured, the composite artifact's `agent-bundle.manifest.json` gains a `web` section (each App carries its server's `entry`, `args`, and `env`; Apps scoped to unselected targets are omitted) and `bin/<plugin>.mjs` carries the framework-owned `<plugin> web` command even without `src/cli/**`; `agent-bundle dev` serves the same host at `/web/<server>/<app>`. Host adapters publish a `web` capability row that gates the web-only bin like `cli` gates a routed CLI; a target without it is an `AB4341` warning, and an authored command or alias spelled `web` is `AB4341`. Remove `agent-bundle/serve-app-command` (`spawnServeApp`, `serveAppArgv`, `locateFrameworkCli`, `ServeAppCommandError`); the supported path from an installed artifact is `<plugin> web`. `web` never displaces an authored executable: a hand-written `src/cli.ts`, a `bin` entry claiming the plugin name, or `bin: false` keeps its bin and `AB4341` reports the web surface with nowhere to live. Fix `agent-bundle dev` rebuilding the epoch it just produced whenever the project has a `dist/` package build: the watcher now ignores the build's `.dist.stage-*` staging directory. (#620)
- efdec6b: Reserve `.cli.{ts,tsx}` under `src/mcp/**` for the opt-in CLI surface projection of a generated tool: a colocated `<tool>.cli.ts` exporting `CliProjectionConfig` (`agent-bundle/routes`) and an optional synchronous `mapInput` compiles to an idiomatic command (`inspect --routes` shows `cli.commands[].projection`) and excludes that tool from the bulk `routes.mcpCommands` projection. The bulk `routes.mcpCommands` projection now runs tools with `invocation.kind: 'cli'` (same as explicit projections; the generated MCP server still passes `kind: 'tool'`). Orphan or misplaced modules are `AB4843`, an invalid projection contract is `AB4844`, and a grammar that does not bind to the tool's contract is `AB4845` (#616).
- 8b0a6b9: Prove self-containment from compiler evidence for every host-pack surface and package-build entry. Reject `tools.rsbuild.output.autoExternal` other than `false` and static package `externals` with `AB4725`; judge function-form externals from compiler evidence and fail with `AB6005` when Rspack keeps anything except a Node built-in or emitted sibling external. Keep the emitted-module walk as defense in depth until #619 completes. (#623)
- f449ce2: Add `definePrebuilt` to `agent-bundle` and `agent-bundle/config`, with a
  `runtimeDependencies` field for the bare package names a prebuilt payload
  loads. Report a malformed list as `AB4740`, and as `AB4751` a name npm does
  not read as a bare package name or one `package.json` does not install for a
  consumer (`dependencies`, `optionalDependencies`, or a peer not marked
  optional); count declared runtime dependencies as used for `AB7014` and expose
  them as `NormalizedPayload.runtimeDependencies`. (#630)
- 02b8972: Judge MCP App views from compiler evidence: the `ArtifactDependencyAuditPlugin` now sits in every view's Rsbuild compilation, and a module the compilation kept external — through a `tools.rspack` mutator or a function-form `externals`, whatever it was mapped to — fails the view with `AB6005` (`Compiled MCP App view "mcp-apps/<name>.html" keeps … external …`), since a browser document has no allowable external. (#627)
- 833e48f: Close out #99 acceptance item 7 with a notice redaction contract and a retention policy. `notices.publish()` accepts `sensitivity: 'public' | 'internal' | 'secret'` (default `internal`); each host's `noticeDelivery` row may name a dated `sensitivity` ceiling, and the ledger, inbox resource (`agent-bundle://notices/inbox`, which now reports `sensitivity` and `disclosure`), event admission, and `resources/updated` signaller withhold a notice above the route's ceiling, recording the refusal as `withheld[route]` on the notice; `internal` content is redacted on every route by `flare-redact@1.6.1`, a new exact-pinned runtime dependency of `@agent-bundle/runtime` (default detectors — provider tokens, JWTs, PEM keys, `Bearer`/`Basic` headers, URL credentials, credential assignments, e-mail addresses, cards — plus credential-shaped member names, every finding replaced whole by `[REDACTED]`; assignment values shorter than four characters and OpenAI keys longer than 64 characters are outside the pinned detectors — publish those as `secret`; `redactSecretText`, `redactNoticeDocument`, `containsSecretText`, `noticeRedactionPlaceholder`, `resolveNoticeDisclosure`, `AGENT_NOTICE_ROUTE_SHAPES` from `@agent-bundle/runtime/notices`). `notices.retention: { terminalTtl, maxTerminal, maxJournalBytes }` in `agent-bundle.config.ts` (validated as `AB4833`, shown by `inspect --state` and the Workbench State panel) prunes settled terminal notices on admitted events and compacts the ledger journal past its byte bound through the new `AgentNoticeLedger.retain()` / `inspect()` and the state kernel's `AgentStateStore.compact()` / `inspect()` (a `compact` journal record and `AgentStateChange` kind; a compacted SQLite store moves to kernel format 2). Built-in hosts admit `secret` on `current-response` / `next-event` and `internal` on `mcp-inbox` / `mcp-resource-updated` (adapter revisions bumped). Breaking: `AgentStateStore` implementations must add `compact()` and `inspect()`, `AgentNoticeLedger` gains `retain()` / `inspect()`, `AgentNoticeDelivery` gains `disclosure`, and `AgentStateChange` / `AgentStateJournalRecord` gain the `compact` kind. The aliased `mcp-server-runtime.d.ts` no longer imports from `@agent-bundle/runtime/notices` (`GeneratedNoticeDeliveryBinding` is spelled locally). (#437)
- 9c5bf52: Report every canonical host component kind in `agent-bundle inspect` (`--json` and human output). Each inspection plan now carries a `kinds` matrix — `agent`, `cli`, `command`, `event-route`, `hook`, `lsp`, `mcp-app`, `mcp-server`, `native-diagnostics`, `native-extension`, `rule`, `script`, `skill` — with the target's own four-state judgment and selected/omitted counts, plus a `kinds this host cannot emit:` line, so a host with no LSP, diagnostics-provider, extension, or (G5-deferred) agent surface says so in its own dated words instead of by silence. Filesystem `src/events` routes now report as the `event-route` kind judged by the host's `event:<canonical event>` row instead of folding into `hook` (a breaking change to the `kind` and `name` fields of `inspect --json` for event routes), and `claude.lspServers` entries report as `lsp` components emitted by Claude and the composite `plugin` bundle and excluded elsewhere. The `AgentComponentKind` type and `componentKindCapability` helpers are exported from `agent-bundle/api`. No diagnostic codes change (#425)
- 1daaf69: Enforce per-host component feature sets for conventional `src/commands/*.md` and `src/rules/*.mdc` documents (#100). Every frontmatter field is judged against the target's `<kind>.<feature>` capability row: a command or rule that explicitly targets a host which cannot express a field it uses fails the build (`AB4927` commands, `AB4907` rules), while an implicitly selected host still receives the document minus the field and `agent-bundle validate` reports the omission as a warning with the host's reason (`AB4928`, `AB4908`). `agent-bundle inspect` lists the same omissions as `omittedFeatures` on the selected component (`--json`) and as `<kind> <name> omits <feature>: …` lines. Cursor's pinned commands surface is frontmatter-free Markdown, so a Cursor-required command must not carry `description`, `argumentHint`, `allowedTools`, `model`, or `disableModelInvocation`; Cursor rules keep `description`, `globs`, and `alwaysApply` (#427)
- c9206d0: Replace target adapter Boolean capability records with evidence-backed supported, degraded, unavailable, and prohibited states while retaining `TargetRegistry.supports()` as a derived compatibility view.
- 12526a8: Framework mode (RFC #63), compiler side. The `skills/<name>/` directory
  convention gains a power tier and two migration nudges. Rendered skills: a
  skill directory may hold `SKILL.tsx` (or `SKILL.ts`) instead of `SKILL.md` —
  the module default-exports a component (sync or async) and exports a
  `frontmatter` record, and the build renders the element tree to Markdown
  through a dependency-free renderer covering a documented subset (`h1`–`h6`,
  `p`, lists, `strong`/`em`/`code`, `pre`, `blockquote`, `a`, `hr`, `br`,
  fragments; anything else is a named error, never a silent approximation). The
  compiled `SKILL.md` is emitted as a generated write entry into every target
  artifact. New nudges: `AB4734` when explicit `skills` configuration leaves a
  conventional `skills/<name>/SKILL.md` uncovered (config wins, the shadowed
  state is flagged), and `AB4735` when a hand-authored `SKILL.md` shadows a
  rendered `SKILL.tsx`/`SKILL.ts` in the same directory (the authored file
  wins). The `create-agent-bundle` minimal template now teaches the directory
  convention: no `skills` field in its config at all.
- d30d9ac: Hold the npm package build's `dist` JavaScript to the same self-containment rule as the host packs: `agent-bundle build` and `agent-bundle prepack` now walk every emitted `dist/**/*.js` and `*.mjs` bundle (`dist/bin/<name>.js`, its rendered-route Flight worker, the generated install bin, and the `lib` entry) as an ES module and fail with `AB6005` on any bare import specifier that is not a Node built-in — including an import kept external through the `tools` escape hatch, which previously survived in `dist` and was judged only by the prepack gate. The diagnostic names the file as `dist/<path>` and the specifier; a literal dynamic `import()` counts like a static import; `node:` and bare built-in imports, relative imports of emitted files, `import.meta`, and `createRequire` of packed files stay valid, and `.d.ts` output is not walked. A dependency that only a compiled bundle imports is therefore an `AB6005` build failure before the pack inventory runs, never an `AB7014` finding; `AB7014`'s recovery now names what still keeps a runtime dependency — a prebuilt payload module that imports it, a packed file that requires or resolves it, a packed declaration that references it, or an install script or packed file that runs it. (#588)
- 98751df: portable: fail closed on the Agent Plugins 1.0.0 normative MCP rules during ordinary builds (#307 review follow-up) — the command-form, cwd-containment, env-key-placeholder, URL-form, and header rules the pinned `mcp.schema.json` cannot express now run at plan time (`portable.mcp.{command,cwd,env,url,headers}.standard`, errors) and the Agent Plugins byte lane (`AB6035`–`AB6037`) runs over every emitted `portable/` tree in `build` and `validate --artifact`, so a standard-invalid `mcp.json` (for example `command: "bin/server"`, an escaping `cwd`, duplicate case-insensitive headers, or plain HTTP off loopback) can no longer be published, whether or not `--host-validation` is requested (the flag now only adds the `portable` host report and its `AB6038` provenance note). Containment is checked with platform-independent POSIX semantics: a `./` command or `cwd` containing backslashes or NUL is refused so a bundle built on POSIX cannot resolve outside the root on Windows. Header values are now rejected when they contain any character outside visible ASCII, space, horizontal tab, and obs-text bytes (RFC 9110 §5.5; matches Node's `validateHeaderValue`), not only CR/LF/NUL. Backward compatibility: portable bundles whose MCP servers already satisfy the standard emit byte-identical output; servers that relied on path-bearing or whitespace-bearing `command` values, escaping `cwd`, or plain-HTTP remote URLs now fail the build with a field-scoped diagnostic instead of being published.
- ae91004: Remove the vendored MCP Inspector from the Workbench. The MCP page now has a
  single playground presentation; the only surviving derived code is the
  first-party MCP App renderer (`src/mcp/app-renderer.tsx`, MIT-attributed to
  the Inspector's AppRenderer). Protocol inspection moves to the standalone
  Inspector app: the dev server gains opt-in `/api/inspector/status` and
  `/api/inspector/launch` routes that spawn `@modelcontextprotocol/inspector`
  via npx on demand and return its tokenized URL. Drops the sync-inspector
  machinery and the Mantine/react-icons/syntax-highlighter dependency surface
  (~737 kB less workbench JS).
- 9df37f8: Render `.tsx` CLI commands and scripts through the Agent renderer (#102
  stage 3). A `src/cli/<command>.tsx` route's async default Server Component
  now renders through the runtime dispatcher's public stream against a sibling
  react-server worker with four output modes: interactive TTY progress updated
  in place, exactly one final Markdown document when piped (no partial
  fallbacks), `--json` for the canonical validated final value, and `--ndjson`
  for the sequence-numbered render-event stream (a CLI/script dialect, never
  written to an MCP stdout). Diagnostics stay on stderr; machine output owns
  stdout; exit codes stay deterministic (status- or result-policy-derived,
  130/143 on signals reaching the route's `AbortSignal`). Conventional
  `src/scripts/<name>.tsx` routes ship the same way with `{ argv, signal }`
  component props — lifting the stage-1 `AB4807` gate — while plain `.ts`
  scripts and commands keep ordinary Node semantics and never enter the
  renderer. The stage-2 `AB4816` gate is retired; the route-unit test harness
  now passes rendered CLI/script routes the same props the generated
  executables do.
- 62138ef: Require provider fixtures wherever conventional providers do not run (breaking for provider-enabled projects that omitted them). Once a project's generated `.agent-bundle/routes.d.ts` augmentation declares provider keys, `runAgentRequest`'s `providers` (`AgentRequestProvidersInit`), the `renderRoute` / `invokeCli` / in-memory MCP harness `options` argument (`HarnessOptionsArguments`), and its `context.providers` (`RenderRouteContextInit`) become required, so a handler typed against `(await agent()).providers.<key>` never observes an unchecked `undefined` from a custom scope or a route-unit test; provider-free projects are unchanged. Make `agent-bundle inspect` project only the four-state contract fields of adapter-owned capability rows into component accounting, so extension fields on JavaScript or third-party adapters cannot shadow the canonical capability name or break `inspect --json`. (#409)
- aafcf83: Carry Runtime App reloads over a provider-owned channel instead of Rsbuild's
  private WebSocket protocol. The trusted client-surface endpoint now exposes
  `subscribeReload`, fed by the provider's successful, changed App environment
  compile hook; the relay proxy hosts its own one-way reload WebSocket at
  `/__agent_bundle_runtime/reload`, replays the current reload generation on
  every (re)connect, and refreshes the opaque App child only when that
  generation strictly advances. The proxy no longer dials Rsbuild's WebSocket,
  so the endpoint's `webSocketOrigin`/`webSocketPath`/`webSocketToken` fields
  and the Runtime App preview's `clientSurface.webSocketPath` field are gone,
  and no Rsbuild HMR credential is handled outside the compiler process.
- d10b60f: Add `runScript`, `scriptJson`, `scriptNdjson`, and `inspectWorkbenchSurface` to `agent-bundle/test`, and move the `cli-tool` template onto the routed CLI. `runScript` (the `script-dispatch` proof level) runs a conventional `src/scripts/*` module through its generated executable's contract: a rendered `.tsx` script through the rendered-script shell with piped Markdown, TTY, `--json`, and `--ndjson` output and the project's conventional `src/providers/*` mounted with the `script` invocation (a `process.exit` in rendered code fails the run as the executable's shell reports its render worker's exit, never ending the test process), a plain `.ts` script as a Node process of its own with the `main` envelope, `process.exit`, exit code, stdout, stderr, optional `stdin`, and the compiled `agent-bundle/meta` identity (no `AB4760` outside a compiled surface); `testManifest().scripts` (a new required member of `AgentBundleTestManifest`, so a hand-built manifest literal must now supply it) lists only the compiled scripts that ship — a nested (`AB4808`) or configuration-conflicting (`AB4809`) conventional script is never a `runScript` target — and every failure names the script route, execution form, and proof level. `inspectWorkbenchSurface` (the `workbench-surface` proof level) returns the route manifest, grouped route catalog, state declaration, lifecycle-replay fixtures, and page availability the Workbench would show for a project, without a browser or dev server, and reports `manifest-unavailable` with the compiler's error diagnostics (for example `AB4100`) for a project the compiler rejects. `ScriptRouteProps` types rendered script components. `create-agent-bundle`'s `cli-tool` template replaces the hand-written `src/cli.ts` with a routed `src/cli/greet.ts` command and a conventional `src/scripts/hello.ts`, proved by a generated projection pool at the `cli-dispatch` and `script-dispatch` levels. (#398)
- 43a39ad: Add the conventional shared layout module: `src/layout.{ts,tsx}` default-exports one component receiving `{ children, route, signal }` (`AgentLayoutProps` from `@agent-bundle/runtime`, with `AgentLayoutRoute` and `AgentLayoutRouteKind`) and wraps every rendered route — generated MCP tools, resources, and prompts, rendered `src/cli/**` commands, projected MCP commands, and rendered `src/scripts/*.tsx` — while `src/mcp/<server>/layout.{ts,tsx}` nests inside it for one generated server; event routes and App routes are never wrapped, servers pinned to `custom`, `command`, or `remote` skip their layout, and a project without a layout renders byte-identical MCP, CLI, and script output with an unchanged route-graph digest (generated worker source changes as in every release). `agent-bundle inspect --routes` lists layouts, `agent-bundle/test` (`renderRoute`, cli-dispatch, mcp-in-memory) composes the same chain the artifact bakes, and validation fails closed with `AB4830` (layout contract), `AB4831` (duplicate layout scope), and `AB4832` (orphaned server layout). Breaking for typed consumers: `AgentBundleTestManifest` gains the required `layouts` field and the test registry version is now 5. In `@agent-bundle/runtime`, `decodeAgentDocument` now treats an `Agent.Result` without a `value` as a container that adopts the value of the valued result it directly holds and merges plain-JSON object `metadata` with the container winning — a behavior change for documents that previously nested a valued result under a valueless root — so a layout shell leaves the route's result value, `structuredContent`, and content unchanged, while metadata a layout declares is projected as MCP `_meta` (#396)
- 9514cec: Move conventional authored documents under `src/`: skills now use `src/skills/`, commands use `src/commands/`, and rules use `src/rules/`. Top-level conventional documents are no longer discovered and report AB4736 unless a legacy skill is claimed by explicit `skills` configuration. Explicit skill paths remain supported anywhere, and published artifact paths are unchanged.
- 0f80f8c: Remove `capabilityRevision` and `capabilitySha256` from manifest targets,
  `CapabilityEvidence`, and `TargetAdapterMetadata`, and rename
  `TargetHookContract.capabilityRevision` to `hostContractRevision`. Hash pins
  remain for vendored external schemas, including the Agent Skills schema.
- c9cc793: Redesign the Workbench as an application explorer (#600 PR 1). The dev server gains one route invocation API — `POST /api/routes/invocations` renders any compiled route (MCP tool, resource, prompt, CLI route, script, or event route with a canonical or Claude/Codex/Cursor payload) through the production runtime and returns the render-event stream, final Agent Document, structured result, request context, providers, timings, and the MCP/CLI/host projections; `GET /api/routes/invocations[/<id>]` lists and replays this session's invocations and every completion is published as a `route.invocation` project event (diagnostics `AB8231`, `AB8232`, `AB8236`–`AB8238`). The foreground server serves the Workbench shell for its deep-link paths (`/routes/**`, `/trace`, `/problems`, `/sessions`, `/advanced`). Breaking for `agent-bundle/test`: `inspectWorkbenchSurface()` now reports the Application tree (`application`, with `workbenchLeafPath(leaf)`) and the populated Advanced sections instead of `pages`; `WorkbenchPageName` and `workbenchPageLabel` are removed. (#629)

### Patch Changes

- e647336: Add `agent-bundle uninstall <host> [--from <bundle-dir>] [--scope <scope>] [--mode local|marketplace] [--keep-data | --purge-data --confirm-purge] [--force] [--plan] [--json]`, the package-relative installer bin's `uninstall <host>`, and the emitted standalone `install.mjs --uninstall`: the receipt-owned reverse of `install`. Uninstall removes exactly the receipt's files and installer-created directories (Cursor local, including the `~/.cursor/plugins[/local]` directories the install created), the staged marketplace repository after its `HEAD` matches the recorded commit (Cursor `--mode marketplace`), or the recorded host registrations (`claude plugin uninstall --keep-data` + `claude plugin marketplace remove`, `codex plugin remove` + `codex plugin marketplace remove`, the marketplace retained while another installed plugin uses it — for Claude, including installs at another scope or in another project known only to Claude's `plugins/installed_plugins.json` registry) — and nothing else. Durable runtime state (`state/`, and the `PLUGIN_DATA` directory the receipt of a Cursor Agent Plugins copy records) is kept unless `--purge-data --confirm-purge` (`AB7008` without confirmation) with a typed per-host `data.outcome` (`kept`/`purged`/`absent`, Claude `retained-by-host`, Codex `removed-by-host`/`unavailable`); a missing receipt is `AB7009` and an owned-content, version, or `HEAD` mismatch is `AB7007` unless `--force`; foreign directories are refused regardless; `--plan` prints the exact paths and host verbs without changing anything; a rerun is a `not-installed` no-op. Install receipts move to format `agent-bundle-install-receipt/2` as the single lifecycle source of truth (mode, scope, registrations, created host directories, `updatedAt`), Claude/Codex/Cursor-marketplace installs write store receipts under `<host root>/agent-bundle/receipts/`, and format 1 receipts are read with synthesized fields and diagnosed (`AB7329`), never rejected. `agent-bundle doctor --from` reports the lifecycle stage per host (placed → registered → enabled → active, unobservable stages typed `unavailable`; `AB7330`), inventories store receipts and flags orphaned ones (`AB7328`), and explains a Cursor directory holding only preserved runtime state as `missing` (`AB7307`) instead of foreign. Host capability tables gain dated `lifecycle` rows and every adapter revision advances (#452)
- 8b94bab: Harden `agent-bundle uninstall cursor` and the emitted `install.mjs --uninstall` around the Cursor `PLUGIN_DATA` directory: a symlinked `~/.cursor/agent-bundle` or `agent-bundle/plugin-data` ancestor is refused (`AB7007`) before the recorded directory is read or purged; a default rerun over a `--keep-data` remnant whose preserved `state/` or `PLUGIN_DATA` has since been removed or emptied by hand (an empty directory is pruned, never kept as data) now consumes the remnant (receipt, empty plugin root, recorded host and `plugin-data` directories) instead of staying a `not-installed` no-op forever; and `agent-bundle doctor` names the `PLUGIN_DATA` directory in `AB7307` only when it is this home's real, non-empty directory, reporting a remnant whose preserved state is gone as exhausted instead of inventing `state/`. Follow-up to the review threads on #452. (#519)
- 4155831: Serve task-augmented MCP tool calls (the MCP `2025-11-25` Tasks utility) from generated route servers: a tool route that declares `config.execution.taskSupport: 'optional' | 'required'` (validated as `AB4836`, advertised in `tools/list`) answers a `tools/call` carrying `params.task` with a `CreateTaskResult` while the render continues behind the task; `tasks/get` reports status and the last render progress, `tasks/result` returns the same `CallToolResult` an ordinary call produces, `tasks/cancel` interrupts the render, and `tasks/list` lists the session's tasks. Clients that never ask for a task see no change; a server whose tools never opted in advertises no `tasks` capability. The Workbench MCP page runs a tool as a task, polls it, fetches its result, and cancels it; `agent-bundle/test`'s `openInMemoryMcpServer` client drives the same lifecycle. The host capability tables gain an `mcp.tasks` row recording whether each pinned host issues task-augmented calls. `@agent-bundle/runtime`'s operation-based `createRscMcpServer` is unchanged — no `tasks` capability, ordinary processing — and its README now records that instead of the lifted deferral (#550)
- 926b035: Alias `agent-bundle/meta` automatically in `agentBundleRstest()` and `agentBundleBrowserRstest()` (`agent-bundle/rstest`), so a source module that imports `{ name, version, packageName, packageVersion }` loads under unit, route-unit, `renderRoute`, and `invokeCli` tests with the identity `package.json` and `agent-bundle.config.ts` declare — the same values a build stamps — instead of failing at import. Throw the new `AB4760` diagnostic from the published `agent-bundle/meta` module when it is reached outside every compiled surface and outside those presets; its `code` and `recovery` name the fix (run the pool through the preset, or alias the specifier in a custom runner). (#416)
- 7afb328: Emit the routed CLI (`src/cli/**`) into every host artifact as
  `<target>/bin/<plugin-name>.mjs` (plus `bin/<plugin-name>-flight.mjs` when a
  command renders), not only into the npm package build, so installed skills,
  hooks, and script routes can run it with `node <plugin-root>/bin/<plugin-name>.mjs`.
  Every built-in target publishes the new `cli` adapter capability that admits
  the bin; `inspect` accounts for it as a `cli` component, `inspect --bundler`
  and the artifact manifest list it, and artifact validation admits the `cliBin`
  layout. A target without the capability omits the bin with `AB4765`; a
  host-emitted file colliding with the bin path fails the build with `AB4766`.
  Script routes reach the bin as their `../bin/<plugin-name>.mjs` sibling;
  skills and hooks reach it through the plugin-root token. The package build's
  `dist/bin/<plugin-name>.js` is unchanged. (#419)
- 681fd8d: Reference an MCP App from static route `config` instead of repeating its `ui://` literal: import `appResourceUri('<app>')` from the new `agent-bundle/routes` subpath and the route-graph compiler resolves it to the App route's `config.resourceUri` (`AB4826` for an unknown App or one on another server, `AB4828` when the App is not built for every target the server ships to), or use a `const` string-literal identifier declared in the route module or `export const`-ed by a relative sibling module; `AB4806` now names both supported forms, and `ToolConfig`/`ResourceConfig`/`PromptConfig`/`AppRouteConfig` type `_meta.ui.resourceUri` through `RouteMeta`/`RouteUiMeta`. Resolve an App route's `config.template` relative to the route module like its imports, keep accepting the project-root-relative form while unambiguous, and report `AB4827` with both candidate paths when they conflict or neither exists (#418)
- 1c82c31: Keep a conventional `src/scripts/<name>.ts` module in script discovery when a `bin` config entry also references it, so `agent-bundle build` emits both `dist/bin/<name>.js` and the artifact `scripts/<name>.mjs` and `agent-bundle inspect --json` lists the module under both `packageBuild.bins` and `scripts` instead of silently dropping the script. Explicit `scripts`, `hooks`, `lib`, and `mcp` entries still claim the module they reference. Report `AB4737` when a `bin` entry points at a rendered `src/scripts/<name>.tsx` script that does not export both its default Server Component and a named `main`, because the bin envelope calls `main` while the artifact script renders the component, and `AB4738` when it points at a plain `src/scripts/<name>.ts` script that exports a `default` but no `main`, because the artifact script would ship inert while the bin runs the default export. (#413)
- 2841419: Make `request.lineage` the only identity-adjacent surface — parent conversation, root, and the parent-of-subagent chain — and stop reading operator identity anywhere: the Cursor `workspaceOpen` event-route validator no longer inspects `user_email` (the field passes through inside `native` untouched), and `actor` is documented as the HTTP-authenticated MCP client only. Bind a never-seen Cursor conversation to a pending `subagentStart` only when exactly one is pending in the same `workspace_roots`, and undo a blind binding (re-rooting anything started beneath it) when that conversation later carries a root-only event such as `beforeSubmitPrompt`, so a chat tab whose prompt predates the registry resolves as a root instead of another conversation's subagent. (#444)
- 826dea2: Add `--replace` (alias `--force`) to `agent-bundle install <host>`, the package-relative installer bin, and the emitted standalone `install.mjs`, and replace a same-version stale copy automatically: an agent-bundle install of the same plugin whose version matches but whose content hash differs is replaced without a flag, identical reruns stay an `already-installed` no-op, and rebuilding without a version bump no longer needs a manual uninstall + `rm -rf`. Cursor copies now carry an install receipt (`.agent-bundle-install.json`: plugin, version, host, content hash, owned files); replacement is in place, touches owned files only, refuses to overwrite unowned entries such as `state/`, and `--replace` adopts a pre-receipt copy (`adopted`). Claude replacement runs `claude plugin uninstall --keep-data` before reinstalling because `plugin update` is version-gated; Codex runs `codex plugin remove` before `add`; both fail `--replace` closed when `plugin list --json` is unusable. Foreign directories are still refused (`AB7005`) with an installed-versus-artifact content-hash comparison. `agent-bundle doctor --from` reports the installed copy per host as `current`, `stale` (`AB7308`), `version-mismatch` (`AB7309`), `foreign` (new `AB7321`), or `not-installed` (`AB7307`), and emitted `INSTALL.md` documents the same-version reinstall recipe per host (#420)
- c8504ba: Stop requiring hand-enumerated MCP App fixtures in `runPackedContractMatrix`, `runInstalledHostContractMatrix`, and `runDevEpochContractMatrix`: app routes are auto-covered at those levels with the new `apps: 'auto'` default (`coverage` passes with a reason naming the `ui://` resource sweep; `apps: 'explicit'` restores the fixture requirement), declare a resource or app fixture as `{ kind: 'resource' }` (`ContractResourceFixture`; legacy `{}` still accepted), keep apps `not-applicable` at `mcp-in-memory`, and report the `cancellation` check as `not-applicable` ("invocation completed before abort; use an input that stays in flight") instead of a `contract-violation` when the aborted call settled before `abortAfterMs` elapsed. The `agent-bundle/test` docs now state per level whether apps are covered. No diagnostic codes change. (#417)
- 42539ff: Take Claude Code's own word for a subagent's parent: the parent's `Agent` `PostToolUse` carries the spawn `tool_use_id` and `tool_response.agentId`, the child's `agent_id`, so the lineage registry behind `request.lineage` now confirms the edge it matched from spawn-call ordering, fills in `subagent.toolCallId` for siblings it had claimed blind, places a `SubagentStart` no spawn window could (none open, or two parents with one — the start's id, type, time, stop, and any confirmations it issued for its own children are kept meanwhile, so a missed spawn hook at one level does not lose the subtree beneath it), moves a child it had filed under the wrong parent and re-bases that child's descendants, and holds a child the host names before its start arrives. Add `'confirmed'` to `AgentLineageResolution` (`@agent-bundle/runtime`, `RequestLineageProvenance` in `agent-bundle`): a subagent's `parent`/`root`/`depth` resolve `confirmed` once every edge up to the root is host-named — right after `SubagentStart` for a background spawn, after `SubagentStop` for a foreground one — and stay `registry` otherwise. The Claude capability table's `lineage.parent`/`lineage.depth` rows record the confirmation and its timing, and the generated hosts page gains a "Conversation lineage" section rendered from every host's `lineage` rows. (#422)
- 10e217e: Resolve `request.lineage` for concurrent Cursor MCP calls by their arguments. Cursor's `tools/call` `_meta` names no conversation, so a generated MCP server correlated a call only through the open `MCP:<tool>` pre-tool hook and reported `id-not-resolvable` whenever several conversations had the same tool open. The pre-tool hook's `tool_input` is the call's arguments verbatim, so the lineage registry now records their digest on each open window (`inputDigest`) and the generated server passes the call's raw wire arguments (captured before schema parsing, so input defaults never make two calls look alike) to `resolveToolCall`; a concurrent call with different arguments resolves (`resolution: inferred`, provenance `derived`), identical arguments still refuse, a window recorded without a digest stays in contention, and a single open conversation is unaffected. (#483)
- b351f4a: Expand Agent Plugins placeholders for Cursor at install time. The `install.mjs` emitted with a `portable` bundle now rewrites `mcp.json` in the `~/.cursor/plugins/local/<name>` copy — `${PLUGIN_ROOT}` to the absolute plugin root, `${PLUGIN_DATA}` to `~/.cursor/agent-bundle/plugin-data/<name>` (created), an omitted `cwd` to the plugin root, plugin-relative `./` commands to absolute paths, and `PLUGIN_ROOT`/`PLUGIN_DATA` into every stdio server's `env` — because Cursor 3.18.25 performs none of that resolution and every spec-shaped stdio server failed to spawn there. The bundle itself is untouched, the pre-expansion document is recorded in the install receipt (`cursorExpansion`), reruns stay idempotent and older unexpanded copies are replaced on the next run. `agent-bundle doctor --host cursor` validates the Agent Plugins contract (`AB7320`) against the recorded document and adds `AB7326` (`expanded` / `unexpanded` / `drifted`) for the launch proof; `cursor`-target bundles are never rewritten. (#482)
- 9bb5d0d: Refresh the `portable` (Agent Plugins 1.0.0) capability table and schema provenance with the 2026-09-03 re-verification: the Cursor 3.18.25 `${PLUGIN_ROOT}` gaps in `cwd`, `args`, and the default working directory reproduce on the current build, and the `mcp` evidence now also records that `env` values are not expanded, the reserved `PLUGIN_ROOT`/`PLUGIN_DATA` variables are not provided, and plugin-relative `./` commands resolve against the workspace; the pinned 1.0.0 schemas were rehashed against the live specification site with no published 1.1.0 release, so the pin and `adapterRevision` are unchanged and the `AB6038` provenance info emitted by `validate` for portable artifacts now reads "re-verified 2026-09-03" (#443).
- fbc183b: Stop the native Claude contract smoke (`runNativeClaudeSmoke`, the `native-host-smoke` Claude source leg) from reporting `claude-native.normal-home.changed` → `harness-failure` on every signed-in turn against Claude Code 2.1.257+. The normal-home guard digested the sibling `.claude.json` whole, and the host rewrites that file's bookkeeping (cached feature flags, first-start and machine identity, notification and usage counters, per-project session statistics) on every start, even under `--no-session-persistence`. The guard now digests `config.json`, `settings.json`, `settings.local.json`, and `plugins/` as before, plus only the user-scope `mcpServers` registrations of `.claude.json` — a first start creating the file, or any bookkeeping rewrite, passes with `normalHome: 'unchanged'`, while adding, changing, or removing a registration or corrupting the file still fails. Fixes #439 (#529)
- 9f61247: Let a rendered Skill (`src/skills/<name>/SKILL.tsx`) import `agent-bundle/meta` and evaluate independently of the process's `react` resolution. The skill loader now aliases `agent-bundle/meta` to the same generated identity module the compiler stamps into every built surface — `{ name, packageName, packageVersion, version }` derived from `plugin.name`, `package.json`, and the resolved plugin version — under `validate`, `build`, `inspect`, dev, the Workbench's source Skill documents, and `inspectWorkbenchSurface`, instead of failing with `AB3003` wrapping `AB4760`. The skill's JSX compiles against the loader's own element factory rather than the project's `react/jsx-runtime`, so `inspectWorkbenchSurface` no longer fails with `AB3005` (`recentlyCreatedOwnerStacks`) on a project with a rendered skill when the test runs under the `react-server` condition the `agentBundleRstest()` route-unit pool sets. Fixes #440 and #441 (#527)
- e54522d: Accept a re-exported default component in the route contract check (`AB4810`): `agent-bundle validate`, `inspect`, and `build` now follow `export { default } from '../shared.tsx'` and `export { Page as default } from` through relative modules (including `.js` specifiers for `.ts`/`.tsx` sources and re-export chains) and judge the default export in the module that declares it, so one tool can be placed on two generated MCP servers with a second route module that carries only its own `config` and re-exports the component and schemas from the first. A sync component behind the re-export is still `AB4810`, and the message now names the re-exported module; a default re-exported from a package the check cannot read is accepted and verified when the route loads. The same resolution applies to the layout (`AB4830`), provider (`AB4940`), event-route, routed-CLI, and bin-shared rendered-script (`AB4737`) contract checks. Fixes #446 (#524)
- adb25b4: Project an `Agent.Progress` node streamed in a `Suspense` fallback (any `shell`/`replace` document) to `notifications/progress` when the MCP request carries `_meta.progressToken`, under the same monotonic `progress` rule as `progress.report()` so a re-streamed fallback or an explicit report of the same step is never duplicated; the rendered CLI's interactive TTY draws its in-place progress line from the same streamed node. A fallback alone is now enough on both surfaces; `announce()`-style shims that repeat the fallback message through `progress.report()` are unnecessary. Fixes #448. (#498)
- 43d787f: Let a rendered route declare its own render budget: `config.render: { maxElapsedMs }` on `ToolConfig`, `ResourceConfig`, `PromptConfig`, and `CliRouteConfig` raises (or lowers) the 60-second `maxElapsedMs` of that route's render session, validated at build time as a positive integer of milliseconds up to `MAX_ROUTE_RENDER_ELAPSED_MS` (24 hours, exported from `agent-bundle`) — `AB4835` otherwise, including on a plain `.ts` command, which has no render session. The generated MCP server applies it per `tools/call`, `resources/read`, and `prompts/get` while still forwarding every progress report as `notifications/progress`; the compiled command carries it into the generated CLI executable (`CompiledCliCommand.render`, inherited by `routes.mcpCommands` projections); `renderRoute` and `openInMemoryMcpServer` apply it over the `limits` a test passes as the dispatcher's base. `AgentRenderDispatch.limits` layers per-dispatch limits over `createAgentRenderDispatcher`'s. Defaults are unchanged. Fixes #454. (#526)
- a2d1795: Address a notice to one agent conversation or to a whole conversation tree: `AgentRecipient` gains `conversation` (matches `request.lineage.conversation` exactly) and `root` (matches every request whose `request.lineage.root` is that id), matched in conjunction with the existing `actor` / `host` / `session` / `workspace` axes at admission, inbox reads, `resources/updated` eligibility, and acknowledgement. `AgentNoticePrincipal` gains an optional `lineage`, which every generated surface (event routes, MCP tools, routed CLI, rendered scripts) now mounts; a principal built without it, or with unresolved lineage, never matches a lineage-addressed recipient and otherwise behaves exactly as before. The ledger journals only `{ conversation, root }` of the admitting lineage as an additive optional field — no state-definition version bump, journals written before the axes replay unchanged. `notices.publish()` rejects blank `conversation` / `root` with `invalid-input`. `examples/worktree-proximity` addresses its proximity notices to the other actor's conversation instead of its worktree. (#458)
- 017961f: Hand conventional `src/providers/<name>` factories the request they run for: `AgentProviderContext` (`agent-bundle`) gains `host`, `session`, `workspace`, and `lineage` beside `plugin` — the same observed axes the route reads on `await agent()`, provenance and the lineage's live `tree` included — plus read-only `state` (`lifetime`, `read()`) and `notices` (`inbox()`, `published()`) views of the mounted handles; `dispatch`, `publish`, and `acknowledge` stay route-only, and `agent()`/`useAgent()` inside a factory throw `outside-invocation`. New exported types `AgentProviderObserved`, `AgentProviderHostIdentity`, `AgentProviderSessionIdentity`, `AgentProviderWorkspaceIdentity`, `AgentProviderLineage`, `AgentProviderLineageTree`, `AgentProviderLineagePeer`, `AgentProviderLineageSubagent`, `AgentProviderLineageResolution`, `AgentProviderStateHandle`, `AgentProviderStateSnapshot`, `AgentProviderNoticesHandle`, `AgentProviderNotice`, `AgentProviderNoticeState`, `AgentProviderNoticeRecipient`, `AgentProviderNoticePublisher`, `AgentProviderNoticeAttempt`, `AgentProviderNoticeWithholding`; `AgentProviderObservedPluginRoot` is now `AgentProviderObserved<AgentProviderPluginRoot>`. Every generated request scope (Flight worker, rendered CLI/script worker, plain routed CLI) and the `agent-bundle/test` harness now run providers as the request's own resolver — after `runAgentRequest` freezes the identity axes and opens the notice lease, before the route. `@agent-bundle/runtime`: `runAgentRequest` accepts `providers` as an `AgentProviderResolver` `(request: AgentProviderRequest) => values` beside the plain record; new exported types `AgentProviderRequest`, `AgentProviderResolver`, `AgentProviderStateHandle`, `AgentProviderNoticesHandle`. Existing factories that destructure `{ invocation, plugin, signal }` are unchanged. (#459)
- e0ae9f0: Report routed-CLI input-validation failures in CLI terms instead of raw zod issue JSON, and route the first-party `agent-bundle` CLI's terminal I/O through Effect's `Terminal`/`Stdio` services. A generated executable (`dist/bin/<name>.js`, the artifact `bin/<name>.mjs`, and the `invokeCli` test harness) whose route `inputSchema` rejects the parsed argv now prints one line per issue — `Invalid value for --max-wait-ms: expected number <= 55000; received 300000.` naming the flag, `<positional>`, or projected-MCP `--input.<path>` — followed by the exact `Usage:` line and the `--help` hint on stderr, still exit 2; under `--json` stdout stays empty and stderr carries one canonical `{"error":{"code":"CLI_INPUT_INVALID","issues":[...],"usage":"..."}}` line, and `--ndjson` emits one `type: "error"` event. `CliInputError` from `agent-bundle/cli-entry` gains a typed `issues` list and a `cliInputError(command, input, error)` constructor. The `agent-bundle` CLI (`build`, `prepack`, `install`, `doctor`, `validate`, `eval`, `inspect`, `dev`, `mcp run`, help and version) writes user-facing text through `Terminal.display` and diagnostics/`--json` output through `Stdio`, provided once at the CLI root from `@effect/platform-node-shared` (`NodeTerminal`/`NodeStdio`, the package `agent-bundle` already depends on); `runCli` takes `{ services }` in place of the former stream injection. `create-agent-bundle --help` and its flag-error text go through the same services at its existing `NodeServices` root (Clack still renders the prompts). Protocol stdout (MCP stdio, hook results, emitted routed-CLI and installer shells) is unchanged. Fixes #465 (#505)
- 5d5c9c9: Expose the resolved plugin root on the request context: `(await agent()).plugin` is an observed `{ root, stateRoot }` — `source: 'native'` from an expanded `AGENT_BUNDLE_PLUGIN_ROOT`, `'derived'` from the shell's fallback (the artifact root, or `$PWD/.agent-bundle` for the npm bin) — and conventional providers receive the same value as `plugin` beside `invocation` and `signal` (`AgentProviderContext.plugin`). Every generated shell (MCP entry and Flight worker, routed CLI executable and render worker, hook wrappers) now resolves the anchor once through the new `resolvePluginRoot` export of `@agent-bundle/runtime` and mounts its SQLite state, notice ledger, and lineage journal on that one `stateRoot`, so `plugin.stateRoot` is the directory they use by construction; an unexpanded `${…}` token is treated as unset and reported once on stderr instead of being joined into a path. `renderRoute`, `invokeCli`, `runScript`, and `openInMemoryMcpServer` publish the axis the same way and accept `context.plugin`; `createGeneratedRouteMcpServer` takes `pluginRoot`. `AGENT_REQUEST_STORE_VERSION` is 4. Fixes #468. (#532)
- d88cc10: Make the operator `.env` layer of an installed pack follow the documented `manifest env < .env < .env.local < process.env` order and reach plugin code before it evaluates. A host merges a stdio server's manifest `env` block into the child environment, so the emitted MCP entry now carries that block as build-time literals and `applyOperatorEnv` (new `manifestEnv` option on `agent-bundle/launch-env`) treats a variable still holding its manifest default as unset — the file overrides it, while an exported variable still wins; an operator export equal to the default reads as the default, and a value carrying a path token (`AGENT_BUNDLE_PLUGIN_ROOT`) is always kept. The layer is now the first import of every emitted stdio entry, hook wrapper, and artifact CLI `bin/<name>.mjs` rather than a statement after the consumer imports, so a `process.env` read at the top level of a server, handler, route, provider, or state module sees the composed environment; the build marks generated modules side-effectful so a consumer `"sideEffects": false` cannot drop the import. In the emitted stdio entry that first import is a prelude that also installs the console guard, so stdout written at module scope by server modules — `console.log` or `process.stdout.write` — is redirected to stderr before the protocol stream opens, and `redirectConsoleToStderr` from `agent-bundle/mcp-entry` now returns the guard already installed instead of stacking a second one; a wrapper a server module installs over `process.stdout.write` at module scope is discarded when the protocol stream opens, with one stderr warning naming it. `AGENT_BUNDLE_ENV_FILE=none` still disables the layer entirely. Host manifests are unchanged. (#554)
- c2ffe5e: Give installed packs the operator `.env` layer that only `agent-bundle mcp run` had: every emitted stdio MCP entry with a factory default export (a self-connecting entry keeps its byte-identical body; `agent-bundle/launch-env` is aliased into every stdio entry, so such an entry imports and applies `applyOperatorEnv` itself if it wants the layer), every hook wrapper that runs plugin code, and the artifact CLI `bin/<name>.mjs` read `<plugin root>/.env` then `.env.local` at launch (the plugin root is the expanded `AGENT_BUNDLE_PLUGIN_ROOT`, else the shell's parent directory), filling only variables the host did not set — host environment and manifest `env` win, `.env.local` beats `.env`, values are never logged, a missing file costs nothing, an unreadable one is skipped. `AGENT_BUNDLE_ENV_FILE` names the file(s) to read instead (platform path delimiter; `none` disables the layer), and `mcp run` hands `--env-file` / `--no-env` down through it so a rehearsal and an installed pack read the same files. The loader is the new plain-Node `agent-bundle/launch-env` module (`applyOperatorEnv`, `parseOperatorEnv`), inlined into the shells without Effect. `agent-bundle doctor` reports whether an installed copy carries `.env` / `.env.local` and how many variables each declares (`AB7331`, informational; a warning when the file cannot be read), never a name or a value. The npm package bin reads no pack file. Fixes #469. (#538)
- ec65738: Run the Claude Code host validator where it was missing and turn it into a load verdict. `agent-bundle build` now runs the same Claude Code checks as `validate --artifact` over every built `claude` and `plugin` target (`--host-validation` on by default, `--no-host-validation` to skip, `--strict` to promote host warnings to errors), and both commands follow the two `claude plugin validate --strict` runs with a `claude --plugin-dir <dir> plugin list --json` load check: a row with `errors` is reported as `AB7325` (a warning when the only errors are uninstalled declared dependencies), no row as `AB7311`, an unreadable listing as `AB6022`; the report carries `load.status` (`loaded`, `refused`, `unregistered`, `failed`). Without `claude` on `PATH`, `build` spawns once and reports a single informational `AB6019`. `agent-bundle doctor --host claude --from <dir>` runs the validator over the bundle and every installed copy (findings keep `AB6019`–`AB6022`, prefixed with the copy they came from) and reads each row's `enabled` flag: an installed-but-disabled copy is reported as `disabled` with the new `AB7327` warning naming the `claude plugin enable` command. The native Claude proofs now validate in plugin mode through the shared runner and record the documented symlink warning. (#504)
- 853c31a: Re-pin the Claude Code `hooks.schema.json` to the documented hook handler contract so a `claude.nativeHooks` document may use every handler type (`command`, `http`, `mcp_tool`, `prompt`, `agent`), the per-type fields (`args`, `async`, `asyncRewake`, `shell`, `url`, `headers`, `allowedEnvVars`, `server`, `tool`, `input`, `prompt`, `model`, `continueOnBlock`), the common `if`, `once`, `statusMessage`, and `timeout` fields, and every documented event the pinned Claude Code 2.1.250 host knows (`PreModelSwitch` and `PostModelSwitch` require 2.1.251 and wait for the re-pin), each closed to the handler types the reference allows for it; the compiler still emits shell-form `command` handlers only. Update the `claude` host's agents capability rows with `color`, `initialPrompt`, and `experimental.cacheTtl`, record that `permissionMode`, `mcpServers`, and `hooks` are ignored for plugin subagents, pin the anchored `^<plugin>:<agent>$` `agent_type` matcher note, and bump the Claude `adapterRevision` to `1.26.0`. (#496)
- d11213a: Export `mountTestState()` and `withTestState()` from `agent-bundle/test`: mount the project's state definition and notice ledger once — a disposable sqlite root for `workspace-durable`, the memory driver otherwise, or `options.driver` — and spread `context()` into any number of `renderRoute` / `renderRouteEvents` calls for a multi-render journey, with `read()` and `notices()` snapshots and one `close()`. `options.definition` mounts an explicit definition instead; a manifest without state or an `external` definition without a driver fails closed (`manifest-unavailable`, `invalid-input`). The worktree-proximity, host-test, and audiobook-curator examples drop their hand-rolled `@agent-bundle/runtime/mount` and `/state` mounts for it. Fixes #484. (#525)
- 6c2f8da: Export the `dev.runtime.provider` protocol from `agent-bundle/api`, next to `DevRuntimeProvider`: the start-context and session types (`DevRuntimeStartContext`, `DevRuntimeSession`, `DevRuntimePreparedProject`, `DevRuntimePreparedMcpServer`, `DevRuntimePreparedMcpApp`, `DevRuntimeEventInput`, `DevRuntimeClientSurfaceEndpoint`, `DevRuntimeMcpRegistry`, `DevRuntimeMcpSession`, `DevRuntimeMcpSessionView`, `DevRuntimeMcpSessionCloseObservation`, `DevRuntimeMcpSessionExecuteOptions`, `DevRuntimeMcpRegistryListener`, `DevRuntimeMcpRegistryMessage`, `DevRuntimeMcpRegistrySubscription`), the wire protocol (`DevRuntimeInspectionEnvelope`, `DevRuntimeMcpServerDescriptor`, `DevRuntimeRun`, `DevRuntimeStatus`, `DevRuntimeSurface`, `DevRuntimeDescriptor`, `DevRuntimeDiagnostic`, `DevRuntimeDiagnosticPhase`, `DevRuntimeFixture`, `DevRuntimeTraceSpan`, `DevRuntimeTreeNode`, `DevRuntimeAsset`, `DevRuntimeAssetRequest`, `DevRuntimeInvocationRequest`, `DevRuntimeReplayRequest`, `DevRuntimeStateIdentity`, `DevRuntimeStateResetRequest`, `DevRuntimeMcpAppRunBinding`, `DevRuntimeMcpConnectionState`, `DevRuntimeMcpInvalidatedBinding`, `DevRuntimeMcpOperationRequest`, `DevRuntimeMcpOperationResult`, `DevRuntimeMcpRegistryReconcileInput`, `DevRuntimeMcpRegistryReconcileResult`, `DevRuntimeMcpRegistryReplayGap`, `DevRuntimeMcpRegistrySnapshot`, `DevRuntimeMcpSessionBinding`, `DevRuntimeMcpSessionControlRequest`, `DevRuntimeMcpSessionRequest`, `DevRuntimeMcpSessionSnapshot`, `RuntimeVector`), the errors a provider throws (`DevRuntimeUnavailableError` AB8201, `DevRuntimeGenerationConflictError` AB8204), and the generation store and MCP registry a session drives as effect-free contracts with constructors — `DevRuntimeGenerationStore` / `createRuntimeGenerationStore`, `DevRuntimeProviderMcpRegistry` / `createRuntimeMcpRegistry` — plus their option, candidate, lease, manifest, and error-code types (`RuntimeGenerationStoreOptions`, `RuntimeGenerationCandidate`, `RuntimeGenerationLease`, `RuntimeGenerationManifest`, `RuntimeGenerationStoreErrorCode`, `RuntimeMcpRegistryOptions`, `RuntimeMcpConnector`, `RuntimeMcpExecutionContext`, `RuntimeMcpRegistryErrorCode`, …). A provider can now be written out of tree against `agent-bundle/api` alone; `examples/rsc-agent-runtime/src` no longer reaches into the package source. Fixes #485. (#528)
- 0554f01: Export the typed config hook handler contract from `agent-bundle` and `agent-bundle/config`: `HookHandler<E>`, `HookEvent<E>`, and `HookResult<E>` for every `HookHandlerEventName` (`sessionStart`, `beforeTool`, `afterTool`, `stop`, `agentStart`, `agentStop` — the canonical events every host maps to a plain hook; `CanonicalHookEvent`, `AgentBundleHookEntry`, and `AgentBundleHookInput` are exported too), the per-event payloads (`SessionStartHookEvent`, `BeforeToolHookEvent`, `AfterToolHookEvent`, `StopHookEvent`, `AgentStartHookEvent`, `AgentStopHookEvent`, `HookEventBase`, `HookEventPayloads`), the second handler argument `HookHandlerContext`, and the tables the types derive from (`hookHandlerEventNames`, `hookResultContract`, `hookEventFields`). `export default ((event) => ({ … })) satisfies HookHandler<'sessionStart'>` makes an illegal result — a denying `sessionStart`, `reason` beside `continue`, `updatedInput` on `stop` — a `tsc` error. The types are the portable contract (accepted by every host's wrapper and delivered in its native output), so host-only fields such as `beforeTool` `additionalContext` stay untyped; the generated wrappers' runtime validation is unchanged and a test holds the types to exactly what every host wrapper accepts. Fixes #488. (#533)
- 5c00b3e: Export `loadRouteModule(id)` from `agent-bundle/test`: the evaluated module behind one compiled route id, through the same registered loader `renderRoute` uses, so `inputSchema`, `resultSchema`, `config`, and `default` are the route's own exports by reference and a schema-identity suite can iterate `testManifest().routes` instead of maintaining static route imports. A literal id is checked against the registered route ids and the schemas' parsed values are typed from the registration; outside an `agentBundleRstest()` pool or against a foreign manifest it fails closed with `manifest-unavailable`. Fixes #493. (#499)
- 9551498: Expose the process's terminal capability to routes and scripts as `(await agent()).terminal`, so a plugin that paints its own stderr or sizes its own output no longer probes `process.stdout.isTTY`, `columns`, or `FORCE_COLOR` itself. The new `Observed<AgentTerminal>` axis reports `hostSurface` (`cli`, `mcp`, `hook`, `script`, `workbench`), a `stdout` and `stderr` stream each with `kind` (`tty`, `pipe`, `none`), `color` (`none`, `basic`, `256`, `truecolor`), and `columns`/`rows` when known, plus `sharesTarget` (fd 1 and fd 2 name one file). Routed CLI executables (plain, rendered, and projected MCP commands) and rendered scripts probe their process once — honouring `FORCE_COLOR`, `CLICOLOR_FORCE`, `NO_COLOR`, `CLICOLOR=0`, `TERM=dumb`, `COLORTERM`/`TERM` depth, and `COLUMNS`/`LINES` overrides — and select their `tty` or piped output mode from that same value; generated MCP servers, event routes, and Workbench replays report `none` on both streams and never guess. The executable envelope passes the same value to plain `main` scripts and bins as `main(argv, { terminal })` (`ExecutableMainContext` from `agent-bundle`); a one-parameter `main` keeps working. `runGeneratedCliEntry` and `runGeneratedRenderedScript` (`agent-bundle/cli-entry`) accept `terminal` and hand it to `execute`, `render`, and `createSession`; `runRscCli` accepts `terminal` in its options and `createRscMcpServer` mounts the MCP value. In `agent-bundle/test`, the `tty` knob of `invokeCli` and `runScript` shapes a deterministic synthetic terminal, `renderRoute` and the in-memory MCP level mount what the artifact would, and `context.terminal` injects any other value. Fixes #511 (#534)
- 08a6a3d: Reject closed, uninitialized, or misused `agent-bundle dev` MCP sessions with a coded `McpSessionError` (`code` one of `session-closed`, `not-initialized`, `invalid-request-id`, `duplicate-request-id`, `invalid-server-name`, `service-closed`) instead of a bare `Error`; every message is unchanged, so existing message matches keep working. A tool call's request slot is now released — and its in-flight SDK request aborted — whenever the call is interrupted, not only when it settles. (#512)
- 178237c: Add `agent-bundle serve-app <server>/<app>` and `serveApp` in `agent-bundle/api`: serve one built MCP App standalone in a browser, bound to the plugin's own packed MCP server. The server launches exactly as `mcp run` does (same artifact resolution, `.env` layering, and plugin-data root), the App is hosted through the Workbench's MCP App host stack (sandbox proxy, consent authority, bridge) on `127.0.0.1` behind a per-launch token (`AB8003` / `AB8004` on refusal), and the App's tool is called once so it opens populated. `--tool`, `--input`, `--port`, `--profile`, `--allow <capability>`, `--open`, and the `mcp run` environment flags select the binding; `serveApp` returns `{ url, close, closed }` for scripts and tests — a plugin's own "open the dashboard" CLI route spawns `agent-bundle serve-app` instead, since the self-contained routed CLI bin cannot import `agent-bundle/api` (`AB6005`; #558). Fixes #514. (#537)
- 8951739: Report the new `AB4837` diagnostic from `inspect`, `validate`, `build`, and `dev` when a route module, layout, or provider — or a module it reaches through relative imports — value-imports a compiler-carrying framework entry (`agent-bundle`, `agent-bundle/api`, `agent-bundle/config`, `agent-bundle/eval`, `agent-bundle/rstest`, `agent-bundle/test`, `agent-bundle/test/browser`), naming the file, the specifier, and the helper, instead of failing inside the bundler with `Can't resolve '../events'`; `import type` and type-only usage are not reported (#582)
- ea58d20: Emit tuple `outputSchema`/`inputSchema` in a projection Cursor's draft-07 validator accepts (`prefixItems` + `items: anyOf` + `minItems`/`maxItems`, never `items: false`), fixing `MCP error -32602 … boolean schema is false` on tuple-bearing `tools/call` results; tool arguments are advertised through the same projection, and 2020-12 validators keep positional precision for closed tuples (a `.rest()` tuple's rest positions are loosened to the union). Host capability tables gain an `mcp.structuredContentValidation` row. (#580)
- 97a5bfa: Fix the MCP App view compiler path. `@rsbuild/plugin-react` is registered on every App view, so a `.ts` entry importing `.tsx` components compiles JSX with the automatic runtime instead of leaving a free `React.createElement` in the view, and the reserved `agent-bundle/meta` specifier is rewritten to the generated identity module before resolution, so a `tsconfig.json` `paths` entry can no longer shadow it (other `paths` entries keep resolving inside views). Compile failures now report one `AB4770` per Rspack error carrying the project-relative file, `line:column`, and the bundler's message (warnings not on the documented ignore list are `AB4771`) in place of the `AB5000` catch-all and the Workbench's `AB7100 "Unable to compile the build: Rspack build failed."`; the Overview Diagnostics table shows the same rows with the failing file as their source, and the last good epoch stays active. `agent-bundle build` prints one `MCP App <name> (<target>): mcp-apps/<name>.html <size> (<gzip> gzip)` line per view after `Built …` and carries the measured sizes in `--json` as `build.compiledMcpApps[].size`; `AB4772` warns when a production view reaches 1 MiB or any view exceeds the 2 MiB bound the Workbench and `serve-app` hosts accept, naming the largest modules — the author's own concatenated ESM modules included. `agent-bundle/api` exports the stats formatters `rspackStatsErrors`, `describeRspackStatsError`, and `formatRspackStatsError` so tools driving their own Rsbuild compile render errors the same way. Template-less Apps ship `<html lang="en">`, a `<title>` equal to the App name, and the `#root` mount point (a template that sets its own is left alone). `agent-bundle dev` compiles views unminified — still one self-contained HTML per App, falling back to the production profile when the readable document would not render in the hosts — and `AB7100`–`AB7102` are documented. Resolves the MCP Apps compiler-path and dev-loop findings of #572. (#585)
- fb56fa0: Let the documented contributor HMR loop complete a Workbench session: `agent-bundle dev --workbench-dev-origin <origin>` (repeatable; `startDevServer({ workbenchDevOrigins })`) makes the foreground server accept session bootstrap, mutation, and project-event requests whose `Origin` is that explicitly listed loopback Rsbuild dev-server origin instead of answering `AB8003`, and `GET /api/project/session` reports the list as `devOrigins` so the Workbench UI served from that origin accepts the session. Values that are not loopback `http(s)` origins are refused before the server starts (`startDevServer` rejects with `AB8000`); without the flag the same-origin guard is unchanged, and the proxy never rewrites `Origin`. (#572)
- 1fb100f: Make the dev runtime client-surface proxy's upstream request timeout configurable: `RuntimeClientSurfaceProxy.open` accepts a trailing `RuntimeClientSurfaceProxyOptions` with `upstreamRequestTimeoutMs` (default `defaultRuntimeClientSurfaceUpstreamRequestTimeoutMs`, 15 000 ms; a value that is not a positive safe integer within the `setTimeout` ceiling is rejected before the proxy opens). The dev server keeps the 15 s default (#584)
- cfdaeca: Document every emitted diagnostic code explicitly in `docs/diagnostics.md` (the `reference/diagnostics` page). Codes that were covered only by a family row now each have a row with severity, trigger message, and — where the diagnostic carries one — recovery, read from the emitting site: `AB3000`–`AB3006`, `AB3008`–`AB3010`, `AB4000`, `AB4002`–`AB4007`, `AB4012`, `AB4100`–`AB4102`, `AB4200`–`AB4212` (including the previously undocumented `AB4204`), `AB4300`–`AB4339`, `AB4400`–`AB4408`, `AB4600`–`AB4602`, `AB4700`–`AB4716`, `AB6000`–`AB6001`, `AB6002`–`AB6003` (reserved, never emitted), `AB6004`–`AB6018` (`AB6005` restates #588), `AB6023`–`AB6025`, `AB6200`–`AB6202`, `AB7000`–`AB7004`, `AB7103`, `AB8000`–`AB8023` (including `AB8003` and `AB8004`), `AB8030`–`AB8034`, `AB8040`–`AB8057`, `AB8060`–`AB8068`, `AB8070`–`AB8083`, `AB8085`–`AB8088`, `AB8090`–`AB8093`, `AB8120`–`AB8123`, `AB9001`–`AB9005`, and `AB9007`–`AB9011`. The `AB4834` row is rewritten to three cells so the table renders. `pnpm docs:site:build` now fails when a code cited in the docs or a code literal in `packages/agent-bundle/src` has no explicit row (`website/scripts/check-diagnostics-coverage.mjs`). (#599)
- c9546b4: Resolve `inputSchema` (and `config` string consts, `AB4806`) declared in another module: `export const inputSchema = statusInputSchema`, imported through relative specifiers inside the project across any number of `export const` alias hops, is parsed statically in the declaring module's scope — no module is executed — so a `src/cli/**` command and an MCP tool share one schema. The route graph normalizes each statically read schema once into a `RouteContract` (`id` = `contract:<module>#<binding>`, `input`, `origin`, `routes`), exposed as `contracts` on `CompiledRouteGraph`, `agent-bundle inspect --routes`, the route manifest, and the Workbench Routes page, and referenced by each route as `route.contract`; the argv grammar and static MCP `inputSchema` are projections of it. On CLI routes a reference the resolver cannot follow is `AB4838` (names the import chain and the boundary) and a cyclic chain is `AB4839`; grammar violations inside a resolved schema stay `AB4814` with the position qualified by the declaring module (#603)
- ef2abba: Allow an event route under `src/events/**` to declare a `preflight` gate — `export { default as preflight } from './<name>.js'`, a sync or async function that receives the frozen `{ canonical, host, signal, terminal }` context and returns `'execute'`, `{ outcome: 'continue' }`, or `{ outcome: 'deny', reason }` — which the generated hook entry runs on the canonical event before the rendered route runtime, React, or any application provider loads. `inspect`, `validate`, `build`, and `dev` report `AB4840` when `preflight` is declared inline, exported more than once, re-exported from a bare package or under a binding other than `default`, unresolvable, cyclic, or not a function, naming the route module and, once a re-export was found, its specifier. Allow an executed event route to declare the provider keys it requires (`config.providers: ['<key>', …]`) so only that subset resolves, in the existing deterministic key/source order with `processLifetime` seeded first; a route without a declaration still resolves every conventional provider, `[]` mounts `processLifetime` alone, and `AB4841` reports a malformed declaration, a duplicate key, the reserved `processLifetime`, or a key that matches no discovered `src/providers/*` module — unknown keys list the project's provider keys. Export `EventPreflight`, `EventPreflightContext`, `EventPreflightResult`, `validateEventPreflightResult`, and `eventFamilyAllowsPreflightDeny` from `agent-bundle`, `agent-bundle/api`, and `agent-bundle/routes`. Export the payload-free `EventTraceEvent` union, `createEventTracer`, and `installEventTraceObserver` for developer tooling. (#618)
- 62fd597: Resolve the dev `/web/<server>/<app>` launch from the projections the artifact manifest declares instead of hardcoding portable (#620 review follow-up): validate an explicit `?target=` (invalid is an error, never a fallback), open unprompted when declared projections share one normalized launch descriptor, answer 409 (`AB8023`) naming the choices when they differ materially, and require no portable projection or `mcp.json` for a Claude- or Codex-only build. Cache web sessions by epoch, server, and resolved launch identity, retiring them only when a rebuild publishes a new epoch — a session pages still lease stays valid and closes at its last release, and a failed rebuild retires nothing. Run a non-read-only opening tool once per session, tool, App, and input (concurrent first loads share one call; `readOnlyHint: true` runs on every load) and rebind refreshes to the retained result. Move `<plugin> web` per-server state out of the installed artifact to `~/.agent-bundle/web-data/<plugin>-<digest>/<server>` so a read-only install launches. (#628)
- 9e98f4d: Hold Cursor's 64-character plugin-name bound in the standalone `cursor` planner as well as the unified `plugin` planner, and reject capability states outside the four-state contract with a typed `CapabilityStateError` at the registry boundary instead of returning a fabricated truthy state.
- 6b74fc6: Adopt effect-rstest for Effect-native tests and scoped test resources.
- a0c2add: Bound decoded Agent Document responses and prevent remote Markdown images from loading in the Workbench document stage.
- 8a5b425: Add the Workbench Agent Document stage (#105 stage 2). The dev server gains a
  read-only `GET /api/runtime/runs/:id/document` route that decodes a succeeded
  run's stored Flight through the optional `@agent-bundle/runtime` peer's
  bounded render-event decoder — Flight bytes never reach the browser — with
  honest diagnostics when the peer is absent (AB8207) or the payload is not an
  Agent Document (AB8208). The Workbench decodes the event stream with its own
  strict schemas and renders it in a shared stage: Markdown through the audited
  shared projector, text/context/json/progress/image/audio/resource/error
  nodes, accumulated render diagnostics, live progress, final status, and an
  inspectable event timeline, surfaced as a new Document view in the Runtime
  Playground inspector. MCP protocol results deliberately keep showing the
  lowered projection the server actually returned.
- 979789c: Prevent concurrent event runtime startups from unlinking a newly claimed IPC socket.
- 7404daa: Make Workbench MCP App teardown and project reloads robust under load: raise the MCP App frame relay default `closeTimeoutMs` to 5s and the dev-server graceful-close receipt window to 35s so a healthy graceful close is no longer superseded by the force-close timer, and re-read a project config that changed between load and snapshot instead of serving a stale model under a fresh revision. (#118)
- 7404daa: Stop dispatching an MCP tool call whose request was cancelled while the epoch availability probe was pending: the dev-server MCP session re-checks the caller abort signal after the probe and before dispatch. (#163)
- 7404daa: Reject non-finite numeric literals such as `1e999` in a route `export const config` with the `AB4806` dynamic-config diagnostic instead of digesting them as `null`, keep a literal `__proto__` config key as an own property, and discover `.jsx` modules under `src/scripts/` as script routes instead of skipping them silently. (#165)
- 7404daa: Omit schema-less script routes from the generated route declarations, and make `create-agent-bundle` refuse local-tarball scaffolds whose `agent-bundle` and `@agent-bundle/runtime` identities disagree. (#168)
- 7404daa: Ship the `agent-bundle` package manifest without a `workspace:*` devDependency on `@agent-bundle/runtime`, which npm refused to install; the optional peer is satisfied through a workspace override instead. (#183)
- 7404daa: Add the `agent-bundle` compiler, the `agent-bundle` CLI, and the developer Workbench: compile a typed Agent Bundle configuration into portable, Codex, and Claude Code plugin artifacts and iterate on them from a local dev server. (#2)
- 7404daa: Open the Workbench from `agent-bundle dev --open` through `open` 11.0.2 instead of 11.0.1; `agent-bundle` installs pull the updated dependency. (#303)
- 7404daa: Evaluate `ignore` patterns for config and skill file discovery with `ignore` 7.0.7 instead of 7.0.6; `agent-bundle` installs pull the updated dependency. (#305)
- 7404daa: Speed up `agent-bundle build` and the dev server by reading each route module once per build instead of once per surface, caching prepared statements in the `@agent-bundle/runtime/state/sqlite` driver, and bounding directory-walk concurrency; keep `node:*` imports out of the Workbench browser bundle by moving the MCP App consent-capability vocabulary to a browser-safe module. (#348)
- 7404daa: Run the Workbench lint diagnostics service (`dev/diagnostic-service`) on `@rslint/core` 0.8.1 instead of 0.8.0; `agent-bundle` installs pull the updated dependency. (#7)
- 81721de: Keep timed-out MCP probes responsive when transport teardown stalls, while
  continuing the transport close path that terminates stdio children. Redact
  absolute paths that follow common key-value and list separators.
- f6997c2: Support the documented Claude marketplace plugin source matrix, including pinned git, npm, archive, and command copy/link sources.
- 34d2650: Add the browser-app proof level to the consumer test harness (#103 stage 3).
  `agentBundleBrowserRstest()` from `agent-bundle/rstest` compiles every declared
  MCP App once per pool run through the production Rsbuild profile and configures
  an Rstest browser pool; the new browser-safe `agent-bundle/test/browser`
  subpath ships `mountBrowserApp`, which mounts the compiled self-contained HTML
  in a sandboxed iframe over the product's own MCP App bridge with test-supplied
  binding operations, consent decisions, and captured traffic. The test manifest
  now carries collision-checked MCP App descriptors from the same compiler pass,
  and `compileMcpApps` accepts a per-app target selection alongside the existing
  single-target form.
- 72c3b38: Force-close the MCP App bridge when the initial tool result publication is rejected in mountBrowserApp, so the test binding is released instead of leaking.
- a2fa7d0: Harden the generated-executable build path (Rspack/Rslib/Rsbuild
  conformance audit). One deliberate experimental surface remains:
  `rspack.experiments.VirtualModulesPlugin` serves generated module sources,
  behind a feature check with an actionable diagnostic.
  
  - Generated wrapper entries and registry modules (the stdio MCP entry shell,
    `main` process envelopes, `agent-bundle/mcp-apps` registries) now live at
    dedicated, deterministic, guaranteed-nonexistent paths under the reserved
    `.agent-bundle-virtual/` namespace — replacing the undocumented
    real-file-overlay of the framework's own module as the entry anchor. The
    generated sources never reach the filesystem or a published artifact and
    never count as authored source provenance; emitted bundles keep their
    behavior byte for byte (the only content shift is one scope-hoisting
    identifier now derived from the stable generated-entry name instead of the
    framework's install-dependent bundle filename).
  - The self-contained-artifact invariant now closes the `output.externals`
    hole: a `tools` hatch that externalizes a reserved specifier
    (`agent-bundle/mcp-entry`, `agent-bundle/mcp-apps`, or any generated
    registry name) fails the build with a hard diagnostic — statically for
    string/RegExp/object externals, and via a post-build residual-import scan
    of every emitted bundle for function-form externals.
  - Dist cleaning is now a framework invariant rather than a profile default:
    scripts, MCP entries, hooks, and MCP Apps build sequentially into one
    shared staged root, so a `tools.rsbuild.output.cleanDistPath: true` hatch
    would delete sibling outputs already emitted there. It is pinned off after
    the hatch merge and asserted on the resolved environment config.
  - Pre-build inspection assertions are keyed by the documented Rslib `lib.id`
    (`origin.environmentConfigs[id]` and the Rspack config `name`) instead of
    relying on undocumented array ordering, and reserved aliases use Rspack's
    exact-match (`$`) key form.
  - Per-entry Rslib configs compose through Rslib's own documented
    `mergeRslibConfig` (merged by `id`) with the framework invariant hooks
    typed against each executing engine's own `Rspack.Configuration` and
    returning the config, removing every `as never` cast; the one remaining
    type seam between the public hatch types and Rslib's nested engine is a
    single documented conversion. The dual-engine reality of the hatch —
    Rslib's nested Rsbuild/Rspack (2.1.x line) on the executable path, the
    workspace `@rsbuild/core` (2.2.x) on the MCP Apps path — is now documented
    on `AgentBundleToolsConfig` and in the entry-conventions reference,
    steering hatch authors to the `{ rspack }` utils argument instead of
    importing `@rspack/core`.
  - The unused direct `@rspack/core` dependency is dropped per Rslib guidance
    (its types resolve through `@rsbuild/core`), the `lib` build's declaration
    output is described accurately as a bundleless `.d.ts` graph, and the
    `mcp run` docs no longer claim programmatic builds load the same `.env`
    set (they load none).
- 8f90c53: Make emitted artifacts byte-reproducible across builds: `agent-bundle build` now emits identical bytes — the same `agent-bundle.manifest.json`, the same per-file `sha256` — from two builds of one unchanged source tree, whatever `--output` names and however the per-build staging directory (`.<output>.stage-XXXXXX`) is named. The generated wrapper, route registry, and `agent-bundle/meta` modules every compiled surface imports are now served under the project-rooted `.agent-bundle-virtual/` namespace instead of under the staging root, so the module identifiers Rspack writes into MCP entries (`// NAMESPACE OBJECT: ./.agent-bundle-virtual/…`) no longer carry the staging token that made consecutive builds differ. This keeps install receipts, preview packages, and `doctor`'s bytes-at-rest comparison (`AB7326`) stable for one source revision. `agent-bundle inspect --bundler` shows the same project-rooted paths in each entry's virtual-module aliases and generated entry. Because those paths are predictable, `.agent-bundle-virtual/` under the project root is reserved: the build refuses to compile while anything occupies it. (#518)
- 15a7854: Add authored Codex plugin package metadata, validate documented component forms, and record submission-facing capability limits.
- 7779cb0: Pin the Claude Code and Codex CLI versions the real-host install proofs run
  against beside each adapter's schema provenance (`hostCli` in
  `src/adapters/schemas/{claude,codex}/PROVENANCE.json`, kept equal to
  `observedCliVersion`), and export the Codex adapter's declared
  `codexInterfaceFields` so the host-install proofs can reject an undeclared
  `interface` emission before comparing against their single pinned snapshot.
  Repository CI now installs the pinned CLIs and runs the host-install, packed
  host-install, and packed Claude plugin-validation proofs on every change,
  signed out and without secrets. No runtime behavior changes.
- 2530cc3: Harden Claude adapter planning for monitor path tokens, theme presets, dependency resolution and ranges, indexed channel diagnostics, scoped installation capabilities, and Unicode marketplace topics.
- fe8b026: Re-pin the `claude` host contract from Claude Code 2.1.250 to 2.1.260 (`observedCliVersion`, `hostCli.version`, the `claude-2.1.260.json` capability table, and every `schemas/claude/*` snapshot; Claude `adapterRevision` `1.28.0`, composite `plugin` `1.29.0`). Add the `model-switch/before` and `model-switch/after` canonical event-route families (`src/events/model-switch/before.tsx`, `.../after.tsx`): on Claude Code they compile to `PreModelSwitch` and `PostModelSwitch` (2.1.251 or later), a decided `model-switch/before` projects `outcome: 'allow' | 'ask' | 'deny'` to `hookSpecificOutput.permissionDecision` with the reason as `permissionDecisionReason`, `model-switch/after` is observation-only with `Agent.Context` delivered as `additionalContext`, and Codex, Cursor, and portable carry dated `unavailable` rows. `hooks.schema.json` now admits `PreModelSwitch` and `PostModelSwitch` (`command`, `http`, `mcp_tool` handlers) in a `claude.nativeHooks` document. `build`, `validate --artifact`, and `doctor` request `claude plugin validate --strict --json` first and fall back to the text reporter only when the CLI rejects the flag, so a CLI of unknown version no longer skips the JSON report. The Claude agents capability rows record that 2.1.260 `--strict --json` accepts `color`, `initialPrompt`, and `experimental.cacheTtl` without validating their values; the agents component stays deferred. (#542)
- 8a38720: Add validated Claude Code experimental theme and monitor declarations, including default-location emission, monitor trigger checks, and host-availability warnings.
- 5775351: Stop emitting a `hooks` pointer in `.claude-plugin/plugin.json` for the `claude` and unified `plugin` targets: Claude Code loads `hooks/hooks.json` on its own and reports a manifest pointer at that same file as a duplicate hooks file (`hook-load-failed`, observed on Claude Code 2.1.259). The generated Claude wrappers keep comparing `hook_event_name` against the pinned PascalCase spellings (`PreToolUse`, `PostToolUse`, `Stop`, ... for every supported Claude event), now covered by a per-event regression test; `native hook_event_name must equal postToolUse` on a Claude session identifies a Cursor-built wrapper under the Claude plugin root. (#470)
- 221ed4e: Validate built Claude bundles with Claude Code's strict plugin developer tools and expose the bounded validator as an opt-in test helper.
- 11847a5: Record live-model evidence (Claude Code 2.1.257, 2026-09-03) on the Claude capability table's `lineage.subagent-events`, `lineage.root`, `lineage.parent`, and `lineage.mcp-correlation` rows — the parent's `Agent` PostToolUse names the child in `tool_response.agentId`, `background_tasks[]` lists only background subagents, and `claudecode/toolUseId` correlates parallel MCP calls — and route `pnpm test:packed:native:claude` / `pnpm test:packed:native:codex` through `scripts/run-packed-native-smoke.mjs` so the opt-in packed native smokes pack and install with npm instead of failing under pnpm's `pack --json` and `install --omit=dev`. Emitted host output and `adapterRevision` are unchanged. (#436)
- 7379552: Add host-scoped Claude Code language-server configuration and emit validated plugin-root `.lsp.json` documents for Claude targets.
- 4e514e4: Emit validated Claude Code `displayName`, `metadata`, and `defaultEnabled` manifest fields, and pin the documented custom component-path discovery rules as capability evidence.
- 4344443: Add the complete authored Claude marketplace manifest overlay, including catalog metadata, plugin relevance and authentication fields, renames, and cross-marketplace dependency allowlists.
- d9e4589: Extend the Claude host capability table (`claude-2.1.250.json`, rendered on the hosts reference page) with live Claude Code 2.1.259 evidence on the `lineage.subagent-events`, `lineage.root`, `lineage.parent`, `lineage.depth`, and `lineage.mcp-correlation` rows: two `Agent` spawns issued in one message bind to their own spawn calls, `Explore` subagents carry the same lineage fields as `general-purpose` ones, `PostToolUseFailure` carries the subagent's `agent_id`, the root `session_id` survives `--resume` and `/compact`, and `claudecode/toolUseId` correlates MCP calls at depth 0, 1, and 2. Emitted host output and `adapterRevision` are unchanged. (#455)
- 3e431ea: Add `claude.bin` for byte-faithful Claude Code plugin executables, preserving executable modes in emitted plugin-root `bin/` directories.
- 33e9d08: Add validated Claude Code plugin channel declarations bound to emitted MCP servers, including per-channel user configuration and unified plugin bundle emission.
- 9c767c9: Add validated Claude Code plugin dependency declarations and emit them in generated plugin manifests, including unified plugin bundles.
- 9f1e707: Read the `errors` array from `claude plugin list --json` so a plugin Claude Code refused to load is no longer reported healthy: `agent-bundle doctor --host claude` reports the installed copy as `load-failed` (`AB7325`, error) with the host's message verbatim — instead of `current` — and marks the inventory entry and `--plugin-dir` registration proof `failed`; `agent-bundle install claude` fails with `AB7006` when the freshly installed or byte-identical existing copy carries `errors`. The pinned Claude `plugin` schema now admits the documented additional-hook-file forms of the manifest `hooks` field but rejects `"./hooks/hooks.json"` (`AB6012`), the auto-loaded path Claude Code refuses as a duplicate hooks file. (#479)
- 658dd64: Add host-scoped Claude Code plugin defaults under `claude.settings` and emit a validated plugin-root `settings.json` for Claude targets, pinned to the documented `agent` and `subagentStatusLine` keys. Declaring `agent` warns that the plugin agents component is still deferred, so the referenced agent must reach the plugin root another way.
- 4500114: Add validated Claude Code plugin `userConfig` declarations and emit them in Claude plugin manifests, including unified plugin bundles.
- e879820: Make `agent-bundle validate --artifact` run Claude Code's validator against `.claude-plugin/plugin.json` and, when the bundle emits one, `.claude-plugin/marketplace.json`, instead of the bundle directory: Claude Code treats a directory holding both manifests as a marketplace and never opens `hooks/hooks.json`, `skills/`, `agents/`, or `commands/`, so hook, skill, and agent findings were invisible to the `claude` and `plugin` targets. On Claude Code 2.1.259 or later the runs use `claude plugin validate --json`, and every `AB6020` warning and `AB6021` error now names the validated file (`generatedPath`) and Claude Code's field path; older releases fall back to the text report with the same attribution. Duplicate `plugins[N] plugin.json →` manifest findings from the marketplace run are dropped, notes surface as info, and a run that returns no report is `AB6022` with the CLI's stderr. The native Claude eval gate validates `plugin.json` the same way. (#474)
- 2b5a985: Add Claude Code plugin workflow scripts and Markdown output styles as byte-faithful `workflows/` and `output-styles/` directory payloads.
- 8315637: Resolve Claude plugin directories before invoking the host validator, and fail validation when the Claude CLI version probe cannot complete successfully.
- e4e960a: Restore CLI cold-start time by loading the Effect terminal runtime lazily. `agent-bundle --version`, `--help`, and argv errors answer in about 60 ms again (they had regressed to about 300 ms) because the Effect `Terminal` / `Stdio` runtime is now built on a command's first write instead of before argv parsing; command output, `--json` documents, and diagnostics are unchanged. `create-agent-bundle --help` and flag errors no longer evaluate the scaffold bundle (Effect, the Node platform layer, Clack), about 70 ms → 40 ms. (#530)
- c94df11: Docs-only corrections from the closed-issue audit (#23, #45, #47, #63). The
  published README no longer claims the Claude adapter emits
  `cwd: "${CLAUDE_PLUGIN_ROOT}"` for source-built stdio servers — that emission
  was deliberately removed because Claude Code's placeholder table excludes
  `cwd`; the absolute entry path plus the `AGENT_BUNDLE_PLUGIN_ROOT` env anchor
  carry the working-directory guarantee. No runtime code or export surface
  changes.
- abf5d8c: Pin the Codex 0.147.0 hook contract: close `hooks/hooks.json` to the eleven release events, admit every documented `command` and `mcp_tool` handler field while rejecting parsed-but-skipped `prompt`/`agent` handlers and per-event rules the host would ignore (`codex.hooks.*` and `codex.native-hooks.*` diagnostics), byte-pin all 21 generated hook wire schemas and validate Codex lifecycle-replay envelopes and codec outputs against them, accept a null `last_assistant_message` on Codex `Stop`, and publish dated four-state hook-contract capability rows (handler types, async, `additionalContextLimit`, `commandWindows`, `statusMessage`, timeouts, matcher semantics, trust review, generated-schema validation).
- 93c4664: Validate built Codex bundles against vendored pinned schemas, report the host's missing plugin-validation developer tool honestly, and expose bounded app-server schema drift evidence through the public and test APIs.
- 9e94116: Support authored Codex interface metadata and registered MCP app mappings, and publish capability evidence for plugin policy and compatibility environment surfaces.
- 48c89c1: Resolve a Codex subagent's `request.lineage` parent and depth from the thread's own rollout instead of spawn ordering: the registry reads the `session_meta` head of the rollout every hook payload names in `transcript_path` (`agent_transcript_path` on `SubagentStop`), places the thread with the new `resolution: 'transcript'` (provenance `derived`), matches the `spawn_agent` call to the child by `agent_path`, and corrects an inferred parent at `SubagentStop` from the parent rollout it names. Standalone hooks gain `resolveStandaloneLineage` for the same read. The Codex capability table's `lineage.parent` and `lineage.depth` rows move to `supported`. Refs #423 (#480)
- 325e7f4: Author the Codex marketplace entry (`codex.marketplace` displayName, category, and documented `policy.installation` / `policy.authentication` values, with the category following the plugin interface category; `installation: NOT_AVAILABLE` fails the build with `codex.marketplace.policy.installation.not-installable` because live `codex plugin add` refuses it and the emitted `INSTALL.md` / `installBundle()` run that command), admit every documented marketplace source form (local string or object, Git root `url`, `git-subdir`, `npm`) in the pinned marketplace schema with structurally validated Git and registry URLs, and publish dated four-state Codex distribution rows for marketplace discovery, sources, cache layout, enable state, `codex plugin` / `codex plugin marketplace` JSON contracts, feature flags, managed `requirements.toml`, `allow_managed_hooks_only`, `restrict_to_allowed_sources`, and workspace publishing, backed by live codex-cli 0.147.0 probes.
- f4572a3: Record the Codex MCP `${PLUGIN_ROOT}` lowering rule as a dated
  `mcp.pathTokenLowering` row in the pinned `codex-0.147.0.json` capability
  table (no host interpolation; a *leading* `${PLUGIN_ROOT}` in `command`,
  `args`, `env` values, and `cwd` is rewritten to a `./`-relative path under
  `cwd: "./"` only when `cwd` is the plugin root; embedded tokens,
  `${PLUGIN_DATA}`, and workspace-root tokens fail the build), so the generated
  hosts reference renders it from the table instead of a hardcoded note. The
  `codex` target's `adapterRevision` advances to `1.12.0`, so previously built
  Codex artifacts revalidate as stale against the changed table. (#431)
- 08549c3: Publish dated four-state Codex capability rows for the plugins-overview parts under `plugin.overviewSurfaces`, exposed on the `codex` adapter as `mcpUi`, `browserExtensions`, and `scheduledTaskTemplates` and intersected to `unavailable` by the unified `plugin` adapter: optional MCP UI is `degraded` because the compiled MCP server serves `ui://` MCP Apps resources that Codex CLI 0.147.0 does not render, and browser extensions and scheduled task templates are `unavailable` because no plugin manifest or package contract publishes an authoring field for them (#415)
- c95091d: Accept any JSON `tool_input` / `tool_response` on Codex `PreToolUse` / `PostToolUse` hook input, matching the pinned rust-v0.147.0 generated schemas (`"tool_input": true`, `"tool_response": true`). The generated Codex hook wrapper and the event-route envelope validator now require presence only for Codex, so string, number, boolean, and null tool payloads reach the handler instead of failing with `must be an object`; Claude keeps its documented object requirement.
- 0ca8e11: Resolve the concrete invoking host for composite plugin shared event routes so Claude, Codex, and Cursor wrappers validate and project their native envelopes correctly.
- 9cb6d76: Add user-initiated, read-only live MCP probing to the Workbench Hosts page
  with per-probe consent, redacted launch details, honest neutral down states,
  and ephemeral results. Discovery now enumerates installed-bundle MCP servers,
  and the authenticated `POST /api/discovery/probes` route reports probe outcomes
  with diagnostics AB8219 through AB8223.
- ce55a67: Ship the consumer route test harness as two new public subpaths.
  
  `agent-bundle/rstest` exposes `agentBundleRstest()`: it runs the same
  route-graph compilation the build runs — one compiler pass, through the shared
  project service, with no artifact build — and returns a plain Rstest
  configuration object that registers the compiled test manifest and the route
  loaders, resolves React under the `react-server` condition, and selects the
  automatic JSX runtime. `agent-bundle/test` exposes `renderRoute`, which executes
  a route by compiled id or by module through the real final-only Flight
  dispatcher and the real request store and resolves to the final Agent Document,
  plus `expectDocument` matchers over the Agent Document contracts
  (`toHaveStatus`, `toContainMarkdown`, `toContainText`, `toHaveValue`,
  `toHaveError`, `toHaveNodeKinds`) and `testManifest()` for iterating the route
  inventory in process. Failures name the route id, target kind, and module
  provenance.
  
  `@rstest/core` and `react` are optional peer dependencies: a project that does
  not test routes installs neither, and neither becomes a runtime dependency.
  `@agent-bundle/runtime` stays undeclared and is loaded through a dynamic
  import, matching how the generated entry shells already import it from the
  consumer project.
  
  This is the route-unit proof level, labeled as such. Transport, packed, and
  browser levels are not included and are not scaffolded.
- d992838: Fix generated route input and result helpers to infer event component contracts.
- f150adb: Add stage-1 generated-plugin contract matrix at the `mcp-in-memory` and packed stdio proof boundaries (#218). `runContractMatrix` runs framework-owned wire-contract checks — surface completeness, fixture coverage, invocation sweep, JSON serialized round-trip, declared additive/closed result compat, version-skew fixtures, negative inputs from advertised JSON Schema, and cancellation hygiene — with project-supplied fixtures only. `runPackedContractMatrix` reuses the same implementation against an already-open packed session for process stdio evidence (including MCP App resource registration), reporting module-backed checks as not-applicable when project source may be absent.
- 78b3b6d: Add stage-2 stateful lifecycle replay to the generated-plugin contract matrix (#218). Projects can supply deterministic `unknown → queued → running → first-progress → repeated-progress → terminal` drivers while the shared matrix owns transport, per-phase schema/render/compat checks, live-progress evidence, journal accumulation, notice observation, idempotency replay, typed commit-budget rejection, and same-store restart durability at both in-memory and packed boundaries.
- 24905b9: Add the stage-3 installed-host contract matrix boundary (#218). `openInstalledHostMcpServer` verifies and discovers a clean installed host layout, spawns its emitted MCP command over stdio, and observes the live initialize identity. `runInstalledHostContractMatrix` reuses the shared matrix at `host-install` proof level and reports a fail-closed source, built-artifact, installed-artifact, and running-process version quadruple with host binary, adapter, manifest/schema, and framework metadata.
- 9ae79c3: Discover plain `src/scripts/` modules as conventional script entries (#102
  stage 1). An unclaimed plain `.ts` module directly under `src/scripts/` now
  compiles through the existing explicit-`scripts` pipeline to
  `scripts/<name>.mjs` in every selected target artifact, carrying
  `provenance.kind: 'conventional'`; explicit `scripts` configuration keeps
  claiming its files. Rendered (`.tsx`/`.jsx`), nested, and
  identity-conflicting script routes fail source validation with the new
  `AB4807`–`AB4809` diagnostics instead of building silently.
- 4955f2f: Correct Claude Code and Codex event-route capabilities for native
  `SubagentStart` and `SubagentStop` hooks, including host-specific input
  validation, result projection, plugin packaging, and pinned Codex wire-schema
  evidence. Resolve the actual Claude or Codex invoker before a composite plugin
  route validates input or projects output.
- 4fd7c8c: Re-date the Cursor capability table's desktop hooks evidence against Cursor 3.18.25: `sessionStart` is dispatched to plugin-scoped hooks for newly created root chats — not for resumed roots or `Task` children — and the earlier 0× count came from 3.14.7 launches only; `subagentStart`/`subagentStop` delivery varies by instance on the same build, and where an instance does not deliver them `request.lineage` reports `id-not-resolvable` for the child rather than inferring a parent. Evidence notes only; no projection or `request.lineage` behaviour changes (#546)
- 49281f1: Correct Cursor capability reporting and bundle output: mark the sessionless `workspace/open`/`pluginPaths` envelope unavailable, emit a schema-validated Cursor marketplace document from the pinned official schema, and include Cursor in plugin composite capability intersections.
- 60445ec: Add the `cursor.*` config extension so Cursor builds emit manifest metadata
  (`author`, `homepage`, `repository`, `license`, `keywords`, `publisher`,
  `category`, `tags`, `minClientVersions`) into `.cursor-plugin/plugin.json`;
  invalid values are reported as `cursor.manifest.field.unknown`,
  `cursor.manifest.author.*`, and `cursor.manifest.<field>.invalid` instead of a
  generic schema failure. Cursor `subagentStart`/`subagentStop` hooks now
  validate the documented envelope (every field except `git_branch` required),
  decode `subagent_model` into `event.model`, and only return a
  `followup_message` when the subagent `status` is `completed`; the `cursor` and
  `plugin` capability reports list every documented Cursor hook event with its
  cloud availability. (#375)
- dcf602a: Lower hooks to Cursor. The `cursor` target now emits the flat versioned
  `hooks/hooks.json` with per-hook wrappers speaking Cursor's own stdin/stdout
  envelope (pinned from the published hooks reference and verified against
  installed Cursor plugins), and the unified `plugin` bundle ships dedicated
  `hooks/<name>.cursor.mjs` wrapper variants beside the shared Claude/Codex
  wrappers, replacing the empty schema-collision guard whenever a hook lowers
  to Cursor. One authored hook now serves Claude Code, Codex, and Cursor.
- 10a98a0: Validate the Cursor hooks document that `.cursor-plugin/plugin.json` `hooks` names instead of always reading `hooks/hooks.json`, so `agent-bundle doctor` (`AB7319`/`AB7320`) and `validateCursorPlugin` (`AB6027`) no longer reject a unified `plugin` bundle whose Cursor manifest points at `hooks/hooks-cursor.json` beside the Claude-format `hooks/hooks.json`. A declared hooks file that is missing or leaves the plugin root is now an `AB6027` error, an inline `hooks` object is validated in place, and Doctor's `AB7322` registration proof applies the same folder-discovery fallback. (#442)
- 386375a: Add a first-class `cursor` compile target. The standalone Cursor artifact
  carries the `.cursor-plugin/plugin.json` manifest with explicit document
  pointers, Cursor's auto-discovered typeless `mcp.json`, and shared skills,
  scripts, and assets, all validated against the pinned Cursor schemas. The
  unified `plugin` bundle now shares one Cursor lowering with the new adapter,
  and the target MCP runtime reads shape-discriminated server documents.
- 9c91a86: Add `--mode local|marketplace` to `agent-bundle install cursor`, the generated installer bin, and the emitted `install.mjs`: marketplace mode stages a committed local `.cursor-plugin/marketplace.json` repository under `~/.cursor/agent-bundle/marketplaces/<name>` and prints the Cursor Customize import step, while local mode keeps the safe copy into `~/.cursor/plugins/local/<name>`. Doctor now proves Cursor hook registration from the plugin manifest (`AB7322`), warns about duplicate `~/.cursor/hooks.json` delivery (`AB7323`), and tracks staged marketplaces to imported (`AB7324`). Documents that plugin-scoped hooks fire without user-level registration, closing #407 (#414).
- 3b1c423: Emit Cursor MCP configuration at the plugin root, keep the confirmed
  `.cursor-plugin/plugin.json` local-plugin manifest with an explicit Cursor hook
  document pointer, and document a physical copy installation because Cursor
  rejects symlinks whose targets are outside `~/.cursor/plugins/local`. Validate
  Cursor artifacts against the pinned official full Cursor Plugin manifest schema
  and strict MCP/hooks schemas, declare custom MCP placeholders through manifest
  `variables`, and retain real-host provenance for `${CURSOR_PLUGIN_ROOT}`.
- b938cbf: Add conventional `rules/*.mdc` authoring with validated Cursor rule emission
  and honest unavailable capability states for hosts without a rules surface.
- 69a413b: Support Cursor's canonical `workspace/open` event route as a fire-and-forget
  observation. The generated wrapper accepts Cursor's sessionless `workspaceOpen`
  envelope and emits no output; the optional native `pluginPaths` return channel
  is deliberately not modeled.
- 123c487: Keep `agent-bundle dev` and `agent-bundle eval` error output unchanged while their internal framework errors become yieldable Effect errors: every error message, `code`, `name`, `instanceof` check, JSON / `stableJson` serialization, and CLI stack trace is byte-for-byte what it was; emitted hook wrappers, `bin/*.mjs`, MCP shells, and `install.mjs` do not change in size or content; and no `effect` type enters any public `.d.ts`, so consumers still compile against `agent-bundle`, `agent-bundle/api`, `agent-bundle/eval`, and the other entries without an `effect` dependency. (#543)
- ef5e125: Declaration-build failures now report as the dedicated `AB4716` code instead of the `AB5000` catch-all, and carry the TypeScript diagnostics that caused them. When the `lib` dts pass aborts, the package build replays declaration emit over the same synthesized tsconfig using the consumer project's own `typescript`, so every underlying error reaches human and `--json` CLI output with its file, `(line,column)`, `TS` code, and message — plus a recovery hint that emit-only errors such as `TS4023` are invisible to `tsc --noEmit`.
- deb9381: Record the #100 stage 2 agents-component deferral in Claude and Cursor pinned capability-table notes.
- 98cc244: Remove nineteen unreferenced modules left behind by extractions that never
  rewired their callers, collapse the surviving duplicated helpers onto their
  canonical owners, and fix the three defects that drift had caused: the
  Workbench Logs view now shows `lifecycle.replay.started`, `.completed`, and
  `.failed` Dev Log records and records carrying `routeId` (the browser log
  client's private copy of the `agent-bundle/contracts/dev-logs` vocabulary had
  omitted them); the Workbench now subscribes to `dev.host.sync` project events,
  which `project-client` had left out of its SSE listener list; and the
  Playground trace store redacts with the shared `core/credentials` classifier,
  which adds the provider environment-variable patterns its local copy lacked.
  `@agent-bundle/runtime` drops the internal, never-exported
  `expectCanonicalPayload` helper from `state/contract`. No public export, route,
  diagnostic code, or runtime behavior changes otherwise. (#451)
- 75e1a53: Deslop pass over the Wave 1 delta: `config/normalize.ts` reuses the shared `core/freeze.ts` `deepFreeze` instead of a local copy, the internal `configClaimedSources` helper is no longer exported, the dev-lock URL publication settles through one named cleanup, and the rsc-runtime CLI binding drops a redundant `Object.freeze` (the request store snapshots and freezes capabilities itself). No behavior changes.
- 43abb2d: Accept an optional `now` time source on `createAgentRenderEventSequence` and run the render dispatcher's `maxElapsedMs` deadline — the event sequence's elapsed check and the pending-boundary deadline sleep — against one injectable clock, so a Flight render's deadline can be driven by a test clock instead of wall-clock time. Add a `timers` option (`McpProbeTimers`) to the Workbench MCP probe service so its total-budget timeout, bounded teardown wait, and detached plugin-data cap can be scheduled without real timers; production behavior is unchanged. (#434)
- 5fac480: Gate live host and development-install epoch adoption on an opt-in, project-declared contract matrix (`dev.contracts`). Each published epoch runs the generated contract matrix through an epoch-pinned generated stdio session at the new `dev-epoch` proof level (`runDevEpochContractMatrix`); failing epochs stay inactive for live host MCP connections and `--install-host` installs while the last passing epoch keeps serving, and are reported on the `dev.contract.status` project event with `AB7210` (invalid declaration or fixture module) or `AB7211` (contract violations). `startDevServer().status()` and `/api/project/status` now carry a `hostAdoption` snapshot (`mode`, `adoptedEpochId`, latest `contracts` evaluation) that the Workbench Overview renders as **Host adoption**. A cold start whose initial build fails now seeds the restored last-good epoch through the same gate instead of leaving hosts without an epoch.
- 24f0ea1: Harden the Runtime App development relay against Rsbuild protocol changes.
  Only the provider-emitted `full-reload` signal now reinstalls the opaque App
  child; private `ok` and `hash` frames and unknown future frame kinds are
  ignored. Runtime compiler WebSocket paths come from normalized Rsbuild
  configuration, and bounded credentials are encoded without assuming an
  undocumented token alphabet.
- 98136ac: Link the package README to the hosted documentation site so `npm` readers can find the full guide, configuration, host, event, notice, and diagnostics references. The pinned Cursor and portable capability tables now record Cursor's `.cursor-plugin/marketplace.json` path and the portable `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` tokens, so the generated host matrix matches what the adapters emit. (#384)
- 46e8537: Doctor's Claude registration proof now matches the pinned `id === '<name>@inline'` list contract, and versionless Cursor manifests are treated as installed or drifted instead of corrupt or conflicted.
- cbbaf0e: Add a read-only `agent-bundle doctor` command for inspecting host availability, installed bundles, bundle drift, and runtime endpoint health without applying repairs.
- eb0e732: Surface pinned static bytes-at-rest validation findings for supplied bundles
  and installed Cursor plugins through the read-only Doctor report.
- 70deb99: Add the Stage-3 Effect boundary module for the dev seam (`src/effect/boundary.ts`, exact `effect@4.0.0-rc.112` pin). Internal only: no public API or artifact change.
- f596377: Rewrite EpochStore staging, leases, and recovery orchestration on Effect: store and process-wide lease mutexes are `Semaphore(1)` permits, the publication saga carries Exit-aware compensations, and retention aggregates concurrent deletions via per-element `Exit`. No public API, on-disk format, or behavior change.
- 1a8a2f3: Keep `agent-bundle dev` — the Workbench dev server, its host installs, MCP sessions and probes, hook / host-discovery / native / script playgrounds, skill documents, evals, and asset serving — behaving exactly as before while every service's file reads, temporary directories, and removals run on one platform runtime that `startDevServer` creates and the session's `close` releases after the last service has closed. Diagnostics, routes, and responses are unchanged. Two lifetimes are now explicit: an MCP session's plugin-data directory lives exactly as long as the session (removed when the session closes, or when an open fails before the session exists), and a script playground workspace that cannot be removed is still reported in the run result's `cleanupFailures` instead of replacing the script's outcome. `agent-bundle --version` / `--help` keep loading no Effect module. (#551)
- 6228a82: Keep `agent-bundle validate` (the `AB60xx` portable / Claude / Cursor plugin diagnostics), `mcp list` / `mcp invoke` / `mcp run`, `hooks list`, `eval`, and the post-build artifact readers (`validateArtifact`, the pack inventory) behaving exactly as before while their file reads, copies, and temporary directories move onto the shared platform layer: the same diagnostic codes and messages, the same `ENOENT` / `ENOTDIR` / `ELOOP` errors at the same places, byte-identical built artifacts. Two guarantees are now unconditional: `mcp run` stops forwarding SIGINT/SIGTERM to the server the moment the server exits, however it exits, and `mcp invoke` removes its per-connection plugin-data directory even when connecting fails. (#540)
- 8c70ffa: Stage the throwaway artifact behind `listMcp`, `invokeMcp`, `runMcp`, `listHooks`, and `simulateHook` (when no `artifact` is given) and the Codex validator's schema-generation output in Effect `FileSystem` temporary directories that are removed on every exit path, including interruption; results, diagnostics, and thrown errors are unchanged. `agent-bundle` now depends on `@effect/platform-node-shared` (adds `@types/node`, `@types/ws`, `undici-types` to a consumer install, ≈4 MB). (#508)
- 5b9d3b7: Publish `.agent-bundle/routes.d.ts` during project preparation (`agent-bundle build`, `agent-bundle dev`, and every API call that prepares a project) through Effect `FileSystem`: the staging file is removed on every exit path, including interruption, while the generated declarations, the atomic rename, and thrown Node errors are unchanged. (#520)
- 8045094: Report every local Cursor install failure as an `AB7004` diagnostic for the `cursor` host: a Cursor home that exists but cannot be inspected (for example an unreadable `~/.cursor`) now surfaces as `AB7004` with `target: 'cursor'` like every other Cursor install failure, instead of a bare error. Successful installs, `AB7002`/`AB7003`/`AB7005` refusals, and the Claude/Codex installers are unchanged. (#522)
- b8e9390: Report shared event runtime teardown failures instead of swallowing them: `createEventRuntimeServer(...).close()` now rejects with `EventRuntimeTransportError` (`code: 'runtime-failed'`, "Unable to remove the event runtime endpoint.") when the owned socket path cannot be removed, and opening a server fails with the same error class ("Unable to release the event runtime endpoint claim.") — after shutting the just-started listener down — when the endpoint claim lock cannot be released. Successful opens and closes are unchanged, and the generated MCP runtime's shutdown surfaces the close error the way it already surfaces other teardown failures. (#516)
- 0343e04: Rewrite MCP session lifecycles on Effect: the open acquisition chain is scoped `acquireRelease` resources, session teardown is one structured Effect, and the #134 fail-closed stale-epoch contract rides the typed error channel. No public API or wire-contract change.
- 87711c4: Rewrite the dev coordinator's coalescing rebuild scheduler on Effect: build passes run as fibers holding a `Semaphore(1)` permit, and coalesced follow-up rebuilds share one `Deferred` result. No public API or behavior change.
- 8b75a6c: Cleanup pass over the Wave 3.5 Effect migration: harden the sqlite
  connection and Flight reader finalizers against masking the original
  failure, consolidate the state drivers' duplicated pending-open lifecycle
  tracking, remove the dead epoch lease registry and unused `runSyncExit`
  boundary exports, and trim migration-narration comments. No public API or
  behavior change.
- 75d5c3d: Reclaim provably dead orphaned event-runtime endpoint claims using owner pid and process start-time identity, while keeping live and ambiguous claims fail-closed.
- 21a8ace: Publish evidence-backed event-route support states for Claude, Codex, Cursor,
  the unified plugin, and Portable targets, and reject unavailable routes before
  packaging unless their static config restricts them to supported targets.
- 363890b: Compile semantic event routes into native hook clients that render through the
  generated MCP entry's epoch-bound local runtime, with explicit standalone
  fallback and fail-closed transport behavior.
- cd0b4a6: Keep a generated MCP server running when another process from the same install already owns the event runtime socket: the server stands by and takes the socket over when the owner exits, instead of exiting with `Event runtime endpoint already has a live server`. `createEventRuntimeServer` gains `whenOwned: 'fail' | 'standby'` (default `'fail'`), and the returned server exposes `role()` and `onRoleChange()`; the standby start and the takeover are announced on stderr only (#561)
- 305161a: Address the third-wave review findings across the adapters: Codex artifacts honor `plugin.logo` (interface field + shipped image), the generated fallback prompt is bounded to the pinned 128-code-point limit and authored prompts are counted in code points, the transcribed Codex plugin schema rejects backslash parent traversal in component and interface-asset paths and accepts case-insensitive HTTP(S) schemes, Claude marketplace relative paths allow harmless `.` segments again (only `..` escapes), `permission/request` envelopes accept every `tool_input` shape the pinned schema declares, adapter revisions advance for the promoted event contracts (claude 1.22.0, codex 1.6.0, cursor 1.8.0, plugin 1.21.0), the G5 agents provenance note reconciles with the published parity rows, and the repository-owned capability-table hash pins are removed per the documented hashing policy.
- a45992e: Harden artifact output validation, payload snapshot containment, executable
  source freshness, and workspace identity for native event routes.
- c2511ea: Prevent artifact validation from attributing compiler outputs to a different target whose name has the same length.
- 63e5bd1: Document that artifact output roots remain project-contained even when the CLI
  overrides `output.distPath`. Omit generated installer bins from scaffolds that
  select no installable host, and make the default template install examples use
  a selected host.
- 1c36813: Fail rendered CLI requests closed when their worker exits or progress
  forwarding rejects, reserve generated Flight worker output names, accept
  negative numeric positionals, and canonicalize command results only after
  validating result-derived exit codes.
- 045b04f: Fix root-independent model digest canonicalization for Skill IR fields added in #185.
  
  `skillIr` and `hostDocuments` carried absolute filesystem paths into `modelDigest`, breaking cross-checkout identity for equivalent projects.
- 079a77d: Validate raw portable Skill metadata before building the sanitized Skill IR, and report AB3006 diagnostics for unknown fields nested under Claude, Cursor, and Codex targets.
- 0ad0c18: Keep standalone event-hook worker URLs runtime-relative so generated wrappers
  compile without Rspack attempting to bundle the separately emitted worker.
- 2c28363: Normalize `<plugin> web` and `/web` portable-plus-host launch identity to avoid false AB8023 conflicts (#633)
- da5df1d: agent-bundle owns the build (RFC #50 Phase 1): one `agent-bundle.config.ts` now produces the npm package build alongside host artifacts, with framework-owned entry lifecycles and one bundler escape hatch.
  
  - `bin` config (or the `src/cli.ts` convention) emits self-executing `dist/bin/<name>.js` bundles with a shebang, executable bit, and a generated `main(argv)` process envelope; artifact Scripts whose module exports `main` receive the same envelope.
  - `lib` config (or the `src/index.ts` convention) emits a single-entry ESM library build with declarations, resolving `typescript` and tsconfig compiler options from the project.
  - MCP server entries that default-export a server factory are wrapped in the new framework stdio lifecycle shell — console-to-stderr guard with raw stdout restored for protocol frames, SIGINT 130 / SIGTERM 143, stdin-EOF exit 0, bounded shutdown race, heartbeat — also public as `agent-bundle/mcp-entry`. Self-connecting entries keep their behavior byte for byte. The `src/mcp/<server-id>.ts` convention supplies the entry for servers naming no `entry`, `command`, or `url`.
  - `tools.rsbuild` / `tools.rspack` is the single blessed bundler escape hatch, merged last into every synthesized config (scripts, MCP entries, hooks, MCP Apps, package build) and still bounded by the artifact invariant assertions.
  - `agent-bundle mcp run --server <name> --target <target>` runs one built stdio server in the foreground, resolving its content-hashed generated entry from the target manifest.
- bb0754f: Harden Claude artifact and marketplace validation, preserve lifecycle replay invocation and workspace provenance, and invalidate development rebuilds after executable-mode changes.
- c69c6b5: Cancel shared event renders when their IPC client disconnects, decode split
  UTF-8 request bytes incrementally, refuse to unlink live runtime sockets,
  preserve event-route timeout milliseconds until native host projection, and
  assign a fresh diagnostic to missing shared runtime hosts.
- 403d9d8: Assign unique AB48xx codes to event vocabulary and target diagnostics while preserving the documented routed CLI meanings.
- 67730f4: Publish the reusable RSC protocol runtime and allow generated executables to
  bundle declared pnpm workspace packages without treating dependency source as
  authored project provenance.
- 02d2e37: Execute conventional `src/providers/*.{ts,tsx}` factories once per generated
  MCP or event request and mount their values at
  `(await agent()).providers.<camelCaseKey>`. Provider execution is deterministic,
  sequential, abort-aware, and fail-closed; duplicate, reserved, and invalid
  provider exports report `AB4940`–`AB4942`.
  
  Export `AgentRenderInvocation` as a type from the runtime package root so
  provider authoring types do not require an internal import.
- e131071: Mount the #98 state kernel and #99 notice ledger into generated request
  scopes (#233). `@agent-bundle/runtime/mount` exports
  `createGeneratedRuntimeState`, which owns the project state store and the
  notice ledger over one driver and returns typed-failing handles when that
  driver cannot open. `createWarmFlightHost` accepts optional `runtimeState`
  ownership so the warm host closes the generated owner with the process.
  Conventional `src/state.ts` default-exports `defineState({ ... })` with
  statically extracted literal `id` and `lifetime` (`AB4818`–`AB4820`);
  `state: false` opts out. Generated MCP flight workers, routed CLI bins, and
  rendered workers and scripts mount `state` and `noticeLedger` into every
  request scope — memory driver for `request`/`process` lifetimes,
  `node:sqlite` at the `AGENT_BUNDLE_PLUGIN_ROOT`-anchored `state/` root for
  `workspace-durable`, and a cwd `.agent-bundle/state` fallback for package
  bins. Event invocations run notice admission once in the render scope with
  invocation identity forwarded from the host process. Stateless projects
  emit none of this. The test harness auto-mounts declared state at
  route-unit level, and `openInMemoryMcpServer` accepts a state owner.
- 3ae7721: Fix generated executables crashing on any route authored with JSX.
  
  Route entries were bundled without the React plugin, so Rslib lowered JSX to
  the classic `React.createElement` factory — which no generated entry or Flight
  worker has in scope. Every documented `.tsx` route (the contract's own example
  shape) therefore failed at run time with `React is not defined`, while builds
  and route-unit tests stayed green because the test transform selects the
  automatic runtime. Route entries now build with the automatic JSX runtime, so
  emitted modules import `react/jsx-runtime` themselves — under the
  `react-server` condition for worker entries.
  
  The defect survived because every build-level test authored its routes with an
  explicit `createElement` import; the generated-route server test now authors
  its tool route as JSX instead, which is what surfaced this from the new
  `packed-stdio` proof level.
- 87eb921: Add honest Cursor plugin host validation that probes the installed CLI for version evidence while always validating generated bytes locally against the vendored pinned schemas and loader contract.
- 7dbfacf: Reject stale consumer test registries before projection helpers read fields
  they do not contain, and derive CLI dispatch workspace context from the
  invocation working directory to match generated executables.
- 5317ce6: Preserve provider and exit-code semantics across generated CLI workers, make bare prepack output non-overlapping, and harden packed installer and README validation.
- 8362f4f: Add conventional `commands/*.md` authoring with validated Cursor and Claude
  command emission and honest capability states for unsupported hosts.
- 1235be1: Emit evidence-backed install instructions for every target, add safe Cursor
  placement and public Claude/Codex CLI delegation through
  `agent-bundle install`, and require install surfaces during artifact
  validation.
- 9928c3e: Add the `host-install` consumer proof level for real public-path installation
  into isolated Claude, Codex, and Cursor homes. The source-built proof fixture
  exercises Skills, Hooks, and MCP registration without model calls or packed
  artifact claims, validates Cursor's emitted documents against the pinned
  schemas, and records only path-relative evidence.
  
  The level now also carries the real-host token proofs deferred from the
  canonical Skill IR work. The Codex proof asserts the installed cache copy of a
  skill's `agents/openai.yaml` sidecar is byte-identical to the built artifact and
  valid against the pinned schema, and that the installed `.codex-plugin/plugin.json`
  carries its `interface` block. The Cursor proof asserts the installed hooks and
  MCP documents keep `${CURSOR_PLUGIN_ROOT}` unresolved, which is the honest
  ceiling because Cursor publishes no non-interactive plugin-loading session
  surface. An opt-in session-token qualifier
  (`AGENT_BUNDLE_HOST_INSTALL_CLAUDE_SESSION=1`) observes `$ARGUMENTS`,
  `${CLAUDE_PLUGIN_ROOT}`, and `${CLAUDE_SKILL_DIR}` resolving inside one real
  `claude -p` turn with the built bundle loaded inline via `--plugin-dir`.
  
  Generated Claude and Codex installation instructions now use
  `plugin marketplace add ./`; Claude Code 2.1.257 rejects the previously emitted
  bare `.` source.
- e8908cc: Derive validated `packageName`/`packageVersion` from the project's `package.json` into the project identity (issue #94 stages 1-2). Both axes now flow through the normalized model metadata, `ProjectContext`, artifact manifests, inspect output, and dev status DTOs (source status and artifact epochs); `plugin.version` still authors the native plugin version but the package version is authoritative for release identity and a mismatch never silently wins. Projects without a package version keep a clearly labeled `0.0.0-dev` development fallback in displays. New warning diagnostics: AB4008 (`plugin.version` differs from the package version), AB4009 (invalid npm package name), AB4010 (invalid package semver), AB4011 (unusable package.json).
- c1a113c: Include the existing development workbench URL when another process already owns the project.
- 1a365cf: Explain host component selection in `inspect`. Every inspection plan now
  lists `selected` components beside `skipped`, and each component that needs a
  host capability carries that target's own four-state judgment as
  `capability` — `supported` with pinned evidence for emitted surfaces, or
  `degraded`/`unavailable`/`prohibited` with the host's reason for omissions —
  so `inspect --json` explains why a surface is absent from a bundle in the
  host's words. An adapter that publishes no row for a needed capability reads
  as an honest `unavailable`. Human `inspect` output prints one accounting line
  per target followed by each omission and its reason.
- 2e91ea1: Add the async `MarkdownContent` component and the `renderToMarkdown` /
  `renderToMarkdownStream` exports to `@agent-bundle/runtime`, so routes author
  rich Markdown blocks — headings, lists, GFM tables, task lists, nested async
  components, escaped text — as JSX lowered into `Agent.Markdown` instead of
  hand-concatenated strings. The renderer behind them, `rsc-markdown-stream`, is
  now a package of this repository and is published from it (it was previously
  only installable from its git URL), so `@agent-bundle/runtime` depends on it
  by version. `agent-bundle build` now follows symlinked (workspace) dependencies
  transitively when attributing bundle provenance, resolving each one the way
  Node does, so a project whose linked dependency links another package —
  including one hoisted to an ancestor `node_modules` — no longer fails with
  `AB5000`, and a dependency that links back onto the project never hides the
  project's own sources from provenance. (#344)
- a00273b: `agent-bundle dev` now leases the adopted epoch until another epoch replaces it
  or the server closes, so store retention cannot delete the advertised last-good
  build during a run of failing rebuilds, and an epoch that cannot be leased is
  reported as `AB7211` instead of adopted; the `dev.contracts` matrix opens the
  configured server on a target whose manifest carries it, applies the session
  timeout per request, forwards each request's `_meta.progressToken` so generated
  routes emit progress, and observes lifecycle progress through the session trace
  (`ContractMatrixClient` from `agent-bundle/test` gains an optional
  `observeProgress` seam, `ContractMatrixProgressSource`; `McpSession.callTool`
  accepts `_meta`). Native Playground catalog readers wait for a hard-link
  publisher to release its staging link before adopting the sidecar, return to
  discovery when that publication is rolled back, and recover a staging link
  abandoned by an exited publisher instead of rejecting the epoch forever. (#408)
- f469376: License: Apache-2.0 (previously unspecified/MIT-declared); LICENSE and NOTICE
  shipped in the tarball. Every package manifest now declares
  `"license": "Apache-2.0"`, the build copies the repository LICENSE and NOTICE
  into each publishable package, and `pnpm audit:release` fails if any
  publishable tarball is missing either file or the license field.
- af344a8: Keep development hosts connected across rebuilds with an epoch-aware Streamable HTTP MCP endpoint and stable stdio proxy. New calls use the active artifact while in-flight calls retain their original epoch, and catalog changes reach hosts without reinstalling the plugin.
- 64aaab0: Keep the optional `@agent-bundle/runtime` peer out of the dev server's emitted declarations: the Agent Document route now consumes the peer through an opaque structural loader, so consumers without the optional peer compile against the packed root types again.
- c158be5: Derive Workbench navigation and its route catalog from the compiled route graph
  instead of artifact counts alone (#105 stage 1).
  
  The dev server exposes one new read-only route, `GET /api/routes/manifest`,
  which projects the prepared project's existing `CompiledRouteGraph` into a
  browser-safe DTO: route id, kind, project-relative source, provenance, a
  flattened static `config` summary, MCP server surfaces with their packaging
  mode, the generated CLI command surface with its argv projection, conventional
  scripts, context providers, the graph digest, and the graph's own diagnostics.
  There is no second discovery pass — the manifest is a projection of the compiler
  pass the build, inspect, and test harness already share.
  
  The Workbench gains a Routes page under **Build** that renders that catalog
  grouped by server and by project surface, and reports whether the manifest
  matches the published build or is ahead of it. Hooks, MCP playground, and
  Playground now open when either the artifact catalog or the compiled graph
  declares the surface, so a routed project no longer needs configuration to reach
  its own pages. Every existing page is preserved: an absent or refused manifest
  degrades only the Routes page.
- 77aadd2: One MCP App can now be served by several local servers (#42): declaring the
  same app name with an identical definition (`entry`, `resourceUri`,
  `template`, `_meta`; per-server `targets` may differ) under multiple servers
  compiles the view once into one `mcp-apps/<name>.html` output and includes
  it in every declaring server's `agent-bundle/mcp-apps` registry, instead of
  failing as a duplicate compiled destination. Validation now flags only
  conflicting redeclarations of an app name (AB4325) and resource URIs spread
  across different app names (AB4330); identical shared declarations pass.
- 4e54651: Throw the intended unavailable-entrypoint error from the built
  `agent-bundle/mcp-apps` stub. The rslib bundle reorders module statements so
  the emitted `export default` binding was read before its `const` initializer
  ran, surfacing a TDZ `ReferenceError` ("Cannot access 'mcp_apps' before
  initialization") on import instead of the stub's message. The stub now throws
  through a hoisted function declaration, which survives the bundler's
  statement reordering, so importing the built entrypoint reports
  "agent-bundle/mcp-apps is available only while Agent Bundle compiles a local
  MCP server." as intended.
- ed44cd5: Add the standards-compatible MCP progress/final projector and warm-runtime
  fail-closed host. Generated tool calls emit `notifications/progress` only when
  the caller supplied a token, return one `CallToolResult`, and refuse silent
  rich-content drops, epoch mismatch, and a missing or restarted runtime.
- 1286f5b: `mcp run` now owns the operator-environment seam the RFC #50 launchers were meant to retire, and stops fragmenting durable state per rebuild.
  
  - The runner loads the project-root `.env` set by default (rsbuild `loadEnv` conventions: `.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`), with `--env-file <path>` (repeatable, replaces the conventional set) and `--no-env` overrides. A named file that cannot be read is an error.
  - Launch-environment precedence is now documented and enforced, lowest to highest: manifest env, `.env` file layer, operator `process.env`. Previously manifest env was spread last and silently beat operator exports (for example `AGENT_BUNDLE_PLUGIN_ROOT`).
  - Plugin-root path tokens in env values — including the injected `AGENT_BUNDLE_PLUGIN_ROOT` durable-state anchor — now expand to the resolved project root under `mcp run` instead of the ephemeral `artifact/<target>` root, so consumer state survives rebuilds. `args`/`cwd` stay artifact-rooted (the entry is the content-hashed bundle inside the artifact). `--plugin-root <path>` restores a byte-faithful copied-artifact rehearsal when wanted.
- fa28261: Fail MCP playground tool calls closed when the session's pinned artifact
  epoch is removed underneath it. A long-lived `agent-bundle dev` server whose
  project changed substantially — edits plus `agent-bundle build` runs from
  another process, whose epoch retention cannot observe this process's epoch
  leases — could lose the epoch a live MCP session was bound to. Tool calls
  then kept executing against a vanished artifact or pended without any
  indication that the project had changed. `tools/call` now probes the epoch
  store before dispatch and on failure: a vanished epoch raises a typed
  `McpSessionStaleEpochError`, cancels every in-flight tool call with the same
  typed failure, and closes the session, mirroring the stderr-overflow
  fail-closed contract. The MCP session routes surface it as a fail-closed
  `AB8018` (409) diagnostic — like the artifact routes' epoch mapping — so the
  Workbench playground renders the failure in its existing invocation-error
  state instead of hanging silently.
- e806d7b: Raise the dev-server MCP session default request timeout from five seconds
  to thirty. A session request can legitimately sit behind an rsbuild compile
  or Chrome startup on a small machine, and the old ceiling manufactured
  -32001 request timeouts there; thirty seconds stays interactive while
  remaining well under the MCP SDK's own sixty-second default. The Workbench
  session form now defers to the server default instead of forcing 5000ms,
  still validating any explicit entry. Also moves the published toolchain
  pins onto the Rsbuild 2.2 line (`@rsbuild/core` 2.2.1, `@rspack/core`
  2.2.1, alongside the workspace's react-server-dom-rspack 0.1.0).
- 56b77db: Fixes found while re-porting a real external plugin onto route mode
  (#380, #381, #383):
  
  - A `mcp.servers.<id>` declaration for a route-generated server now
    **augments** that server — `env`, `args`, `targets`, `apps`, and
    `transport: 'stdio'` apply — instead of failing `AB4304`/`AB4322`. Redeclaring
    `entry`, `command`, or `url` beside `routes.servers.<id>: 'generated'` is
    the new precise `AB4340` error; without an explicit mode it stays `AB4800`.
  - `Agent.Result metadata` projects to `CallToolResult._meta` (an object,
    JSON-snapshotted like `structuredContent`; a non-object fails the projection
    closed with `McpProjectionError('invalid-result-metadata')`). The
    `mcp-in-memory` harness result exposes `_meta`.
  - Generated tools advertise `outputSchema` only when the route's
    `resultSchema` describes an object; text-only routes (for example
    `resultSchema = z.undefined()`) advertise none and return no
    `structuredContent`, as the MCP specification requires.
  - The `typescript-5` parser alias is bundled into the package instead of
    shipped as a dependency, so `npm install agent-bundle` never links a `tsc`
    bin over the consumer's own TypeScript.
- 605cfe3: Native Playground catalog readers no longer reject a sidecar that a concurrent publisher has just hard-linked into place but not yet released its staging file for. Hard-link publication legitimately leaves the sidecar doubly linked until the winner unlinks its `.stage-` file; a loser (or any reader) arriving inside that window previously failed with `Native Playground catalog snapshot is invalid.` instead of adopting the winner. The extra link is now accounted for by identity — exactly one same-epoch staging sibling shares the sidecar's dev/ino, or the still-open handle reports a single link once the staging file is gone — and any other extra hard link stays rejected as aliasing.
- d88cc10: Run plain `.ts` scripts through `runScript` (`agent-bundle/test`) on Node 26: the child process gets `--experimental-transform-types` only where the running Node accepts it (Node 22 and 24) and `--strip-types` on Node 26, which removed the transform flag and only strips types; the flag is always named on the command line, so an inherited `NODE_OPTIONS=--no-strip-types` cannot switch TypeScript loading off. Previously every plain-script dispatch on Node 26 exited with code 9 (`node: bad option: --experimental-transform-types`) before the script ran; TypeScript-only syntax such as `enum` in a plain script now fails on Node 26 exactly as it does under `node file.ts`. (#554)
- 9b7fe81: Gate the generated MCP server's notice routes on the target host's delivery advertisement. `TargetAdapter` gains the optional `noticeDelivery` field (typed by the new `NoticeDeliveryAdvertisement`, `NoticeDeliveryRoute`, and `NoticeDeliveryRouteState` exports, which resolve without the optional `@agent-bundle/runtime` peer), and `TargetRegistry` gains `noticeDelivery(target)`. The built-in `claude`, `codex`, `cursor`, and `portable` adapters advertise from their pinned capability tables and the `plugin` adapter advertises the three-host intersection; a JavaScript adapter declaring an unknown route state or an `unavailable` route whose reason carries no ISO survey date (`YYYY-MM-DD`) is rejected at registration with a `CapabilityStateError` (a thrown registration error, not a build diagnostic; no diagnostic codes are added or changed). `agent-bundle build` and `agent-bundle inspect --bundler` register the `agent-bundle://notices/inbox` resource only for hosts advertising `mcp-inbox`, and wire `resources/subscribe` plus `notifications/resources/updated` only where the host additionally advertises `mcp-resource-updated` and the state lifetime is workspace-durable. Built-in hosts all advertise `mcp-inbox`, so their artifacts are unchanged. (#412)
- 105c65d: Advertise #99 notice-delivery routes per pinned host in a new `noticeDelivery` capability-table section consumed by the runtime's delivery-route selector: `mcp-inbox` and `mcp-resource-updated` are supported on every target, `next-event` and `current-response` on the three hook-bearing hosts (honestly unavailable on hookless portable), and `directed-push`/`host-toast` carry dated unavailable rows because no pinned host documents a plugin-initiated directed message or toast API (2026-09-02 survey on #99). A pin test enforces the route set, dated reasons, and the per-host truths.
- 23ee0f5: Deliver notices over the `mcp-resource-updated` route from generated MCP servers with a workspace-durable state lifetime: accept `resources/subscribe` / `resources/unsubscribe` for the reserved inbox resource `AGENT_NOTICE_INBOX_URI`, advertise `resources.subscribe` only when that wiring is active, and send each subscribed session at most one `notifications/resources/updated` per newly eligible pending notice — honouring `nextAttemptAt`, bounded per notice by `retryBudget` across restarts, never duplicated across concurrent server processes over one store, detached from the render that triggered it and coalesced behind a pending write so a slow subscriber never delays a tool result nor grows a queue, abandoned (never awaited) by server teardown when its write or ledger call cannot settle (`closeTimeoutMs` bounds the close-time receipt drain), and recorded as an `availability` receipt (never a delivery claim) that the inbox projection exposes beside `exposure`. Fail subscriptions closed when the store is unreadable; volatile lifetimes advertise no subscription capability. Use the new exports `createNoticeInboxSignaller`, `AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS`, `AGENT_NOTICE_STATE_VERSION`, and the `AgentNoticeError` code `reservation-lost` from `@agent-bundle/runtime/notices`, and `createGeneratedNoticeRuntime` plus `GeneratedRuntimeState.noticeLedger()` from `@agent-bundle/runtime/mount`. Update implementers of `AgentNoticeLedger`: the interface now requires `reserveAvailability()` and `releaseAvailability()`, and `AgentNotice` gains the optional `availabilityReservation` field (breaking). Existing workspace-durable notice stores migrate in place to schema version 2 on first open, with no data loss. (#376)
- 907bfa9: Add an opt-in MCP conformance lane that builds a generated route server,
  adapts its stdio transport to loopback Streamable HTTP, and runs the official
  `@modelcontextprotocol/conformance` active suite for specification
  `2025-11-25`. The manually dispatched workflow preserves per-scenario runner
  artifacts and keeps known gaps in a stale-detecting expected-failure baseline.
- 61ff1f1: Document the framework-owned Rsbuild plugin set (`@rsbuild/plugin-react`, `rsbuild:react`) and the official plugins a project may add through `tools.rsbuild.plugins` in the configuration reference; `packages/agent-bundle/src/build/framework-plugins.ts` exports that set for the plugin-collision diagnostic and a unit test derives it from the synthesized configs. Remove the standalone `lint:package` script and its CI step: publint already runs inside every publishable package's `rslib build` through `rsbuild-plugin-publint` at `throwOn: 'warning'`, so `lint:release` is now only `attw --pack --profile esm-only`. (#509)
- b17c75a: Make `plugin.version` optional and derive it from `package.json`, so a packaged plugin declares its release version once. A declared value that is not a nonempty string still reports `AB4001`, and a declared value that disagrees with `package.json` still reports the `AB4008` warning. Development keeps the labeled `0.0.0-dev` fallback, while `agent-bundle build` now refuses a project with no release version at all with the new `AB4013` error, so a development fallback can never reach a release artifact.
  
  Add the `agent-bundle/meta` build-time identity module. Every compiled plugin surface — script, CLI, MCP entry, hook, and package bundles plus browser MCP App bundles — resolves it to the exact `{ name, version, packageName, packageVersion }` reported by artifact manifests, `inspect`, and dev status, so plugins can delete hand-written `src/lib/version.ts` shims. Types ship with the package export; outside Agent Bundle compilation the module throws instead of reporting a fabricated identity.
- df52dc7: Agent Bundle config now supports `output.distPath` to relocate the build
  artifact root (the default `dist` is unchanged); CLI `--output` still takes
  precedence. Invalid values report `AB4707`–`AB4709`.
- 721a0e0: Select the intended `npm pack --json` entry by package name in `packOutputFromJson`, `scripts/run-packed-tests.mjs`, the release audit, and the packed test harnesses, so workspace-aware pack output that lists sibling packages no longer breaks `test:packed`, `test:packed:native`, or `audit-packed-release` (#432)
- 8c8907e: Expose `./package.json` in the `exports` of `agent-bundle`, `rsc-markdown-stream`, and `create-agent-bundle`. `create-agent-bundle` gains its first `exports` map, so `create-agent-bundle/dist/**` deep imports no longer resolve — the CLI is reachable only through its `bin`, which is the breaking change behind its minor bump. Bound `agent-bundle`'s optional `@agent-bundle/runtime` peer to `>=0.0.0 <1` instead of `*`; drop `@modelcontextprotocol/server` from `agent-bundle`'s devDependencies (it stays a dependency) and the dead `!dist/workbench/**/*.map` entry from its `files`; gate releases on `attw --profile esm-only` for all three packed tarballs plus `scripts/check-declaration-imports.mjs`, which fails `pnpm lint:release` when a shipped `.d.ts` a consumer can reach imports a devDependency, an undeclared package, an unexported subpath of the package itself, or a `#` import its `imports` map does not resolve. (#568)
- 2655ca5: Generate package-relative host installer bins for publishable plugin packages and add the `agent-bundle prepack` inventory, freshness, bin-target, and version-agreement gate.
- ae9b2fb: Add the `packed-deleted-source` consumer proof level to `agent-bundle/test`.
  
  `removeProjectSource` removes conventional project inputs and returns a frozen
  receipt, while `openPackedMcpServer({ deletedSource })` verifies every receipt
  path is still absent immediately before spawn and upgrades its provenance only
  then.
  
  The repository's single packed harness journey now builds once, removes the
  fixture source and configuration, spawns once, asserts every route, and proves
  the generated server serves its self-contained embedded MCP App resource.
  Packed test and release scripts also accept both npm 11's array and npm 12's
  package-keyed object forms of `npm pack --json`.
- 140bd3c: Keep the public API importable without optional runtime or React peers, and
  keep the packed event journey's request-context probe within native hook
  output fields.
- a0562e6: Mount conventional request context providers for plain `.ts` routed CLI commands, so `(await agent()).providers` carries the same values on every generated request scope (MCP, events, rendered CLI, rendered scripts, and now plain CLI) with identical ordering, cancellation, and fail-closed semantics; the plain execute context also exposes the consumed `args`. The rendered-session bridge now forwards the invocation to its react-server worker, so providers behind rendered CLI commands and rendered scripts observe the real `invocation.kind` instead of `undefined`.
- ceeca52: Fix inspect so commands and rules emitted by the composite plugin target are no longer reported as skipped for unsupported capabilities by accounting for component kinds as a union of host-side emission while preserving honest intersected capability claims.
- 0455b19: Add optional `plugin.logo` so Cursor artifacts can emit a `logo` field.
  
  The path is validated at build time (AB4012) and copied into the artifact; Cursor `.cursor-plugin/plugin.json` references it relatively. Claude and Codex manifests still have no icon field, so they omit it on purpose. Artifact validation fails with AB6025 when a declared logo is missing from the deploy tree.
- 9a31306: Anchor every emitted stdio MCP server entry with a well-known
  `AGENT_BUNDLE_PLUGIN_ROOT` environment variable holding the plugin install
  root in each target's native spelling: `${CLAUDE_PLUGIN_ROOT}` on Claude Code,
  `${PLUGIN_ROOT}` on portable, `${CURSOR_PLUGIN_ROOT}` on Cursor, and `./` on
  Codex resolved against the entry's plugin-root cwd (a Codex entry without one
  omits the anchor; source-built servers always carry it on every target).
  User-declared `env` keys win over the injected value. The Claude adapter also
  stops dropping `cwd` for source-built servers and emits
  `cwd: "${CLAUDE_PLUGIN_ROOT}"` as documented, schema-valid future-proofing —
  Claude Code currently ignores the field at runtime, which is exactly why
  runtime code should resolve persistent state against the env anchor instead of
  the process working directory. The anchor name ships as the new
  `pluginRootEnvAnchor` export, and every adapter's revision advances to 1.1.0
  so previously built artifacts revalidate as stale instead of silently passing
  with the old emission shape.
- 65c05a6: portable: complete the Agent Plugins 1.0.0 adoption (#307) — author the standard's §5.4 manifest metadata (`author`, `homepage`, `repository`, `license`, `keywords`) and §5.6 reverse-domain `extensions` under the `portable` config key and emit them into the root `plugin.json` (omitted fields leave the manifest byte-identical to the previous contract; malformed values fail closed with `portable.manifest.<field>.invalid`); add the pinned Agent Plugins byte lane (`validatePortablePlugin`, `AB6035`–`AB6038`: pinned schemas plus the normative command/cwd/URL/header/placeholder/version/skill-layout/symlink-containment rules) to `validate --artifact --host-validation`, to `doctor` for installed Cursor local plugins that declare the standard's `$schema` (`AB7320`), and to the portable host-install proof; record dated capability rows for every standard feature (manifest metadata, extensions, extension directories, legacy SSE); re-verify the schema pins against the live 1.0.0 schemas and the specification repository (2026-09-02); adapterRevision 1.5.0 → 1.6.0.
- 0560c75: portable: pin Agent Plugins 1.0.0 adoption evidence — specification repository commit, native-client roster, a repeatable installer/filesystem/pinned-schema conformance proof against an isolated Cursor home, and a Cursor 3.18.25 IDE plugin-loader dogfood audit (discovery, skill and MCP surfacing, stdio handshake, and three observed placeholder-expansion conformance gaps) — and refresh the install surface wording.
- 755aa72: Fix the `portable` host capability table's `mcp.evidence` reference: the 2026-09-03 Cursor re-verification note now cites the surviving audit (`docs/audits/2026-09-03-agent-plugins-cursor-ide-proof.md`) instead of a document removed in #467. (#472)
- a420de3: Reject the runtime's reserved notice-ledger state id during extraction, mount
  each missing route-unit binding independently when the caller overrides only
  one of state or noticeLedger, and document `zod` in the cli-tool migration
  steps.
- 28830bd: Prebuilt payload adapter mode (RFC #50 Phase 3): the top-level `payload` block declares already-built directory trees that `agent-bundle build` packages byte-for-byte at stable paths, and `{ prebuilt: ... }` markers on MCP server entries and hook handlers point the generated host manifests at files inside those payloads. Prebuilt entries skip compilation but flow through the same adapter lowering as compiled entries — path-token expansion in every target's MCP document, the injected `AGENT_BUNDLE_PLUGIN_ROOT` env anchor, generated `hooks/hooks.json` commands (with shell-safe prebuilt hook `args`), and artifact-reference validation. Payload files are recorded in the artifact manifest with the new `prebuilt` file kind and hash into `project.sourceInputs`; declaration provenance is recorded as `kind: 'prebuilt'`. New diagnostics: `AB4740`–`AB4746` at validation (missing payloads and prebuilt files warn so development flows work before the consumer's own build has run), `AB4747`–`AB4749` as build-time refusals, and the `AB4750` staleness nudge.
- b0f14c8: Simplify prebuilt-payload internals (post-#71 follow-up): dev-server preparations no longer pay the AB4750 payload-freshness mtime walk for commands that discard it, the payload-declaration parse and innermost-payload ownership rule are shared across discovery, normalization, and validation instead of being open-coded per module, and `PreparedProject.snapshotSource` is required so artifact re-snapshots always observe the payload roots the prepared identity hashed.
- cbda5ab: Gate `agent-bundle prepack` on the installed-dependency fields of `package.json` so a published plugin installs only what its packed files need: `AB7014` reports a `dependencies`, `optionalDependencies`, or `peerDependencies` entry that no packed JavaScript imports, requires, resolves, or runs as an executable (a computed `import`/`require`, a packed file the ESM lexer rejects, or a `require` passed on as a value such as `const load = require`, withholds `AB7014` for the whole package; an installed manifest's `bin` is read as npm reads it, the last of duplicate keys winning), no packed declaration file references, and no `imports` mapping or consumer install script (including scripts it delegates to with `npm run` or `npm test`/`start`/`stop`/`restart`, `npm restart` without a `restart` script running `stop` and `start`) reaches — a warning rather than an error for a `peerDependencies` entry, which may be a deliberate host-compatibility contract — (the build inlines every dependency into `dist/bin` and the host packs, so a runtime external must be reached one of those ways; optional peers are skipped), and `AB7015` reports an entry a consumer's npm cannot resolve through a registry, judged by npm's own parser (`npm-package-arg`, now a dependency of `agent-bundle`): a git, GitHub-shorthand, remote-tarball, or path source, which npm 12 refuses to fetch by default (`allow-git`, `allow-remote`); a name or specifier npm cannot parse (`EINVALIDPACKAGENAME`, `EUNSUPPORTEDPROTOCOL` for `link:`, `portal:`, or a typo, `EINVALIDTAGNAME`, an alias of a non-registry target — reported even on an optional peer, since the manifest read itself fails); and `workspace:`/`catalog:` unless pnpm, Yarn, or Bun is running the pack and will rewrite them; a fetchable-but-unfetched `optionalDependencies` entry warns rather than fails, since npm continues without it (an unparseable one, or one a consumer install script runs, loads from an inline `node -e` program by `require`, `createRequire`, or `import()`, preloads with `node -r`/`--require`/`--import`/`--loader`, or loads from a packed file it executes — `node install.js`, `node .` through the root `main` — stays an error; each command after `&&`, `;`, or a newline counts on its own, shell quotes and backslash escapes are resolved, `node`'s options end at the program so `node install.js --require x` preloads nothing while a `NODE_OPTIONS=--require=x` assignment on the same command does, and `npm run <script>` delegates to the first positional alone — `npm run setup -- dormant` runs `setup`); an entry the tarball itself carries — a bundled dependency npm packed, or a `file:` path whose packed source is an installable package directory or tarball — is not reported — `agent-bundle prepack` prints such warnings and exits 0, and `prepack()` returns them on `PrepackResult.diagnostics`. Emitted `INSTALL.md` files now state that the bundle is self-contained, use the host's own `claude plugin` / `codex plugin` commands for uninstall, and mark every `agent-bundle install`/`uninstall`/`doctor` mention as optional automation. The `create-agent-bundle` `mcp-server` and `cli-tool` templates declare `@agent-bundle/runtime`, `react`, and `zod` under `devDependencies`. (#547)
- f06a91c: Project generated MCP tools into the framework-owned routed CLI with
  `routes.mcpCommands`. The in-house G7 implementation selects tools from the
  compiled route graph, merges them through the existing collision checks,
  accepts one JSON object through `--input`, enforces `--yes` for tools not
  explicitly annotated read-only, and preserves rendered Markdown, JSON,
  NDJSON, progress, schema validation, provenance, and the tool request
  contract without adding MCPorter or any other dependency.
- 3ae7721: Add the projection-contract proof levels to `agent-bundle/test` (#103 stage 2).
  
  Three levels join `route-unit`, each labeled in its result provenance and in
  every failure message, because a pass at one level is never a receipt for
  another:
  
  - `mcp-in-memory` — `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`,
    `getMcpPrompt`, and `listMcpSurface` drive the real generated MCP server with
    a real MCP client over the SDK's in-memory transport pair. Protocol-contract
    proof only: no process, no stdio framing, no packed artifact.
  - `cli-dispatch` — `invokeCli` runs an argv vector through the routed CLI's own
    shell (#102 stage 2) over the compiled command graph the manifest now
    carries, in-process. Command resolution, argv projection, help, `--version`,
    and the exit-code policy are the product's; the harness supplies only the
    `execute` bridge, and it mirrors the one the generated executable inlines.
    `cliJson` reads the canonical stdout line.
  - `packed-stdio` — `openPackedMcpServer` spawns a built artifact's generated
    stdio entry and connects a real MCP client to it. This is the only level here
    that is process evidence.
  
  `renderRouteEvents` returns the ordered render-event stream alongside the final
  document, and `expectEvents` asserts over it. The default matcher
  (`toContainSequence`) is sequence-tolerant so a legitimate extra `progress` or
  `replace` frame cannot turn a passing render red, while a missing frame, a
  reordering, or a regressed ordinal still fails.
  
  The test manifest gains `cliCommands`, the compiled routed-CLI command graph
  from the same compiler pass, so the dispatch level never recompiles it.
  `expectDocument` gains `toContainContext` for the context nodes an event route
  returns to its host.
  
  Event routes now render with the props the public contract defines —
  `{ canonical, native, signal }`, the same unwrapping the generated Flight
  worker performs — instead of the raw invocation payload. A route written
  against `AgentEventRouteProps` previously received `undefined` for both.
  
  Internally, the generated MCP server's warm Flight host, route registration,
  and MCP projection move out of the entry template into the shared
  `agent-bundle/mcp-server-runtime` module the generated entry aliases, so the
  in-memory level exercises the artifact's own code rather than a second copy of
  it. Generated-entry behaviour is unchanged.
- 2119cee: Promote canonical `tool/failure`, `compact/before`, and `compact/after`
  event-route families across Claude Code, Codex, Cursor, and composite plugin
  artifacts with evidence-pinned envelope validation and fail-closed result
  projection.
- ee206d5: Promote the `file/change`, `config/change`, `task/create`, `task/complete`, and `agent/idle` canonical event-route families as Claude-only capabilities with their documented decision channels: `config/change` and `task/create` project deny as a top-level block decision, `agent/idle` projects deny as `continue: false` with a stop reason, while `file/change` and `task/complete` are observation-only with fail-closed errors explaining the host's side-effect-only and exit-code-only control models. Codex, Cursor, and portable carry dated `unavailable` rows per family.
- 8c541ad: Promote the `permission/request`, `permission/denied`, and `stop/failure` canonical event-route families. `permission/request` projects allow/deny decisions through the pinned PermissionRequest output contract on Claude Code and Codex (input rewrite stays fail-closed as reserved upstream); `permission/denied` and `stop/failure` are observation-only Claude families with fail-closed rejection of decision or context output. Codex permission-request wire schemas are byte-pinned from the rust-v0.147.0 tag; hosts without a documented native event carry dated `unavailable` capability rows.
- 36ec507: Promote canonical `session/end` and `prompt/submit` event-route families across
  Claude Code, Codex, Cursor, and composite plugin artifacts. Keep both families
  route-only, validate their native envelopes, and fail closed when a rendered
  result requests a host output channel that the pinned contract cannot express.
- dee724f: Type project-defined context providers without a compiler change per
  provider. `AgentProviderValues` is now an augmentable interface (string index
  of `unknown` plus the optional framework-owned `processLifetime`, exported as
  `AgentProcessLifetime`), and the generated `.agent-bundle/routes.d.ts`
  declares `AgentBundleProviders` / `ProviderKey` / `ProviderValue<Key>` from
  each conventional `src/providers/*` factory's awaited return type and augments
  `@agent-bundle/runtime` so `(await agent()).providers.<key>` observes that
  type. Provider-free graphs emit no augmentation; a graph with providers but no
  executable routes keeps the declaration file.
- fe855fd: Export the `CapabilityRow` and `HostCapabilityTable` capability-table types. (#626)
- ed06db0: Compile generated MCP route servers through a warm final-only Flight dispatcher and emit deterministic route types.
- d84b0aa: Record Claude plugin-agent capability and native validation evidence while keeping agents directory emission deliberately deferred by the G5 gate.
- 27b3b99: Record Claude package, cache, substitution, and persistent-data lifecycle contracts, and reject path tokens from undocumented MCP and LSP fields.
- 7050026: Move invalid `--port`, `--trials`, `dev --install-host`, and install or uninstall `<host>`, `--mode`, and `--scope` values in the `agent-bundle` CLI away from `AB5000` diagnostics and exit code 1 to Commander usage errors and exit code 2. (#615)
- a8e78e4: Read-only host discovery: `/api/discovery` dev route over the install doctor and the Workbench Hosts page.
- ef1bcdf: Expose a recipient-scoped, read-only notice inbox through generated stateful
  MCP servers. Inbox reads record bounded availability and observed re-read
  evidence without acknowledging notices or marking delivery attempted; stateless
  projects emit no inbox resource or related runtime imports.
- 2314594: Record dated deferral rows for every explicitly deferred native host callback from the #258 v2 tracker in a new `deferredNativeEvents` capability-table section: Claude host/UI/protocol callbacks (Setup, UserPromptExpansion, PostToolBatch, MessageDisplay, InstructionsLoaded, CwdChanged, DirectoryAdded, Pre/PostModelSwitch, Elicitation and ElicitationResult, WorktreeCreate/Remove, Notification which belongs to #99 delivery evidence, and the policy_settings exception to config/change blocking), Cursor tab/thought callbacks and the tool-selector native variants, and Codex Interrupt. A pin test enforces the list and the dated reasons.
- c6db0ff: Remove the release audit gate: the `audit:release` script that ran `scripts/audit-packed-release.mjs` (external consumer install, npm advisory and signature checks, CycloneDX SBOM, LICENSE/NOTICE tarball checks) is replaced by `lint:release`, which runs publint and attw only, and the packaged README no longer states that the release gate fails on missing license files (#487)
- 0131bc6: Exercise rendered CLI command routes through the public `cli-dispatch` test
  harness. `invokeCli` now mirrors the generated executable's render session,
  supports explicit TTY projection through `tty`, and exposes `cliNdjson` for
  asserting ordered rendered event streams.
- 21af4ce: Add `request.lineage` to `AgentRequestContext` on every surface (event routes, generated MCP tools, routed CLI, rendered scripts): `{ conversation, root, parent?, depth, generation?, subagent?, resolution }` resolved by the new runtime-held agent lineage registry (`@agent-bundle/runtime/lineage`, journaled through the state kernel beside workspace-durable project state) that the `agent/start`/`agent/stop` and `tool/before`/`tool/after` families feed, with hook→MCP correlation from Claude `claudecode/toolUseId`, Codex `x-codex-turn-metadata`, and Cursor's open `MCP:<tool>` pre-tool hook. Unavailable lineage carries a typed reason (`no-subagent-events`, `id-not-resolvable`, `cloud-agent-no-user-hooks`, `no-shared-runtime`, `unsupported-surface`, `not-provided`); every pinned capability table gains dated `lineage` rows, the Workbench Lifecycles view shows the lineage axis and chain, and `openInMemoryMcpServer` accepts `lineage`/`lineageHost`. Claude `PostToolUse` event routes and `afterTool` hooks now accept the plain-string `tool_response` that MCP tools deliver (any present JSON value, as on Codex) instead of failing with `native tool_response must be an object`; no diagnostic codes are added or changed. (#421)
- d25a9c6: Harden the Codex plugin manifest, MCP probe reports, Doctor endpoint scans, CLI
  help, and scaffolded README install instructions (#397).
  
  - Reject line terminators, control characters, and backslash-form parent
    segments in the pinned Codex `plugin.json` `screenshots` paths, matching the
    component and interface-asset patterns; a manifest that relies on them now
    fails `AB6012` (pinned-schema rejection) and `AB6032` (Codex host validation)
    instead of validating. The Codex adapter is revision `1.9.0` and the composite
    `plugin` adapter `1.24.0`.
  - Admit any-JSON `tool_input` on `permission/request` event envelopes only for
    the `codex` target, whose pinned schema declares it; `claude` envelopes keep
    the documented object requirement.
  - `agent-bundle build --help` and `agent-bundle prepack --help` now state the
    `artifact` default for `--output` that those commands actually use.
  - Workbench MCP probe reports keep `http(s)`/`ws(s)` documentation links while
    masking URL userinfo (`scheme://user:secret@host`) through the final authority
    delimiter, and fail closed on local-resource URIs such as `unix:///…` or
    `vscode://file/…` and on every other `scheme://…/…` form. Plugin-data
    directories are removed only after the transport teardown settles (bounded by
    a 10 s cap, with one fenced retry when a still-exiting child held the
    directory), a synchronously throwing `close()` no longer skips cleanup, a
    timeout's transport close is reused rather than duplicated, and Workbench
    shutdown (`server.close()`) joins in-flight probes and their detached
    cleanups.
  - `agent-bundle doctor` probes runtime socket and lock endpoints eight at a
    time, so a directory of silent runtimes is bounded as a whole instead of
    costing one timeout per endpoint.
  - `create-agent-bundle` renders README install instructions for the selected
    `--targets` (one `npx <bin> install <host>` line per installable host) instead
    of a hard-coded `install claude`; portable-only scaffolds explain that no
    installer bin is generated and name the `package.json` `bin` entry to restore
    alongside the config target to get one.
- 66a7961: RFC #50 Phase 2, framework side. `validate`/`inspect`/`build`/`dev` now
  report informational migration nudges (never errors — migrations stay
  optional): `AB4730` for a self-connecting stdio MCP entry that a
  default-exported factory would upgrade to the framework lifecycle shell, and
  `AB4731`/`AB4732`/`AB4733` when `src/cli.ts`, `src/index.ts`, or
  `src/mcp/<server-id>.ts` is present but shadowed by explicit configuration.
  `agent-bundle inspect --bundler` dumps the synthesized Rslib/Rsbuild
  configuration for every generated output — artifact scripts, MCP entries,
  hook wrappers, MCP App views, and the `dist/` package build — post-`tools`-
  hatch merge with the invariant hook visible, composed by the same functions
  the build lowers so the dump cannot drift. `agent-bundle dev` extends the
  debounced, serialized rebuild pass to the framework-owned package build:
  `dist/` bin/lib outputs rebuild when their provenance-tracked inputs change,
  and a package build failure surfaces as one `AB7103` warning without
  invalidating the committed artifact epoch. New `docs/diagnostics.md`
  reference documents the diagnostic families and the new codes.
- a7d42cf: Statically extract each route module's `config` export into the route-graph IR (#93, PR-2).
  
  - Extraction is a real TS/TSX parse (TypeScript compiler, module never executed) of a single top-level `export const config = <expression>` declaration. The accepted grammar: object literals with identifier/string/numeric property names, array literals without spreads or holes, string and substitution-free template literals, numeric literals with optional unary `+`/`-`, `true`/`false`/`null`, and `as`/`satisfies`/non-null/parenthesis wrappers. The grammar is documented in `docs/diagnostics.md`.
  - Rejections are named errors beside the compiled route, never silent choices: `AB4805` for a rejected declaration shape (`let`/`var`, destructuring, indirect `export { config }`, function/class, missing initializer, non-object value) and `AB4806` for a dynamic initializer, naming the offending construct and position. The route compiles with the shared empty config in both cases; a module without a config export compiles silently.
  - The graph digest now covers extracted configs, and `agent-bundle inspect --routes` surfaces them per route. Still consumer-invisible: no public authoring surface changes.
- 7857add: Compile the conventional route tree into an immutable route-graph IR (#93, PR-1) and expose it through `agent-bundle inspect --routes`.
  
  - Discovery covers `src/mcp/<server>/{tools,resources,prompts,apps}/*.{ts,tsx}` (direct children per MCP kind), `src/events/<family>/*.{ts,tsx}` (`event:<family>/<name>`), `src/providers/*.{ts,tsx}` (a separate provider collection), and nested `src/cli/**` / `src/scripts/**` identities. Project ignore rules, private `_`/`.` segments, and `*.d.ts` files are skipped. Modules referenced by explicit `scripts`/`hooks`/`bin`/`lib`/`mcp` configuration are claimed by that declaration and never become routes, so existing layouts (for example `scripts` entries under `src/scripts/`) stay route-free without a migration.
  - The graph is deep-frozen, every route carries `config: {}` until the config extractor lands (PR-2), and the graph digest covers project-relative identity only, so equal trees hash equally on every machine.
  - Collisions are hard errors, never silent choices: `AB4800` (routed MCP server vs existing entry claim), `AB4801` (`src/cli.ts` vs `src/cli/`), `AB4802` (duplicate route id), `AB4803` (unsafe identity segment), `AB4804` (invalid `routes` mode override). Explicit `routes.servers.<id>` (`generated`/`custom`/`command`/`remote`) and `routes.cli` (`generated`/`conventional`) overrides resolve conflicts; without one, the conflicting surface keeps its discovered routes in `conflict` mode beside the error.
  - `discoverProject` attaches the graph only when it is non-empty, `validate` surfaces its diagnostics, and `inspect({ focus: 'routes' })` / `agent-bundle inspect --routes` dump the compiled graph like the bundler focus. `CapabilityState`/`CapabilityEvidence` types ship with the IR; population follows with the host-component work (#100).
- 6901324: Route catalog and MCP prefill correctness fixes from post-merge review: CLI
  usage summaries mark repeatable named options with the same ` ...` operand
  suffix the generated help prints; optional booleans without a schema default
  keep an unset state (a three-state omitted/true/false control) instead of
  submitting an explicit `false` the handler can observe; and a stale
  Routes-page prefill naming a tool the server no longer advertises surfaces a
  missing-tool notice instead of silently attaching the prepared arguments to
  the first advertised tool.
- 1d1623b: Compile `src/cli/**` routes into a routed CLI (#102 stage 2). Conventional
  command routes now compile into one collision-checked command graph —
  path nesting is identity (`src/cli/library/audit.ts` runs as
  `<bin> library audit`), the static `config` export supplies description,
  aliases, positionals, and the exit-code policy, and a bounded, documented
  zod grammar projects each route's `inputSchema` onto argv (options,
  positionals, arrays, defaults) with named `AB4814` diagnostics for
  constructs outside it. The graph feeds the existing package-build pipeline
  as one generated Rslib executable named after the plugin, superseding the
  `src/cli.ts` bin convention for that project; commands run inside the typed
  Agent request context, write one canonical JSON line to stdout, accept
  `--json`, and map exit codes deterministically (0/1/2, 130/143 on signals).
  Command-tree and alias collisions, contract violations, and rendered
  (`.tsx`) command routes fail source validation with the new
  `AB4813`–`AB4816` diagnostics instead of building silently.
- d67f84c: Correct Workbench route usage summaries, retain externally packaged MCP server
  surfaces in the Routes catalog, and cover the stale-manifest repair flow in
  real-browser acceptance.
- 7e447b5: Build on Rslib 1.0 and Rsbuild 2.2 so a project installs one Rspack engine and one native
  binding instead of two; `create-agent-bundle` templates pin `@rstest/core` 0.11.12. Plugin
  builds stay self-contained (`output.autoExternal: false`, Node builtins the only externals) and
  keep `new URL(…, import.meta.url)` and `new Worker(new URL(…))` expressions verbatim.
  `agent-bundle inspect --bundler` lowers in production mode regardless of `NODE_ENV` and shows the
  new `bundlerChain` invariant beside `tools.rspack`. Published `.d.ts` files (`agent-bundle`,
  `@agent-bundle/runtime`) now import their siblings with `.js` specifiers; every `exports` entry
  resolves as before. (#575)
- 0f66bc4: Bump the published `@rslint/core` dependency from 0.8.1 to 0.8.2, keeping the
  diagnostic service on the current rslint patch line. The workspace lint pass
  is unchanged under the new version.
- 853872e: Expose warm-runtime availability and add a read-only event IPC status verb
  that carries runtime identity through Doctor and Workbench discovery.
- cf02915: Stop dropping host messages relayed to a Runtime App during its initialize
  handshake. The dev-server client-surface relay forwarded host-to-app
  traffic only once the App had reported `ui/notifications/initialized`
  (plus the initialize response itself) and silently discarded anything
  earlier, so a host request that raced the handshake — observed as
  `ui/resource-teardown` on contended runners — could never be answered.
  The relay now queues up to 32 validated host messages during the handshake
  and flushes them once the App initializes; the queue survives an HMR entry
  reload so a request sent to a retiring App instance is answered by its
  replacement.
- 101e70b: Project conventional route `inputSchema` exports into a deterministic,
  deep-frozen JSON Schema subset without executing route modules (#105 stage 2).
  Supported zod object, scalar, enum, array, optional, default, description, and
  validation-only chains now travel through `CompiledRouteGraph` and the route
  manifest as an optional `inputSchema` field. Rich schemas remain valid and
  simply omit the projection; CLI routes retain their existing `AB4814`
  diagnostics and argv behavior.
  
  The Workbench Routes page renders generated scalar, enum, boolean, and
  repeatable-array editors with defaults, descriptions, required markers, and
  client-side validation. Unprojectable schemas receive an explicit raw-JSON
  fallback. Valid tool input can be handed to the existing MCP playground as a
  prefilled server, tool, and arguments selection without auto-execution, while
  valid CLI input produces a copyable argv invocation.
- 54e4c4c: Fix installed-host verification to reject integrity failures before spawning
  an MCP command, distinguish simulated staging from real host-install proof,
  and accept artifacts that declare no resources or hooks. Preserve caller-owned
  progress handlers while the contract matrix observes lifecycle notifications.
- 9dc12bc: Add the seven v1 semantic event-route descriptors and the `Agent.Context`
  document vocabulary used for immediate host guidance.
- e98a711: Add stage 3 semantic lifecycle replay: authenticated dev-server lifecycle replay routes, single-sourced native event validation, and the Workbench lifecycle page.
- afe54e2: Serialize Linux event-runtime orphan claim reclamation behind an automatically released kernel gate, and reclaim claims owned by zombie processes.
- d9abeb7: Fix `agent-bundle serve-app` (and `serveApp`) showing the "ordinary tool result" fallback with `AB8010: Request body exceeds 64 KiB` instead of the App when the opening tool's result is large, and give a served App one scrollbar instead of three nested ones (the host page, the MCP App sandbox document, and the Runtime App surface proxy no longer scroll around it). (#565)
- 6f10d7c: Keep Doctor socket fixtures reliable under long local-CI temporary directory names by deriving short, isolated Rstest worker roots.
- 6baf597: Compile one Skill source into a canonical IR with a typed plugin-surface token registry and closed per-host lowering (#108).
  
  Portable `SKILL.md` stays a byte-stable pass-through when no host extension or placeholder requires target-specific output. Claude, Cursor, and Codex receive only schema-legal documents (Claude frontmatter extensions, Cursor path/invocation fields, Codex `agents/openai.yaml`); unsupported tokens and unknown fields fail with AB3006–AB3010. Shared-vs-per-host `skills/` layout is an inspect-visible evidence decision for #101, not a hard-committed install tree. Rendered skills keep the existing `SKILL.tsx`/`SKILL.ts` build-time path — no live Flight client.
- 77ca3a9: Keep opt-in Claude, Codex, and Cursor development installs synchronized with each successful dev epoch so hosts pick up changed Skills, Hooks, MCP Apps, and manifests without reinstalling.
- 0d2561d: Render standalone event routes through a local react-server Flight worker while
  preserving each host's native hook input and output envelopes.
- 4788a65: Expose normalized state lifetime, driver, budgets, and durability details in the compiled route manifest for a read-only Workbench catalog.
- 1791401: Expose declared state lifetime, driver, budgets, and provenance through
  `agent-bundle inspect --state`, and add read-only durable SQLite store
  inventory to `agent-bundle doctor`.
- abf73be: Keep generated package-relative installer paths statically analyzable when plugin projects build through a packed `agent-bundle` dependency.
- be33352: Record Claude Code distribution, managed-policy, and CLI lifecycle boundaries as dated capability evidence without claiming compiler control over host installation behavior.
- f70d7fc: Ship type declarations that reference only packages a consumer can resolve: `dist/events/ipc.d.ts` no longer imports `zod` (`EventRuntimeAvailability` keeps the same `'available' | 'runtime-restarted' | 'runtime-unavailable'` union) and `dist/routes/input-schema.d.ts` no longer imports `typescript-5`, so a consumer type-checking with `skipLibCheck: false` never has to resolve an `agent-bundle` devDependency. The release gate enforces this from now on: `pnpm lint:release` runs `scripts/check-declaration-imports.mjs --strict`, so a devDependency or undeclared package imported from any packed `.d.ts` — internal declarations included, not only those reachable from `exports` — fails the gate instead of printing a warning. (#586)
- bf04ae1: Reject two MCP App routes of one generated server that declare the same static `config.resourceUri` with the new `AB4829` diagnostic, naming both route files and the server, instead of registering whichever route was discovered first; the same URI on App routes of different servers still passes, since each generated server registers only its own Apps. Sweep staging files (`.<epoch>.stage-<pid>-<nonce>`) that an exited native Playground catalog publisher left orphaned on the next catalog publication: only singly linked entries of another epoch in the publisher's own directory are removed, a live winner's hard-linked staging entry, a running publisher's file, and foreign files are kept, and the sweep is bounded per publish (#430)
- 6a44907: Add explicit target-capability fixtures to `agent-bundle/test`.
  
  `createTargetCapabilityFixture()` records support or denial for image, audio,
  resource, and progress projection while keeping text as the always-supported
  baseline. `projectTargetCapabilities()` projects a real `renderRouteEvents()`
  result through the runtime's MCP projector, preserving its rich-content
  fallback and fail-closed behavior without claiming transport, packed artifact,
  or host proof.
  
  `expectDocument()` now includes field-aware assertions for image, audio, and
  resource nodes.
- 0f700a3: Mount conventional request context providers (`src/providers/*`) in the `agent-bundle/test` harness for every manifest-backed call — `renderRoute`, `renderRouteEvents`, `invokeCli` (plain, rendered, and projected MCP commands), `openInMemoryMcpServer`, and `invokeMcpTool` — exactly as the generated request scopes do: same deterministic key order, same surface-specific `invocation`, same fail-closed factory errors, and a `providers.processLifetime` scoped like the artifact's (fresh per `invokeCli` call and per `renderRoute` render, shared across one open in-memory MCP session). Pass `context.providers` to mount an explicit fixture map instead; `context` and its `providers` stay optional even once the generated `.agent-bundle/routes.d.ts` augmentation declares provider keys (`HarnessOptionsArguments`, `RenderRouteContextInit`), while an explicit map must carry every declared key and a direct `runAgentRequest` still requires `providers`. Provider modules are evaluated once per test worker, so module-level provider state is shared across simulated executables; prove cold state through the proof levels that spawn the artifact. Hand `renderRoute` providers and the request scope the executable surface the artifact records (a routed CLI command's space-joined path, a script's path-derived name) instead of the route id, and mount an event route's compiled id (`event:tool/after`) as `invocation.operationId` in the generated Flight worker, matching the hook shell, lifecycle replay, and harness. The test manifest gains `providers`, the generated Rstest setup registers provider loaders (test registry version 4), and a project whose setup predates that registration fails with the `manifest-unavailable` harness error naming the provider. (#399)
- d8ab71d: Bind route-unit test loaders to the manifest that produced them, so rendering
  against an explicit manifest can no longer execute the registered project's
  module for a colliding route id. `expectDocument().toHaveValue()` now separates
  a document that emitted no value from one whose value is `null`, `renderRoute`
  records request-scoped progress even when the caller supplies its own reporter,
  and the generated registry's version is validated where the helpers read it
  rather than only in `registerTestRoutes`.
- ccc8ef4: Validate emitted Agent Skills for the pinned specification's required Markdown instruction body and document the `@skill-tools/core` provenance decision.
- 0d4a37c: Export `createAppClient` from `agent-bundle/app` with generated `AppRegister` route contracts, make `createMcpAppBridge` validate bound route ids, cancel App-owned requests, and reject duplicate request ids, and reword `AB4837` to name Apps as the bundle-safe exception. (#601)
- 979738e: Expose the transport-installed `AgentRequestContext` as optional
  `context.request` to `defineOperation` handlers while preserving the same
  request handle returned by `agent()`. Identity axes remain honest `Observed`
  values with typed unavailable reasons when a transport cannot know them.
  
  Document `await agent()` as the route-component context contract and the
  `renderRoute(..., { context })` identity-injection seam for tests. Business
  input cannot override host, session, actor, workspace, or capability context.
- ad3bd24: Type `renderRoute` and `renderRouteEvents` (`agent-bundle/test`) against the project's own routes: the generated `.agent-bundle/routes.d.ts` registers each route's harness contract on the new `Register` interface of `@agent-bundle/runtime`, so a string-literal route id is checked against the compiled ids, `input` is typed from the route's `inputSchema` (an event route's `{ canonical, native }` payload), and `result` from its `resultSchema` (`undefined` for event routes). Add `Register`, `RegisteredRoutes`, `RegisteredRouteContract`, `RegisteredRouteId`, `RegisteredRouteInput`, and `RegisteredRouteResult` to `@agent-bundle/runtime`, and `RouteTargetConstraint`, `RouteTargetInput`, and `RouteTargetResult` to `agent-bundle/test`; a program without the generated file keeps the previous `string` / `unknown` types. (#456)
- fc4d6b6: Make the generated `.agent-bundle/routes.d.ts` part of the TypeScript program by default and reject duplicated framework plugins. `create-agent-bundle` templates list `".agent-bundle/routes.d.ts"` in `tsconfig.json` `include` (the file stays gitignored), so `renderRoute` / `renderRouteEvents` type-check route ids, `input`, and `result` from the first build instead of degrading to `string` / `unknown` until the include is discovered in the docs; `agent-bundle validate` warns with `AB4834` when a project that compiles routes or providers has a root `tsconfig.json` whose program (resolved like `tsc -p`, including `extends` and one level of project `references`) leaves the published declaration out. `agent-bundle validate` (and every diagnostic-gated command) rejects a `tools.rsbuild.plugins` entry whose `name` matches a plugin the framework already registers (`rsbuild:react` from `@rsbuild/plugin-react`) with `AB4724`, because `plugins` arrays concatenate and Rsbuild never dedupes plugins by name, so the plugin would otherwise run twice. (#497)
- 904e6bf: Cut artifact validation time in `agent-bundle build` and `agent-bundle validate --artifact` without dropping a check: modules the framework compiled (manifest kind `bundle`) are no longer re-parsed in full with `acorn` to prove they are JavaScript — the ESM lexer that drives the import-graph walk is their only syntax pass, while copied and generated modules the framework did not compile keep the full parse, as do all bundles of a build whose `tools` hatch could have rewritten the emitted assets — and each module's imports are read once per process by the digest of the bytes actually read, so the post-compile self-containment check and the two validation passes of one build share one lex. `AB6005` codes and messages are unchanged; `validate --artifact` results are identical for every emitted artifact. `examples/host-test`: build 40 s → 12.5 s, `validate --artifact` 17 s → 3.6 s; `examples/audiobook-curator`: build 12.7 s → 6.8 s. (#521)
- 69c20ab: Generated MCP tool, resource, and prompt request scopes now observe native client, session, and authenticated actor identity alongside a derived process workspace, then forward those axes into the Flight worker while preserving typed unavailability when a transport omits them.
- 36f52c5: Assert stable warm-runtime identity and compiled state catalogs at packed and installed-host contract-matrix boundaries.
- 61fc4a9: Prevent delayed duplicate filesystem events from triggering redundant development rebuilds when the watched path has not changed.
- 4edbd49: Close a Workbench MCP App preview immediately when its sandbox proxy has not loaded yet: closing the preview (or switching its profile, deactivating the MCP page, or ending the session) before the proxy signals readiness now releases the binding at once instead of posting a teardown no window can acknowledge and holding the preview in its closing state for the full five-second force-close budget (#435)
- 84b2ca7: The Workbench route input editor migrated its coordinated local state to
  `@effect/atom-react` atoms keyed by manifest digest and compiled route id,
  preserving typed and raw validation behavior while releasing state on unmount.
- 4d84f84: The Workbench Agent Document panel migrated its hand-rolled request state to
  `@effect/atom-react` atoms keyed by run id under a root `RegistryProvider`,
  keeping the strict zod decoding and imperative client lifecycles unchanged.
- 59e6f46: Workbench connection gate and Overview rebuild alert: show the foreground diagnostic code and message — `AB8003 — Origin http://localhost:3000 is not allowed by the foreground server at http://127.0.0.1:3100. Open http://127.0.0.1:3100 instead, or start agent-bundle dev with --workbench-dev-origin http://localhost:3000 to allow this origin.` — with an `(HTTP <status>)` suffix only when the foreground response itself failed, instead of the misleading `Workbench request failed with HTTP 200.` (#589)
- b75073b: Workbench MCP page: launch the standalone MCP Inspector and open it in a new tab, deep-linked to the selected session; launch failures surface `AB8112`/`AB8113` inline (#579)
- 0e3c444: Expose credential-free request provenance for Workbench lifecycle replays, including explicit host, session, actor, workspace, and invocation axes with typed absence. Lifecycle routes now execute under the same receipt-sourced context shown in the Workbench, and the strict client decoder rejects unsupported wire fields.
  
  Deprecate `plugin.version` in favor of package identity. Compiled MCP App routes now consume compiler-stamped `agent-bundle/meta` identity, while the prebuilt RSC example centralizes its host slug and derives its release version from `package.json`, so runtime registries and App modules no longer restate project identity.
- e542840: Compose every synthesized bundler config through one shared layering (`profile` → `tools.rsbuild` → `tools.rspack` → framework invariants), so a `tools` escape-hatch value reaches the MCP Apps Rsbuild config exactly as it reaches artifact scripts, hooks, MCP entries, the routed CLI bin, and the package build, and `output.cleanDistPath` stays off on every path. No artifact or `inspect --bundler` output changes. (#495)
- e3473e6: Compile every agent-host surface of a target — the routed CLI bin, bundled scripts, hook wrappers, MCP stdio entries, and their react-server Flight workers — through one Rslib instance per target instead of one instance per surface, with the optional browser MCP Apps stage ordered first only for targets that declare App routes; `agent-bundle build`, `dev`, and `prepack` emit byte-identical artifacts with the same manifest source inputs while spending less time in bundler setup and stats collection (#503)
- 45feab5: Carry the route registration that `.agent-bundle/routes.d.ts` places on `@agent-bundle/runtime`'s `Register` through the rest of the public API, not only `renderRoute`, the way TanStack Router's one `Register` reaches `Link to`, `useNavigate`, and `RoutesByPath`. In `agent-bundle/test`, `invokeMcpTool` and `getMcpPrompt` now check a literal wire name against the registered tool/prompt names and type `input` from that route — of the literal `server` when one is passed, which is itself checked against the compiled server names (`McpInvocationOptions<Input, Server>`, `McpRouteNameConstraint`, `McpRouteInput`, `McpServerConstraint`, `McpRouteServer`); the `fixtures` of `runContractMatrix`, `runPackedContractMatrix`, `runDevEpochContractMatrix`, and `runInstalledHostContractMatrix` type each registered key's `input`, `inputs`, `cancellation.input`, and lifecycle transitions (`ContractRouteFixtures`, `ContractRouteFixture<Input>`, `ContractLifecycleFixture<Input>`, `ContractLifecycleTransition<Input>`) while MCP App keys and dynamic records stay legal; and `invokeCli` reports `CliInvocation.routeId` as a `RegisteredRouteId` (`argv` is unchanged). In `agent-bundle/eval`, `expectMcpCall` and `expectNoMcpCall` check a literal `tool` against the registered tools of a literal project `server` (`ExpectMcpCallOptions`, `ExpectNoMcpCallOptions`, `EvalMcpToolConstraint`); third-party servers stay free. `@agent-bundle/runtime` adds `RegisteredMcpRouteKind`, `RegisteredMcpServerName`, `RegisteredMcpRouteName`, and `RegisteredMcpRouteId` for the server and protocol names a registered id encodes. Type-only: nothing changes at run time, and every surface keeps its `string`/`unknown` shape when no project has registered. (#494)
- Updated dependencies [4155831]
- Updated dependencies [2841419]
- Updated dependencies [42539ff]
- Updated dependencies [10e217e]
- Updated dependencies [adb25b4]
- Updated dependencies [43d787f]
- Updated dependencies [a69673b]
- Updated dependencies [a2d1795]
- Updated dependencies [017961f]
- Updated dependencies [a391791]
- Updated dependencies [5d5c9c9]
- Updated dependencies [9551498]
- Updated dependencies [833e48f]
- Updated dependencies [6b74fc6]
- Updated dependencies [6c8b1a8]
- Updated dependencies [7404daa]
- Updated dependencies [7404daa]
- Updated dependencies [7404daa]
- Updated dependencies [7404daa]
- Updated dependencies [4daf388]
- Updated dependencies [3c963e9]
- Updated dependencies [766e824]
- Updated dependencies [48c89c1]
- Updated dependencies [98cc244]
- Updated dependencies [75e1a53]
- Updated dependencies [43abb2d]
- Updated dependencies [88eb4b9]
- Updated dependencies [d691cdb]
- Updated dependencies [b4afb74]
- Updated dependencies [3e891ac]
- Updated dependencies [8b75a6c]
- Updated dependencies [aad35b3]
- Updated dependencies [d63dd3b]
- Updated dependencies [12526a8]
- Updated dependencies [67730f4]
- Updated dependencies [02d2e37]
- Updated dependencies [e131071]
- Updated dependencies [941aa08]
- Updated dependencies [2e91ea1]
- Updated dependencies [f469376]
- Updated dependencies [77aadd2]
- Updated dependencies [ed44cd5]
- Updated dependencies [055edf1]
- Updated dependencies [56b77db]
- Updated dependencies [78cc1fb]
- Updated dependencies [23ee0f5]
- Updated dependencies [6a2b341]
- Updated dependencies [dee724f]
- Updated dependencies [ef1bcdf]
- Updated dependencies [7abd6b5]
- Updated dependencies [f81ff04]
- Updated dependencies [9df37f8]
- Updated dependencies [21af4ce]
- Updated dependencies [b3c12f3]
- Updated dependencies [62138ef]
- Updated dependencies [77aadd2]
- Updated dependencies [77aadd2]
- Updated dependencies [cf94ccc]
- Updated dependencies [baed7d8]
- Updated dependencies [7e447b5]
- Updated dependencies [853872e]
- Updated dependencies [99eb375]
- Updated dependencies [9dc12bc]
- Updated dependencies [43a39ad]
- Updated dependencies [e3fee71]
- Updated dependencies [d024e81]
- Updated dependencies [f45ae75]
- Updated dependencies [ae7722c]
- Updated dependencies [48cdcd2]
- Updated dependencies [33f8651]
- Updated dependencies [979738e]
- Updated dependencies [ad3bd24]
- Updated dependencies [746a7ac]
- Updated dependencies [45feab5]
  - @agent-bundle/runtime@0.1.0
