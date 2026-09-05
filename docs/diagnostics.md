# Diagnostics reference

Every agent-bundle failure or nudge is one structured diagnostic: a stable
`code` (`AB` + four digits), a `severity` (`error`, `warning`, or `info`), a
`message`, and usually a `sourcePath` and a `recovery` hint. The
diagnostic-gated commands (`build`, `prepack`, `validate`, `doctor`, `install`,
`dev`) exit nonzero only when an **error** diagnostic is present; warnings and
infos never gate a build, a validation, or a dev rebuild. `eval` and `inspect`
additionally exit `1` for a failing or inconclusive trial or an invalid model
even when no error diagnostic was reported.

## Code families

| Family | Area |
| --- | --- |
| `AB30xx` | Skill documents: Markdown parsing (`AB3000`–`AB3002`: unreadable, missing or malformed frontmatter) and rendered-skill compilation (`AB3003`: module failed to load, `AB3004`: missing/invalid default component or `frontmatter` export, `AB3005`: content outside the supported Markdown element subset). |
| `AB40xx` | Plugin metadata and Skill source validation (`AB4000`/`AB4001`: name/version; `AB4002`–`AB4007`: Skill fields; `AB4008`–`AB4011` and `AB4013`: release identity, see below; `AB4012`: declared `plugin.logo` is missing, not a file, or outside the project). |
| `AB41xx` | Normalized model invariants (unknown targets, duplicate IDs and outputs). |
| `AB42xx` | Hook configuration and native hook sources. |
| `AB43xx` | MCP server and MCP App configuration (`AB4340`: a declaration for a route-generated server redeclares `entry`/`command`/`url`; see below). |
| `AB44xx` | Script configuration. |
| `AB4500` | Registered config extensions (strict finite JSON). |
| `AB46xx` | Assets and the generated-runtime floor. |
| `AB470x` | Package build `bin` configuration (`AB4706`: artifact output overlaps `dist`; `AB4707`–`AB4709`: `output.distPath` shape, root escape, reserved namespace). |
| `AB471x` | Package build `lib` configuration (`AB4710`–`AB4715`) and declaration generation (`AB4716`; see below). |
| `AB472x` | The `tools.rsbuild` / `tools.rspack` escape hatch (`AB4720`–`AB4723`: shape; `AB4724`: a framework-owned Rsbuild plugin re-added through `tools.rsbuild.plugins`; see below). |
| `AB473x` | Migration nudges (informational; see below). |
| `AB474x`/`AB4750` | Prebuilt payloads and prebuilt entries (see below). |
| `AB4760` | The published `agent-bundle/meta` identity module evaluated outside every compiled surface and outside the Rstest presets (see below). |
| `AB4765`–`AB4766` | Artifact-hosted routed CLI: a target without the `cli` capability omits `bin/<name>.mjs`; a host-emitted file collides with it (see below). |
| `AB477x` | MCP App view compilation (`AB4770`: compile error with file, line, column and the bundler message; `AB4771`: compile warning; `AB4772`: emitted-size advisory; see below). |
| `AB490x`/`AB492x` | Conventional host components (#100 stage 2): rules `src/rules/*.mdc` (`AB4900`–`AB4908`) and commands `src/commands/*.md` (`AB4920`–`AB4928`), including per-host feature-set enforcement (`AB4907`/`AB4908`, `AB4927`/`AB4928`); see below. |
| `AB48xx`/`AB494x` | Route graph, state, layout (`AB4830`–`AB4832`), generated route declarations outside the TypeScript program (`AB4834`), route render budgets (`AB4835`), tool task support (`AB4836`), and provider conventions (see below). |
| `AB5000` | General CLI and adapter failures. |
| `AB60xx` | Built-artifact validation, including schema documents and referenced files (`AB6011`/`AB6012`: a target's required pinned-schema document is missing or invalid; `AB6025`: a manifest-declared `logo` path is missing from the artifact or escapes the deploy tree; `AB6034`: emitted Skill Markdown has no instruction body; `AB6035`–`AB6038`: Agent Plugins portable validation, see below). |
| `AB700x` | Host installation and uninstallation: bundle identity, host availability, scope, command failure, and collision checks (`AB7005`: version collision, pre-receipt content collision, or foreign install; `AB7006`: the host lists the installed copy with load errors; see below), plus the `uninstall` refusals `AB7007`–`AB7009` (ownership or content mismatch, unconfirmed data purge, missing receipt; see below). |
| `AB7010`–`AB7015` | npm prepack inventory, artifact freshness, package bin targets, release-version agreement, and installed-dependency hygiene (`AB7014`: a dependency no packed file references; `AB7015`: a git, remote-tarball, path, or unrewritten workspace-protocol dependency specifier). |
| `AB7200`–`AB7202`, `AB7210`–`AB7211` | Development rebuilds and live host surfaces: rebuild admission and phase failures, development host install sync, and the dev-epoch contract gate (see below). |
| `AB7xxx` | Project preparation and development rebuilds (`AB7100`–`AB7102`: a development rebuild's compilation, publication, and cleanup; `AB7103`: the development package build; see below). |
| `AB7300`–`AB7331` | Read-only install Doctor: host probes, installed inventory, bundle comparison and registration proof, runtime endpoint health and identity, durable-state inventory, static bytes-at-rest validation, foreign-install detection (`AB7321`; see below), Cursor plugin hook registration / marketplace staging (`AB7322`–`AB7324`; see below), host load refusal (`AB7325`; see below), the Cursor Agent Plugins launch proof (`AB7326`; see below), a disabled Claude install (`AB7327`; see below), lifecycle receipts and activation states (`AB7328`–`AB7330`; see below), and the operator `.env` layer of an installed pack (`AB7331`; see below). `AB7311` and `AB7325` are also emitted by `build` and `validate --artifact` from the Claude load check (see "Claude Code host validation"). |
| `AB8200`–`AB8209` | Workbench development runtime routes (`/api/runtime/**`): `AB8200` development runtime provider configuration, load, or lifecycle failure, `AB8201` runtime/session/run not available, `AB8202` invalid route path, `AB8203` invalid request shape, `AB8204` stale runtime generation or MCP session revision (409), `AB8205` runtime request could not be completed, `AB8206` Workbench runtime client failure, `AB8207` Agent Document decoding needs the optional `@agent-bundle/runtime` peer (503), `AB8208` stored Flight could not be decoded as an Agent Document (409), `AB8209` decoded Agent Document over the 16 MiB budget (413) or an invalid document response. |
| `AB8210`–`AB8214` | Workbench semantic lifecycle replay routes (`/api/lifecycles`, `/api/lifecycles/replays`): `AB8210` invalid path, `AB8211` malformed replay request or native envelope (400, carries the shared validator message), `AB8212` replay unavailable or could not be completed, `AB8213` stale manifest binding (409; the page repairs it with refresh → explicit re-run), `AB8214` replay over the 16 MiB budget (413). |
| `AB8215`–`AB8218` | Workbench read-only host discovery route. |
| `AB8219`–`AB8223` | Workbench live MCP probe route (user-initiated, read-only initialize + tools/list): `AB8219` invalid path, `AB8220` invalid request/method, `AB8221` probe target not found, `AB8222` response over the 16 MiB budget, `AB8223` probe unavailable. |
| `AB8233`–`AB8235` | Workbench browser-side strict decoders rejecting a dev-server response: `AB8233` lifecycle replay, `AB8234` host discovery, `AB8235` MCP probe report. |
| `AB8024`–`AB8025` | Live host MCP proxy: epoch drift behind a host connection and dev-server unavailability (see below). |
| `AB8xxx` | Development server configuration. |
| `AB9xxx` | Eval selection, harnesses, and persisted runs. |

## Claude Code host validation (`AB6019`–`AB6022`, `AB7311`, `AB7325`)

`agent-bundle validate --artifact <dir>` and `agent-bundle build` run the
installed Claude Code validator for the `claude` and `plugin` targets when
`--host-validation` is on (the default for both commands; `--no-host-validation`
skips it, and programmatic `build()` calls skip it unless `hostValidation: true`
is passed). `agent-bundle doctor --host claude --from <dir>` runs the same
validator over the `--from` bundle and over every installed copy Claude lists
for the plugin, prefixing each finding with `Bundle at …` or `Installed copy at
… (scope …)`. Claude Code decides what to check from the manifest it is pointed at: a run
against the bundle directory picks `.claude-plugin/marketplace.json` when it is
present and never opens the plugin's skill, agent, command, or hook files
(Claude Code docs, "Create and distribute a plugin marketplace" →
"Marketplace validation errors"). Agent Bundle emits both manifests side by
side, so it runs `claude plugin validate <dir>/.claude-plugin/plugin.json --strict`
first, which covers `plugin.json`, `hooks/hooks.json`, and the `skills/`,
`agents/`, and `commands/` directories, and then
`claude plugin validate <dir>/.claude-plugin/marketplace.json --strict`, dropping
the marketplace run's `plugins[N] plugin.json →` copies of manifest findings the
plugin run already reported. Both runs ask for `--json` first (Claude Code
2.1.259 or later; the pinned 2.1.260 prints it) and each finding is attributed
to its file (`generatedPath`); when the CLI rejects the flag (`unknown option
'--json'`) or the probed version predates 2.1.259, the runs fall back to the
text report, attributed by its `Validating <type>: <file>` headers.

`claude plugin validate --strict` is not a load verdict: Claude Code 2.1.250
through 2.1.260 accept manifests and component files (for example an invalid
`monitors/monitors.json`, or a `hooks` field naming the auto-loaded
`hooks/hooks.json`) that a session then refuses to load. So `build` and
`validate --artifact` follow the two validation runs with a load check,
`claude --plugin-dir <dir> plugin list --json`, and read the plugin's
`<name>@inline` row: no `errors` is `load.status: 'loaded'`; `errors` is
`refused` and `AB7325`; no row at all is `unregistered` and `AB7311`; a listing
that cannot be read is `failed` and `AB6022`. The check is read-only (the
listing writes nothing under `~/.claude`), is skipped with the two validation
runs when `claude` is absent (`AB6019`), and is skipped when the bundle has no
readable `.claude-plugin/plugin.json` name (the validation runs already report
that manifest). Doctor does not repeat it: its registration proof and the
inventory rows' `errors` already carry the same verdicts. Without `claude` on
`PATH`, `build` spawns once, reports one `AB6019`, and marks the remaining
`claude`/`plugin` targets `unavailable` without spawning again.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6019` | info | The `claude` CLI is not installed or not on `PATH`, so host validation was skipped. Local pinned-schema validation (`AB6011`/`AB6012`) still runs. | Install Claude Code and ensure `claude` is on `PATH`, then rerun artifact validation. |
| `AB6020` | warning (error in strict mode) / info | One Claude Code validation warning, or (info) one note, from the plugin or marketplace run. The message names the validated file and Claude Code's field path, for example `(hooks hooks/hooks.json): hooks: hooks.postToolUse: unknown hook event`. Claude Code tolerates these at load time; `agent-bundle validate --strict` promotes warnings to errors, mirroring `claude plugin validate --strict`. | Run `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`, repair the reported Claude artifact, and rebuild. |
| `AB6021` | error | One Claude Code validation error from the plugin or marketplace run, such as invalid JSON in `hooks/hooks.json`, frontmatter that fails to parse, or a duplicate plugin name in `marketplace.json`. Claude Code loads the plugin without the failing component or refuses the marketplace. | Same as `AB6020`. |
| `AB6022` | error | The bounded `claude --version` probe, a validation run, or the load check could not start, exited nonzero without a report, timed out, exceeded 1 MiB of output, (2.1.259+) returned no JSON report, or (load check) returned something other than a JSON array; the message carries the CLI's stderr when there is one. | Verify the Claude CLI starts and responds, then rerun `claude plugin validate <bundle-dir>/.claude-plugin/plugin.json --strict`. |
| `AB7311` | error | The load check's `claude --plugin-dir <dir> plugin list --json` listed no `<name>@inline` row for the bundle (`load.status: 'unregistered'`): Claude Code did not register the directory as a plugin. Doctor emits the same code from its registration proof. | Inspect `claude --plugin-dir <bundle-dir> plugin list --json` and register the intended bundle. |
| `AB7325` | error; warning when every `errors` entry is `Dependency "<name>@<marketplace>" is not installed …` (error under `--strict`) | The load check's row for the bundle carries `errors` (`load.status: 'refused'` with the strings verbatim): `claude plugin validate --strict` accepted the artifact, but a session would refuse to load it. A missing declared dependency is a property of the validating machine rather than of the artifact, so it is a warning and the build completes. Doctor emits the same code for installed copies and its registration proof (see "Host load refusal for Claude installs"). | Fix the artifact so `claude --plugin-dir <bundle-dir> plugin list --json` reports no `errors` for it, then rebuild; for a missing dependency, install it (`claude plugin install <name>@<marketplace>`) or validate where it is installed. |

## Cursor built-artifact validation (`AB6026`–`AB6029`)

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB6026` | info | Every Cursor host-validation report states that Cursor publishes no plugin-validate devtools verb and names the vendored schema pin used for local validation. | Review the pinned Cursor schema provenance before changing the local validator contract. |
| `AB6027` | error | A required generated Cursor document is missing or a present plugin, marketplace, MCP, or hooks document is unreadable, invalid JSON, or rejected by its pinned schema. The hooks document is the one `.cursor-plugin/plugin.json` `hooks` names — a plugin-root-relative file (`hooks/hooks.json` for the `cursor` target, `hooks/hooks-cursor.json` for the unified `plugin` target, reported under that path) or an inline object (`.cursor-plugin/plugin.json#/hooks`) — falling back to `hooks/hooks.json` folder discovery only when the field is absent; a declared file that is missing or resolves outside the plugin root is an error, and any other `hooks/hooks.json` beside a named document is not read. | Repair the generated Cursor JSON document so it satisfies the vendored pinned schema, then rebuild. |
| `AB6028` | error | Generated bytes violate pinned Cursor loader evidence: manifest-candidate precedence selects a fallback manifest, a symlink resolves outside the bundle, or `CURSOR_PLUGIN_ROOT` appears outside loader-substituted fields. | Repair the generated Cursor layout, token locations, or symlinks to match the pinned loader evidence, then rebuild. |
| `AB6029` | info / warning | The Cursor Agent version probe is unavailable (`ENOENT`, info) or cannot complete successfully (warning). Local pinned-schema validation still runs. | Install Cursor Agent or repair `cursor-agent --version` when local CLI version evidence is required, then rerun artifact validation. |

## Codex host validation (`AB6030`–`AB6033`)

Codex 0.147.0 publishes plugin installation commands but no plugin-validation
developer tool. Agent Bundle therefore validates built Codex JSON documents
against its vendored pinned schemas and treats the app-server schema generator
as a separate drift signal, never as a substitute plugin contract.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6030` | info | The Codex CLI is unavailable, or the installed Codex release publishes no plugin validation command. | Install Codex and put it on `PATH`; until Codex publishes a validator, use the vendored pinned-schema diagnostics. |
| `AB6031` | info / warning (error in strict mode) | The app-server schema-generation verb is unavailable, or its live output is missing or differs from the pinned generated hook schemas. | Review the attributable host schema source and update the pinned revision only when Codex publishes the matching contract. |
| `AB6032` | error | A required Codex bundle document is missing, unreadable, invalid JSON, or fails its vendored pinned schema. | Repair the named `.codex-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, or marketplace document and rebuild. |
| `AB6033` | error | A bounded Codex version or schema-generation command could not start, failed, timed out, exceeded 1 MiB of output, or produced unreadable output. | Verify `codex --version` and `codex app-server generate-json-schema --out <dir>` complete successfully, then rerun validation. |

## Agent Skills emitted spec lint (`AB6034`)

Agent Bundle evaluated `@skill-tools/core@0.2.2` on 2026-09-02 and found a
genuine Agent Skills utility whose lint is nevertheless lower fidelity than
the pinned specification contract. Its parser does not pin a specification
revision, misses closed-frontmatter rules already enforced here, and contains
an internally inconsistent description-length warning. The package is not a
runtime dependency; the one missing mandatory rule it identified is enforced
locally against emitted bytes.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6034` | error | An emitted `SKILL.md` has valid YAML frontmatter but no Markdown instruction body after it. The pinned Agent Skills specification requires frontmatter followed by Markdown content. | Add Markdown instructions after the Skill frontmatter, then rebuild the artifact. |

## Agent Plugins portable validation (`AB6035`–`AB6038`)

The `portable` target is the [Agent Plugins open standard](https://agent-plugins.org/specification)
(specification 1.0.0) adapter. Its contract is pinned in
`packages/agent-bundle/src/adapters/schemas/portable/PROVENANCE.json` (schema
hashes, specification repository commit, retrieval and re-verification dates).
The standard publishes machine-readable schemas plus normative text the schemas
cannot express; the text wins on conflict, so validation runs both lanes and
never spawns a client CLI (the standard publishes no reference validator).

Validation happens at three moments, all fail-closed:

1. **Plan time** (`agent-bundle build`/`validate`): the emitted `plugin.json`
   and `mcp.json` are validated against the pinned schemas before they are
   written (`portable.schema.plugin`, `portable.schema.mcp`), authored manifest
   metadata is checked field by field (`portable.manifest.<field>.invalid`),
   MCP path tokens are refused where the standard forbids them
   (`portable.mcp.token.*`), and the normative MCP rules the schemas cannot
   express are applied to each server as it will be written
   (`portable.mcp.{command,cwd,env,url,headers}.standard`: command form, cwd
   containment, env-key placeholders, URL form, header names/values/casing).
   These target-scoped codes are errors, so a standard-invalid server never
   reaches an artifact.
2. **Artifact time** (`agent-bundle build`, `validate --artifact`): the generic
   target-contract pass reports a missing required document as `AB6011` and a
   pinned-schema rejection as `AB6012`, and the Agent Plugins byte lane below
   (`AB6035`–`AB6037`) runs over every tree emitted by the built-in portable
   adapter, so a standard-invalid layout fails the ordinary build before
   publication (a tree already carrying a symlink or other unsupported entry
   is reported as `AB6013` and never read by this lane).
   `validate --artifact --host-validation` additionally returns the same lane
   as a `portable` host validation report with the `AB6038` provenance note.
3. **Installed bytes** (`agent-bundle doctor`): a Cursor local plugin whose root
   `plugin.json` declares an Agent Plugins `$schema` is validated with the same
   byte lane and reported under `AB7320` (an error marks the entry `corrupt`).

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB6035` | error | The root `plugin.json` is missing, or a present `plugin.json`/`mcp.json` is unreadable, not valid JSON, or rejected by its pinned Agent Plugins 1.0.0 schema (closed manifest fields, plugin name constraints, reserved `PLUGIN_ROOT`/`PLUGIN_DATA` env keys, closed server variants). | Repair the generated Agent Plugins document so it satisfies the pinned 1.0.0 schema, then rebuild. |
| `AB6036` | error | A normative-text rule the schemas cannot express is violated: `plugin.json` and `mcp.json` declare different Agent Plugins versions (§10.1); a stdio `command` is neither a bare executable name nor a bundled plugin-relative `./` file, or carries a placeholder (§7.2.1); a `./`, `${PLUGIN_ROOT}`, or `${PLUGIN_DATA}` `cwd` escapes its root after resolution (§4.1/§7.2.1); a remote `url` is not an absolute HTTP(S) URL, carries user information or a fragment, uses plain HTTP against a non-loopback host, or carries a placeholder; header names are invalid, repeat under different casing, or carry placeholders, or a header value contains anything other than visible ASCII, space, horizontal tab, or obs-text bytes (§7.2.1, RFC 9110 §5.5); an `env` key carries a placeholder (§9.2); `skills/` or `mcp.json` is present with the wrong filesystem kind (§6.2); or a `skills/<name>/` directory has no regular `SKILL.md` (§7.1). | Repair the generated portable layout or MCP entry to satisfy the Agent Plugins 1.0.0 normative text, then rebuild. |
| `AB6037` | error | A symlink inside the plugin resolves outside the plugin root, or cannot be resolved at all (§4.1 containment). | Replace the escaping symlink with a file or a link that resolves inside the plugin root, then rebuild. |
| `AB6038` | info | Every portable host-validation report states that Agent Plugins publishes no reference validator and names the pinned schema provenance (specification repository commit, retrieval and re-verification dates) used for local validation. | Review the pinned Agent Plugins provenance before changing the local validator contract. |

## npm prepack gate (`AB7010`–`AB7015`)

| Code | Meaning |
| --- | --- |
| `AB7010` | The dry-run npm inventory omits a package output, artifact manifest/file, install surface, or README. Include `dist` and the artifact directory in the package `files` allowlist. |
| `AB7011` | An on-disk artifact file no longer matches its manifest SHA-256. Rebuild and do not modify generated host packs. |
| `AB7012` | A `package.json` bin points outside the packed `dist` output (including `src/`) or names a file npm omitted. Point it at the generated `dist/bin` file. |
| `AB7013` | `package.json`, normalized plugin metadata, a host manifest, or artifact provenance reports a different release version. Make every release identity agree. |
| `AB7014` | A `package.json` `dependencies`, `optionalDependencies`, or `peerDependencies` field names packages nothing in the pack uses: no packed JavaScript imports, requires, or resolves them, or runs one of their `bin` commands, no packed declaration file references them, no `#subpath` import reaches them through the manifest's `imports` map, and no consumer-side install script (or script it delegates to) runs them (one diagnostic per field; the full evidence list follows this table). Peers `peerDependenciesMeta` marks optional are never installed and are not inspected here (their specifier is still checked by `AB7015`), and a name under both `dependencies` and `optionalDependencies` is judged by its optional entry, which npm lets override. The build inlines every dependency into `dist/bin` and the host packs, so such an entry only makes every consumer's `npm install` fetch build-time packages. Move them to `devDependencies`, or import the package from a packed module if a consumer really needs it at runtime. For `peerDependencies` the diagnostic is a warning: a required peer nothing imports may be a deliberate compatibility contract with the host that loads the package, though npm 7+ still installs it for every consumer — keep it, mark it optional in `peerDependenciesMeta`, or move a build-only package to `devDependencies`. |
| `AB7015` | A `package.json` `dependencies`, `optionalDependencies`, or `peerDependencies` entry that a consumer's npm cannot resolve through a registry. Each entry — name and specifier together, the value exactly as written (a leading space makes `" npm:bar@1"` an invalid dist-tag, not an alias) — is read with `npm-package-arg`, the parser npm, Arborist, and pacote share, so the verdict is npm's own rather than an imitation of its grammar: **registry** (a version, range, or dist-tag, or an `npm:` alias of one — the only kind a published package can rely on), **fetched** (parseable, but a `git`/`github:`/`gitlab:`/`bitbucket:`/`gist:` source or `owner/repo` shorthand, an `http(s):` tarball, or a `file:`/relative/bare path or tarball filename — npm 12 refuses git and remote fetches by default (`allow-git=none`, `allow-remote=none`) and a path never exists on the consumer's disk), or **unparseable** (npm rejects the manifest before fetching anything: `EINVALIDPACKAGENAME` for a name such as `bad name`, `.hidden`, or `node_modules`; `EUNSUPPORTEDPROTOCOL` for `link:`, `portal:`, `jsr:`, a `git+` transport npm lacks, or a typo; `EINVALIDTAGNAME` for a selector that is neither a range nor a URL-safe dist-tag, such as `"not a valid spec"`; an `npm:` alias without a name or with a non-registry target, since aliases only work for registry dependencies; or an invalid URL such as `http:%zz`). A fetched specifier is reported on installed entries only; an unparseable one is reported on every entry, even an optional peer npm would never install, because the manifest read itself fails. A peer that `dependencies` or `optionalDependencies` also names is judged by that concrete entry alone: npm resolves the concrete declaration and never reads the duplicate peer's selector. For an `optionalDependencies` entry that is fetched, the diagnostic is a warning, not an error (`agent-bundle prepack` prints it and exits 0): npm continues an install without such a dependency, but every consumer still tries and fails to fetch it. It stays an error when the entry is unparseable, or when a consumer-side install script needs the skipped package — runs one of its `bin` commands in command position (`setup-tool --init`, `npx setup-tool`, `cross-env CI=1 setup-tool`, `./node_modules/.bin/setup-tool`; a mention elsewhere, `echo setup-tool`, proves nothing), runs one of its files (`node node_modules/setup-tool/install.js`), loads it from an inline program (`node -e "require('setup-tool')"`, `node --input-type=module -e "await import('setup-tool')"`, also `-p`, `-pe`, `--eval=…`, `--print=…`; the program is read as a packed file is — `require`, `createRequire`, and `import()` — and a computed load there, or a program the lexer rejects, may need any declared package), preloads it (`node -r setup-tool/register install.js`; `-r`/`--require`, `--import`, `--loader`/`--experimental-loader`, with a space or `=` before the module — read as Node does, `node [options] script [arguments]`: options end at the first positional (the script, or an argument when `-e`/`-p` supply the program) or a `--`, valued options such as `--conditions x` or `--env-file x` taking their word with them, so `node install.js --require x` passes `--require x` to `install.js` and preloads nothing; a `NODE_OPTIONS` assignment on the same command — `NODE_OPTIONS=--require=setup-tool/register node install.js`, `cross-env NODE_OPTIONS="-r setup-tool/register" node .` — supplies options Node applies before the command line's, while one `export`ed by an earlier command is not read), or runs a packed file (`node install.cjs`, `node scripts/install` resolving `scripts/install.js`, `node "scripts/my install.cjs"`, `node install.js&&echo done`, `node .` or `node ./` running the root `main`, `node --import ./setup.mjs .` running a packed preload) that imports it — every word of the script that names a packed JavaScript file counts as run, deliberately, so that runners this gate does not model (`tsx`, `ts-node`, `zx`, `bun`, `deno run`, `npx <runner>`) still have the dependencies their file loads traced; the cost is a rare escalation for a word that names a packed file without running it (`echo install.js`), which the diagnostic makes visible by naming the file — directly, through relative imports inside the tarball (`require("./lib")` following `lib/package.json`'s `main` before `lib/index.js`, as Node does), or through the `imports` map resolved as Node does (`"#setup": "./setup.js"`; `#setup/foo` through `"#setup/*": "./scripts/*.js"`, a preloaded `#setup` included): npm continues past the failed fetch, then the script fails on the missing command or module. Each command of a script is read on its own: after a shell operator (`&&`, `;`, and the rest) or a newline — the second line of a script, and each lifecycle script after the first, starts a new command — and Node's options belong to `node` alone (`rm -r dist` preloads nothing, `npm --prefix . run setup` runs no `main`). Depend on a published registry version, or bundle the package and declare it under `devDependencies`. Entries the tarball itself carries are never reported, since a consumer does not fetch them: `bundleDependencies` (by name or `true`; never a peer, which npm cannot bundle; only when the pack inventory contains `node_modules/<name>/package.json`, since npm silently packs nothing for a bundled name absent from `node_modules`), and a `file:` or bare path inside the package (`file:vendor/foo`, `file:vendor/foo.tgz`) whose packed source npm can install from — a directory whose packed `package.json` parses to an object, or a packed tarball (gzipped or plain tar, ustar headers with valid checksums and payloads inside the archive) whose `<dir>/package.json` entry parses to an object — since npm installs it from the consumer's own copy. A path that escapes the package (`file:../sibling`), whose source is not packed, or whose packed source is not installable (a `.tgz` that is not an archive, or is malformed or truncated, fails the consumer's install with `TAR_BAD_ARCHIVE`; a manifest that does not parse, on disk or inside the archive, fails it with `EJSONPARSE`) is reported. `workspace:` and `catalog:` count as registry specifiers only when the `prepack` lifecycle runs under pnpm, Yarn, or Bun (`npm_config_user_agent`), which rewrite them in the tarball they pack; `npm publish` publishes them verbatim and consumers fail with `EUNSUPPORTEDPROTOCOL`, so under npm — or when `agent-bundle prepack` runs outside any package-manager lifecycle — they are reported. The `npm pack --dry-run` that `prepack` itself spawns is only the file inventory; the tarball consumers receive is the lifecycle's packer's, which is what the user agent identifies. |

The dependency evidence is read from the packed bytes themselves: every `.js`/`.mjs`/`.cjs` file
`npm pack --dry-run` lists is lexed for static and dynamic `import` specifiers and scanned for
literal `require("…")` and `.resolve("…")` calls (`require.resolve`, `createRequire(…).resolve`,
`import.meta.resolve`: a package located only to find an asset is still a runtime dependency; a
binding such as `const load = createRequire(import.meta.url)` is a loader and `load("…")` counts like
`require("…")`, whether the factory is imported under its own name, renamed with `as`, reached through a
namespace import, or chained off `require("node:module")`; `createRequire(…)("…")` inline counts too, qualified the same
ways — `Module.createRequire(…)("…")`, `require("node:module").createRequire(…)("…")` — the
factory's argument nesting calls such as `new URL("./entry.js", import.meta.url)`; comments between a loader
and its parentheses or around the argument, `require /* x */ ("y")`, are trivia), and
every `.d.ts`/`.d.mts`/`.d.cts` file is scanned for `from "…"`,
`import("…")`, `import x = require("…")`, `declare module "…"` (a module augmentation), and `/// <reference types="…" />` (a consumer needs the
package that provides those types even without a runtime import; a type directive counts for the
named package and its `@types/*` twin, `@types/scope__name` for a scoped name); bare specifiers are reduced to
their package name (`@scope/name` or `name`), string escapes decoded first (`require("\x66oo")` loads `foo`),
and Node built-ins are ignored. A dependency packed JavaScript runs rather than loads — a string literal that
is one of the `bin` commands its manifest under `node_modules` declares, bare or followed by arguments
(`spawnSync("tsc", ["--version"])`, `execSync("tsc --noEmit")`) — counts as used too; a dependency not installed
at pack time has no known commands, so its bare name in a string proves nothing here. A mention inside a
comment or string can only keep a dependency, never report one, and `devDependencies` are never
inspected. A packed `#subpath` import counts for every package the `imports` entry Node would pick for it targets
(the exact key, or the wildcard key with the longest matching prefix, its `*` substituted — every conditional target
of that entry, since conditions are not settled here), and a dependency named — anywhere in the text, since a mention
can only keep a declaration — by a consumer-side `preinstall`/`install`/`postinstall` script (not `prepare`, which npm
runs on `pack`, local installs, and git dependencies but never for a published tarball), or by any
script those reach through `npm run <name>` (also `pnpm`/`yarn`/`bun run` and npm's `run-script`/`rum`/`urn` aliases; the script is
the first positional after `run`, options before or after `run` skipped with their values — `npm --prefix . run setup`,
`npm run -w pkg setup`, `pnpm --filter pkg run setup`, `npm run -- setup` — and every later word an argument of that script,
so `npm run setup -- dormant` and `npm run setup dormant` run `setup` alone; shell quotes and backslash escapes resolved
(`npm run "setup"`) and `&&`/`||`/`;`/`|`/`&`/newline split off; the script is visited with its `pre<name>`/`post<name>` hooks) or through
npm's direct script commands (`npm test`, `t`, `tst`, `start`, `stop`, `restart`, each running the script of that name with its hooks; `npm test foo` runs `test` alone; `npm restart` without a `restart` script runs `stop` then `start`, each with its hooks, inside `prerestart`/`postrestart`) — by
package name or by one of its `bin` commands, read from `node_modules/<name>/package.json` (a string-form `bin`
is one command named after the installed manifest's unscoped `name` — `real` for an alias `"wrapper":
"npm:@scope/real@1"`; the manifest is read as npm reads it, so the last of duplicate keys wins), with the unscoped dependency name standing in when that manifest is unreadable or not JSON — counts as used. A computed `import(expression)` or
`require(expression)` — also `require.resolve`, `import.meta.resolve`, a direct `createRequire(…)(…)`, or a
`createRequire` binding — with a non-literal argument — in packed JavaScript could load any declared package, so its presence withholds
`AB7014` entirely; the recovery text says so. So does packed source the ESM lexer rejects, whose `import()` calls it cannot report, and so does a loader passed on as a value rather than called — `const load = require`, `fn(require)`,
`module.exports = require`, `x ? require : y` — since packages may then be loaded under a name the scan never sees (`require("x")`,
`require.resolve("x")`, `typeof require`, and a `require` inside a string or comment are not that). Only those resolvers count, literal argument or not: `path.resolve("foo")`
and `Promise.resolve("foo")` are not package resolution and never keep `foo`.

## Declaration generation (`AB4716`)

A `lib` entry with `dts` enabled compiles its source directory as its own
TypeScript program. When that declaration emit fails, the bundler aborts with
one prose line naming only its own environment, so the framework replays
declaration emit over the same synthesized project (the consumer's own
`typescript`, the same tsconfig, `--declaration --emitDeclarationOnly`) and
reports **one `AB4716` error per recovered TypeScript diagnostic**, each
carrying the file, the `(line,column)` position, the `TS` code, and the
compiler's message, plus a `sourcePath`:

```text
[AB4716] Declaration generation for lib entry "index" failed:
  src/operations/audible.ts(79,14): TS4023: Exported variable 'audibleOperations'
  has or is using name 'CliCommandDefinition' from external module "…" but cannot be named.
```

When no diagnostic can be recovered — the project has no resolvable
`typescript`, or the replay passes because the failure was elsewhere in
declaration generation — the failure still reports as a single `AB4716`
carrying the bundler's own message. Declaration failures never fall through
to the `AB5000` catch-all, whose dev-lock meaning previously misdirected
triage.

The recovery hint names the trap these failures share: declaration-emit
errors such as `TS4023` (an exported value whose inferred type names a type
its module does not export) are invisible to `tsc --noEmit`, so a green
`typecheck` script proves nothing about them. Reproduce them with
`tsc --declaration --emitDeclarationOnly` over the lib entry source
directory.

## MCP App view compilation (`AB4770`–`AB4772`)

MCP App views compile through Rsbuild with its logging silenced
(`logLevel: 'silent'`), so the bundler never prints on its own. The framework
reads the Rspack stats of every App environment instead and reports **one
`AB4770` error per Rspack error**, each carrying the failing module as a
project-relative path (forward slashes; absolute when the module lives outside
the project root), the `line:column` the bundler reported, and the bundler's
message — ANSI colours, the miette frame glyphs, and code-frame lines
stripped, the remaining lines joined into one — plus a `sourcePath` naming the
failing module:

```text
[AB4770] MCP App "status" failed to compile: views/status.ts:1:10: Module build failed
  (from builtin:swc-loader): Syntax Error: Expression expected
[AB4770] MCP App "status" failed to compile: views/status.ts:1:1: Module not found:
  Can't resolve './missing-module' in '…/views'
[AB4770] MCP App "status" failed to compile: Tsconfig not found …/does-not-exist.json
```

The third line is the shape without a location: Rspack attributes a
`tsconfig.json` whose `extends` target is missing to no module, so the message
carries only the bundler text and `sourcePath` falls back to the App's entry
source. A compile that fails without a single stats error still reports one
`AB4770` with the bundler's own message. More than 20 errors on one App are
cut at 20, and the last diagnostic ends with `… and N more errors (run the
compile with logLevel error via tools.rsbuild for the full list)`. App compile
failures never fall through to the `AB5000` catch-all, and `agent-bundle dev`
shows the same `AB4770` rows in the Workbench Overview's Diagnostics table —
the Source column is the failing file — instead of
`AB7100 "Unable to compile the build: Rspack build failed."`.

Rspack warnings that are not on the framework's ignore list report as
`AB4771` **warnings** of the same shape, with `produced a warning while
compiling` in place of `failed to compile`. They never fail the build and are
returned beside the compiled Apps (`build.diagnostics` in
`agent-bundle build --json`). The ignore list is the documented constant in
`packages/agent-bundle/src/build/mcp-app-diagnostics.ts` — one comment per
entry citing the warning text it drops and why it is noise; it may be empty.

Every App is measured after it is emitted: the UTF-8 bytes of the
self-contained HTML and their gzip size, what a compressing transport would
carry. `AB4772` is the size advisory, one **warning** per App. Any view that
imports `@modelcontextprotocol/ext-apps` starts at about 437 kB (104 kB gzip)
— `zod` v3 and v4, `@modelcontextprotocol/sdk`, `zod-to-json-schema`, and
`ext-apps` itself — so the advisory bound of 1 MiB (1,048,576 bytes) sits at
roughly 2.4× that floor and at half the 2 MiB (2,097,152 bytes) bound above
which the Workbench and `serve-app` hosts refuse the resource and the Rstest
browser harness refuses to mount it. The advisory fires when a production
build emits 1 MiB or more, and in either compile mode when the document
exceeds 2 MiB (the view will not render in those hosts). The message names
the raw and gzip sizes, the bound that was crossed, and the five largest
modules from the stats (project-relative, or `node_modules/<package>/…`), with
sizes 1024-based to one decimal, a trailing `.0` dropped (`427.1 KiB`,
`1.3 MiB`, `2 MiB`). Both thresholds are fixed; no configuration key moves
them.

`agent-bundle dev` compiles views unminified so the Workbench preview is
readable — about 2.7× the production bytes. A view whose readable document
would exceed the 2 MiB host bound is recompiled with the production profile
so the preview still renders it, and one `AB4772` reports the substitution
instead: `MCP App "<name>" readable development output compiled to <size>,
above the 2 MiB bound the Workbench and serve-app hosts accept; the preview
renders the production build (<size>, <gzip> gzip) instead; largest modules:
…`. The production sizes in that notice stand in for the 1 MiB advisory, so
a substituted view never carries two size advisories. When the production
build itself exceeds 2 MiB the substitution buys nothing: the notice is not
emitted, the preview receives that production document, and the ordinary
over-bound `AB4772` names its sizes so the author knows the view does not
render. The 1 MiB advisory is a production concern and never fires on
readable output.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4770` | error (build) | One Rspack error while compiling an App view — a syntax error, an unresolved import, a `tsconfig.json` whose `extends` target is missing, or any other module failure. `MCP App "<name>" failed to compile: <file>:<line>:<column>: <message>`, without the location prefix when Rspack attributes the error to no module; `sourcePath` is the failing module, else the App's entry. | Fix the reported error in the named file and rebuild; run `agent-bundle build` for the full message. |
| `AB4771` | warning | One Rspack warning while compiling an App view that the framework's ignore list does not cover; `MCP App "<name>" produced a warning while compiling: <file>:<line>:<column>: <message>`. | Address the warning in the named file; a warning that is bundler noise inside the framework's own dependency graph belongs on the documented ignore list. |
| `AB4772` | warning | The emitted App HTML is 1 MiB or larger in a production build, or larger than 2 MiB in any build; `MCP App "<name>" compiled to <size> (<gzip> gzip), above the … bound; largest modules: …`. In `agent-bundle dev`, a view whose readable output would exceed 2 MiB was recompiled with the production profile for the preview and that production build fits: `MCP App "<name>" readable development output compiled to <size>, above the 2 MiB bound …; the preview renders the production build (…) instead; largest modules: …` — the only size advisory that view receives; a production build that is itself over 2 MiB gets the ordinary over-bound message instead. | Trim the largest modules the message names — usually a dependency imported whole; a view over 2 MiB does not render in the Workbench or `serve-app` and must shrink before it ships. The development substitution costs only the readable source in the preview. |

## Release identity (`AB4001`, `AB4008`–`AB4011`, `AB4013`)

`package.json` is authoritative for release identity (issue #94): its `name`
and `version` become the `packageName` and `packageVersion` axes carried on
the project context, artifact manifests, `inspect` output, and dev status.
`plugin.name` stays the host-native slug and is never derived from the npm
package name.

`plugin.version` is **deprecated and optional**. New projects declare the
release version only in `package.json`; removal of the compatibility field
follows the normal breaking-change policy rather than a fixed window. When it
is omitted, the version every surface reports — manifests, host projections,
dev status, and the `agent-bundle/meta` constant compiled into plugin code —
is the `package.json` version. When it is declared, the declared value still
wins so a legacy config never changes meaning mid-migration, and a
disagreement reports the `AB4008` **warning**. Declaring it as anything but a
nonempty string is an `AB4001` error.

A project with neither an authored `plugin.version` nor a valid `package.json`
version has no release identity. Development commands (`dev`, `inspect`,
`validate`) keep running on the labeled `0.0.0-dev.<short-revision>` fallback,
because an unpackaged scratch project is a normal development state. A
development-only fallback can never produce a release artifact, so
`agent-bundle build` alone refuses it with `AB4013`.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4001` | error | `plugin.version` is declared as something other than a nonempty string. Omit the field to derive the version from `package.json`. |
| `AB4008` | warning | A declared `plugin.version` differs from the `package.json` version. Align the two, or drop `plugin.version`. |
| `AB4009` | warning | `package.json` `name` is not a valid npm package name; the `packageName` axis is withheld. |
| `AB4010` | warning | `package.json` `version` is not a valid semantic version; the `packageVersion` axis is withheld. |
| `AB4011` | warning | `package.json` is unusable — unparsable, not a JSON object, or symlinked outside the project root. |
| `AB4013` | error (build) | `agent-bundle build` refuses a project with no release version: `plugin.version` is omitted and `package.json` declares no valid semantic version. |

## Migration nudges and convention claims (`AB4730`–`AB4738`)

The entry conventions and the framework-owned stdio lifecycle shell (RFC #50)
replaced patterns consumers previously wrote by hand. When `validate`,
`inspect`, `build`, or `dev` prepares project source and finds one of those
pre-convention patterns, it reports a migration diagnostic. `AB4730`–`AB4735`
are **informational** nudges and never block anything. `AB4736`–`AB4738` are
errors: the removed top-level authored-document locations are no longer
discovered, and a conventional script whose `bin` entry would run an export
the artifact script ignores cannot ship on both surfaces, so the compiler
refuses to omit or misbuild them silently. The CLI prints these in
human `validate` output and includes them in every `--json` diagnostics array.

Which explicit config keys *claim* a conventional module out of discovery is
tabulated in `docs/entry-conventions.md` ("Which config keys claim a
conventional module"). In short: `scripts`, `hooks`, `lib`, and `mcp` entries
claim the module they reference; a `bin` entry claims every conventional
module **except** a safely named direct `src/scripts/<name>` child, which
keeps shipping as an artifact script beside the bin because the two outputs
are disjoint and both envelopes run the same `main`. That dual-surface shape
is intentional and raises no diagnostic.

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

### `AB4734` — conventional skill shadowed by explicit `skills` config

A `src/skills/<name>/SKILL.md` (or rendered `SKILL.tsx`/`SKILL.ts`) directory
exists, but the explicit `skills` configuration does not cover it — the
conventional skill is silently shadowed. When config is silent, every
`src/skills/<name>/` directory ships by convention and this nudge never fires.

Adopt: remove the explicit `skills` configuration so the convention applies,
or add the directory to `skills`. Silence: remove the directory.

### `AB4735` — rendered skill source shadowed by hand-authored `SKILL.md`

A skill directory contains both a hand-authored `SKILL.md` and a rendered
skill source (`SKILL.tsx`/`SKILL.ts`). The authored file wins — an authored
document beats a generated one — so the component module never compiles.

Adopt: remove `SKILL.md` so the rendered skill compiles at build. Silence:
remove the component module.

### `AB4736` — legacy top-level authored document location

A document still matches a removed top-level convention:
`skills/<name>/SKILL.md` (or rendered `SKILL.tsx`/`SKILL.ts`),
`commands/*.md`, or `rules/*.mdc`. These locations are no longer discovered,
and every unignored legacy document is reported as an error. A top-level
skill covered by explicit `skills` configuration is claimed and stays valid;
commands and rules have no equivalent override.

Recover: move the document under `src/skills/`, `src/commands/`, or
`src/rules/`. Explicit `skills` paths remain valid anywhere. Published
artifact paths remain `skills/`, `commands/`, and `rules/`.

### `AB4737` — rendered script claimed as a package bin entry lacks `main` or the component

An explicit `bin` entry references a conventional rendered script
(`src/scripts/<name>.tsx` or `.jsx`) that does not export **both** an async
default Server Component and a named `main`. The component check is the
route compiler's own static scan — the default export must be an async
function, so `export default {}` does not count; a default re-exported from
another module (`export { default } from './component.tsx'`) cannot be judged
statically and is accepted (the rendered worker still verifies it at run
time). A plain `src/scripts/<name>.ts` module
ships happily on both surfaces — the npm bin envelope calls its `main(argv)`
and the artifact script is the same bundle — but a rendered script's default
export is an async Server Component the Agent renderer drives with
`{ argv, signal }` props. The bin envelope prefers a named `main` export and
only falls back to the default export, so without `main` it would call that
component as `main(argv)` and produce a bin that renders nothing; without the
default component, the bin works but `scripts/<name>.mjs` fails at run time
with no component to render. The compiler refuses either shape instead of
emitting a broken surface beside a working one. A rendered script that
exports both serves both surfaces and is not gated. The message names every
`bin` entry referencing the module and which export is missing.

Recover: export both an async default Server Component and a named
`main(argv)` from the module; point the `bin` entry at a plain module that exports `main`;
rename the script to `.ts` so one plain module ships as both the bin and the
artifact script; or prefix a path segment with `_` (`src/scripts/_name.tsx`)
to keep the module out of script discovery and bin-only.

### `AB4738` — plain script claimed as a package bin entry runs only as the bin

An explicit `bin` entry references a conventional plain script
(`src/scripts/<name>.ts`) that exports a `default` but no named `main`. Both
the bin envelope and the artifact-script envelope wrap a `main(argv)` export
and bundle a self-executing module (no `main`, no `default`) byte for byte,
so those shapes run identically on both surfaces. Only the bin envelope falls
back to invoking a default export: the artifact `scripts/<name>.mjs` would
merely define the function and exit, so a successful build would publish an
inert script beside a working bin. The detection is the same static export
scan the package build uses. The message names every `bin` entry referencing
the module.

Recover: export a named `main(argv)` so both surfaces run the same entry;
make the module self-executing (drop the default export and run at top
level); or prefix a path segment with `_` (`src/scripts/_name.ts`) to keep
the module out of script discovery and bin-only.

## Prebuilt payloads (`AB4740`–`AB4750`)

The `payload` block and `{ prebuilt: ... }` entries (see
`docs/entry-conventions.md`) package files the framework did not compile.
The consumer's own build produces them, so their diagnostics split by
moment: configuration mistakes are validation **errors**, a payload that has
simply not been built yet is a validation **warning** that only
`agent-bundle build` escalates, and freshness is an **info** nudge.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4740` | error | The `payload` block, one entry, or its `targets` list is malformed, or a payload selects an unknown target. |
| `AB4741` | error | A payload destination is not a safe directory name, or shadows a compiler-owned artifact namespace (`assets`, `hooks`, `mcp`, `mcp-apps`, `scripts`, `skills`, root documents). |
| `AB4742` | error | A payload source escapes the project root, is not a directory, or contains another payload's source. |
| `AB4743` | warning | A declared payload directory does not exist yet or contains no files. Run the project's own build first. |
| `AB4744` | error | A `{ prebuilt: ... }` entry (MCP server or hook handler) does not resolve inside a declared payload, or its payload does not select every target the component needs. |
| `AB4745` | warning | A declared prebuilt entry file does not exist yet. Run the project's own build first. |
| `AB4746` | error | Hook `args` on a non-prebuilt handler, or arguments outside the shell-safe charset. |
| `AB4747` | error (build) | `agent-bundle build` refuses an empty or missing payload. |
| `AB4748` | error (build) | `agent-bundle build` refuses a prebuilt entry file absent from its payload. |
| `AB4749` | error (build) | A payload directory overlaps the artifact `--output` root. |
| `AB4750` | info | A payload is older than the newest project source file and may be stale; rerun the project's own build if so. |

## Build-time identity outside the compiler (`AB4760`)

`agent-bundle/meta` (see `docs/entry-conventions.md`) is a reserved specifier
the compiler replaces in every compiled surface with the project's exact
`{ name, packageName, packageVersion, version }`. The published
`dist/meta.js` module behind that specifier therefore never carries an
identity of its own: every binding — `name`, `version`, `packageName`,
`packageVersion`, `meta`, and the default export — throws this diagnostic at
module evaluation, so a module that reaches it fails on import rather than
observing a fabricated identity. The thrown value is an `Error` named
`AgentBundleMetaUnavailableError` whose `code`, `recovery`, and structured
`diagnostic` fields carry the same data the message prints, so a bare `node`
process and a test runner both show the fix. The importing module is not
observable from a module evaluated through ESM linking, so the message names
the situation, not a file; the runner's own "failed to load" line names the
file.

Unit tests are the common way to reach it (issue #386): a plain Rstest pool
imports a source module that imports `agent-bundle/meta`, no compiled surface
replaced the specifier, and every test that touches that module fails at
import. `agentBundleRstest()` and `agentBundleBrowserRstest()` prevent this by
aliasing the specifier to `.agent-bundle/test/meta.mjs`, generated from the
same compiler pass. When that pass produced no plugin model (the configuration
could not be loaded or normalized) there is no identity to stamp, so the
aliased module throws the same `AB4760` naming the compiler diagnostics and
the recovery "fix them, then rerun Rstest" — the manifest's placeholder
identity is never served as a real one.

Rendered skills (`src/skills/<name>/SKILL.tsx`) evaluate during discovery,
and the skill loader aliases the specifier to the same generated module fed
from the identity normalization stamps into the model, so a skill importing
`agent-bundle/meta` compiles under `validate`, `build`, `inspect`, dev, and
`inspectWorkbenchSurface` (#440). Only a direct `parseSkill` call without a
project identity leaves the specifier to resolve as the project resolves
`agent-bundle`; the published module then raises this diagnostic inside the
skill's `AB3003`.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4760` | error | A module evaluated the published `agent-bundle/meta` outside a surface Agent Bundle compiles — typically a unit test pool not built from the Rstest preset, or a hand-run script importing plugin source. | Run the test under `agentBundleRstest()` or `agentBundleBrowserRstest()` from `agent-bundle/rstest` (pass `include` to cover a plain unit pool), or compile the surface with `agent-bundle build`. In a custom test runner, alias `agent-bundle/meta` (`resolve.alias`, exact match) to a module with the named exports `{ name, packageName, packageVersion, version, meta }` — `meta` the frozen object of the other four, exported as both the named binding and the default export — computed from the project's `agent-bundle.config.ts` plugin name and `package.json` version; the `.agent-bundle/test/meta.mjs` module `agentBundleRstest()` writes is that module. |

## Artifact-hosted routed CLI (`AB4765`–`AB4766`)

A generated-mode `src/cli/**` surface compiles into the npm package bin
(`dist/bin/<name>.js`) **and** into every host artifact whose adapter
publishes a supported `cli` capability, as `bin/<plugin-name>.mjs` (plus
`bin/<plugin-name>-flight.mjs` when any command renders). Every built-in
target hosts it; the two codes cover a target that does not and a host file
that claims the same path. See “The routed CLI shell” in
`docs/entry-conventions.md` for the layout and the sibling-path convention.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4765` | warning | The project has a routed CLI but a selected target's adapter publishes no supported `cli` capability, so that artifact ships no `bin/<name>.mjs`. Skills, hooks, and scripts in that artifact cannot invoke the routed CLI. `inspect` lists the same omission as an `unsupported-capability` skip of the `cli` component. Publish the capability (with a `cliBin` artifact layout) on the adapter, or keep references to the bin out of that target's surfaces. |
| `AB4766` | error (build) | A target plan already emits `bin/<name>.mjs` or `bin/<name>-flight.mjs` (for example a Claude `claude.bin` directory shipping a file of that name), compared case-insensitively because those are one file on macOS and Windows. The routed CLI owns those paths, so the build refuses instead of choosing. Rename or remove the host-emitted file, or set `bin: false` to keep it and drop the routed CLI executable. |

## Config beside a route-generated MCP server (`AB4340`)

A `mcp.servers.<id>` block for a server the route graph compiles in
`generated` mode augments that server (`env`, `args`, `targets`, `apps`,
`transport: 'stdio'`) — see the precedence table in
[Entry conventions](entry-conventions.md#config-beside-a-route-generated-mcp-server).
The local-entry field rules apply to it unchanged (`AB4305`, `AB4308`–`AB4312`,
`AB432x`), and it never triggers `AB4304` or `AB4322`: the route modules are
its entry.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4340` | error | A declaration for a route-generated server sets `entry`, `command`, or `url` while `routes.servers.<id>` is `generated`. The routes already compile this server, so a second entry claim has no reading the compiler could honor. Remove the field to keep the generated server (the other fields still apply), or set the mode to `custom`, `command`, or `remote` to serve the declared entry and omit the routes. Without an explicit mode the same collision is `AB4800`. |

## Conventional host components: rules and commands (`AB4900`–`AB4908`, `AB4920`–`AB4928`)

Conventional `src/rules/*.mdc` documents compile to the Rule IR (closed
frontmatter: `description`, `globs`, `alwaysApply`, plus the bundle-only
`targets` key that is peeled before emission) and `src/commands/*.md`
documents compile to the Command IR (closed frontmatter: `description`,
`argumentHint`, `allowedTools`, `model`, `disableModelInvocation`, plus
`targets`). Each host lowers only the surfaces its pinned capability table
supports; a document without `targets` is emitted where supported and
accounted as `skipped` with the host's judgment elsewhere (see
`agent-bundle inspect`), while a document that explicitly names a host without
the surface is a build error — unsupported components fail before artifact
publication rather than shipping as a broken half. Identity paths are
canonicalized so the model digest is root-independent.

Every frontmatter field is also a **component feature** (#100): each host
publishes one `<kind>.<feature>` capability row per field it can express
(`commands.argumentHint`, `rules.globs`, …; see
[Host components](framework-mode.md#component-feature-sets)). A component
that uses a feature the target's row does not support is judged per target:
an explicitly named target fails closed (`AB4907` / `AB4927`), while an
implicitly selected target still receives the component minus the feature and
the omission is reported as a warning with the host's reason (`AB4908` /
`AB4928`) and on the selected component in `inspect` (`omittedFeatures`).
Targets whose kind row is itself unsupported are judged by the kind-level codes
above, never per feature. Skills keep their own closed per-host schemas
(`AB3006`, `AB3008`, `AB3010`).

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4900` | error | A conventional rule file cannot be read. | Make the `.mdc` file readable, or remove it from `src/rules/`. |
| `AB4901` | error | Rule YAML frontmatter is invalid. | Repair the YAML between the `---` fences. |
| `AB4902` | error | Rule frontmatter declares a field outside `description`, `globs`, `alwaysApply`, `targets`. | Remove the field; host-specific rule metadata is not part of the closed contract. |
| `AB4903` | error | A rule frontmatter field has the wrong shape (`description` string, `globs` nonempty string or array, `alwaysApply` boolean, `targets` array of target names). | Fix the field's value. |
| `AB4904` | error | A rule's `targets` names a target that is not registered or not selected for the project. | Name only selected targets, or select that target in `targets`. |
| `AB4905` | error | A rule explicitly targets a host whose `rules` capability is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). | Drop that host from the rule's `targets`; only Cursor publishes a rules surface. |
| `AB4906` | error | Two rule files share a name. | Rename one file so every rule name is unique. |
| `AB4907` | error | A rule explicitly targets a host that supports rules but whose `rules.<field>` row for a frontmatter field the rule uses is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). | Remove the field or drop that host from the rule's `targets`. Cursor documents `description`, `globs`, and `alwaysApply`. |
| `AB4908` | warning | An implicitly selected host supports rules but cannot express a frontmatter field the rule uses; the rule ships there without it. | Accept the omission, restrict the rule's `targets` to hosts that support the field, or remove the field. |
| `AB4920` | error | A conventional command file cannot be read. | Make the `.md` file readable, or remove it from `src/commands/`. |
| `AB4921` | error | Command YAML frontmatter is invalid. | Repair the YAML between the `---` fences. |
| `AB4922` | error | Command frontmatter declares a field outside `description`, `argumentHint`, `allowedTools`, `model`, `disableModelInvocation`, `targets`. | Remove the field; per-host frontmatter is regenerated from the validated fields at lowering time. |
| `AB4923` | error | A command frontmatter field has the wrong shape (`allowedTools` nonempty string or array, string fields, `disableModelInvocation` boolean, `targets` array of target names). | Fix the field's value. |
| `AB4924` | error | A command's `targets` names a target that is not registered or not selected for the project. | Name only selected targets, or select that target in `targets`. |
| `AB4925` | error | A command explicitly targets a host whose `commands` capability is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). | Drop that host from the command's `targets`; Cursor and Claude publish command surfaces, Codex and portable do not. |
| `AB4926` | error | Two command files share a name. | Rename one file so every command name is unique. |
| `AB4927` | error | A command explicitly targets a host that supports commands but whose `commands.<field>` row for a frontmatter field the command uses is `degraded`, `unavailable`, or `prohibited` (the message carries the host's reason). Cursor's pinned commands surface is frontmatter-free Markdown, so every field row is unavailable there. | Remove the field or drop that host from the command's `targets`. |
| `AB4928` | warning | An implicitly selected host supports commands but cannot express a frontmatter field the command uses; the command ships there without it (Cursor receives the prompt body only). | Accept the omission, restrict the command's `targets` to hosts that support the field, or remove the field. |

## The bundler escape hatch (`AB4720`–`AB4724`)

`tools.rsbuild` and `tools.rspack` are validated with the rest of the config
source, so a malformed or colliding hatch is an **error** before any bundler
runs — in `validate`, `build`, `inspect`, and `dev` alike. `AB4720`–`AB4723`
check the shape: `tools` must be an object whose only keys are `rsbuild`
(an Rsbuild environment-config object) and `rspack` (an Rspack config
object, a mutator function, or an array of both).

`AB4724` checks `tools.rsbuild.plugins` against the Rsbuild plugins the
framework registers itself — currently `@rsbuild/plugin-react`
(`rsbuild:react`), which every synthesized Rslib entry and every MCP App
view carries, whatever the view's entry extension. The hatch merges *beside* the framework profile
(`mergeRslibConfig` / `mergeRsbuildConfig` concatenate `plugins` arrays), and
Rsbuild's plugin manager appends every plugin it is handed without deduping by
name, so re-adding `pluginReact()` would register it twice. The check is
static: plugin objects are matched by `name`, nested arrays are flattened the
way Rsbuild flattens them, `false`/`null`/`undefined` holes are skipped, and a
plugin supplied as a Promise is not inspected. It is an error rather than a
warning for the same reason as its siblings: a config problem with one
deterministic fix, reported once at the source, so no build ever runs a
framework-owned plugin twice by accident.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB4720` | error | `tools` is not an object. | Declare `tools: { rsbuild?, rspack? }`. |
| `AB4721` | error | `tools` carries a key other than `rsbuild` or `rspack`. | Remove the key; the hatch has exactly two fragments. |
| `AB4722` | error | `tools.rsbuild` is not an Rsbuild environment-config object. | Declare an object fragment. |
| `AB4723` | error | `tools.rspack` is not an Rspack config object, a mutator function, or an array of both. | Use one of the three Rslib `tools.rspack` forms. |
| `AB4724` | error | `tools.rsbuild.plugins` supplies a plugin whose `name` matches a framework-owned registration (`rsbuild:react` from `@rsbuild/plugin-react`). The message names the plugin and its package. | Remove the plugin from `tools.rsbuild.plugins`; agent-bundle registers it in every config it synthesizes. |

## Route graph, state, layout, and provider conventions (`AB4800`–`AB4836`, `AB4940`–`AB4942`)

The route-graph compiler discovers conventional route modules
(`src/mcp/<server>/{tools,resources,prompts,apps}/*`, `src/events/*/*`,
`src/providers/*`, `src/cli/**`, `src/scripts/**`) and the shared layout
modules (`src/layout.*`, `src/mcp/<server>/layout.*`) into one immutable IR.
Discovery is not a packaging choice, so every collision is a hard **error**
and the compiler never silently picks a side. Modules that explicit
`scripts`, `hooks`, `bin`, `lib`, or `mcp` configuration references are
claimed by that declaration and never become routes — config always wins.
`agent-bundle inspect --routes` dumps the compiled graph.

Each route's `config` export is extracted statically — the module is parsed
with the TypeScript compiler, never executed — from a single top-level
`export const config = <expression>` declaration. The accepted expression
grammar is: object literals whose property names are identifiers, string
literals, or numeric literals (no computed names, spreads, shorthand
references, methods, or accessors); array literals without spreads or holes;
string literals and substitution-free template literals; numeric literals,
optionally wrapped in unary `+`/`-`; `true`, `false`, and `null`; and
`as`/`satisfies` casts, non-null assertions, and parentheses around any
accepted form. Two constrained reference forms are accepted for string
values, so an MCP App's `resourceUri` never has to be repeated as a literal
in every tool that opens it:

- **A `const` string-literal identifier.** A top-level `const X = '<literal>'`
  (optionally `as const`) declared in the route module, or an
  `export const X = '<literal>'` of a module reached through a *relative*
  import (`import { X } from '../constants'`; `.ts`/`.tsx` resolution,
  `.js`-style specifiers map onto their TypeScript source, index modules
  resolve) inside the project root. The sibling module is parsed, never
  executed, and only that one hop is followed: the exported const's
  initializer must itself be a string literal. Because the identifier is a
  real import, the same value is available at run time (for example in
  `Agent.Result metadata`).
- **`appResourceUri('<app>')`** imported from `agent-bundle/routes`. The
  compiler resolves the reference to the target App route's static
  `config.resourceUri` while compiling the graph. The App must belong to the
  referencing route's own generated server — a generated server registers
  exactly its own Apps, so another server's URI could never be read through
  it. References are `'<app>'`, `'<server>/<app>'`,
  `'app:<server>/<app>'`, or a module path relative to the referencing file
  (`'../apps/dashboard'`, with or without its `.ts`/`.tsx` extension — a
  `.js`/`.jsx` spelling maps onto the TypeScript source, and any other suffix
  is part of the App name). The argument may be a
  string literal or a const identifier of the first form. An unknown
  reference — another server's App, an App whose own `resourceUri` is not a
  static string, or any reference from a non-MCP route — is `AB4826`, and the
  route compiles with the empty config beside it. Routes of a server that is
  not generated (`custom`/`command`/`remote`, or an `AB4800` conflict) never
  ship their config, so their references are left as authored rather than
  reported. Whether referenced or
  written as a literal, an advertised `_meta.ui.resourceUri` must name an App
  the server builds for every target it ships to (`AB4828` otherwise). At run time the helper returns the reference unchanged: generated
  servers read the compiled config, never the module's evaluated `config`, so
  use the const form when the URI is also needed inside the component.

Anything else — any other identifier, a call, a package import, a relative
import that leaves the project or does not export a string-literal const —
is dynamic: the route compiles with an empty config beside a named `AB4806`
error whose recovery names both reference forms. A module without a `config`
export compiles silently with an empty config.

An MCP App route's `config.template` resolves **relative to the route
module**, the way its imports do (`template: './dashboard.html'`). The older
project-root-relative form (`'./src/mcp/<server>/apps/dashboard.html'`) is
still accepted, without a diagnostic, while it is the only interpretation
that names an existing file. When both interpretations name different
existing files, or neither exists, `AB4827` names both candidate paths; the
fix is to make the path route-relative. The IR keeps the authored path (so the
graph digest stays machine-independent) and the normalized model carries the
resolved absolute file. Config-declared Apps (`mcp.servers.<server>.apps`)
keep resolving `entry` and `template` from the project root, where the config
file lives.
Generated route declarations are published at `.agent-bundle/routes.d.ts` from
the same graph. Development writes a sibling temporary file and renames it over
the prior complete declaration atomically; invalid source retains the prior
last-good file, while a successful route-free, provider-free preparation
removes it. Beside `AgentBundleRoutes`, a graph with conventional providers
declares `AgentBundleProviders` (`ProviderKey`, `ProviderValue<Key>`) — each
camel-cased key mapped to its factory's awaited return type, in execution
order — and augments `@agent-bundle/runtime`'s `AgentProviderValues` so
`(await agent()).providers.<key>` observes that type in projects whose
TypeScript program includes the file. Provider-free graphs emit no
augmentation, so the declaration never references a module the project has no
reason to depend on. The file is only as good as the program that compiles
it: `create-agent-bundle` templates and the `examples/*` projects list
`".agent-bundle/routes.d.ts"` in `tsconfig.json` `include` (a literal entry,
because `**/*` never descends into dot-directories), while the file itself
stays gitignored. After publishing the declaration, `agent-bundle validate`
resolves the root `tsconfig.json` program the way `tsc -p` does — `extends`,
`files`, `include`, `exclude`, and one level of `references` for a
solution-style root — and reports `AB4834` (a **warning**, surfaced by
`validate` only) when the published file is not among its root files. A
project with no root `tsconfig.json`, no published declaration (route-free
and provider-free), or a `tsconfig.json` TypeScript cannot parse gets no
diagnostic: there is no program to be missing from, or `tsc` already
reports the parse failure itself.

Conventional `src/scripts/` routes ship through the same pipeline as
explicit `scripts` entries (#102 stage 1): a plain module directly under
`src/scripts/` compiles to `scripts/<name>.mjs` in every selected target
artifact with `provenance.kind: 'conventional'`. A rendered module
(`src/scripts/<name>.tsx`/`.jsx`, #102 stage 3) compiles to the same
`scripts/<name>.mjs` plus a sibling `scripts/<name>-flight.mjs` react-server
worker: its async default component receives `{ argv, signal }` and renders
through the Agent renderer with the full CLI output contract (`--json`,
`--ndjson`, interactive TTY progress, piped Markdown); the framework dialect
reserves exactly `--json` and `--ndjson`, every other argument passes
through as `argv`, and the exit code derives from the final document status
(0 on `success`, 1 otherwise). Explicit `scripts` config entries keep
ordinary Node semantics regardless of extension — config always wins, and
only the conventional route contract opts into rendering. Script routes
neither pipeline can ship are hard errors (`AB4808`/`AB4809`), never silent
omissions.

Conventional `src/cli/**` routes compile into one collision-checked command
graph (#102 stages 2-3): the file path below the CLI root is the command
nesting (`src/cli/library/audit.ts` runs as `<bin> library audit`), the
static `config` export supplies `description`, `aliases`, `positionals`, and
the `exitCode` policy, and the graph feeds one framework-generated package
executable named after the plugin (`dist/bin/<plugin-name>.js`), replacing
the `src/cli.ts` convention for that project. Every command route exports
`inputSchema` and `resultSchema` zod schemas plus one async default function
receiving `{ input, signal }`, and runs inside the typed Agent request
context. A plain (`.ts`) command executes directly and writes one canonical
JSON line to stdout. A rendered (`.tsx`) command's async default Server
Component renders through the runtime dispatcher against a sibling
`dist/bin/<plugin-name>-flight.mjs` react-server worker with four output
modes: interactive TTY updates progress in place before the final document;
piped output emits exactly one final Markdown document (no partial
fallbacks); `--json` emits the canonical validated final value; `--ndjson`
emits the sequence-numbered render-event stream (an Agent Bundle CLI/script
dialect — never MCP JSON-RPC, never written to an MCP server's stdout).
Diagnostics go to stderr; machine output owns stdout. Exit codes: 0 on
success (or the validated result's integer `exitCode` under
`config.exitCode: 'result'`), 1 on execution/render failure, 2 on usage or
input-validation failure, 130/143 after SIGINT/SIGTERM. `--help`, `--json`,
`--ndjson`, and `--version` are owned by the generated shell. An
`inputSchema` rejection is reported one issue per line in CLI terms —
`Invalid value for <target>: expected <expectation>; received <JSON>.` — then
the usage line; `--json` writes one `{"error":{"code":"CLI_INPUT_INVALID",
...}}` line to stderr and `--ndjson` one `type: "error"` event (#465).

The power-tier `routes.mcpCommands` option projects tools from generated MCP
servers into that same command graph. Each tool becomes
`<server> <tool>` with one optional `--input '<JSON object>'` argument;
mutation-capable tools also require the enforced `--yes` flag. Missing or
malformed `annotations.readOnlyHint` is mutation-capable by default. Include
and exclude patterns use only literal text plus `*`; every declared pattern
must match at least one eligible `<server>:<tool>` identity so misspellings
fail during compilation. Projected commands invoke the same tool render and
request-context contracts as the generated MCP server, and their `mcp`
metadata records server, tool, and confirmation provenance in `inspect`.

The argv projection of `inputSchema` is extracted statically — the module is
parsed, never executed — from a bounded zod grammar: the top level is
`z.object({ ... })` or `z.strictObject({ ... })` (optionally `.strict()`);
each property chains from `z.string()`, `z.number()`, `z.boolean()`,
`z.url()` (a string option validated as a URL at run time),
`z.enum([...string literals])`, or `z.array(<string/number/enum element>)`;
chains may add `.optional()`, `.default(<static literal>)`, and
`.describe('<string literal>')`, plus validation-only refinements the
projection accepts without interpreting (strings: `min`/`max`/`length`/
`regex`/`startsWith`/`endsWith`/`includes`; numbers: `int`/`min`/`max`/`gt`/
`gte`/`lt`/`lte`/`positive`/`nonnegative`/`negative`/`nonpositive`/`finite`/
`safe`/`multipleOf`/`step`; arrays: `min`/`max`/`length`/`nonempty`) because
the module's real zod schema still validates every input at run time. Keys
project onto kebab-case options (`maxFiles` becomes `--max-files`); booleans
are flags and must carry `.optional()` or `.default(...)`;
`config.positionals` names the keys consumed as bare arguments in order,
where only the trailing positional may be a `z.array(...)` (variadic).
Anything outside that grammar — identifier references (including shared
schema constants), unions, nested objects, transforms, coercions — raises
`AB4814` naming the offending construct.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB4800` | error | An MCP server has both discovered route modules under `src/mcp/<id>/` and an existing entry claim (the conventional `src/mcp/<id>.ts` module, or a declared `entry`/`command`/`url`) without an explicit `routes.servers.<id>` mode. |
| `AB4801` | error | The conventional `src/cli.ts` entry and `src/cli/` command route modules both exist without an explicit `routes.cli` mode. |
| `AB4802` | error | Two route modules derive the same route id (for example `.ts` and `.tsx` siblings with one stem). |
| `AB4803` | error | A route path derives an unsafe identity segment (each segment must match `^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$`). |
| `AB4804` | error | A `routes` mode override is not `generated`/`custom`/`command`/`remote` for a server, or `generated`/`conventional` for the CLI. |
| `AB4805` | error | A route module exports `config` through a rejected declaration shape (`let`/`var`, destructuring, `export { config }`, a function or class, a missing initializer), or the extracted value is not an object. |
| `AB4806` | error | A route module's `config` initializer is dynamic — the message names the offending construct and position, and the recovery names the two accepted reference forms (a top-level `const` string literal declared locally or `export const`-ed by a relative sibling module, and `appResourceUri('<app>')` from `agent-bundle/routes`). |
| `AB4807` | retired | The stage-1 rendered-script gate. Rendered script routes ship through the Agent renderer pipeline since #102 stage 3; the code is never reused. |
| `AB4808` | error | A conventional `src/scripts/` route nests below the scripts root; conventional scripts ship as direct children only. Move it up, prefix a path segment with `_`, or declare it under `scripts` in config with a flat name. |
| `AB4809` | error | A conventional `src/scripts/` route and a configured `scripts` entry share one script identity through different files. Point the config entry at the module to claim it, or rename one of the two. |
| `AB4810` | error | A generated MCP route is missing named `inputSchema`/`resultSchema` exports or its default export is not an async function component. A default re-exported from a relative module (`export { default } from '../shared.tsx'`, `export { Page as default } from`) is judged in the module that declares it and the message names that module; one re-exported from a package the check cannot read is accepted and verified when the route loads. |
| `AB4811` | error | A generated MCP route exports `execute` or `render`; route mode accepts only the async default Server Component contract. |
| `AB4812` | error | A generated MCP App route has no non-empty static `config.resourceUri`. |
| `AB4813` | error | The command graph collides: a route is both a command module and a command group, an alias collides with a sibling command, group, or alias, an alias is unsafe or duplicated, or an explicit `bin` entry claims the generated CLI executable's name. |
| `AB4814` | error | A CLI route's `inputSchema` leaves the bounded argv grammar (the message names the offending construct and position), a key projects onto a reserved or duplicate option name, a required boolean has no flag expression, or `config.positionals` violates the positional policy. |
| `AB4815` | error | A CLI route does not satisfy the routed command contract: missing named `inputSchema`/`resultSchema` exports, a default export that is not an async function, or malformed `config.description`/`aliases`/`exitCode` fields. |
| `AB4816` | retired | The stage-2 rendered-command gate. Rendered command routes render through the dispatcher since #102 stage 3; the code is never reused. |
| `AB4817` | error | An event route requires the shared runtime for a target, but no generated MCP entry hosts that runtime and the route does not allow standalone fallback. |
| `AB4818` | error | `src/state.ts` is present but does not default-export one direct `defineState({ ... })` call, or `state` config is not the supported `false` opt-out. |
| `AB4819` | error | The state definition's `id` or `lifetime` is missing, non-literal, empty, duplicated, or outside the state lifetime vocabulary. |
| `AB4820` | error | A generated project selects `external` state lifetime; v1 generated mounting supports only `request`, `process`, and `workspace-durable` because external drivers require embedder wiring. |
| `AB4821` | error | A project state definition uses the reserved notice-ledger id `@agent-bundle/runtime/agent-notice-ledger/v1`; generated runtimes own that id for the co-mounted notice store. |
| `AB4822` | error | A `routes.mcpCommands.include` or `.exclude` pattern matches no eligible tool, or `include: []` explicitly selects none. Correct the pattern using an available `<server>:<tool>` identity listed by the diagnostic. |
| `AB4823` | error | An event route declares an event outside the v1 event vocabulary. |
| `AB4824` | error | An event route selects an unknown target or requires an event capability that the selected target does not support. |
| `AB4825` | error | An event route's `config.targets` is not a nonempty array of nonempty target names. |
| `AB4826` | error | A route's static `config` calls `appResourceUri('<app>')` with a reference that matches no App route of the route's own generated server with a static `config.resourceUri`: an unknown name, another server's App (a generated server registers only its own Apps), or a reference from a non-MCP route. The message names the cause and lists the server's known App route ids; reference the App as `'<app>'`, `'<server>/<app>'`, `'app:<server>/<app>'`, or a relative module path. |
| `AB4827` | error | An MCP App route's `config.template` is ambiguous or missing: both the route-relative and the project-root-relative interpretation name different existing files, or neither exists. The message names both candidate paths; templates resolve relative to the route module, so rewrite the path as `'./<file>.html'` beside the route. |
| `AB4828` | error | A generated MCP route advertises `_meta.ui.resourceUri` of an App on its server (through `appResourceUri()` or a literal) that is not built for every target the server ships to, because the App's `config.targets` (or a config-declared App's `targets`) is narrower. Widen the App's targets or restrict `mcp.servers.<server>.targets`. |
| `AB4829` | error | Two distinct MCP App routes of one generated server declare the same static `config.resourceUri`. The message names both route files and the server; a generated server registers one App per resource URI and never picks a side. The same URI on App routes of *different* servers is not a collision — each server registers only its own Apps. Give each App route of the server a distinct `config.resourceUri`, or remove the duplicate module. |
| `AB4830` | error | A conventional layout module (`src/layout.*`, `src/mcp/<server>/layout.*`) does not satisfy the layout contract: its default export is not a function component, it exports the route-only `config`/`inputSchema`/`resultSchema`, or it exports `execute`/`render`. Default-export one component receiving `{ children, route, signal }` that renders `Agent.Result` around `children`. |
| `AB4831` | error | Two layout modules declare one layout scope (for example `src/layout.ts` beside `src/layout.tsx`). Keep exactly one module per scope. |
| `AB4832` | error | A server layout (`src/mcp/<server>/layout.*`) names an MCP server that declares no tool, resource, or prompt route modules — the server directory is missing or holds only `apps/` routes, which never take a layout. Add routes under that server directory, move the layout, or rename it `_layout.*` to opt out. A server pinned to `custom`, `command`, or `remote` via `routes.servers.<server>` is skipped entirely: its layout is neither validated (`AB4830`) nor retained, because no generated worker composes it. |
| `AB4833` | error | `notices.retention` is malformed: `notices` or `retention` is not an object, carries an unknown key, `terminalTtl` is not a positive integer of milliseconds or a duration such as `"7d"`, `"12h"`, `"30m"`, or `"90s"`, `maxTerminal` / `maxJournalBytes` is not a positive integer — or the policy is declared by a project without a conventional `src/state.ts`, which has no co-mounted notice ledger to retain. Omit a field to keep the runtime default (`7d`, `500`, `16777216`). |
| `AB4834` | warning | `agent-bundle validate` published `.agent-bundle/routes.d.ts` (the project compiles routes or providers) but the root `tsconfig.json` program — resolved like `tsc -p`, including `extends` and one level of project `references` — does not compile it, so `renderRoute` / `renderRouteEvents` type-check route ids as `string` and `input` / `result` as `unknown`. Reported on `tsconfig.json`; never for a project without one. | Add `".agent-bundle/routes.d.ts"` to `tsconfig.json` `include` (not `files`: an `include` entry is inert until the first build publishes the file, while a missing `files` entry is a `tsc` error); `build`, `dev`, and `validate` keep the file current and it stays gitignored. |
| `AB4835` | error | A route's static `config.render` (the render budget of one call, #454) is malformed: `render` is not an object, carries a key other than `maxElapsedMs`, `maxElapsedMs` is not a positive integer of milliseconds, or it exceeds the framework ceiling of `86400000` (24 hours) — or a plain `.ts` CLI command declares one, although it executes without a render session. Reported once per route: on an MCP tool, resource, or prompt route with its server (the tool's projected CLI command inherits the value), or on a `src/cli/**` command route; a route with a rejected budget compiles no command. Omit `render` to keep the runtime default (`60000`). Declare `config.render = { maxElapsedMs: <positive integer ≤ 86400000> }` on a rendered route, or remove it. The budget bounds the framework's render session only: Codex's `tool_timeout_sec` (60 s by default) and any per-server host timeout must be raised by the operator separately, while Claude Code's default per-call wall clock is about 28 hours and its idle timer is kept alive by the `notifications/progress` the projector forwards. |
| `AB4836` | error | A route's static `config.execution` (MCP task support, #369) is malformed: `execution` is not an object, carries a key other than `taskSupport`, or `taskSupport` is not one of `forbidden`, `optional`, `required` — or a resource or prompt route declares it, although the `2025-11-25` Tasks utility augments `tools/call` only. Reported once per route with its server. Omit `execution` to keep the wire default (`forbidden`: every call is an ordinary request), or declare `config.execution = { taskSupport: 'optional' }` so a task-aware client may receive a `CreateTaskResult` and poll `tasks/get` / `tasks/result` while the render continues, or `'required'` to refuse ordinary calls with JSON-RPC `-32601`. The generated server advertises the value in `tools/list` and declares the `tasks` capability only when at least one tool opted in. |
| `AB4940` | error | A conventional provider module has no default export or its default export is not a function. Default-export a factory receiving `{ invocation, plugin, signal }`. |
| `AB4941` | error | Two provider filenames derive the same camel-cased provider key. Rename one file so every provider key is unique. |
| `AB4942` | error | A provider filename derives the reserved `processLifetime` key. Rename the file so its camel-cased key does not collide with the framework-owned provider. |

## Read-only Doctor durable-state inventory (`AB7316`)

`agent-bundle doctor` inventories workspace-durable SQLite stores by directory
entry and filesystem metadata only. It never opens a database or creates
SQLite lock or shared-memory files.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB7316` | warning | An installed bundle's `state/` directory or one of its `*.sqlite`, `-wal`, or `-shm` files cannot be read with filesystem metadata operations. Repair permissions and rerun Doctor; Doctor never repairs state. |

## Read-only Doctor operator env inventory (`AB7331`)

An installed pack's shells read `<plugin root>/.env` and `.env.local` at
launch (#469) to fill variables the host did not set. Doctor reports whether
those files are present and how many variables each declares — never a name
or a value — so an operator can see that a credential-configured pack is, or
is not, configured. Absent files are the normal case and produce no
diagnostic.

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB7331` | info / warning | Info: an installed copy (or the `--from` bundle) carries `.env` or `.env.local` at its plugin root; the message names the file and its variable count. Warning: the file exists but cannot be read, so the pack's shells skip it at launch — repair its permissions and rerun Doctor. |

## Read-only runtime identity introspection (`AB7317`–`AB7318`)

| Code | Severity | Trigger |
| --- | --- | --- |
| `AB7317` | info | A live event runtime implements the older strict protocol and does not expose runtime identity. Restart it after upgrading Agent Bundle. |
| `AB7318` | error | A live event runtime became unavailable, timed out, or returned an invalid status response during the bounded read-only identity probe. Inspect or restart the runtime, then rerun Doctor. |

## Read-only Doctor static validation (`AB7319`–`AB7320`)

Doctor reuses the pinned, process-free host document and loader validators.
These checks read installed or supplied bundle bytes only; they never invoke a
host CLI, repair a bundle, or perform a live protocol exchange.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7319` | error | A host tree resolved from `doctor --from` violates its pinned document schemas or process-free loader rules. The message retains the originating build-validator code and detail. | Rebuild that host bundle from valid source bytes, then rerun Doctor. |
| `AB7320` | error / info | Error when a `.cursor-plugin/plugin.json` install violates Cursor's pinned document schemas or token-location rules (the hooks document checked is the one the manifest `hooks` field names, so a unified `plugin` bundle's Claude-format `hooks/hooks.json` beside its `hooks/hooks-cursor.json` is not a finding), when a root `plugin.json` install that declares an Agent Plugins `$schema` violates the pinned Agent Plugins 1.0.0 contract (`AB6035`–`AB6037`, retained in the message), or when any local plugin contains a symlink that escapes `~/.cursor/plugins/local`; the inventory entry is reported as `corrupt`. Info naming the contract applied to an Agent Plugins install, or stating that a `.claude-plugin/plugin.json` (or schema-less root `plugin.json`) install has no Cursor-side pinned static document contract; loader-recognized entries remain `installed`. | Reinstall an invalid Cursor plugin, rebuild an invalid portable bundle, or repair an escaping symlink. For other manifest flavors, use that ecosystem's validator when static document proof is required. |

## Install replacement and Doctor install comparison (`AB7005`, `AB7307`–`AB7309`, `AB7321`)

`agent-bundle install <host>` and the emitted standalone `install.mjs` share one
replace policy, and `agent-bundle doctor --from <bundle-dir>` reports the same
verdict read-only. Every Cursor copy an agent-bundle installer places carries an
install receipt, `.agent-bundle-install.json`, beside the plugin manifest:

```json
{
  "contentHash": "<sha256 over path\\0mode\\0bytes\\0 for every owned file; mode is x when executable>",
  "directories": [".cursor-plugin", "..."],
  "files": [".cursor-plugin/plugin.json", "INSTALL.md", "install.mjs", "..."],
  "format": "agent-bundle-install-receipt/2",
  "host": "cursor",
  "hostDirectories": ["plugins", "plugins/local"],
  "installedAt": "2026-09-03T08:00:00.000Z",
  "mode": "local",
  "plugin": "<plugin name>",
  "registrations": [{ "kind": "cursor-local-plugin" }],
  "scope": "user",
  "updatedAt": "2026-09-03T08:00:00.000Z",
  "version": "<plugin version>"
}
```

Format 2 (#101) adds the lifecycle fields that `agent-bundle uninstall`
consumes: `mode` (`local`, `marketplace`, or `host-cli`), `scope`, the
`registrations` the installer performed in order, the `hostDirectories` it
created under the host root on the way to the plugin root (pruned by uninstall
once empty; a directory the host made is never touched), and `updatedAt`
(`installedAt` stays the first install). Host-CLI installs (Claude, Codex) and
Cursor marketplace-mode staging cannot carry a receipt inside a host-owned or
committed tree, so theirs live in an Agent Bundle-owned store,
`<host root>/agent-bundle/receipts/<plugin>.<marketplace>.<scope>.json` for
Claude and Codex and `<plugin>.marketplace.json` for Cursor staging
(`~/.claude` or `$CLAUDE_CONFIG_DIR`, `~/.codex` or `$CODEX_HOME`,
`~/.cursor`), with `files: []` — they own no files, only the registrations and
the content hash. The host identifies a registration as `<plugin>@<marketplace>`,
so the same plugin installed from two marketplaces is two installs with two
receipts. A Claude `project` / `local` scope registration belongs to
the working directory the host verbs ran in (the bundle root), so those
receipts are keyed `<plugin>.<marketplace>.<scope>.<12-hex digest of projectRoot>.json` and
record `projectRoot`: two projects installing the same plugin at the same scope
are two receipts. The `<host>-marketplace` registration is recorded only when
the install actually created it — `plugin marketplace list --json` did not list
the marketplace beforehand (or the receipted install it replaces recorded it);
a marketplace that already existed, or one whose state could not be read,
is not claimed, and `uninstall` then retains it and says why. Between
`plugin marketplace add` and the receipt write those registrations exist only
in memory, so if the plugin install or the receipt write fails the install
reverses what did complete — the plugin (`plugin uninstall … --keep-data` /
`plugin remove`) when it was installed, then the marketplace when this run
created it — before rethrowing; a failed reversal is reported with the exact
host commands to run before retrying. Nothing is left registered without a
receipt to record it. A format 1
receipt (written by #420) is read with those
fields synthesized (`mode: local`, `scope: user`, one `cursor-local-plugin`
registration, no host directories) and reported as migrated (`AB7329`); an
identical rerun of the installer rewrites it as format 2. A current-format
receipt missing any field reads as absent, exactly like a malformed one.

The receipt never participates in the content hash, and neither do empty
directories or runtime roots (`state/`): only regular files are plugin content,
so the artifact hash, the installed tree, and the receipt always describe the
same entries. Ownership of an existing
destination is decided as **receipt** (a receipt naming this plugin), **legacy**
(no receipt, but the emitted `INSTALL.md` + `install.mjs` and a manifest with
this plugin's name — a copy installed before receipts existed), or **foreign**
(anything else). Claude and Codex copies are located through the host's own
`plugin list --json` inventory (Doctor runs it once per host and also lists every
installed plugin from it; `AB7303` is emitted only when that listing is unusable);
the host owns those copies, so replacement runs `claude plugin uninstall
--keep-data` + `install` or `codex plugin remove` + `add`.

| Installed copy | `install` | `install --replace` (alias `--force`) | Doctor |
| --- | --- | --- | --- |
| Identical content (receipt / host-managed) | `already-installed` no-op | `already-installed` no-op | `current` |
| Identical content (legacy) | `already-installed` no-op | `adopted` — receipt written, no plugin file changes | `current` |
| Receipt / host-managed, same version, different content | replaced automatically (`replaced`) | replaced | `stale` — `AB7308` warning |
| Receipt / host-managed, different version | `AB7005` version collision | replaced | `version-mismatch` — `AB7309` warning |
| Legacy, different content | `AB7005` content collision | adopted: the artifact's files are rewritten, every other file is left in place and stays unowned, receipt written (`replaced`) | `stale` — `AB7308` warning, recovery names `--replace` |
| Foreign directory | `AB7005` foreign install | `AB7005` foreign install | `foreign` — `AB7321` warning |
| Claude copy listed with `errors` (host refused to load it) | identical content: `AB7006`; otherwise replaced, then `AB7006` if the fresh row still carries `errors` | replaced, then `AB7006` if the fresh row still carries `errors` | `load-failed` — `AB7325` error (see below) |
| Nothing installed | installed | installed | `not-installed` — `AB7307` info |

Every `AB7005`, `AB7308`, `AB7309`, and `AB7321` message carries the comparison
`installed <name>@<version> content <hash> vs artifact <name>@<version> content
<hash> (same version, different content | different version | same content)`.
Cursor replacement is in place and touches owned files only: stale owned files
are removed and the emptied directories the installer itself created
(`directories` in the receipt) are pruned, staged files are renamed over their
predecessors, and the receipt lands last. Entries the installer does not own —
notably workspace-durable `state/` stores, and any directory that already
existed before the installer wrote beneath it — are never removed or rewritten;
when a rebuilt artifact introduces a path that an existing unowned entry already
occupies, replacement aborts before any change (`AB7004`, "Refusing to overwrite
unowned files") and names the colliding paths. Receipt file and directory lists
are validated as strict POSIX-relative paths (no backslashes, no
`..`/`.`/empty segments, no drive letters, nothing under a runtime root such as
`state/`) before they can drive a deletion; a receipt that fails validation
reads as absent, and a receipt that is not a regular file (a symbolic link, a
FIFO) is refused outright (`AB7004`) before it is read. The same rules apply to
the artifact itself: a file whose path could not round-trip through a receipt
(a backslash in a POSIX name, reserved characters, a trailing dot or space) is
refused (`AB7004`) before anything is staged. Every other failure of a local
Cursor install — a `~/.cursor` that exists but cannot be inspected, an
inventory, staging, or receipt write that fails — is reported the same way, as
`AB7004` with `target: cursor` and the underlying message; a missing
`~/.cursor` is `AB7002`. The staging directory is removed before the failure is
reported, so a refused or failed replacement never leaves a
`plugins/local/.<name>.stage-*` directory behind, and the installed copy is
untouched.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7005` | error | `install` refused an existing destination: a different installed version without `--replace`, a legacy pre-receipt copy with different content without `--replace`, or a foreign directory (refused even with `--replace`). | Re-run with `--replace` for the first two cases; remove a foreign directory manually. |
| `AB7321` | warning | Doctor found a directory at the Cursor install path that is not an agent-bundle install of this plugin: no receipt naming it and no emitted install surface with a matching manifest, or a receipt naming another plugin. The message carries the installed-versus-artifact content-hash comparison. | Remove the foreign directory manually before installing; `--replace` refuses foreign installs by design. |

A Cursor destination that holds nothing but preserved runtime state (`state/`,
plus the remnant receipt described below) is what `uninstall --keep-data`
leaves behind: `install` fills it back in as an `installed` (not a
replacement, not a foreign refusal), and Doctor reports it as `missing` with an
`AB7307` info naming the preserved state instead of `AB7321` or `AB7304`. The
remnant receipt alone does not make a directory "state-only": when `uninstall`
also retained unowned entries beside (or instead of) `state/`, both the
inventory finding and the `--from` bundle finding read the directory and the
`AB7307` message names those retained entries and points at removing them by
hand, since `uninstall` never will. Preserved state is only what `uninstall`
would still keep — a `state/` that holds something, and this home's real,
non-empty `PLUGIN_DATA` directory — so a remnant whose data has since been
removed or emptied is reported as exhausted, with the default `uninstall` that
consumes it as the recovery.

## Managed uninstall (`AB7007`–`AB7009`)

`agent-bundle uninstall <host> [--from <bundle-dir>] [--scope <scope>]
[--mode local|marketplace] [--keep-data | --purge-data --confirm-purge]
[--force] [--plan] [--json]`, the package-relative installer bin's
`uninstall <host>`, and the emitted `install.mjs --uninstall` are the
receipt-owned reverse of `install` (#101; the maintainer's 2026-09-01 G4
deferral of mutation was reversed on 2026-09-03 with the request to fix every
open issue). Every mutation is opt-in and bounded by the receipt:

- **Cursor local** — removes exactly the receipt's `files`, prunes its
  `directories` and the plugin root once empty, then the `hostDirectories` the
  install created (`~/.cursor/plugins/local`, `~/.cursor/plugins` in a fresh
  home). Unowned entries are listed as retained and never removed — files by
  path, and unowned directories that hold nothing retained as `name/` (the
  prune only ever touches owned directories, so they survive too). When the
  plugin root survives (retained state or unowned entries), a **remnant
  receipt** — `files: []`, `registrations: []`, the carried `hostDirectories` —
  is written there so a later purge can still prune the created directories and
  Doctor can explain the directory. When the receipt records a Cursor
  placeholder expansion (`cursorExpansion`, written by the emitted `install.mjs`
  for an Agent Plugins pack), its `PLUGIN_DATA` directory
  (`~/.cursor/agent-bundle/plugin-data/<name>`) is receipt-owned durable state:
  a written one is kept (the plugin root then survives with a remnant receipt
  carrying the expansion, so a later `--purge-data --confirm-purge` still finds
  it) or purged; an empty, installer-created one is pruned together with its
  `agent-bundle/plugin-data` and `agent-bundle` parents once they empty out; a
  recorded path outside this home's `plugin-data` is never touched and the
  `data.detail` says so; a symlinked `agent-bundle` or `plugin-data` ancestor
  is refused (`AB7007`) before anything is read or removed, since a recursive
  purge of the leaf would follow it outside the Cursor home. Doctor's `AB7307`
  names the directory as preserved state only when it is that same real,
  non-empty directory.
- **Cursor marketplace** — verifies the staged repository's `HEAD` against the
  commit the store receipt recorded and its working tree against that commit
  (`git --no-optional-locks status --porcelain --untracked-files=all
  --ignored=matching`, the same probe Doctor uses: any uncommitted, untracked,
  or ignored entry — or a tree that cannot be verified because git is missing
  or `status` fails — is refused with `AB7007` until `--force`, since the
  removal is recursive and those entries are not receipt-owned), then removes
  the repository wholesale and the receipt; a copy Cursor imported into
  `~/.cursor/plugins/cache` (recognised by the receipted commit and version,
  not the version the bundle may have been rebuilt to) is Cursor-owned and is
  reported `manual` with the Customize step in `nextSteps`.
- **Claude / Codex** — reads `<host> plugin list --json` (an unusable listing
  fails closed, `AB7004`), compares the cached copy with the receipt, runs
  `claude plugin uninstall <id> --scope <scope> --keep-data` /
  `codex plugin remove <id>`, then `plugin marketplace remove <marketplace>`
  and removes the store receipt. Because `plugin marketplace remove` applies
  to every scope, the marketplace is `retained` when the receipt does not
  record Agent Bundle registering it (it pre-existed the install, or there is
  no receipt), when another installed plugin still names it, when another
  store receipt (another project's scoped install) installs from it — whether
  that receipt records the marketplace registration or only its plugin, since
  a plugin installed after the marketplace existed still needs it — when the
  same plugin is installed at another Claude scope or in another project (live
  row, Claude's cross-project `plugins/installed_plugins.json` registry —
  which also records hand-made `project`/`local` installs elsewhere that have
  no receipt and are invisible to `plugin list --json` run here — or stored
  receipt), or when `plugin marketplace list --json`, the dependency re-read
  of `plugin list --json`, that registry, or any receipt in the store
  cannot be read (a failed read is not proof that nothing depends on it: an
  unreadable receipt may be the very dependent or ownership heir, so the
  dependency set is unknown and a purge of shared state is refused with
  `AB7008` too). When the receipt being consumed is
  the one recording that Agent Bundle registered the marketplace and a
  dependent keeps the marketplace alive, that claim is not lost with the
  receipt: it moves to a dependent's store receipt (the first not already
  recording it, at that receipt's scope) so the last uninstall can still
  remove the marketplace; when every dependent is a live row with no receipt
  to carry it, the registration `detail` says the marketplace now counts as
  user-owned. A registration the host no longer holds is `already-absent`, so
  a receipt orphaned behind Agent Bundle's back is consumed without running
  any host verb.

Durable runtime state (`state/`: the state kernel and notices journal) is kept
by default; `--keep-data` says so explicitly. `--purge-data` removes it only
with `--confirm-purge`. The typed `data.outcome` is honest per host: `kept` /
`purged` / `absent` (Cursor local, Agent Bundle's own doing),
`retained-by-host` (Claude 2.1.257 orphans the cached copy, `state/` included,
for its ~14-day grace period; a purge additionally removes `state/` and
`plugins/data/<id>/`), `removed-by-host` (codex-cli 0.147.0 deletes the cached
tree on `plugin remove`), and `unavailable` (Codex has no keep-data option; a
staged Cursor marketplace holds no runtime state). `--plan` computes the same
report — exact absolute paths, registrations, data decision — without opening a
writer; planned directories are exactly the ones the run would prune (purged
`state/` first, then every owned directory that would be left empty, and for
store receipts the `<host root>/agent-bundle/receipts` and
`<host root>/agent-bundle` directories — plus Cursor's
`agent-bundle/marketplaces` — once the last entry leaves them), never a
directory kept alive by retained state or unowned entries: `removed` in a
`--plan` result equals `removed` in the completed one. A second run after a
successful uninstall is a `not-installed` no-op. When `--keep-data` left
`state/` (or a written `PLUGIN_DATA` directory) behind under a Cursor local
root, the remnant receipt written there stays in place (`receipt.status:
'remnant'`) and a rerun without `--purge-data` is the same `not-installed`
no-op for as long as that preserved data — or an unowned entry the uninstall
retained — is still there; `--purge-data --confirm-purge` removes the
preserved state and prunes the root. Once the preserved data has been removed
or emptied by hand (an empty `state/` or `PLUGIN_DATA` directory holds no
data, so it is pruned like an installer-created directory rather than kept),
the remnant guards nothing, and the next run — with or without `--purge-data`
— consumes it: the receipt, the empty plugin root, and the host and
`plugin-data` directories it recorded. Doctor reports such a remnant as
exhausted (`AB7307`) instead of claiming preserved state that is gone.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7007` | error | `uninstall` refused a mismatch or a foreign target: the owned files hash differently from the receipt, the cached host copy differs from the receipt in version or content, the staged repository's `HEAD` is not the recorded commit or its working tree is dirty / unverifiable, the receipt names another plugin, the directory is not this plugin's install at all, or a destination / `state/` entry is a symlink or special file. | `--force` overrides content and `HEAD` mismatches (the receipt-owned set is still the only thing removed); a receipt or manifest naming another plugin, and symlinked entries, are refused regardless — inspect and remove them manually. |
| `AB7008` | error | `--purge-data` without `--confirm-purge`, `--purge-data` together with `--keep-data`, or (Claude) `--purge-data` while the same plugin is installed at another scope or in another project (a live `plugin list --json` row, an entry in Claude's `plugins/installed_plugins.json` registry, or a stored receipt for the same plugin) — the cached copy and `plugins/data/<id>/` are scope-less and still in use — or while `claude plugin list --json` or that registry cannot be read to prove there is no other scope. | Pass `--purge-data --confirm-purge` to delete durable state, or neither flag to keep it; for a shared Claude scope, uninstall without `--purge-data` and purge after the last scope is removed. |
| `AB7009` | error | `uninstall` found the install but no receipt proving Agent Bundle owns it: a Cursor local copy in the pre-receipt legacy layout, a staged marketplace repository without its store receipt, or a host-registered Claude/Codex copy without its store receipt. | Re-run with `--force` (a legacy Cursor copy is removed by its inventory, `state/` kept; a host-CLI install is removed through the host verbs), or reinstall with `--replace` first to record a receipt. |

The Cursor and portable host-install proofs (`tests/host-install-proof.test.ts`,
`tests/packed-host-install-proof.test.ts`) snapshot the isolated home before
install and after uninstall and require them byte-identical; the Claude and
Codex proofs require zero Agent Bundle residue and classify every remaining
host-owned entry (Claude: orphaned cache copy with `.orphaned_at`, empty
`installed_plugins.json` / `known_marketplaces.json`, `settings.json`, session
bookkeeping; Codex: an empty `config.toml` and empty cache directories).

## Read-only Doctor lifecycle receipts and activation states (`AB7328`–`AB7330`)

With `--from`, Doctor reports each host bundle's lifecycle as four typed
observations — **placed** (bytes at the host's install location), **registered**
(the host's registry names the plugin), **enabled** (the host reports it
enabled/trusted), **active** (loaded by a live host process) — each either
`observed` with the host evidence that made it true or false, or `unavailable`
with the reason no pinned read-only surface exposes it, and a `stage` (the
furthest observed-true stage; `absent` when placement is observed false,
`unknown` when it is unobservable). Doctor never guesses an activation state.

| Host | placed | registered | enabled | active |
| --- | --- | --- | --- | --- |
| Claude 2.1.257 | cache path from `claude plugin list --json` exists | row present (scope noted) | row `enabled` flag | unavailable: no read-only verb reports what a live session loaded |
| Codex 0.147.0 | pinned cache path exists | row present in `installed` | row `enabled` flag | unavailable: no read-only verb; plugin hooks additionally stay untrusted until the user trusts them in the hook browser (no trust verb) |
| Cursor (local) | `~/.cursor/plugins/local/<name>` exists | same as placed (the directory is the registration; loads at window reload) | unavailable: enabled state is server-assigned in `state.vscdb`, gated by `thirdPartyExtensibilityEnabled` / `enable_cc_plugin_import` (2026-09-03 audit, 3.18.25) | unavailable: no non-interactive plugin-loading surface |
| Cursor (marketplace) | staged repository exists | completed copy from this staging under `~/.cursor/plugins/cache` | unavailable (as above) | unavailable |

Doctor also inventories the Agent Bundle receipt store under each host root
(`hosts[].receipts`) and cross-checks every receipt against the host, and
reports the in-tree receipt of every Cursor local copy (`receipt` on the
inventory finding and on the bundle finding).

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB7328` | warning | A store receipt is orphaned — the host no longer holds the registration it records (Claude/Codex listing lacks the plugin — a Claude `project`/`local` receipt is checked by `plugin list --json` run from its recorded `projectRoot`, and is `unknown`, never orphaned, when that root cannot be listed; the staged Cursor marketplace repository is gone) — or the receipt store / a receipt file could not be read or is not a valid receipt. | `agent-bundle uninstall <host> --from <bundle-dir> [--mode marketplace]` consumes an orphaned receipt; reinstall to rewrite an invalid one; repair permissions. |
| `AB7329` | info | A receipt predates lifecycle receipts (`agent-bundle-install-receipt/1`) and was read with synthesized `mode`, `scope`, `registrations`, and `hostDirectories`. Doctor never rewrites it. | Rerun `agent-bundle install` (or `install.mjs`) once; an identical copy rewrites the receipt as format 2 without changing plugin files. `uninstall` accepts the migrated receipt as is. |
| `AB7330` | info | The bundle's lifecycle stage on this host and its four observations; the message lists every `unavailable` stage with its reason. When Claude lists the plugin at several scopes the observations aggregate every row — a stage holds only when it holds for every listed copy, and the evidence names the scopes that are disabled, unplaced, or carry no enabled flag — so the report never depends on Claude's row order. | Stage-specific: register (`agent-bundle install`), enable (`claude plugin enable`, Codex `/plugins`, Cursor Customize), or complete the Cursor import; unavailable stages need no action and are never guessed. |

## Live development into hosts (`AB7200`–`AB7202`, `AB7210`–`AB7211`, `AB8024`–`AB8025`)

`agent-bundle dev` keeps a host's one stdio MCP process connected while it
swaps the generated plugin behind it (`dev proxy`), re-syncs opted-in
development installs (`--install-host`) on every adopted epoch, and — when a
project declares `dev.contracts` — gates host-facing adoption on the
development contract matrix. Every failure on that path is a structured
diagnostic; none of them silently changes what a host serves. A failing gate
is not a build failure: the epoch publishes to the Workbench playground, and
the Overview page's **Host adoption** section names both the published and the
host-facing build together with the failed checks.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7200` | error | A development rebuild could not be admitted: the coordinator is closed, closing, or not yet started. | Restart `agent-bundle dev`; no epoch changed. |
| `AB7201` | error | The prepare, lint, or artifact phase of a development rebuild threw instead of reporting diagnostics. The message names the phase and the underlying error. | Fix the named failure and save again; the last-good epoch stays active. |
| `AB7202` | error | Publishing a new epoch into an installed development host (`claude`, `codex`, or `cursor`) failed. Pointers were rolled back to the previous generation and the failure was published on `dev.host.sync`. | Repair the host cache path or permissions named in the message; the next successful epoch re-syncs. |
| `AB7210` | error | `dev.contracts` is malformed, its `fixtures` module escapes the project root, cannot be loaded, or default-exports something other than route-id keyed `ContractRouteFixture` objects. Reported on `dev.contract.status` for the affected epoch; compilation is unaffected. | Correct `dev.contracts` or the fixture module and rebuild; host surfaces keep the last passing epoch meanwhile. |
| `AB7211` | error | The development contract matrix failed or could not complete for a published epoch. The message carries the aggregated `contract-violation` detail; `dev.contract.status` lists the failed check names grouped by route. That epoch is never adopted by live host connections or development installs. | Fix the failing route or fixture and rebuild; a passing epoch is adopted normally. |
| `AB8024` | error (MCP) | The epoch a live host connection was serving vanished from the epoch store mid-session. The connection is invalidated and the typed MCP error carries `{ code, epochId }`. | Reconnect from the host; the proxy binds to the currently adopted epoch. |
| `AB8025` | error (MCP) | `agent-bundle dev proxy` found no running development server for the project (cold start or shutdown), so the host-facing connection fails closed rather than serving stale bytes. | Start `agent-bundle dev` for that project root; installed hooks and Skills remain in place. |

## Development rebuild compilation and publication (`AB7100`–`AB7102`)

Every `agent-bundle dev` rebuild compiles the project into a build attempt,
validates the artifact, proves the project source did not change underneath
it, and publishes the result as an immutable epoch. Structured diagnostics
thrown along that path — the `AB4770` compile errors of an MCP App view, the
artifact validation codes — pass through to the failed attempt unchanged, so
the Workbench Overview and the `build.failed` Logs entry show the real
finding. `AB7100` is only what remains: the fallback for a throw in that pass
that carried no structured diagnostics, and the code of a cleanup failure
after the attempt settled. `sourcePath` on all three codes is the project's
config file.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7100` | error / warning | `Unable to compile the build: <error>` — the compile, validate, or publish pass of a rebuild threw something that was not a `DiagnosticError` carrying diagnostics. Also `Unable to clean up build attempt after the build: <error>` or `Unable to clean up staging epoch after the build: <error>` when removing the attempt directory or closing an unpublished staging epoch fails: a **warning** on a succeeded attempt (the epoch is live), an error on a failed one. | Read the wrapped error; a structured cause reports under its own code instead. A cleanup failure names a path under `.agent-bundle/attempts` or `.agent-bundle/epochs` to repair or remove. |
| `AB7101` | error | `Project source changed while the artifact was compiling; publication was rejected.` — the source snapshot taken after compilation differs from the inputs the build read, so the attempt is discarded rather than published as an epoch built from mixed inputs. | Nothing to fix: the change that raced the build is already queued as the follow-up rebuild, and the last-good epoch stays active until it succeeds. |
| `AB7102` | warning | `Artifact epoch was committed, but follow-up work was incomplete: <error>` — the epoch is published and active, but the work after the commit failed: retention cleanup of older epochs (`Epoch publication committed, but retention cleanup failed.`) or confirming the active-epoch metadata reached disk (`… active metadata durability could not be confirmed.`). | The epoch itself is valid and serving. Check the epoch store under `.agent-bundle/epochs` for the retained or unsynced files the wrapped error names; the next publication runs the same follow-up work again. |

## Development package build (`AB7103`)

`agent-bundle dev` rebuilds the framework-owned package build (`dist/` bin
and lib outputs) inside the same serialized rebuild pass that publishes
artifact epochs. A package build failure never invalidates the artifact epoch
that already committed; it surfaces as one `AB7103` **warning** on the
succeeded build attempt, and the package build retries on the next
invalidation. See `docs/entry-conventions.md` for the dev-watch contract.

## Read-only Doctor Cursor hook registration and marketplace staging (`AB7322`–`AB7324`)

Cursor delivers a plugin's hooks from its `.cursor-plugin/plugin.json` `hooks`
declaration (observed 2026-09-03 on Cursor 3.18.25; see
`docs/audits/2026-09-03-cursor-plugin-hooks-registration.md`). Doctor proves
that registration statically and never writes `~/.cursor/hooks.json`.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB7322` | info / error | Info: an installed `.cursor-plugin/plugin.json` plugin registers plugin-scoped hooks (from the document its manifest `hooks` field names, or from `hooks/hooks.json` folder discovery when the field is absent; events and command count listed) and the script each command executes — `${CURSOR_PLUGIN_ROOT}/…` or any relative path, including an interpreter's entry operand — exists under the plugin root (`hooks.state = registered`). Error: the declared hooks file is missing (`missing`), is not a regular file or not a `{ version, hooks: { <event>: [{ command }] } }` document, or an executed script is absent (`stale`). Documents and scripts are probed with `stat` before any read, so a FIFO cannot stall Doctor. | Reinstall the plugin from a bundle whose emitted hooks document and scripts are intact. |
| `AB7323` | warning | `~/.cursor/hooks.json` registers a command whose executed file (after leading `NAME=value` assignments, `env`, and interpreter options) points into an installed plugin directory — compared on path-component boundaries, case-folded on Windows — so Cursor would deliver that hook twice; or the file is not a valid hooks document. | Remove the plugin-pointing entries or repair the file; manifest registration alone is sufficient. |
| `AB7324` | info / warning / error | A staged marketplace repository under `~/.cursor/agent-bundle/marketplaces/<name>` (from `install cursor --mode marketplace`) is imported by Cursor (matching plugin under `~/.cursor/plugins/cache`; info, `registered`), still awaiting the Customize "Add Plugins from Local Repository" step (warning, `unregistered`), or incomplete (error, `corrupt`: manifests missing or failing the pinned schemas, no resolvable Git HEAD, HEAD naming a commit object that does not exist, or a working tree that differs from committed HEAD — verified read-only through `git cat-file -e` / `git --no-optional-locks status` when `git` is available). | Complete the Customize import, use `--mode local`, or remove the staged directory and rerun the installer. |

The installer side reuses the `AB700x` codes: `AB7002` when `git` is missing
in marketplace mode, `AB7003` when a mode is passed for a non-Cursor host, when
marketplace mode is requested for a bundle without `.cursor-plugin/plugin.json`,
or when the bundle contains nested Git metadata (`.git`, which `git add` would
record as an empty gitlink), `AB7004` when a `git` step fails or the committed
tree does not hold the staged bundle bytes (the installer disables `text`,
`eol`, `filter`, `ident` and `working-tree-encoding` attributes through
`.git/info/attributes`, adds with `core.autocrlf=false`, and proves every
blob id in `git ls-tree -r HEAD` against the staged files; requires Git ≥ 2.29
for `git init --object-format=sha1`), and `AB7005` for staged version or
content collisions (including a working tree that differs from committed HEAD).

## Host load refusal for Claude installs (`AB7006`, `AB7325`)

`claude plugin install` and `claude plugin validate --strict` both accept a
plugin that Claude Code then refuses at load time; the refusal surfaces only
as the `errors` array on that plugin's row in `claude plugin list --json`
(Claude Code 2.1.259 shape: `id`, `version`, `scope`, `enabled`, `installPath`,
`installedAt`, `lastUpdated`, optional `mcpServers`, and `errors` — a nonempty
array of strings present only on a refused plugin; healthy rows omit the key,
and the refused row still reports `enabled: true`). A refused copy is
installed but contributes no hooks, MCP servers, or skills to a session, so
`agent-bundle install claude` and `agent-bundle doctor --host claude` read
that array instead of treating every listed row as a healthy install. The
observed instance is the manifest `hooks` pointer at the auto-loaded
`hooks/hooks.json` ("Hook load failed: Duplicate hooks file detected …
manifest.hooks should only reference additional hook files"), which the
`claude` and unified `plugin` targets no longer emit (#470) and which the
pinned Claude `plugin` schema now rejects (`AB6012` at `/hooks`).

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7006` | error | `install claude` found `errors` on the plugin's row: after `claude plugin install` ran (the install itself exited 0, so the result would otherwise have been `installed`/`replaced`), or on a byte-identical existing copy that would otherwise have been reported `already-installed` (reinstalling the same bytes cannot help). The message carries the host's `errors` verbatim, the install path, and the scope. An unusable post-install listing leaves the result unverified rather than failing an install the host accepted. | Fix the artifact until `claude plugin list --json` shows no `errors` for it (the message names the cause), rebuild, and rerun `agent-bundle install claude --from <bundle-dir> --replace`. |
| `AB7325` | error | Doctor found `errors` on the plugin's row in `claude plugin list --json` (inventory entry `state: 'failed'` with `errors`; `doctor --from` comparison `status: 'load-failed'` with `errors` instead of `current`/`stale`, since the installed bytes never reach a session) or on the `--plugin-dir` registration proof row (`bundle.state: 'failed'` with `errors`, replacing the `registered` verdict). The message carries the host's `errors` verbatim. `build` and `validate --artifact` emit the same code from their load check (see "Claude Code host validation"). | Same as `AB7006`: fix the artifact, rebuild, and reinstall with `--replace`. |

## Disabled Claude install (`AB7327`)

`claude plugin disable <plugin>` (or the `/plugin` menu) keeps a plugin
installed but switched off: its row in `claude plugin list --json` reports
`enabled: false`, and none of its hooks, MCP servers, or skills reach a session
until `claude plugin enable` runs (Claude Code docs, "Plugins reference" →
"plugin enable" / "plugin disable"). Reinstalling, even with `--replace`, does
not enable it. `agent-bundle doctor --host claude` reads the flag: the
inventory entry carries `enabled: false` with `state: 'disabled'` (instead of
`installed`), and a `--from` comparison of that copy carries `enabled: false`
next to its content verdict — a disabled copy can still be `current` or
`stale`, and both facts are reported. Rows without a boolean `enabled` carry no
flag and are `installed`. A row with `errors` is `failed` (`AB7325`) whatever
its `enabled` value. A plugin that ships `defaultEnabled: false` in
`plugin.json` installs disabled by design ("Plugins reference" → "Default
enablement"); Doctor still reports `AB7327` for it, because the recovery is the
same `claude plugin enable`.

| Code | Severity | Trigger | Recovery |
| --- | --- | --- | --- |
| `AB7327` | warning | `doctor --host claude --from <dir>` compared an installed copy whose row reports `enabled: false`. The message names the plugin, version, install path, and scope. | Run `claude plugin enable <name>@<marketplace> [--scope <scope>]` (or use `/plugin` in a session), then rerun Doctor; reinstalling does not enable a disabled plugin. |

The JSON report exposes the same facts: `hosts[].inventory.findings[].errors`,
`hosts[].bundle.errors`, and `hosts[].bundle.comparison.errors`. The text
report prints the comparison as `installed copy: load failed (installed
<version>, refused by the host: <errors>)`.

## Read-only Doctor Cursor Agent Plugins launch proof (`AB7326`)

Cursor 3.18.25 loads Agent Plugins 1.0.0 packages from
`~/.cursor/plugins/local/<name>` but spawns their stdio servers without
expanding `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` in `args`, `env` values, or
`cwd`, without providing the reserved `PLUGIN_ROOT` / `PLUGIN_DATA` variables
(spec §9.1), with an omitted `cwd` defaulting to the home directory, and with
plugin-relative `./` commands resolved against the workspace folder (spec
§7.2.1); see `docs/audits/2026-09-03-agent-plugins-cursor-ide-proof.md`. The
emitted portable `install.mjs` therefore rewrites `mcp.json` in the Cursor copy
only — absolute plugin root, `~/.cursor/agent-bundle/plugin-data/<name>`
(created) for the data directory, plugin-root `cwd`, resolved `./` command, and
`PLUGIN_ROOT` / `PLUGIN_DATA` in every stdio server's environment — and records
the substituted values plus the pre-expansion document in the install receipt
(`cursorExpansion`). Doctor validates the Agent Plugins contract (`AB7320`)
against that recorded document and proves the expansion against the installed
bytes. Provenance is always `derived`: nothing here claims Cursor expands the
placeholders itself.

| Code | Severity | Meaning | Recovery |
| --- | --- | --- | --- |
| `AB7326` | info / warning / error | Info (`launch.state = expanded`): the receipt's expansion still describes the installed copy — same plugin root, existing data directory, no placeholder left, absolute `cwd` and plugin-root `command`/`args` paths that exist, `PLUGIN_ROOT` / `PLUGIN_DATA` equal to the recorded values. Warning (`unexpanded`): an Agent Plugins install without a recorded expansion whose stdio servers still rely on the spec forms Cursor does not resolve (the message lists the forms per server); Cursor reports `spawn … ENOENT` / `MODULE_NOT_FOUND` for them. Error (`drifted`, entry `corrupt`): the installed `mcp.json` is not byte-identical to the expansion Doctor recomputes from the recorded document (edited, replaced, or removed after install), the recorded expansion names another plugin root (the copy was moved or duplicated), the data directory or an expanded path no longer exists, or the environment no longer carries the recorded values. Only a byte-identical copy has its recorded document validated by `AB7320`; a drifted copy is validated as the bytes on disk. Packages without stdio servers, and copies already carrying absolute paths with the §9.1 variables, produce no finding. | Reinstall with the bundle's emitted `install.mjs` at the copy's current location; the Cursor-target (`.cursor-plugin/plugin.json`) bundle is never rewritten and is not subject to this check. |
