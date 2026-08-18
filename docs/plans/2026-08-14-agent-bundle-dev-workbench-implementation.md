# Agent Bundle developer workbench implementation plan

**Status:** Ready for execution

**Date:** 2026-08-14

**Design:** `docs/plans/2026-08-14-agent-bundle-dev-workbench-design.md`

## Outcome

Deliver the developer workbench described by the design as a sequence of usable, independently
reviewed vertical slices. The shipped compiler remains the only artifact compiler. The workbench
adds immutable development epochs, a packaged Rsbuild React UI, artifact-bound MCP and hook
playgrounds, deterministic and native-host evals, comparison, and an optional agent-facing MCP
endpoint.

The published product must work with the installed Claude Code and Codex CLIs using their existing
signed-in subscription/session authentication. It must not accept, request, inject, or persist
model-provider API keys.

## Settled implementation decisions

1. Services precede the UI that presents them. No page ships with fake data or placeholder host
   behavior.
2. The implementation order is phase 0, coordinator/epochs, packaged shell, Skills, basic MCP and
   hooks, deterministic evals, native Claude and Codex harnesses, host-backed playground, then
   comparison and the optional agent MCP.
3. Natural-language playground runs arrive only after at least one real native harness. Before
   that, the playground supports MCP and hook operations plus Skill inspect/render/validate/select.
   `script.run` remains in the typed contract for a future host-provided OS-contained executor,
   but is capability-gated and rejected before admission until that executor is configured;
   Skills do not gain a fake executor.
4. Codex and Claude path-token expansion is capability-gated. Agent Bundle expands only the
   tokens supported by the selected adapter and never claims unsupported native host behavior.
5. Inspector protocol state, controlled Inspector source vendoring, hook UI, and MCP Apps
   sandboxing are separate review boundaries.
6. The initial Inspector baseline is release `2.2.0`, commit
   `672f9f41c548487a468b9e7007d2f9de14da5a69`, subject to the phase-zero closure build. The
   allowlist, license, dependency closure, patches, and content digests are checked in. Install,
   build, and dev never download Inspector source.
7. Current compatible dependency releases are resolved and pinned when each slice lands. Stale
   design-era pins do not override the already verified MCP split SDK `2.0.0` or current Rstack
   packages.
8. Workbench assets have stable unhashed filenames. Integrity and versioning live in package and
   artifact manifests, not asset-name hashes.
9. `inspect` remains a source/config planning operation. `validate --artifact` and artifact-bound
   services are the source-free artifact operations.
10. Terra workers own implementation. Non-Terra reviewers and the root agent own architecture,
    contract decisions, and review. Every code slice starts with a failing test, commits at a
    coherent green boundary, and receives independent review before dependent work proceeds.

## Shared verification contract

Every implementation task must:

- add a focused failing contract before production code;
- use public Rstack and MCP APIs rather than private subpaths;
- preserve stable unhashed output names and the existing source-free artifact contract;
- avoid shell-joined child commands and avoid API-key configuration;
- run focused tests, typecheck, lint, and relevant package/build checks;
- mutation-probe the important new guard or binding;
- commit only its owned coherent slice;
- leave the tracked worktree clean and append an ignored evidence report.

Native subscription-backed probes are opt-in in ordinary test runs but must be executed locally
before the corresponding harness task is approved. Expected missing/incompatible/unauthenticated
host states are structured harness failures, not plugin failures.

## Task sequence

### W1: Host and toolchain contract fixtures

Add checked-in, secret-free capability fixtures for installed Claude Code and Codex CLI versions,
their supported non-interactive flags, plugin lifecycle commands, stream event envelopes, and
minimum supported versions. Unit-test the parser against checked-in raw `--version` and `--help`
output. Put comparison with locally installed CLIs behind the native-contract opt-in so ordinary
CI and packed consumers do not need either host CLI.

Acceptance:

- fixtures record Claude `--plugin-dir`, stream JSON, hook-event, and no-session flags;
- fixtures record Codex temporary-home marketplace/add/list and ephemeral JSON execution commands;
- no fixture contains auth state, user paths, prompts, or model output;
- missing or changed required flags produce one actionable contract diagnostic;
- versions older than the checked-in modern baseline are rejected rather than routed through a
  compatibility branch.

### W2: Native host contract smokes

Create opt-in handwritten-plugin smokes for Claude and Codex. Claude loads an explicit plugin with
`-p --plugin-dir`, stream JSON, the current signed-in subscription/session, and never `--bare`.
Codex creates a temporary `CODEX_HOME`, copies `auth.json` opaquely with its mode, installs a local
marketplace candidate, verifies it, and runs `codex exec --ephemeral --json` from a fresh fixture.

Acceptance:

- neither harness accepts or sets API-key options, and provider API-key variables are removed from
  the child environment before the signed-in CLI is launched;
- normal Claude/Codex config and plugin state are unchanged;
- startup/plugin/MCP errors and capability evidence are captured into redacted fixtures;
- Claude activation is marked observed only for authoritative events; Codex automatic activation
  remains inferred unless the CLI exposes an authoritative event.

### W3: Inspector allowlist and sync contract

Build the smallest useful Inspector `2.2.0` source closure under Rsbuild. Add a maintainer-only
sync command, `UPSTREAM.json`, exact copied-path allowlist, dependency allowlist, retained upstream
tests, MIT license, `PATCHES.md`, patch files when unavoidable, and post-patch digests.

Acceptance:

- vendored byte-identical files remain byte-identical;
- imports outside the declared closure fail the sync/build contract;
- sync requires an explicit repository commit and produces a reviewable diff;
- ordinary install/build/dev performs no network fetch;
- Inspector license and notices are included in the eventual published tarball.

### W4: Epoch, path-token, and browser-bridge contract spikes

Run disposable, self-contained spikes for atomic epoch publication, lock ownership, and the
browser-to-stdio transport before the production coordinator/session services exist. Retain only
checked-in contract fixtures and evidence from those spikes; permanent epoch/lock tests land with
W7. Separately add the shared production path-token resolver now and route the existing one-shot
MCP service through it so selected-host expansion applies to `args`, `env`, and `cwd`, never
`command`.

Acceptance:

- the disposable epoch fixture proves failed publication retention, second-writer rejection, and
  dead-PID recovery on the local platform without leaving skipped future tests;
- a self-contained `AgentBundleRemoteTransport` prototype initializes, lists, calls, receives
  stderr/progress, cancels, and closes against a generated stdio fixture;
- retained protocol frames become the W12/W13 transport contract rather than production code;
- unsupported tokens produce adapter capability diagnostics;
- standalone `mcp invoke` and later persistent sessions share the same command-excluding resolver.

### W5: Development contracts and event hub

Add public/internal types for artifact epochs, source/build/artifact status, invalidations, and a
stable project-event envelope. Implement an in-process ordered event hub with bounded replay for a
newly connected browser.

Acceptance:

- source state, failed build attempts, active artifact epochs, and runtime events are distinct;
- events have monotonic sequence IDs and explicit epoch IDs where applicable;
- replay cannot reorder live events.

### W6: Project and diagnostic services

Extract a `ProjectService` around the existing load/discover/validate/normalize flow and a
`DiagnosticService` around one resident Rslint engine. Associate diagnostics with source paths
without reparsing Skill Markdown in the browser.

Acceptance:

- config/source/model errors stop a candidate build while preserving last-good status;
- affected-file lint reuses one engine and closes cleanly;
- programmatic consumers receive frozen structured results.

### W7: Epoch store and lock

Implement `.agent-bundle/epochs`, staging publication, active epoch metadata, the dev lock, epoch
references, and retention of the active epoch, referenced epochs, and five newest unreferenced
epochs.

Acceptance:

- publication is atomic across all selected targets;
- an MCP session or eval run pins its exact epoch until close;
- cleanup never deletes active/referenced epochs;
- lock and staging recovery have permanent real-filesystem tests derived from W4 evidence.

### W8: Artifact service, coordinator, and watcher

Implement `ArtifactService`, `DevCoordinator`, and broad-source invalidation. Call the existing
compiler into epoch staging, validate it, publish through the epoch store, serialize builds, and
coalesce changes during a running build into one follow-up build.

Acceptance:

- successful start returns structured status and one active epoch;
- failed rebuild retains last-good epoch and labels it stale;
- no overlapping publications occur;
- config, skills, references, assets, scripts, hooks, MCP sources, Views, and native extension
  files invalidate the project;
- `close()` leaves no watcher, child, engine, or lock.

### W9: Foreground HTTP server and typed routes

Add a loopback-only foreground server for prebuilt assets, typed JSON routes, and a project-event
stream. Product logic remains in services. Add only the minimal same-session origin/token checks
needed for process-starting routes; do not introduce a general auth framework.

Acceptance:

- route decoding errors are stable diagnostics without stack traces;
- event reconnect resumes from sequence ID;
- server and coordinator close together;
- arbitrary executable paths are never accepted from the browser.

### W10: Rsbuild workbench shell and packaged `dev`

Create a private `packages/workbench` React app with Rsbuild contributor HMR and stable production
assets. Implement the Overview page and connect `startDevServer()` plus `agent-bundle dev` to the
published foreground server. Copy prebuilt assets and notices into the `agent-bundle` tarball.

Acceptance:

- Overview answers normalization, active/stale epoch, target, diagnostic, and next-action state;
- contributor proxy and published server expose identical typed contracts;
- production assets contain no filename hashes;
- `--no-open` serves without launching a browser;
- packed consumer starts, receives events, and closes cleanly.

### W11: Skill document service and browser

Expose source and generated Skill documents/resources from explicit source or epoch bases. Build
the Skills tree and synchronized Rendered, Source, and Generated tabs using server-parsed
frontmatter/body, `react-markdown`, GFM, and lazy fine-grained Shiki.

Acceptance:

- CommonMark/GFM, tables, tasks, links, images, and code render correctly;
- raw HTML, JSX/MDX, and Mermaid are inert in the first release;
- source and generated relative links cannot cross their labeled base;
- binary resources are served byte-identically;
- browser tests cover lazy highlighter loading and source/generated parity.

### W12: Persistent epoch-bound MCP sessions

Add a persistent session service beside the existing one-shot `McpService`. Bind each session to
`{epochId,target,serverName}`, one resolved generated command/environment, and one managed plugin
data directory. Expose initialize, catalogs, calls, reads, cancellation, progress, logging,
stderr, raw frames, restart, and close.

Acceptance:

- the browser cannot choose a command or source path;
- restart remains on the selected epoch;
- cancellation and shutdown do not leak a process or temp directory;
- each raw protocol frame is retained unchanged, while decoded structured content, resources, and
  result `_meta` deep-equal the SDK value and are never translated.

### W13: Browser MCP transport and basic playground

Add authenticated workbench session routes/stream and `AgentBundleRemoteTransport`. Build basic
MCP controls for tools, resources, templates, prompts, JSON-Schema forms, raw JSON, history,
replay, logs, progress, and standalone-Inspector config export.

Acceptance:

- form and raw JSON calls are equivalent;
- generated stdio and HTTP/SSE fixtures use the exact selected epoch;
- raw frames and concise views share one ordered trace;
- unsupported client features fail explicitly rather than hanging.

### W14: Inspector-derived UI integration

Integrate only the approved vendored Inspector hooks/components through an internal adapter and
Agent Bundle theme. Do not import private npm subpaths or the Inspector launcher/server shell.

Acceptance:

- retained upstream tests pass under Rstest/Rsbuild;
- adapter-owned transport/epoch/theme logic stays outside `vendor/`;
- snapshot provenance and license ship in the package;
- a sync mutation or undeclared dependency is detected.

### W15: Hook playground

Expose existing `HookService` through epoch-bound routes and build the Hook page showing canonical
intent, host mapping, native input, emitted wrapper execution, native output, and canonical result.

Acceptance:

- simulation executes the emitted target wrapper only;
- fixture and inline canonical inputs produce the same result;
- unsupported target/event mappings are visible diagnostics;
- saved replay stays bound to its original epoch.

### W16: MCP Apps sandbox and bridge

Add a different-origin sandbox proxy and official MCP Apps bridge. Select Views only from standard
`_meta.ui.resourceUri`, read them through the bound MCP session, require
`text/html;profile=mcp-app`, apply conservative CSP defaults, and forward same-session bridge
operations.

Acceptance:

- `ui/initialize`, original tool input/result, same-server `tools/call`, resource reads, context,
  display mode, logging, and teardown work;
- `openai/outputTemplate` remains visible raw metadata but is never synthesized or selected;
- ChatGPT-compatible and Claude-compatible host contexts render the same portable fixture;
- ordinary text/structured fallback remains usable without a renderer;
- teardown releases the App binding and its session reference; the shared MCP session closes only
  when its final owner or explicit session control closes it.

### W17: Deterministic playground trace and replay

Create the shared ordered trace/event store and direct whole-plugin operations for scripts, MCP,
and hooks, plus Skill inspect/render/validate/select operations. Skills are documents and do not
gain a fake deterministic executor. Add replay/export, Artifacts, and Logs pages. Define and freeze
a small versioned `DraftEvalCase` contract; promotion writes that shape with durable outcome and
assertion choices rather than incidental tool order, and W18 consumes it unchanged.

Acceptance:

- all operations cite the exact epoch and raw event references;
- replay preserves ordering and epoch binding;
- artifact tree, provenance, executable metadata, and epoch diff are inspectable;
- the draft case schema contains the task, fixture, target, invocation intent, durable outcome,
  selected assertions, and an explicit schema version;
- no natural-language host action is presented before a native harness exists.

### W18: Eval DSL, discovery, and fixtures

Implement `agent-bundle/eval` types/builders, eval config normalization, suite discovery, invocation
modes, evidence requirements, assertion builders, and allowlisted fresh fixture materialization
with optional Git baseline. Import W17's `DraftEvalCase` unchanged and provide an explicit
conversion into an authored suite case.

Acceptance:

- direct, automatic, none, negative, and edge cases are representable;
- prompts do not receive assertions/reference answers;
- every trial gets an equal fresh fixture digest;
- no provider credentials are configuration fields.

### W19: Run store and deterministic harness

Implement the schema-versioned JSON/JSONL run store, single-writer ownership, deterministic
harness, deterministic graders, pass/fail/inconclusive evidence, and reproducible multi-trial
aggregation.

Acceptance:

- harness failures are distinct from plugin failures;
- raw artifacts can reproduce every displayed conclusion;
- two trials never share a mutable fixture;
- current-source standalone evals build and validate one run-owned immutable artifact copy;
- explicit `--artifact` inputs are validated and read exactly, with no ambient output guessing;
- every run and trial records its exact target digest;
- no database is added;
- JSON documents publish by atomic temporary-file rename; readers ignore and report at most one
  incomplete trailing JSONL record.

### W20: Deterministic eval API, CLI, and UI

Add `runEvals()`, deterministic `agent-bundle eval`, suite/case selection, trial count, and the first
Eval page. Model-backed configuration remains an explicit unsupported diagnostic until native
harnesses land.

Acceptance:

- CLI/API/browser use the same service;
- one- and multi-trial runs persist complete evidence;
- draft playground cases can be promoted into typed suite material without hiding edits.

### W21: Claude native harness

Implement pure Claude stream-event normalization, preflight, process lifecycle, cancellation,
plugin loading, activation evidence, usage capture, and an optional semantic grader through the
installed Claude Code CLI and existing signed-in subscription/session.

Acceptance:

- command uses explicit generated plugin directory and never `--bare`;
- ordinary environment is inherited after removing model-provider API-key variables, forcing the
  CLI to rely on its existing subscription/session auth state and preflight;
- missing/incompatible/unauthenticated CLI becomes a harness-failure trial;
- authoritative Skill events are observed; weaker evidence is not upgraded;
- fixture normalizer tests precede and outnumber live smokes.

### W22: Codex native harness

Implement pure Codex JSONL normalization, temporary-home auth-state handling, local marketplace
installation, plugin verification, ephemeral execution, activation evidence, cleanup, and an
opt-in signed-in smoke.

Acceptance:

- `auth.json` is copied opaquely with permissions and never parsed or modified;
- ordinary environment is inherited after removing model-provider API-key variables;
- normal `CODEX_HOME` config/plugin/auth digests are unchanged;
- candidate state exists only in the temporary home;
- automatic activation is inferred unless an authoritative event exists;
- missing/incompatible/unauthenticated CLI becomes a harness-failure trial.

### W23: Host-backed whole-plugin playground

Connect the whole-plugin natural-language playground to the native harness services. Combine host
initialization, activation evidence, hook/MCP/script events, response, workspace changes, and
diagnostics into the shared ordered trace.

Acceptance:

- host selection and model/version provenance are explicit;
- candidate and baseline never share a workspace;
- completed sessions replay/export and promote to draft eval;
- no provider API or API-key fallback exists.

### W24: Comparisons and reliability matrix

Implement aligned baseline/candidate comparison, pass@k, pass^k, actual `k/n`, duration/recorded
usage, non-comparable labeling, and the comparison UI.

Acceptance:

- case, host, model, CLI version, fixture digest, invocation, and grader versions must align;
- mismatches never contribute to a delta;
- one or two trials are labeled smoke evidence, not reliability claims.

### W25: Optional agent-facing development MCP

When `dev.agentApi` or `--agent-api` is enabled, expose the documented project/skill/artifact/MCP/
hook/eval tools as a Streamable HTTP MCP server backed by the same services. It is absent by
default and never enters generated artifacts.

Acceptance:

- disabled mode exposes no endpoint;
- tools cannot select arbitrary commands or paths;
- endpoint closes with the foreground dev session;
- tool results match the browser/programmatic services.

### W26: Packed workbench dogfood and delivery audit

Install the final tarball outside the repository and exercise the prebuilt UI, live events,
rebuild/stale recovery, Skills, artifact-bound MCP/hooks/Apps, deterministic evals, optional native
smokes, comparison, and optional agent MCP. Delete source where artifact-only behavior is claimed.
Update README and third-party notices with only implemented commands and limitations.

Acceptance:

- tarball contains stable workbench assets, Inspector provenance/license, and no undeclared
  runtime import;
- contributor and published modes share service contracts;
- all processes, watchers, locks, sessions, sandboxes, and temp homes close cleanly;
- full Rstest unit/integration/browser suite, native opt-in suite, lint, typecheck, Rsbuild/Rslib
  builds, dependency audit, and package dry run pass;
- an independent cross-cutting review finds no remaining concrete correctness issue.

## Review gates

- **R0:** W1–W4 external contract evidence and Inspector closure.
- **R1:** W5–W8 coordinator races, epochs, locks, invalidation, and shutdown.
- **R2:** W9–W10 published server/assets and clean consumer.
- **R3:** W11 Skill safety/parity and source/generated bases.
- **R4:** W12–W16 session binding, vendoring provenance, hook wrapper execution, Apps sandbox.
- **R5:** W17 trace/replay/draft schema.
- **R6:** W18–W20 deterministic eval evidence and run storage.
- **R7:** W21 Claude harness command/auth/evidence contract.
- **R8:** W22 Codex temporary-home isolation and evidence contract.
- **R9:** W23–W26 end-to-end comparison, optional agent MCP, packaging, and shutdown.

No dependent gate opens until the previous gate is green, committed, and independently approved.
