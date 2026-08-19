# Agent Bundle Workbench and Evals Implementation Plan

**Status:** Implemented through Task 11; Task 12 delivery verification, authenticated native smokes, and packed-consumer verification remain in progress.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foreground development coordinator, React workbench, generated-artifact MCP/hook playgrounds, deterministic and semantic eval system, and native Claude Code/Codex harnesses described by the approved workbench design.

**Architecture:** Application services live in the published `agent-bundle` package and are shared by CLI, HTTP, optional MCP, and browser handlers. A private Rsbuild React workspace consumes typed JSON/event contracts and ships prebuilt assets with the CLI. Trials always bind immutable artifact epochs and fresh fixture copies; native model work is delegated to installed CLI processes using their existing signed-in sessions.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, Rsbuild 2.1, React 19, Rstest Browser Mode, Playwright Chromium, MCP TypeScript SDK 1.30, React Markdown 10, remark-gfm 4, Shiki 4, Mantine 9.

## Global Constraints

- The foreground server binds loopback only and exits cleanly with the coordinator.
- Published consumers receive prebuilt browser assets; only contributors run Rsbuild HMR.
- Artifact epochs publish atomically and running sessions never switch epochs.
- Browser routes never accept arbitrary executable paths; all processes resolve from validated manifests.
- Claude trials use normal `claude -p --plugin-dir` and existing Claude Code subscription/session auth; never `--bare` and never an API key.
- Codex trials use a temporary `CODEX_HOME`, opaque copied `auth.json`, temporary marketplace/plugin state, and `codex exec --ephemeral --json`.
- Agent Bundle never accepts, requests, injects, logs, or stores API keys/model-provider credentials.
- Semantic graders invoke a configured native CLI harness and do not call provider APIs directly.
- Every trial gets a fresh fixture copy and classifies host/auth/plugin startup failures as harness failures.
- UI claims distinguish `observed`, `inferred`, and `unavailable` evidence.
- Raw HTML and MDX/JSX in Skill Markdown remain inert; Mermaid remains a code fence in the first release.

---

## File Structure

```text
packages/agent-bundle/src/
├── dev/
│   ├── coordinator.ts               # serialized rebuild orchestration
│   ├── project-service.ts           # config/discovery/normalization facade
│   ├── artifact-service.ts          # compiler/validator/epoch facade
│   ├── diagnostic-service.ts        # resident Rslint affected-file engine
│   ├── epochs.ts                    # staging, publication, retention, refs
│   ├── lock.ts                      # single writer and stale recovery
│   ├── watcher.ts                   # invalidation batching
│   ├── server.ts                    # loopback HTTP/static/event server
│   ├── routes.ts                    # typed route codecs only
│   └── events.ts                    # ordered project/session event stream
├── eval/
│   ├── index.ts                     # public eval DSL
│   ├── types.ts                     # suite/case/trial/run contracts
│   ├── discover.ts                  # eval module loading
│   ├── fixture.ts                   # fresh copies and digests
│   ├── assertions.ts                # deterministic assertions
│   ├── aggregate.ts                 # pass rate/pass@k/pass^k/compare
│   ├── run-store.ts                 # locked JSON/JSONL persistence
│   ├── service.ts                   # trial orchestration
│   └── harnesses/
│       ├── types.ts                 # harness contract
│       ├── deterministic.ts
│       ├── claude.ts
│       └── codex.ts
└── services/
    ├── playground-service.ts        # unified trace/replay/promotion
    └── agent-api.ts                 # optional Streamable HTTP MCP
packages/workbench/
├── package.json
├── rsbuild.config.ts
├── rstest.config.ts
├── src/
│   ├── index.html
│   ├── main.tsx
│   ├── app.tsx
│   ├── api/client.ts
│   ├── state/project-store.ts
│   ├── components/*
│   ├── pages/{overview,playground,skills,mcp,hooks,artifacts,evals,logs}.tsx
│   ├── markdown/*
│   └── inspector/
│       ├── adapter/*
│       ├── vendor/*
│       ├── UPSTREAM.json
│       ├── PATCHES.md
│       └── LICENSE.inspector
└── tests/*.test.tsx
scripts/sync-inspector.mjs             # maintainer-only pinned snapshot refresh
THIRD_PARTY_NOTICES
```

### Task 1: Atomic artifact epochs, project lock, watcher, and coordinator — implemented

**Files:**
- Create: `packages/agent-bundle/src/dev/epochs.ts`
- Create: `packages/agent-bundle/src/dev/lock.ts`
- Create: `packages/agent-bundle/src/dev/watcher.ts`
- Create: `packages/agent-bundle/src/dev/coordinator.ts`
- Create: `packages/agent-bundle/src/dev/events.ts`
- Create: `packages/agent-bundle/src/dev/project-service.ts`
- Create: `packages/agent-bundle/src/dev/artifact-service.ts`
- Create: `packages/agent-bundle/src/dev/diagnostic-service.ts`
- Test: `packages/agent-bundle/tests/dev-coordinator.test.ts`

**Interfaces:**
- Produces: `DevCoordinator.start()`, `rebuild(reason)`, `status()`, `close()`
- Produces: `EpochStore.publish()`, `retain()`, `release()`, `cleanup()`

- [x] **Step 1: Write failing real-filesystem tests**

  Assert invalidations coalesce, a second change during a build creates exactly one follow-up, successful staging rename publishes the complete epoch, failed validation retains the last good epoch, references prevent cleanup, the five newest unreferenced epochs remain, affected files reach one resident Rslint engine, and a live second writer is rejected.

- [x] **Step 2: Run the focused test and confirm the coordinator is absent**

- [x] **Step 3: Implement the process lock with PID liveness and stale-lock recovery**

- [x] **Step 4: Implement focused project/artifact/diagnostic services, serialized rebuilds, atomic epoch publication, retention, structured status, and complete shutdown**

- [x] **Step 5: Run tests with open-handle detection and repeat the race cases**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/dev packages/agent-bundle/tests/dev-coordinator.test.ts && git commit -m "feat: coordinate atomic development epochs"`

### Task 2: Eval DSL, fixture materialization, deterministic graders, and RunStore — implemented

**Files:**
- Create: `packages/agent-bundle/src/eval/index.ts`
- Create: `packages/agent-bundle/src/eval/types.ts`
- Create: `packages/agent-bundle/src/eval/discover.ts`
- Create: `packages/agent-bundle/src/eval/fixture.ts`
- Create: `packages/agent-bundle/src/eval/assertions.ts`
- Create: `packages/agent-bundle/src/eval/aggregate.ts`
- Create: `packages/agent-bundle/src/eval/run-store.ts`
- Test: `packages/agent-bundle/tests/eval-core.test.ts`

**Interfaces:**
- Produces: `defineEvalSuite`, assertion builders, `materializeFixture`, `aggregateTrials`, `compareRuns`, `RunStore`

- [x] **Step 1: Write failing tests for typed suites and independent fixture copies**

  Assert the same source digest, distinct writable directories, optional Git baseline commit, allowlisted files only, and no mutation sharing.

- [x] **Step 2: Write failing literal-outcome tests for pass/fail/inconclusive assertions and aggregation**

  Cover exit code, script outcome, required/forbidden MCP calls, activation evidence, pass rate, pass@k, pass^k, and alignment mismatch classification.

- [x] **Step 3: Write a failing concurrency test proving one writer per run directory and complete JSONL records**

- [x] **Step 4: Implement the DSL, fixture copier, graders, aggregation, and strict canonical store**

- [x] **Step 5: Run focused tests and inspect the persisted run tree**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/eval packages/agent-bundle/tests/eval-core.test.ts && git commit -m "feat: add deterministic eval core"`

### Task 3: Harness contract and deterministic runner — implemented

**Files:**
- Create: `packages/agent-bundle/src/eval/harnesses/types.ts`
- Create: `packages/agent-bundle/src/eval/harnesses/deterministic.ts`
- Create: `packages/agent-bundle/src/eval/service.ts`
- Test: `packages/agent-bundle/tests/eval-service.test.ts`

**Interfaces:**
- Produces: `Harness.preflight()`, `Harness.runTrial()`, normalized `TrialTrace`, and `EvalService.run()`

- [x] **Step 1: Write a failing end-to-end deterministic trial test against a built epoch**

  Assert preflight, fresh fixture, ordered trace, durable outcome, grading, raw references, and RunStore persistence.

- [x] **Step 2: Run and observe missing orchestration**

- [x] **Step 3: Implement the harness interface, failure taxonomy, deterministic runner, and EvalService lifecycle**

- [x] **Step 4: Ensure startup/auth/plugin/timeout failures remain harness failures and preserve available evidence**

- [x] **Step 5: Run the focused and full suites**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/eval packages/agent-bundle/tests/eval-service.test.ts && git commit -m "feat: orchestrate deterministic eval trials"`

### Task 4: Claude Code native CLI harness and semantic grader — implemented; authenticated smoke remains open

**Files:**
- Create: `packages/agent-bundle/src/eval/harnesses/claude.ts`
- Create: `packages/agent-bundle/fixtures/contracts/claude/stream-events.jsonl`
- Test: `packages/agent-bundle/tests/claude-harness.test.ts`
- Test: `packages/agent-bundle/tests/native-claude.smoke.test.ts`

**Interfaces:**
- Produces: `ClaudeHarness` and `ClaudeSemanticGrader`

- [x] **Step 1: Capture `claude --version`, `claude --help`, and `claude auth status --json` into redacted capability fixtures**

  Retain only boolean auth state, auth method category, CLI version, and supported flags; never persist account identifiers or credential values.

- [x] **Step 2: Write failing trace-normalization tests from a complete stream fixture**

  Cover initialization, plugin errors, MCP state, Skill calls, hook events, tools, result, usage, stderr, malformed lines, and `observed` activation.

- [x] **Step 3: Implement preflight and argument construction**

  Exact invariant: spawn `claude -p --plugin-dir <artifact> --output-format stream-json --include-hook-events --no-session-persistence --model <model>` using inherited environment and existing signed-in session. Reject any Agent Bundle API/config field that attempts to supply an API key. Never add `--bare`.

- [x] **Step 4: Implement streaming execution, timeout/cancellation, normalization, and semantic grading through a second native CLI invocation**

- [ ] **Step 5: Run fixture tests, then the opt-in authenticated smoke against a handwritten plugin and fresh fixture**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/eval packages/agent-bundle/fixtures/contracts/claude packages/agent-bundle/tests/*claude* && git commit -m "feat: run evals through Claude Code CLI"`

### Task 5: Codex native CLI harness — implemented; authenticated smoke remains open

**Files:**
- Create: `packages/agent-bundle/src/eval/harnesses/codex.ts`
- Create: `packages/agent-bundle/fixtures/contracts/codex/exec-events.jsonl`
- Test: `packages/agent-bundle/tests/codex-harness.test.ts`
- Test: `packages/agent-bundle/tests/native-codex.smoke.test.ts`

**Interfaces:**
- Produces: `CodexHarness`

- [x] **Step 1: Capture installed Codex version and plugin/exec help into capability fixtures**

- [x] **Step 2: Write failing unit tests for temporary-home setup and complete JSONL trace normalization**

  The home test must prove only opaque `auth.json` is copied with its mode, marketplace/plugin state is new, the source home digest is unchanged, and cleanup removes the temporary home.

- [x] **Step 3: Implement preflight and temporary lifecycle**

  Invoke `codex plugin marketplace add`, `codex plugin add`, `codex plugin list --json`, and `codex exec --ephemeral --json -m <model>` with the temporary `CODEX_HOME`. Do not accept or construct API-key environment variables.

- [x] **Step 4: Implement JSONL normalization, inferred activation, cancellation, cleanup, and failure classification**

- [ ] **Step 5: Run fixture tests, then the opt-in authenticated smoke and prove the normal Codex home is byte-identical**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/eval packages/agent-bundle/fixtures/contracts/codex packages/agent-bundle/tests/*codex* && git commit -m "feat: run evals through Codex CLI"`

### Task 6: Foreground HTTP server, typed routes, and live events — implemented

**Files:**
- Create: `packages/agent-bundle/src/dev/server.ts`
- Create: `packages/agent-bundle/src/dev/routes.ts`
- Modify: `packages/agent-bundle/src/dev/events.ts`
- Modify: `packages/agent-bundle/src/api.ts`
- Test: `packages/agent-bundle/tests/dev-server.test.ts`

**Interfaces:**
- Produces: `startDevServer({ root, port, open, agentApi }): Promise<DevSession>`
- Produces routes for project, skills, artifacts, MCP, hooks, evals, logs, and event stream.

- [x] **Step 1: Write failing real-server tests on an ephemeral loopback port**

  Assert static index serving, typed project snapshot, ordered live event delivery, route validation, process-start route session token, origin rejection, and close cascading to watchers/children.

- [x] **Step 2: Run and confirm the server entry is absent**

- [x] **Step 3: Implement the loopback server and route codecs with handlers delegating to application services**

- [x] **Step 4: Serve contributor proxy contracts and published prebuilt assets through the same API paths**

- [x] **Step 5: Run focused tests with open-handle detection**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/dev packages/agent-bundle/src/api.ts packages/agent-bundle/tests/dev-server.test.ts && git commit -m "feat: serve the development workbench"`

### Task 7: Rsbuild React shell, project store, and overview — implemented

**Files:**
- Create: `packages/workbench/package.json`
- Create: `packages/workbench/rsbuild.config.ts`
- Create: `packages/workbench/rstest.config.ts`
- Create: `packages/workbench/src/index.html`
- Create: `packages/workbench/src/main.tsx`
- Create: `packages/workbench/src/app.tsx`
- Create: `packages/workbench/src/api/client.ts`
- Create: `packages/workbench/src/state/project-store.ts`
- Create: `packages/workbench/src/pages/overview.tsx`
- Test: `packages/workbench/tests/overview.test.tsx`

**Interfaces:**
- Produces: browser API client, event-driven project store, page router, overview target/status matrix.

- [x] **Step 1: Write a failing browser test for the five overview questions**

  Use a real in-memory API transport and assert normalization state, active/stale epoch, target matrix, diagnostics, changed files, and next action.

- [x] **Step 2: Run Rstest Browser Mode and observe the missing app**

- [x] **Step 3: Configure Rsbuild React/HMR and implement the typed client/store/app shell**

- [x] **Step 4: Implement responsive navigation and overview without duplicating server logic**

- [x] **Step 5: Run browser test and production Rsbuild build**

- [x] **Step 6: Commit**

  Run: `git add packages/workbench package.json package-lock.json && git commit -m "feat: add Rsbuild workbench shell"`

### Task 8: Skill browser and inert Markdown renderer — implemented

**Files:**
- Create: `packages/workbench/src/pages/skills.tsx`
- Create: `packages/workbench/src/markdown/skill-document.tsx`
- Create: `packages/workbench/src/markdown/code-block.tsx`
- Create: `packages/workbench/src/markdown/resource-link.tsx`
- Test: `packages/workbench/tests/skills.test.tsx`

**Interfaces:**
- Consumes server-parsed `SkillDocument`; never parses frontmatter in the browser.

- [x] **Step 1: Write failing browser tests for frontmatter, GFM, resources, source/generated bases, and inert content**

  Assert tables/task lists/links/code render, Shiki loads only when a fence exists, relative images use the correct API base, raw HTML is not mounted, JSX is visible text, and Mermaid remains code.

- [x] **Step 2: Run and confirm the renderer is absent**

- [x] **Step 3: Implement React Markdown/remark-gfm components and lazy fine-grained Shiki loading**

- [x] **Step 4: Implement the tree and synchronized Rendered/Source/Generated tabs**

- [x] **Step 5: Run Browser Mode and production asset build**

- [x] **Step 6: Commit**

  Run: `git add packages/workbench/src packages/workbench/tests/skills.test.tsx && git commit -m "feat: render and inspect Skills"`

### Task 9: Inspector snapshot, MCP remote transport, and MCP page — implemented

**Files:**
- Create: `scripts/sync-inspector.mjs`
- Create: `packages/workbench/src/inspector/{adapter,vendor}/*`
- Create: `packages/workbench/src/inspector/UPSTREAM.json`
- Create: `packages/workbench/src/inspector/PATCHES.md`
- Create: `packages/workbench/src/inspector/LICENSE.inspector`
- Create: `THIRD_PARTY_NOTICES`
- Create: `packages/workbench/src/pages/mcp.tsx`
- Test: `packages/workbench/tests/mcp.test.tsx`
- Test: `packages/agent-bundle/tests/mcp-remote-transport.test.ts`

**Interfaces:**
- Produces: `AgentBundleRemoteTransport` bound to `{ epochId, target, serverName }`.

- [x] **Step 1: Pin one Inspector commit and create an allowlist from public source paths used by client state, hooks, protocol views, forms, progress, and logs**

- [x] **Step 2: Write failing sync verification for upstream/post-patch digests, dependency allowlist, moved paths, license, and adapter preservation**

- [x] **Step 3: Write a failing browser-to-stdio bridge test**

  Initialize, list, call, observe stderr/progress, cancel, restart on the same epoch, and reject arbitrary executable input.

- [x] **Step 4: Vendor byte-identical sources where possible, record mechanical patches, and implement the adapter/transport**

- [x] **Step 5: Build the MCP page with catalog/forms/raw JSON/history/replay/export bound to the selected epoch**

- [x] **Step 6: Run retained upstream fixtures, server transport tests, Browser Mode, and Rsbuild production build**

- [x] **Step 7: Commit**

  Run: `git add scripts packages/workbench/src/inspector packages/workbench/src/pages/mcp.tsx packages/workbench/tests packages/agent-bundle/tests THIRD_PARTY_NOTICES && git commit -m "feat: integrate the MCP protocol workbench"`

### Task 10: Hooks, artifacts, logs, and whole-plugin playground — implemented

**Files:**
- Create: `packages/agent-bundle/src/services/playground-service.ts`
- Create: `packages/workbench/src/pages/hooks.tsx`
- Create: `packages/workbench/src/pages/artifacts.tsx`
- Create: `packages/workbench/src/pages/logs.tsx`
- Create: `packages/workbench/src/pages/playground.tsx`
- Test: `packages/workbench/tests/playground.test.tsx`
- Test: `packages/agent-bundle/tests/playground-service.test.ts`

**Interfaces:**
- Produces ordered trace, replay export, and `promoteToDraftEval(sessionId)`.

- [x] **Step 1: Write failing service tests combining build, host preflight, Skill evidence, hook/MCP/script events, response, workspace changes, diagnostics, and raw links in order**

- [x] **Step 2: Write failing browser tests for canonical/native hook forms, artifact provenance/diff, producer-grouped logs, replay, and draft eval promotion**

- [x] **Step 3: Implement the shared timeline and promotion service over existing product services**

- [x] **Step 4: Implement the four pages with immutable epoch selection and no source shortcuts**

- [x] **Step 5: Run service/browser tests and a real generated hook/MCP fixture**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src/services packages/agent-bundle/tests packages/workbench/src/pages packages/workbench/tests && git commit -m "feat: add the whole-plugin playground"`

### Task 11: Eval matrix, comparisons, and raw evidence UI — implemented

**Files:**
- Create: `packages/workbench/src/pages/evals.tsx`
- Modify: `packages/agent-bundle/src/cli.ts`
- Modify: `packages/agent-bundle/src/api.ts`
- Test: `packages/workbench/tests/evals.test.tsx`
- Test: `packages/agent-bundle/tests/eval-cli.test.ts`

**Interfaces:**
- Produces CLI `eval` and `eval compare`; UI case/host/model matrix and aligned comparison.

- [x] **Step 1: Write failing CLI tests for suite/case selection, host/trial overrides, persisted run IDs, and comparison output**

- [x] **Step 2: Write failing browser tests for live trial state, evidence labels, k/n metrics, non-comparable mismatches, duration/usage, and raw links**

- [x] **Step 3: Implement CLI/API wiring over EvalService**

- [x] **Step 4: Implement the eval page and comparison matrix without recomputing server conclusions**

- [x] **Step 5: Run process/browser tests and compare two deterministic multi-trial runs**

- [x] **Step 6: Commit**

  Run: `git add packages/agent-bundle/src packages/agent-bundle/tests packages/workbench/src/pages/evals.tsx packages/workbench/tests/evals.test.tsx && git commit -m "feat: report and compare eval runs"`

### Task 12: Optional agent-facing MCP and end-to-end packaged dogfood

**Status (2026-08-18):** The optional Agent API and its thirteen-tool contract are implemented.
Documentation is current; packed-consumer dogfood, native authenticated smokes, and the complete
release gate remain the tracked delivery checks in Steps 4 and 6 below.

**Files:**
- Create: `packages/agent-bundle/src/dev/agent-api.ts`
- Test: `packages/agent-bundle/tests/agent-api.test.ts`
- Test: `packages/workbench/tests/packed-release.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces the thirteen documented development MCP tools only while `dev --agent-api` runs.
- Uses one stable, loopback-only Streamable HTTP URL with standard bearer authentication so a preconfigured Codex session can remain connected across foreground-server restarts.
- Keeps the agent-facing tool names and schemas stable. Rebuilds atomically replace the active artifact epoch behind those tools: new calls bind the new epoch, while in-flight calls and open product sessions retain their original epoch reference.
- Does not depend on clients honoring MCP `notifications/tools/list_changed`; direct generated-server tool-list changes may still require an explicit host MCP reload.

- [x] **Step 1: Write a failing MCP client test for every documented development tool**

  Assert the server is absent by default, exposes exactly thirteen tools only for the foreground session, delegates to shared services, and closes with the session.

- [x] **Step 2: Implement the Streamable HTTP MCP endpoint over application services**

  Accept a server-selected or environment-provided bearer token without logging or persisting it. Support a fixed development port and stateless reconnect at the same URL. Resolve omitted operation epochs to the active epoch at call admission and include the resolved epoch identity in every artifact-backed result.

- [x] **Step 3: Prove one configured MCP client observes hot artifact rebuilds without reconnecting**

  Initialize one client once, call against epoch A, rebuild to epoch B, and assert its next call observes B. Hold a separate A-bound operation open through the rebuild and assert it remains on A until completion. Restart the foreground server at the same URL and bearer token and prove a later stateless request succeeds without editing the client configuration.

- [ ] **Step 4: Pack the npm package and start `agent-bundle dev --no-open` in a clean consumer**

  Assert prebuilt assets, all browser/API routes, live events, MCP/hook operations, deterministic evals, and complete shutdown. Then run explicit native Claude and Codex smoke trials using existing CLI sessions.

- [x] **Step 5: Document dev, playground, eval, native-auth, run-store, and Inspector provenance workflows**

- [ ] **Step 6: Run `npm run check`, every Node/Browser/process integration test, production builds, packed-consumer test, and `npm pack --dry-run`**

- [ ] **Step 7: Commit**

  Run: `git add packages README.md && git commit -m "test: verify workbench and evals end to end"`

---

## Workbench and Evals Implementation Evidence

- Contributor HMR and published prebuilt serving use identical service contracts.
- A single configured Codex MCP client observes rebuilt artifacts through the stable agent API without restarting Codex; active operations remain pinned to their admitted epoch.
- Coordinator shutdown leaves no watcher, server, MCP process, hook process, or CLI trial running.
- Epoch and run concurrency tests cover second writers and stale recovery.
- MCP/hook/playground operations execute emitted artifacts bound to explicit epochs.
- Skill rendering tests prove inert HTML/JSX and correct source/generated resource bases.
- Claude and Codex harnesses use existing signed-in CLI sessions and persist no API keys. Their
  opt-in authenticated smoke evidence remains a delivery check.
- Codex trials use a temporary `CODEX_HOME` with opaque copied authentication; the authenticated
  smoke that proves normal-home preservation remains open.
- Multi-trial metrics and comparisons are backed by raw JSON/JSONL evidence.
- W26 packed-consumer dogfood and the complete local delivery gate remain open.
