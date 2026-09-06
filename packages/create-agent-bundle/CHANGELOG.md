# create-agent-bundle

## 0.1.0

### Minor Changes

- 62b69c0: Emit one composite plugin root: `agent-bundle build` writes a single directory at the artifact output and `targets` (`claude`, `codex`, `cursor`, `portable`; default `portable`) selects which host projections it carries, so there is no `artifact/<host>` partition — host manifests sit in their dotfolders at the root (`.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `plugin.json`), Codex and Cursor hook/MCP documents move beside their manifests (`.codex-plugin/hooks.json`, `.codex-plugin/mcp.json`, `.cursor-plugin/hooks.json`, `.cursor-plugin/mcp.json`; `AB6027`, `AB6032`, and `AB7320` name those paths), and `skills/`, `hooks/`, `mcp/`, `scripts/`, `bin/`, and `INSTALL.md` are emitted once, with `install.mjs` beside them whenever `cursor` or `portable` is selected. A hook shared by several selected hosts compiles to `hooks/<name>.<host>.mjs` per host, each wrapper baking its own host, so generated hook wrappers no longer read `AGENT_BUNDLE_HOOK_HOST`; compiled MCP entries, scripts, and CLI bins are attributed to the sorted composite identity (`claude+codex`), and reordering `targets` yields byte-identical output. Remove the `plugin` target: `targets: ['plugin']` and `--target plugin` fail with `AB4100`, the generated `AGENTS.md` is gone, `create-agent-bundle --target` accepts only the four hosts, and the advanced-registry hooks `TargetAdapter.lowersConfigExtensions`, `TargetRegistry.lowersConfigExtension()`, and `NormalizationTargetRegistry.lowersConfigExtension()` are removed. Two selected projections planning one path with different bytes fail with `AB4103`; a command or rule scoped to a subset of the selected hosts that another selected host discovers conventionally (`commands/`, `rules/`) fails with `AB4105`; a selection that mixes an adapter registered on an advanced `TargetRegistry` with any other target fails with `AB4106` — `validate`, `inspect`, and `build` report all three on the same composite root. `agent-bundle install <host> --from <root>` and `doctor --from <root>` read the host manifest directly under the root (no `<root>/<host>` lookup; `AB7001` when it is absent), `mcp run`, `serve-app`, and `dev proxy --target <host>` resolve that host's MCP document in the same root, the `agent-bundle/test` `openInstalledHostMcpServer` harness reads the composite root as every host's bundle root, the warm event runtime's endpoint is identified by the artifact alone (its epoch and root directory, never the selection) with the invoking host carried on each hook request, each selected host reaching it through the first generated MCP server its own MCP document lists, the composite root's `INSTALL.md`/`install.mjs`, the `AB4106` refusal, and `--host-validation` judge the shipped host adapters by identity (an advanced `TargetRegistry` adapter named like a built-in host earns no install surface and is held to no host validator; `TargetRegistry.builtInHost()`/`builtInHosts()` expose the judgment), and `agentBundleBrowserRstest()` compiles every MCP App once for the project's whole selection while its `target` option names the host each app mounts as (default: the app's first declared target the project selects), `inspect --bundler` reports `distPath.root` as `<output>` with root-relative output paths and the composite identity as `target`, and the dev server, Workbench, and eval harnesses stage the composite root as one epoch (#578)
- 45beb54: Package the validated composite root as the npm root, point generated CLI bins at its manifest-declared executable, advance `agent-bundle.manifest.json` to version 3, preserve supported lifecycle assets and authored `AGENTS.md`, persist package-only compile evidence, reject unpublishable dependency protocols with `AB7015`, and report missing generated executables or lifecycle assets with `AB4767` and `AB4768`; rebuild and replace version 2 installs before managing them with this release (#656).
- 13210fd: New package: the `create-agent-bundle` scaffolder (RFC #50 Phase 3).
  `npm create agent-bundle` / `npx create-agent-bundle` emits a ready-to-run
  plugin project from one of three checked-in templates — `minimal`
  (skills-only), `mcp-server` (one conventional `src/mcp/<server-id>.ts`
  factory entry plus an artifact script), and `cli-tool` (the `src/cli.ts` bin
  convention plus a `src/index.ts` library export). Interactive prompts cover
  name, template, and host targets, with full non-interactive flags
  (`--template`, `--targets`, `--package-manager`, `--no-install`,
  `--framework-version`). Scaffolded projects pin `agent-bundle` to the
  pkg.pr.new preview of the same commit the scaffolder shipped from, carry a
  `check` gate (validate + build + typecheck + test), and validate with zero
  diagnostics, including the `AB473x` convention nudges.
- 8c8907e: Expose `./package.json` in the `exports` of `agent-bundle`, `rsc-markdown-stream`, and `create-agent-bundle`. `create-agent-bundle` gains its first `exports` map, so `create-agent-bundle/dist/**` deep imports no longer resolve — the CLI is reachable only through its `bin`, which is the breaking change behind its minor bump. Bound `agent-bundle`'s optional `@agent-bundle/runtime` peer to `>=0.0.0 <1` instead of `*`; drop `@modelcontextprotocol/server` from `agent-bundle`'s devDependencies (it stays a dependency) and the dead `!dist/workbench/**/*.map` entry from its `files`; gate releases on `attw --profile esm-only` for all three packed tarballs plus `scripts/check-declaration-imports.mjs`, which fails `pnpm lint:release` when a shipped `.d.ts` a consumer can reach imports a devDependency, an undeclared package, an unexported subpath of the package itself, or a `#` import its `imports` map does not resolve. (#568)

### Patch Changes

- e0ae9f0: Report routed-CLI input-validation failures in CLI terms instead of raw zod issue JSON, and route the first-party `agent-bundle` CLI's terminal I/O through Effect's `Terminal`/`Stdio` services. A generated executable (`dist/bin/<name>.js`, the artifact `bin/<name>.mjs`, and the `invokeCli` test harness) whose route `inputSchema` rejects the parsed argv now prints one line per issue — `Invalid value for --max-wait-ms: expected number <= 55000; received 300000.` naming the flag, `<positional>`, or projected-MCP `--input.<path>` — followed by the exact `Usage:` line and the `--help` hint on stderr, still exit 2; under `--json` stdout stays empty and stderr carries one canonical `{"error":{"code":"CLI_INPUT_INVALID","issues":[...],"usage":"..."}}` line, and `--ndjson` emits one `type: "error"` event. `CliInputError` from `agent-bundle/cli-entry` gains a typed `issues` list and a `cliInputError(command, input, error)` constructor. The `agent-bundle` CLI (`build`, `prepack`, `install`, `doctor`, `validate`, `eval`, `inspect`, `dev`, `mcp run`, help and version) writes user-facing text through `Terminal.display` and diagnostics/`--json` output through `Stdio`, provided once at the CLI root from `@effect/platform-node-shared` (`NodeTerminal`/`NodeStdio`, the package `agent-bundle` already depends on); `runCli` takes `{ services }` in place of the former stream injection. `create-agent-bundle --help` and its flag-error text go through the same services at its existing `NodeServices` root (Clack still renders the prompts). Protocol stdout (MCP stdio, hook results, emitted routed-CLI and installer shells) is unchanged. Fixes #465 (#505)
- 7404daa: Omit schema-less script routes from the generated route declarations, and make `create-agent-bundle` refuse local-tarball scaffolds whose `agent-bundle` and `@agent-bundle/runtime` identities disagree. (#168)
- e4e960a: Restore CLI cold-start time by loading the Effect terminal runtime lazily. `agent-bundle --version`, `--help`, and argv errors answer in about 60 ms again (they had regressed to about 300 ms) because the Effect `Terminal` / `Stdio` runtime is now built on a command's first write instead of before argv parsing; command output, `--json` documents, and diagnostics are unchanged. `create-agent-bundle --help` and flag errors no longer evaluate the scaffold bundle (Effect, the Node platform layer, Clack), about 70 ms → 40 ms. (#530)
- ccb9cd1: Scaffolded `agent-bundle.config.ts` no longer repeats the deprecated `plugin.version`; every template derives its release version from `package.json`, matching the #94 identity contract.
- b3e8320: Keep framework-only local scaffolds independent of runtime tarballs and reject framework specs that cannot safely resolve under the runtime package name.
- daa67c5: Validate every tar header when probing local framework tarballs, not only entries before `package/package.json`. Document the `src/cli.ts` → `src/cli/**` migration in the cli-tool template README so adopters avoid `AB4801`.
- 4c911b0: Scaffold through Effect's `FileSystem` and `Path` services (`@effect/platform-node`): every filesystem failure during `create-agent-bundle` now surfaces once, at the CLI boundary, with the same Node error text and exit codes as before; the published tarball grows from 33 kB to 110 kB. (#501)
- 63e5bd1: Document that artifact output roots remain project-contained even when the CLI
  overrides `output.distPath`. Omit generated installer bins from scaffolds that
  select no installable host, and make the default template install examples use
  a selected host.
- 954a44b: Validate paired local runtime tarballs before scaffolding begins and support npm registry framework versions, ranges, and tags.
- 298557d: Generate single-file MCP route modules with matching runtime dependencies.
- f469376: License: Apache-2.0 (previously unspecified/MIT-declared); LICENSE and NOTICE
  shipped in the tarball. Every package manifest now declares
  `"license": "Apache-2.0"`, the build copies the repository LICENSE and NOTICE
  into each publishable package, and `pnpm audit:release` fails if any
  publishable tarball is missing either file or the license field.
- a420de3: Reject the runtime's reserved notice-ledger state id during extraction, mount
  each missing route-unit binding independently when the caller overrides only
  one of state or noticeLedger, and document `zod` in the cli-tool migration
  steps.
- cbda5ab: Gate `agent-bundle prepack` on the installed-dependency fields of `package.json` so a published plugin installs only what its packed files need: `AB7014` reports a `dependencies`, `optionalDependencies`, or `peerDependencies` entry that no packed JavaScript imports, requires, resolves, or runs as an executable (a computed `import`/`require`, a packed file the ESM lexer rejects, or a `require` passed on as a value such as `const load = require`, withholds `AB7014` for the whole package; an installed manifest's `bin` is read as npm reads it, the last of duplicate keys winning), no packed declaration file references, and no `imports` mapping or consumer install script (including scripts it delegates to with `npm run` or `npm test`/`start`/`stop`/`restart`, `npm restart` without a `restart` script running `stop` and `start`) reaches — a warning rather than an error for a `peerDependencies` entry, which may be a deliberate host-compatibility contract — (the build inlines every dependency into `dist/bin` and the host packs, so a runtime external must be reached one of those ways; optional peers are skipped), and `AB7015` reports an entry a consumer's npm cannot resolve through a registry, judged by npm's own parser (`npm-package-arg`, now a dependency of `agent-bundle`): a git, GitHub-shorthand, remote-tarball, or path source, which npm 12 refuses to fetch by default (`allow-git`, `allow-remote`); a name or specifier npm cannot parse (`EINVALIDPACKAGENAME`, `EUNSUPPORTEDPROTOCOL` for `link:`, `portal:`, or a typo, `EINVALIDTAGNAME`, an alias of a non-registry target — reported even on an optional peer, since the manifest read itself fails); and `workspace:`/`catalog:` unless pnpm, Yarn, or Bun is running the pack and will rewrite them; a fetchable-but-unfetched `optionalDependencies` entry warns rather than fails, since npm continues without it (an unparseable one, or one a consumer install script runs, loads from an inline `node -e` program by `require`, `createRequire`, or `import()`, preloads with `node -r`/`--require`/`--import`/`--loader`, or loads from a packed file it executes — `node install.js`, `node .` through the root `main` — stays an error; each command after `&&`, `;`, or a newline counts on its own, shell quotes and backslash escapes are resolved, `node`'s options end at the program so `node install.js --require x` preloads nothing while a `NODE_OPTIONS=--require=x` assignment on the same command does, and `npm run <script>` delegates to the first positional alone — `npm run setup -- dormant` runs `setup`); an entry the tarball itself carries — a bundled dependency npm packed, or a `file:` path whose packed source is an installable package directory or tarball — is not reported — `agent-bundle prepack` prints such warnings and exits 0, and `prepack()` returns them on `PrepackResult.diagnostics`. Emitted `INSTALL.md` files now state that the bundle is self-contained, use the host's own `claude plugin` / `codex plugin` commands for uninstall, and mark every `agent-bundle install`/`uninstall`/`doctor` mention as optional automation. The `create-agent-bundle` `mcp-server` and `cli-tool` templates declare `@agent-bundle/runtime`, `react`, and `zod` under `devDependencies`. (#547)
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
- 7e447b5: Build on Rslib 1.0 and Rsbuild 2.2 so a project installs one Rspack engine and one native
  binding instead of two; `create-agent-bundle` templates pin `@rstest/core` 0.11.12. Plugin
  builds stay self-contained (`output.autoExternal: false`, Node builtins the only externals) and
  keep `new URL(…, import.meta.url)` and `new Worker(new URL(…))` expressions verbatim.
  `agent-bundle inspect --bundler` lowers in production mode regardless of `NODE_ENV` and shows the
  new `bundlerChain` invariant beside `tools.rspack`. Published `.d.ts` files (`agent-bundle`,
  `@agent-bundle/runtime`) now import their siblings with `.js` specifiers; every `exports` entry
  resolves as before. (#575)
- 7e4e588: Validate a local `file:` framework tarball for framework-only templates too, so a missing, corrupt, or misnamed archive fails the scaffold with a usage error instead of reporting the project ready with an unusable dependency.
- 0b46b02: Adopt framework-generated package installers and prepack inventory validation
  in the publishable CLI and MCP scaffold templates.
- 51907d6: Scaffold the minimal template's conventional Skill under `src/skills/`.
- a9d5c0b: Verify every tar header checksum when inspecting a local `file:` framework or runtime tarball, so an archive that inflates but is corrupt fails the scaffold instead of being reported ready. Relative `file:` specs are now resolved against the new project directory — the same base npm uses for the emitted `package.json` — rather than the CLI's working directory.
- d10b60f: Add `runScript`, `scriptJson`, `scriptNdjson`, and `inspectWorkbenchSurface` to `agent-bundle/test`, and move the `cli-tool` template onto the routed CLI. `runScript` (the `script-dispatch` proof level) runs a conventional `src/scripts/*` module through its generated executable's contract: a rendered `.tsx` script through the rendered-script shell with piped Markdown, TTY, `--json`, and `--ndjson` output and the project's conventional `src/providers/*` mounted with the `script` invocation (a `process.exit` in rendered code fails the run as the executable's shell reports its render worker's exit, never ending the test process), a plain `.ts` script as a Node process of its own with the `main` envelope, `process.exit`, exit code, stdout, stderr, optional `stdin`, and the compiled `agent-bundle/meta` identity (no `AB4760` outside a compiled surface); `testManifest().scripts` (a new required member of `AgentBundleTestManifest`, so a hand-built manifest literal must now supply it) lists only the compiled scripts that ship — a nested (`AB4808`) or configuration-conflicting (`AB4809`) conventional script is never a `runScript` target — and every failure names the script route, execution form, and proof level. `inspectWorkbenchSurface` (the `workbench-surface` proof level) returns the route manifest, grouped route catalog, state declaration, lifecycle-replay fixtures, and page availability the Workbench would show for a project, without a browser or dev server, and reports `manifest-unavailable` with the compiler's error diagnostics (for example `AB4100`) for a project the compiler rejects. `ScriptRouteProps` types rendered script components. `create-agent-bundle`'s `cli-tool` template replaces the hand-written `src/cli.ts` with a routed `src/cli/greet.ts` command and a conventional `src/scripts/hello.ts`, proved by a generated projection pool at the `cli-dispatch` and `script-dispatch` levels. (#398)
- 048bb8d: Scaffold the framework test harness with the `mcp-server` template (#103
  migration step 8).
  
  A new `mcp-server` project starts with two generated pools beside its plain
  module tests, each naming the proof level it carries and each reported
  separately, because a pass at one level is never a receipt for another:
  
  - `rstest.route-unit.config.ts` + `tests/route-unit/report-status.test.ts` —
    `testManifest()` for the compiled route inventory and clean compiler
    diagnostics, then `renderRoute` and `expectDocument` over the `report-status`
    route. Real renderer, no artifact, no transport.
  - `rstest.projection.config.ts` + `tests/projection/mcp-in-memory.test.ts` —
    `listMcpSurface` and `invokeMcpTool` against the real generated MCP server
    over the SDK's in-memory transport, asserting that the projected
    `structuredContent` is the same value the route rendered. Protocol-contract
    proof only: not a process, not the packed artifact.
  
  `test` now excludes both directories, `test:routes` and `test:projection` run
  them, and `check` runs all three pools.
  
  The `minimal` and `cli-tool` templates deliberately keep their plain tests: a
  skills-only project compiles no routes, and the `cli-tool` CLI is a
  config-declared script bundle rather than a compiled route, so a harness pool
  in either would pass without addressing anything. Both READMEs now document
  what the pools would prove and the exact wiring to add with the first route
  module.
- fc4d6b6: Make the generated `.agent-bundle/routes.d.ts` part of the TypeScript program by default and reject duplicated framework plugins. `create-agent-bundle` templates list `".agent-bundle/routes.d.ts"` in `tsconfig.json` `include` (the file stays gitignored), so `renderRoute` / `renderRouteEvents` type-check route ids, `input`, and `result` from the first build instead of degrading to `string` / `unknown` until the include is discovered in the docs; `agent-bundle validate` warns with `AB4834` when a project that compiles routes or providers has a root `tsconfig.json` whose program (resolved like `tsc -p`, including `extends` and one level of project `references`) leaves the published declaration out. `agent-bundle validate` (and every diagnostic-gated command) rejects a `tools.rsbuild.plugins` entry whose `name` matches a plugin the framework already registers (`rsbuild:react` from `@rsbuild/plugin-react`) with `AB4724`, because `plugins` arrays concatenate and Rsbuild never dedupes plugins by name, so the plugin would otherwise run twice. (#497)
