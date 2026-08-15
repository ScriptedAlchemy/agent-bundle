# RSC Runtime Final Integration and Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, package, document, and independently audit the optional RSC Workbench runtime without changing ordinary Agent Bundle behavior, then deliver reproducible browser, HMR, native-host, topology, and verification evidence.

**Architecture:** This plan is the release-integration layer for the three preceding runtime-provider, Runtime Playground, and MCP Apps/host-profile plans. It adds no second runtime: Rslib packages the Agent Bundle library plus its prebuilt Workbench assets, while the example's Rsbuild graph owns both production RSC artifacts and the provider's separate long-lived development compiler/HMR session. Automated gates exercise installed-package isolation and real browser behavior; native Claude Code and Codex observations are reduced to sanitized, claim-level evidence whose limitations are preserved rather than converted into false passes.

**Tech Stack:** Node.js 22.19+, TypeScript 7.0.2 ESM, Rslib 0.23.2, Rsbuild 2.1.13, Rspack 2.1.10, Rstest 0.11.8, Playwright 1.62.1/Playwright Core 1.62.1 with installed Chrome, React 19.2.8, `rsbuild-plugin-rsc` 0.1.1, Claude Code 2.1.232, Codex CLI 0.147.0, Git worktrees, TraceDecay graph analysis.

## Global Constraints

- Work only on `codex/rsc-agent-runtime-demo` in `/fast/projects/agent-bundle/.worktrees/rsc-agent-runtime-demo`; never edit the base worktree or copy its uncommitted files.
- Before this plan and again immediately before final verification, merge every newer committed change from `codex/agent-bundle-implementation`; keep each merge as its own commit and never reset, rebase, or discard user work.
- The runtime is supplemental and explicitly opt-in. A project without `dev.runtime.provider` must build, inspect, validate, package, and run `agent-bundle dev` without installing, resolving, importing, or starting React RSC, `react-server-dom-rspack`, or `rsbuild-plugin-rsc` project-runtime code.
- Rslib owns Agent Bundle's production library/published-package lane and copies the prebuilt Workbench. Rsbuild owns the Workbench browser build and the example's production and development RSC graphs; the long-lived provider compiler is development-only and must not replace either normal Agent Bundle packaging or the example's explicit production Rsbuild build.
- The published `agent-bundle` tarball may contain prebuilt Workbench assets and provider-neutral serializable contracts, but it may not contain the example provider, project RSC output, `react-server-dom-rspack`, or `rsbuild-plugin-rsc`.
- Keep production output filenames stable and unhashed. Integrity comes from manifest SHA-256 digests, and real initial plus asynchronous RSC assets must remain declared and copied.
- Native evaluators use existing installed Claude Code/Codex sessions only. Never accept, inject, print, or persist API keys, auth content, account data, raw prompts, raw transcripts, or host-supplied file contents.
- Every host claim is independently labelled `observed`, `inferred`, or `unavailable`; local ChatGPT and Claude profile simulation is never described as real-host certification, and CLI hosts never count as MCP App iframe proof.
- Browser evidence must prove real RSC HMR without a Workbench document reload, App React/CSS Fast Refresh inside the sandbox, last-good compile-error recovery, and desktop/mobile accessibility. A screenshot alone is not proof; pair it with machine-readable identity assertions.
- Final reviewers are read-only and independent. Fix every Critical and Important finding before delivery, rerun the affected gate, and ask the originating reviewer to verify the disposition. Record Minor findings and limitations explicitly.
- Completion claims require fresh command output from the final synchronized commit. Do not reuse a pre-merge, pre-fix, or subagent-reported result.

---

## Dependency Contract from the Earlier Plans

This plan starts only after the preceding plans have committed these observable contracts:

- `startDevServer()` exposes an optional provider session, `/api/runtime/*` routes, generation-pinned runs, and idempotent cascading close while leaving the normal coordinator live when the provider is absent or degraded.
- `examples/rsc-agent-runtime/agent-bundle.config.ts` declares the example provider; its long-lived Rsbuild session activates coherent immutable generations and exposes `rsc`, `widget`, and `app` surfaces.
- `packages/workbench/tests/helpers/runtime-playground-fixture.ts` copies the committed runtime fixture to a temporary project and exposes exact Server Component and App-style paths, so HMR tests never mutate author-facing example sources.
- The Workbench hides Runtime navigation when `runtime` capability is absent, and the Runtime Playground exposes accessible navigation, run, inspector, diagnostics, and trace controls.
- The upstream Playground plan owns and tests the root identity attributes `data-runtime-provider-session`, `data-runtime-generation`, `data-runtime-source-revision`, `data-runtime-artifact-epoch`, `data-runtime-state-version`, and `data-runtime-event-sequence`, removing all six while unavailable. This plan consumes those exact attributes and obtains run IDs from immutable run history/API responses; no separate root run attribute is required. The sandbox iframe is titled `MCP App preview`.
- `runtime.generation.activated` replays the selected fixture, while raw `rsc:update` is invalidation only.
- The provider plan's `RuntimeMcpRegistry` owns definition digests, stable broker identity, restart/relist policy, and per-operation generation leases; `runtime-routes.test.ts` and `runtime-mcp-registry.test.ts` are its authoritative core gates. The existing `mcp-session-routes.test.ts` remains the authoritative authenticated MCP session HTTP gate.
- The landed provider-neutral trace foundation is the single `PlaygroundService` in `packages/agent-bundle/src/services/playground-service.ts`. It owns project-contained, nonsymlinked durable authoring sessions; frozen epoch/fixture/task/target/invocation identity; serialized globally ordered JSONL events with raw-event references; cursor replay and reopen; an atomic replay-to-live subscription boundary with bounded subscriber queues; durable-outcome finalization/export; credential-free selected-assertion promotion; trailing-partial recovery with fail-closed completed-record corruption; and all-session cleanup with structural failure visibility. Credential-looking values and normalized sensitive key names (including camel-, snake-, and kebab-case API/auth/access token, authorization, credential, password, and secret forms) are rejected before identity metadata, event logs, outcomes, or draft evals can retain them; reopen treats persisted credential-bearing metadata/events as corrupt without echoing the value. Service close flips admission closed synchronously, waits every already-started cold `openSession()`/`reopen()` admission, and only then snapshots/closes installed sessions. A cold admission rechecks availability immediately before install; if close won, it rejects with `PLAYGROUND_SERVICE_CLOSED`, installs no session, and cleans only resources whose ownership it can still prove. The service records the newly created directory's device/inode identity without yielding, then requires both that identity and its exact owner token before owned cleanup. If an attacker/racer substitutes paths, it locates only the matching displaced admission root inside the immediate sessions directory, quarantines it by rename, revalidates identity/token, and removes it; a same-token replacement with a different inode remains untouched. Before owner establishment, identity alone selects only the created displaced root and any provisional owner token is rolled back. An `EEXIST` conflict never treats the pre-existing finalized/open session root as owned cleanup: its `session.json` and exact `.owner.lock` bytes survive even when the contender closes concurrently. If the owned admission root is displaced beyond the sessions directory, cleanup fails closed: the opening error aggregates the original/admission cleanup failures, service close retains and re-rejects a `PlaygroundServiceCloseError` with that session ID, and both the unrelated replacement root and stranded owned root remain for authoritative recovery. Unknown callback-shaped constructor properties such as `beforeSessionInstall` are ignored and cannot inject or stall lifecycle work. Already admitted operations on an installed session and its close remain ordered by that record's one tail; later append/finalize/subscription/replay/export/promotion is rejected. Therefore close cannot resolve while a cold admission can still publish a session, no session can bypass completed cleanup, and cleanup cannot delete another service instance's durable state or owner claim. Repeated service/session close remains idempotent, open sessions become durable aborted terminal records, subscribers drain, and the single durable-writer claim is released. `packages/agent-bundle/tests/playground-service.test.ts`, especially its linearization, conflict-root preservation, displaced-root identity/token, pre-owner rollback, admission-cleanup aggregation, and callback-injection cases, is authoritative for that contract. This service is not a second name for the provider's bounded, provider-session-scoped `DevRuntimeRun` history or each run's render-local `DevRuntimeTraceSpan[]`: those remain transient execution evidence for the current Workbench UI. The current provider/HMR plan owns producing `/api/runtime/*` runs and the Runtime Playground plan owns reducing/presenting them, but neither plan currently consumes `PlaygroundService`; that is an explicit ownership gap, not permission for final integration to invent a runtime-only trace store, credential filter, lifecycle owner, admission mutex, root/quarantine remover, writer-claim releaser, or cleanup-retry policy. If Runtime later claims durable cross-provider authoring history, whole-plugin replay/export, or draft-eval promotion, return the work to those owners: the provider plan must own one adapter from runtime lifecycle/events/outcomes into this service and its authenticated routes, and the Playground plan must own the corresponding client/presentation. That adapter may submit only detached credential-free evidence and expose the stable rejection diagnostic without returning or caching rejected material; Workbench never receives a storage-owner credential, directory identity, durable writer token, or rejected provider credential to retain across close, and it delegates session open/reopen/operations/close directly to this service instead of serializing, deleting, quarantining, releasing, retrying, or suppressing cleanup through another mutex/lifecycle layer. Until then, document Runtime history as ephemeral and prove its identity/sequence model remains compatible without writing a second JSONL log, replay/export service, credential cache/redactor, lifecycle state machine, or `PlaygroundService` instance per surface.
- The merged core App-access seam is `McpSessionService.acquireAppLease(sessionId): Promise<McpAppSessionLease>`. Runtime App binding must adapt that lease or the provider registry's equivalent immutable lease; it must not open a parallel MCP control session. `mcp-session-service.test.ts` remains authoritative for canonical App-visible tools/resources, JSON snapshots, release idempotence, immediate App-access revocation at session-close start, and synchronous close-observer re-entry sharing the original close promise while draining client/data/epoch cleanup exactly once.
- The merged artifact binding and preview lane remains authoritative for browser-input boundaries: `McpAppBindingService` derives canonical tool context from its immutable binding and never accepts browser-selected `toolInfo`. A failed lease release remains visible and retains an invalidated binding for retry: bridge operations stay rejected, the session watcher stays unsubscribed, a later `closeBinding()` retries release, and teardown is published only after successful release with the original reason. `McpAppPreviewService.closeAll()` waits for blocked creates, attempts every retained preview, and aggregates teardown/release failures without discarding a failed preview; timed-out or rejected graceful teardown remains available for authoritative `forceClose()` retry. Graceful close reserves one canonical route-owned `ui/resource-teardown` frame even when ordinary outbound capacity is full; `McpAppRoutes` forwards that exact bridge frame rather than synthesizing one, admits only one teardown, keeps its acknowledgement path routable until closure, and leaves failed teardown retryable by DELETE. Exactly one teardown acknowledgement is accepted while release settles; a concurrent or later duplicate returns `false`, cannot trigger another release, and cannot erase a retained release failure. `mcp-app-binding-service.test.ts`, `mcp-app-preview-service.test.ts`, `mcp-app-routes.test.ts`, and `dev-workbench.test.ts` are regression gates for those already-implemented guarantees; final integration verifies rather than recreates them.
- The merged `startDevServer()` composition already creates the artifact App sandbox only after the foreground loopback origin exists, attaches one deferred preview route service, and closes Apps before MCP sessions and the coordinator while retaining failures from all three resources. A post-listener sandbox/browser-start failure plus foreground cleanup failure remains one ordered `DevServerStartError`, never a lost cleanup cause. The sandbox origin exposes neither project-session nor MCP-session routes. Runtime work extends this composition through its discriminated runtime service; it must not create a second foreground `McpAppRoutes`, artifact binding/preview stack, sandbox lifecycle, startup-unwind path, or top-level close path. `dev-workbench.test.ts` is authoritative for the real epoch session/App preview, cross-origin containment, DELETE/release behavior, startup unwind, close ordering, and structural aggregate failures.
- The merged Workbench control seam is `McpSessionController` in `packages/workbench/src/mcp/mcp-session-controller.ts`. Runtime work extends its discriminated binding/revision lane and preserves its serialized open/restart/invoke/close admission, immutable history, ordered snapshot-plus-live trace refresh, transport-failure cleanup, and smuggling protections; close rejects late work, drains every active request/trace task, then attempts both client and transport cleanup. Explicit-close cleanup failures remain resource-labelled in one shared rejected `McpSessionControllerCloseError` and a visible `mcp.close.failed` error-state diagnostic after all cleanup is attempted; operation failure plus cleanup is retained in `McpSessionControllerFailureError`. Neither path is converted into a successful close. `AgentBundleRemoteTransport.close()` aborts locally, awaits route cancellation and reader cleanup, suppresses late results, and deletes the remote session once. `mcp-session-controller.test.ts`, `mcp-session-model.test.ts`, and `agent-bundle-remote-transport.test.ts` are the authoritative Workbench gates; the host-profile work reuses this ordering instead of adding another lifecycle/cancellation path.
- The landed artifact-browser App seam is `McpAppClient` plus `McpAppFrameRelay`/`McpAppFrame`. The client owns one memory-only same-foreground credential, finite detached JSON and structured diagnostics, rejects same-origin or malformed server-issued proxy frames, and forgets authentication across graceful/forced close. The frame renders only the server-issued URL/policy attributes, accepts messages from its exact proxy window and origin, supplies the canonical resource only after proxy readiness without an authenticated route call, bounds and serializes relay work, queues close as essential behind accepted traffic, awaits the one teardown acknowledgement, and force-deletes on timeout/failure. Its wall-clock close bound begins when close is requested even if accepted traffic hangs; timeout and delivery failure join one force-delete, late work cannot post after closure, and repeated cleanup after route closure is a resolved no-op. Runtime Apps extend the existing client facade and use their separately specified official bridge/renderer lane; they do not replace this artifact relay or add another credential/bootstrap/parser/frame state machine. `mcp-app-client.test.ts` and `mcp-app-frame.test.ts` are the authoritative landed browser gates.
- The landed artifact preview presentation seam is `McpAppPreviewController`/`McpAppPreview`/`McpAppPreviewFrame` in `packages/workbench/src/mcp/mcp-app-preview.tsx` with its one `loading | error | fallback | ready` lifecycle. Ready requires all three server proofs: a frame, a canonical `{kind:'resource',html}` resource, and a nonempty, canonical-serialization `ui:` Apps-profile URI with a host; malformed, normalized-different, non-`ui:`, or otherwise noncanonical profiles remain an ordinary input/result fallback and start no relay. At controller construction, input/result are transactionally deep-detached into frozen finite JSON using only arrays and ordinary/null-prototype objects; cyclic, nonfinite, non-JSON, or exotic-prototype values fail before any create call, and later caller mutation cannot alter the request or fallback. Repeated `start()` calls share the one in-flight create. `close()` joins that create before cleanup, so an unmount during a late successful create force-closes the exact returned binding once and publishes no late ready state. Create and relay errors retain the detached ordinary fallback alongside the visible error before cleanup; a normal fallback closes its unused binding. Portable-by-default create requests, idempotent close, relay-error cleanup, SSR-safe accessible loading, and exact credential-free iframe attributes remain owned here. The host-profile plan may add runtime-only binding, consent, simulation, and official-renderer state, but one run may mount only one Runtime App preview owner: it must compose the landed client/frame policy boundaries and may not copy this generic create/relay/fallback reducer, create a second artifact preview component, or keep parallel runtime preview UI state for the same binding. `mcp-app-preview.test.ts` is the authoritative boundary/canonical-profile/concurrent-close gate.
- The landed real preview browser gate is `packages/workbench/tests/mcp-app-preview-browser.test.ts`. Its temporary Rsbuild/Chrome fixture mounts the actual component and proves the ready iframe's exact sandbox/referrer/source, a visible ordinary result on create error, fallback with no iframe, exactly one late-binding force close after an unmount/create race, and a long profile plus frame/fallback layout bounded at 390px. Runtime extension keeps this fixture intact and uses the existing `overview.e2e.test.ts`/Runtime Playground journeys for integrated runtime-only assertions; it must not add another preview-specific browser fixture, page builder, or second mounted preview lifecycle.
- The landed live composition is the one `McpPageAppPreview` slot inside `packages/workbench/src/mcp/mcp-page.tsx`. `Workbench` constructs one stable credential-owning `McpAppClient` ref and passes it through the existing `McpScreen` into the existing `McpPage`; neither the page nor the frame constructs another client. Only a successful `callTool` history entry with a named request, own `arguments`, a result, and a currently ready session yields an `McpPageAppPreviewSource`. The page offers the exact portable/ChatGPT/Claude profile picker, owns at most one active `McpAppPreviewController`, injects the landed `createMcpAppFrameRelay`, and owns one serialized `appPreviewClosePromise`. Profile/source replacement, explicit close, session restart/close/reset, session-ID drift, page unmount, and any observed terminal `closed` or `error` model phase join that page-owned cleanup rather than starting another teardown; the preview stays present/busy until that close settles, then the matching promise alone clears it. `appPreviewOpenGeneration` prevents a stale queued open from remounting after terminal cleanup. `mcp-page.test.ts` is the authoritative source/profile/control placement gate. `mcp-page-app-browser.test.ts` is the authoritative mounted page/relay/terminal-close gate: its one Rsbuild/Chrome fixture proves the distinct sandbox origin and credential-free frame; exact current-session input/result/tool/profile/host create request without browser-selected `toolMetadata` or `resourceUri`; binding-scoped `ui/initialize` returning host info/capabilities/context followed by `ui/notifications/initialized`, `tools/call`, `resources/read`, `ui/request-display-mode`, and `notifications/message`; portable → ChatGPT → Claude replacement waiting for each new binding's initialized notification; canonical `ui/resource-teardown`; wrong-MIME and legacy-template ordinary fallbacks; and ordinary MCP operations after preview close. Its stable `terminateAndClickClose('error' | 'closed')` method emits the terminal model and invokes the explicit Close App preview action in the same task, proving both paths join one close, remove the iframe, preserve the terminal phase, and report exactly one terminal cleanup; the suite also proves 390px containment, zero page errors, and full fixture cleanup. Runtime work extends this exact file and fixture in place together with the existing `overview.e2e.test.ts` and `mcp-app-real.e2e.test.ts` real-session journeys, and extends the same `McpAppClient`, `McpPage`, preview slot, relay, terminal-phase observer, and serialized close promise through its discriminated source; it must not add a second App client, preview controller or cleanup owner, terminal-phase effect, interactive preview placement for the same run/binding, App-page browser fixture, or another MCP page/screen.
- The landed real server/browser authority is `packages/workbench/tests/mcp-app-real.e2e.test.ts`. It builds the actual Workbench, generates a temporary SDK-v2 MCP server/resource/tool artifact, starts the real foreground server, opens one epoch-bound MCP session, calls the real tool, and creates the preview through the authenticated `/api/mcp/sessions/:sessionId/apps` route. Its real separate-origin proxy/inner sandbox proves exact input/result and portable profile delivery, host context, nested `tools/call`, `resources/read`, logging, unsupported display-mode response, credential exclusion from App content, iframe policy, 390px containment, acknowledged preview close with the broker session still usable, preview cleanup during MCP close, zero page errors, both origins stopped, and epoch/project cleanup. Runtime/host-profile work extends this exact fixture in place with its discriminated runtime route assertions; it must not create another generated MCP server, foreground/App route stack, project writer, browser lifecycle fixture, controller, client, page slot, or close lifecycle. The mounted component/page fixtures stay focused and do not substitute for this real route/session evidence.
- The Workbench browser build uses the standard `packages/workbench/rsbuild.config.ts` exported through `defineConfig(createWorkbenchConfig())` and the package's exact `rsbuild build` script. Preserve `pluginReact()` ownership of development/production React selection; do not restore a custom `process.env.NODE_ENV` source define, React `source.include`, a second environment parameter, or a separate config-only React-runtime gate. `rsbuild-workbench.test.ts`, the production and explicit-development cases in `inspector-shell.e2e.test.ts`, `npm run build --workspace agent-bundle-workbench`, and `npm run typecheck --workspace agent-bundle-workbench` are the current build gates.
- The merged Inspector presentation seam is `InspectorSessionAdapter` plus `inspector-session-adapter-model.ts` under `packages/workbench/src/inspector/adapter`. Production consumers import `inspector-session-adapter-entry.ts`, not the bare TSX module, so Mantine base styles and `inspector-session-adapter.css` enter the Workbench graph together. The provider-run Playground extends that presentation only through its controller-free evidence mapping and never constructs live MCP client/controller state; the host plan's live runtime MCP page alone feeds it from the existing `McpSessionController`/immutable `McpBrowserSessionModel`. Neither lane forks invocation, cancellation, catalog, trace, or logging state, and raw-frame replay stays explicitly unavailable in favor of artifact-bound controller replay. Preserve JSON-RPC-derived request/response/notification direction, original trace sequence/timestamps, the bounded Tools/Resources/Prompts/Protocol/Logging screen set, adapter-owned theme/style isolation, and exact artifact-binding reset identity. `inspector-session-adapter.test.ts`, `runtime-inspector.test.ts`, and `runtime-contract-compile.test.ts` are the authoritative presentation/boundary gates. The landed `Workbench` owns one `McpSessionController` and one subscribed immutable model shared by `McpScreen` and `InspectorScreen` through the same `WorkbenchScreen`; `inspector-shell.e2e.test.ts` is the authoritative route/browser gate for direct Inspector navigation without session creation and MCP-to-Inspector session, catalog, ordered protocol, logging, close/reset, and mobile-layout continuity, while `overview.e2e.test.ts` remains the authoritative full MCP Playground workflow gate. The upstream Playground plan adds Runtime only as the capability-gated fifth sibling route through that same `WorkbenchScreen`; final integration must not create another shell, navigation/router, controller/model subscription, or Inspector browser fixture.
- The Inspector production boundary also owns its adapter-local classic-React/vendor-screen compatibility modules, scoped TypeScript config, build fixture, and replay-free raw-protocol presenter; vendored Inspector source remains byte-identical. Preserve every raw request/response/notification frame with its transport origin, sequence, and timestamp while exposing no unsupported raw-frame Replay or logging-level control. `inspector-session-adapter-fixture.test.ts` must build the styled entry and mount all five real presentations in Chrome; the runtime plans extend these landed files and must not create another entry, compatibility bridge, protocol projection, or fixture.
- Keep the merged artifact/core bridge in `mcp-app-preview-service.ts`, its existing `mcp-app-routes.ts`, and the landed Workbench-server composition intact. The host-profile plan adds runtime-only `mcp-app-runtime-binding-service.ts`, `mcp-app-runtime-preview-service.ts`, and `runtime-mcp-routes.ts`, then extends existing foreground composition with a discriminated runtime lane; final verification runs both lanes rather than renaming or rewiring one over the other. Normal browser close awaits bounded renderer teardown before backend DELETE in `finally`; backend invalidation revokes first and only prompts a connected browser to attempt teardown, so DELETE never claims to deliver `ui/resource-teardown`.
- The MCP Apps controller supports portable, ChatGPT, and Claude simulated profiles; preview bindings remain generation- and definition-digest-bound.

If any item is absent, stop this plan and return it to the owning earlier plan. Do not add a compatibility shim in final integration.

## File Structure

```text
packages/agent-bundle/
├── src/services/
│   └── playground-service.ts                    # one durable whole-plugin trace/session foundation
└── tests/
    ├── playground-service.test.ts               # persistence/replay/export/cleanup authority
    ├── rsc-runtime-optional-packaging.test.ts   # installed-tarball and no-provider regression
    └── rsc-runtime-topology-script.test.ts      # generator behavior and --check contract
examples/rsc-agent-runtime/
├── README.md                                    # dev, package, and evidence guide
├── scripts/
│   ├── eval-evidence.mjs                        # sanitized claim reducer
│   ├── eval-host-environment.mjs                # child environment allowlist/redaction
│   └── eval-hosts.mjs                           # real CLI evidence producer
└── tests/
    ├── eval-evidence.test.ts                    # observed/inferred/unavailable contract
    └── host-artifacts.test.ts                   # exact production cohort copies
packages/workbench/
├── rsbuild.config.ts                            # standard Workbench browser build
├── src/
│   ├── main.tsx                                 # one WorkbenchScreen and shared MCP/Inspector controller-model owner
│   └── mcp/
│       ├── mcp-app-preview.css                  # landed preview presentation styles
│       ├── mcp-app-preview.tsx                  # sole artifact preview lifecycle/canonical-profile boundary
│       ├── mcp-page.css                         # live preview controls/placement and responsive layout
│       └── mcp-page.tsx                         # one page-owned preview slot/controller and close ordering
├── scripts/capture-runtime-playground.mjs       # browser/HMR capture driver
└── tests/
    ├── inspector-shell.e2e.test.ts              # authoritative shared-session Inspector browser flow
    ├── mcp-app-preview.test.ts                   # preview lifecycle and canonical-profile proof
    ├── mcp-app-preview-browser.test.ts           # real Rsbuild/Chrome lifecycle and 390px fixture
    ├── mcp-app-real.e2e.test.ts                  # real SDK-v2 server/session/routes/sandbox lifecycle
    ├── mcp-page-app-browser.test.ts              # mounted page/relay/terminal exactly-once close journey
    ├── mcp-page.test.ts                          # successful-call source, profiles, and placement contract
    ├── rsbuild-workbench.test.ts                 # standard Workbench config/artifact contract
    └── runtime-playground-capture.test.ts       # machine-readable capture contract
scripts/
└── rsc-runtime-topology.mjs                     # deterministic tracked-file topology renderer
docs/
├── architecture/
│   └── rsc-runtime-workbench.md                  # actual topology and source-to-host flow
├── assets/rsc-runtime-workbench/
│   ├── desktop.png
│   ├── mobile.png
│   ├── hmr-before.png
│   ├── hmr-after.png
│   ├── compile-error.png
│   └── recovered.png
└── audits/
    └── 2026-08-14-rsc-runtime-workbench-delivery.md
```

Generated `examples/rsc-agent-runtime/dist/**`, `.agent-bundle/**`, temporary native homes, raw JSONL transcripts, and browser trace archives remain untracked.

### Task 1: Lock the installed-package optionality and packaging boundary

**Files:**
- Create: `packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts`
- Modify: `examples/rsc-agent-runtime/tests/host-artifacts.test.ts`

**Interfaces:**
- Consumes: built root package from `npm run build`; `startDevServer({ root, open: false, port: 0 })`; ordinary `fixtures/integration/skills-only` config with no `dev.runtime` declaration.
- Produces: an installed-tarball regression gate proving the absence of project RSC dependencies/code and a byte-for-byte cohort gate for production example packaging.

- [ ] **Step 1: Write the installed-tarball regression test**

  Create one sequential Rstest case that builds and packs `packages/agent-bundle`, installs the tarball into a fresh temporary consumer, copies `fixtures/integration/skills-only`, and derives dependency names from `npm ls --all --json` recursively rather than reading the source package declaration. The literal assertions are:

  ```ts
  expect(installedNames).not.toContain('react');
  expect(installedNames).not.toContain('react-dom');
  expect(installedNames).not.toContain('react-server-dom-rspack');
  expect(installedNames).not.toContain('rsbuild-plugin-rsc');
  expect(tarListing).not.toMatch(/examples\/rsc-agent-runtime|react-server-dom-rspack|rsbuild-plugin-rsc/u);

  const script = [
    "import { build, inspect, startDevServer, validate } from 'agent-bundle';",
    `const root = ${JSON.stringify(projectRoot)};`,
    `const output = ${JSON.stringify(artifactRoot)};`,
    'const inspected = await inspect({ root });',
    'await build({ root, output });',
    'const validated = await validate({ artifact: output, root });',
    'const session = await startDevServer({ open: false, port: 0, root });',
    'try {',
    "  const runtimeResponse = await fetch(new URL('/api/runtime/status', session.url));",
    "  const runtimeBody = await runtimeResponse.json();",
    "  const surfacesResponse = await fetch(new URL('/api/runtime/surfaces', session.url));",
    "  const surfacesBody = await surfacesResponse.json();",
    "  process.stdout.write(JSON.stringify({ diagnostics: validated.diagnostics, runtimeBody, runtimeStatus: runtimeResponse.status, status: session.status(), surfacesBody, surfacesStatus: surfacesResponse.status, targets: inspected.model.targets.map(({ name }) => name) }));",
    '} finally { await session.close(); }',
  ].join('\n');
  ```

  Assert the subprocess exits zero, targets equal `['portable']`, diagnostics equal `[]`, `status.runtime` is absent, and `/api/runtime/status` returns `200` with `{ status: null }`. Also assert `/api/runtime/surfaces` returns `200` with `{ surfaces: [] }` and no file named `.runtime-provider-loaded` appears anywhere under the project or consumer. The failing production change this catches is unconditional provider discovery/startup or shipment of example-only RSC dependencies.

- [ ] **Step 2: Run the focused installed-package gate**

  Run:

  ```bash
  npm test -- run packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts
  ```

  This is a final integration characterization gate over behavior implemented red/green in the provider plan, so it may pass on its first run. If it fails, return the defect to that owning plan and preserve this failing output; do not add a final-layer shim. During review, verify the test would fail for each named mutation: adding either RSC package to the packed dependency tree, embedding the example path in the tarball, exposing runtime status for the ordinary project, or returning a failed inspect/build/validate subprocess.

- [ ] **Step 3: Add exact production-cohort assertions to the example package test**

  Extend `host-artifacts.test.ts` after `runPackageHosts()` to hash all files beneath `dist/runtime` and compare those literal `{ path, bytes, sha256 }` arrays with `dist/plugins/claude/runtime` and `dist/plugins/codex/runtime`. Assert each `runtime-assets.json` `allFiles` entry exists, at least one entry matches `^/?chunks/.+\.js$`, and both `dist/app/edit-timeline-v1.html` and `dist/app/standalone.html` contain no external script or stylesheet reference:

  ```ts
  expect(await artifactDigest(join(pluginsRoot, 'claude', 'runtime'))).toEqual(await artifactDigest(join(exampleRoot, 'dist', 'runtime')));
  expect(await artifactDigest(join(pluginsRoot, 'codex', 'runtime'))).toEqual(await artifactDigest(join(exampleRoot, 'dist', 'runtime')));
  expect(runtimeFiles.some((path) => /^\/?chunks\/.+\.js$/u.test(path))).toBe(true);
  expect(appHtml).not.toMatch(/<script[^>]+src=|<link[^>]+rel=["']stylesheet["']/iu);
  ```

  This catches packaging only named entries, losing async chunks, or leaking the Rsbuild development server into production App HTML.

- [ ] **Step 4: Run focused package builds and tests to verify green**

  Run:

  ```bash
  npm run build
  npm test -- run packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts
  npm run build -w @agent-bundle/rsc-agent-runtime-demo
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/host-artifacts.test.ts tests/runtime-artifact-manifest.test.ts tests/mcp-transports.integration.test.ts
  git diff --check
  ```

  Expected: every command exits `0`; the focused Rstest summaries report zero failed tests.

- [ ] **Step 5: Request fresh task review and commit**

  Ask a fresh reviewer to compare the test against Success Criteria 1, 12, and the regression/packaging strategy. The reviewer must specifically reject source-text-only optionality checks, tests that use the repository's example dependencies through `NODE_PATH`, and manifest assertions that do not execute the isolated copied package.

  ```bash
  git add packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts examples/rsc-agent-runtime/tests/host-artifacts.test.ts
  git commit -m "test: lock optional RSC runtime packaging boundary"
  ```

### Task 2: Make native-host evidence claim-level and truthful

**Files:**
- Modify: `examples/rsc-agent-runtime/scripts/eval-evidence.mjs`
- Create: `examples/rsc-agent-runtime/scripts/eval-host-environment.mjs`
- Modify: `examples/rsc-agent-runtime/scripts/eval-hosts.mjs`
- Modify: `examples/rsc-agent-runtime/tests/eval-evidence.test.ts`
- Modify: `examples/rsc-agent-runtime/README.md`

**Interfaces:**
- Produces: `classifyNativeEvidence(host, result, options): NativeEvidenceEnvelope` from `eval-evidence.mjs`.
- Produces: `sanitizedHostEnvironment(environment, owned?: { hookProbeFile?: string; stateFile?: string; codexHome?: string }): NodeJS.ProcessEnv` from side-effect-free `eval-host-environment.mjs`, removing every `*_API_KEY`, provider token, and alternate-provider routing variable before spawning either native CLI.
- Produces: one stdout JSON document `{ schemaVersion: 2, capturedAt, hosts: NativeEvidenceEnvelope[] }` from `eval-hosts.mjs` and no raw transcript persistence.
- `NativeEvidenceEnvelope.claims` contains exact claim IDs `package-activation`, `hook-dispatch`, `mcp-read`, `rsc-render`, `shared-hook-mcp-state`, and `mcp-app-iframe`, each with `evidence: 'observed' | 'inferred' | 'unavailable'` and a nonempty `basis`.

- [ ] **Step 1: Write failing literal claim-classification tests**

  Add a deterministic `capturedAt: '2026-08-14T20:00:00.000Z'` test for a complete Claude result and an incomplete Codex result. Expectations must be literal and must not reuse the classifier:

  ```ts
  expect(classifyNativeEvidence('claude', completeClaude, { capturedAt })).toEqual({
    capturedAt,
    claims: [
      { basis: 'native terminal marker and loaded plugin session', evidence: 'observed', id: 'package-activation' },
      { basis: 'value-free hook launch probe exited 0', evidence: 'observed', id: 'hook-dispatch' },
      { basis: 'completed recent_edits call with native success result', evidence: 'observed', id: 'mcp-read' },
      { basis: 'completed render_edit_timeline call with native success result', evidence: 'observed', id: 'rsc-render' },
      { basis: 'hook-recorded state was returned by recent_edits', evidence: 'observed', id: 'shared-hook-mcp-state' },
      { basis: 'Claude Code CLI is not an MCP Apps iframe host', evidence: 'unavailable', id: 'mcp-app-iframe' },
    ],
    host: 'claude',
    hostVersion: '2.1.232',
  });
  ```

  For Codex, assert `package-activation`, `mcp-read`, and `rsc-render` are `observed`; `hook-dispatch` and `shared-hook-mcp-state` are `unavailable` with the current `exec --ephemeral` basis; `mcp-app-iframe` is unavailable because Codex CLI is not ChatGPT. Add a missing-CLI fixture in which all claims are unavailable and no exception text, path, auth value, prompt, or transcript appears in serialized output.

  Add a literal environment test containing `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `EXAMPLE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_FOUNDRY`, and `CLAUDE_CODE_USE_VERTEX`. Call `sanitizedHostEnvironment` with literal owned hook-probe, state-file, and temporary-Codex-home paths. Assert every sensitive input is absent, while `PATH`, `LANG`, `TERM`, `AGENT_RUNTIME_HOOK_PROBE_FILE`, `AGENT_RUNTIME_STATE_FILE`, and `CODEX_HOME` equal the supplied literal values. Assert the input object is unchanged.

- [ ] **Step 2: Run the focused evaluator tests and verify red**

  Run:

  ```bash
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/eval-evidence.test.ts
  ```

  Expected: FAIL because `classifyNativeEvidence` and schema version 2 do not exist.

- [ ] **Step 3: Implement the pure claim reducer and sanitized CLI envelope**

  Implement `classifyNativeEvidence` as a pure reducer over the booleans/counts already produced by `evidenceFromTranscript` and `summarizeHookProbe`. Do not accept raw events in the returned object. `eval-hosts.mjs` calls it after each run, injects `new Date().toISOString()`, and emits exactly one JSON line. The required native workflow claims for both hosts are `package-activation`, `hook-dispatch`, `mcp-read`, `rsc-render`, and `shared-hook-mcp-state`; `mcp-app-iframe` is never a CLI-required claim. Exit `0` only when every selected host observes all five required workflow claims. Otherwise exit `1` while still emitting the complete unavailable/inferred envelope. This intentionally keeps the currently unobserved Codex hook/shared-state lane nonzero instead of weakening the requirement to match present behavior.

  Keep these hard boundaries in code:

  ```js
  const terminalHostCanRenderIframe = false;
  const evidence = (condition, basis) => ({ basis, evidence: condition ? 'observed' : 'unavailable' });
  // Never derive mcp-app-iframe from MCP tool or resource calls.
  // Never derive shared-hook-mcp-state unless hook probe and state correlation both succeeded.
  ```

  Build the child object from the exact ordinary-session allowlist `PATH`, `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `NO_COLOR`, `TMPDIR`, `TMP`, `TEMP`, `SYSTEMROOT`, `WINDIR`, `PATHEXT`, `COMSPEC`, and `SHELL`; omit missing keys. Route every Claude and Codex child spawn through `sanitizedHostEnvironment`; reject keys ending in `_API_KEY` case-insensitively plus the exact provider token/routing keys named by the test even if a later allowlist edit accidentally includes one. Map the three typed owned inputs only to `AGENT_RUNTIME_HOOK_PROBE_FILE`, `AGENT_RUNTIME_STATE_FILE`, and `CODEX_HOME`; do not accept arbitrary override keys. The catch path records a stable basis such as `installed host/version/session unavailable`; it must not interpolate the caught error.

- [ ] **Step 4: Document the evidence matrix without promoting simulation**

  Update the example README command and matrix so it states:

  - portable/ChatGPT/Claude Workbench profiles are local simulations;
  - Claude Code and Codex CLI evaluation are separate native terminal evidence;
  - ChatGPT Developer Mode remains `unavailable` unless a user explicitly supplies a separately captured real HTTPS-host result;
  - `eval:hosts` may exit `1` while still producing useful truthful evidence;
  - no CLI observation proves the MCP App iframe rendered.

  Human prose earns no source-text test; the behavior is protected by the claim-classification tests.

- [ ] **Step 5: Run focused tests and sanitized native evaluations**

  First run deterministic tests:

  ```bash
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/eval-evidence.test.ts tests/host-artifacts.test.ts
  ```

  Then run both installed hosts independently, preserving output and exit status without treating an unavailable host as an automated-test failure:

  ```bash
  mkdir -p /tmp/rsc-runtime-delivery
  set +e
  npm run --silent eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host claude > /tmp/rsc-runtime-delivery/claude.json
  CLAUDE_EVAL_EXIT=$?
  npm run --silent eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host codex > /tmp/rsc-runtime-delivery/codex.json
  CODEX_EVAL_EXIT=$?
  set -e
  node --input-type=module --eval "import { readFile } from 'node:fs/promises'; for (const file of process.argv.slice(1)) { const value = JSON.parse(await readFile(file, 'utf8')); if (value.schemaVersion !== 2) process.exitCode = 1; console.log(JSON.stringify({ file, hosts: value.hosts.map(({ claims, host, hostVersion }) => ({ claims, host, hostVersion })) })); }" /tmp/rsc-runtime-delivery/claude.json /tmp/rsc-runtime-delivery/codex.json
  printf 'claude_exit=%s codex_exit=%s\n' "$CLAUDE_EVAL_EXIT" "$CODEX_EVAL_EXIT"
  ```

  Inspect only the sanitized JSON. Record the two exit codes and each claim classification later; do not commit `/tmp/rsc-runtime-delivery`.

- [ ] **Step 6: Request fresh task review and commit**

  The reviewer must attempt the mutations “count CLI MCP as iframe proof,” “count prompt text as a tool call,” “count Codex package activation as native hook dispatch,” and “leak caught error text.” Each must be caught by a test or explicit reducer boundary.

  ```bash
  git add examples/rsc-agent-runtime/scripts/eval-evidence.mjs examples/rsc-agent-runtime/scripts/eval-host-environment.mjs examples/rsc-agent-runtime/scripts/eval-hosts.mjs examples/rsc-agent-runtime/tests/eval-evidence.test.ts examples/rsc-agent-runtime/README.md
  git commit -m "test: classify native runtime evidence truthfully"
  ```

### Task 3: Promote the real Workbench HMR suite into release evidence

**Files:**
- Modify: `packages/workbench/scripts/capture-runtime-playground.mjs`
- Create: `packages/workbench/tests/runtime-playground-capture.test.ts`
- Create: `docs/assets/rsc-runtime-workbench/desktop.png`
- Create: `docs/assets/rsc-runtime-workbench/mobile.png`
- Create: `docs/assets/rsc-runtime-workbench/hmr-before.png`
- Create: `docs/assets/rsc-runtime-workbench/hmr-after.png`
- Create: `docs/assets/rsc-runtime-workbench/compile-error.png`
- Create: `docs/assets/rsc-runtime-workbench/recovered.png`

**Interfaces:**
- Consumes: `startRuntimePlaygroundFixture()` and its temporary `serverComponentSource`/`appStyles` paths from `packages/workbench/tests/helpers/runtime-playground-fixture.ts`; the real HMR/recovery assertions already committed in `runtime-playground-hmr.e2e.test.ts`, the mounted artifact preview lifecycle/sandbox/layout assertions in `mcp-app-preview-browser.test.ts`, the live `McpPage` source/profile/placement assertions in `mcp-page.test.ts`, the mounted page/relay/profile/fallback/close-order assertions in `mcp-page-app-browser.test.ts`, the real generated SDK-v2 server/session/routes/sandbox lifecycle in `mcp-app-real.e2e.test.ts`, and the integrated artifact/Runtime App assertions owned by the existing overview/Runtime browser journeys.
- Produces: the existing `capture-runtime-playground.mjs` options `--desktop <path>` and `--mobile <path>` plus `--hmr-before`, `--hmr-after`, `--compile-error`, `--recovered`, and `--evidence <json-path>`.
- The evidence JSON contains `providerSessionId` read from `data-runtime-provider-session`, `generationBefore`/`generationAfter` read from `data-runtime-generation`, `runBefore`/`runAfter` read from the corresponding immutable `DevRuntimeRunResponse` records, `documentTimeOriginBefore`, `documentTimeOriginAfter`, `lastGoodGenerationDuringError`, `generationRecovered`, `appRefreshPreservedDocument`, viewport sizes, and boolean sandbox/accessibility assertions.

- [ ] **Step 1: Write the failing real capture-contract test**

  Spawn the real capture script into a temporary directory with all eight explicit output arguments. Assert exit `0`, six nonempty PNG files, and this independently derived envelope shape:

  ```ts
  expect(evidence).toMatchObject({
    appRefreshPreservedDocument: true,
    hmrWithoutReload: true,
    lastGoodPreserved: true,
    recovered: true,
    sandboxOpaqueOrigin: true,
    viewports: { desktop: { height: 900, width: 1440 }, mobile: { height: 844, width: 390 } },
  });
  expect(evidence.generationAfter).not.toBe(evidence.generationBefore);
  expect(evidence.runAfter).not.toBe(evidence.runBefore);
  expect(evidence.documentTimeOriginAfter).toBe(evidence.documentTimeOriginBefore);
  expect(evidence.generationRecovered).not.toBe(evidence.lastGoodGenerationDuringError);
  ```

  In `finally`, assert the helper's temporary root is removed and no Chrome, foreground server, compiler, or App child remains. This catches screenshots produced without proving identity, page reload masquerading as HMR, last-good loss, and capture-time resource leaks.

- [ ] **Step 2: Run the focused capture test and verify red**

  Run:

  ```bash
  npm test -- run packages/workbench/tests/runtime-playground-capture.test.ts
  ```

  Expected: FAIL because the existing capture script accepts only desktop/mobile paths and emits no machine-readable HMR proof.

- [ ] **Step 3: Extend the existing capture driver over its temporary real fixture**

  Reuse the exact source mutations and event/DOM waits from `runtime-playground-hmr.e2e.test.ts`: record `performance.timeOrigin`, generation, run, and visible output; capture before; edit the temporary Server Component literal; await activated generation and automatic replay; capture after; inject a TypeScript syntax error; capture the last-good result with source/build diagnostics; restore valid source; await a new generation and capture recovery; edit temporary App CSS and prove Fast Refresh leaves the outer document identity unchanged.

  Keep the existing complete-workflow desktop/mobile capture with Tree selected, trace expanded, and `data-app-status="ready"`. Write evidence JSON only after all source bytes are restored. Validate each output argument as an explicit nonempty path, use atomic temp-file renames for outputs, bound every wait to 30 seconds, and clean the browser/server/compiler/temporary fixture in `finally`. Never infer a boolean from screenshot existence.

- [ ] **Step 4: Run all real browser gates and generate tracked captures**

  Run:

  ```bash
  npm run build
  npm test -- run packages/workbench/tests/overview.e2e.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts packages/workbench/tests/mcp-app-preview-browser.test.ts packages/workbench/tests/mcp-page-app-browser.test.ts packages/workbench/tests/mcp-app-real.e2e.test.ts packages/workbench/tests/runtime-playground.e2e.test.ts packages/workbench/tests/runtime-playground-hmr.e2e.test.ts packages/workbench/tests/runtime-playground-capture.test.ts
  mkdir -p docs/assets/rsc-runtime-workbench /tmp/rsc-runtime-delivery
  node packages/workbench/scripts/capture-runtime-playground.mjs \
    --desktop docs/assets/rsc-runtime-workbench/desktop.png \
    --mobile docs/assets/rsc-runtime-workbench/mobile.png \
    --hmr-before docs/assets/rsc-runtime-workbench/hmr-before.png \
    --hmr-after docs/assets/rsc-runtime-workbench/hmr-after.png \
    --compile-error docs/assets/rsc-runtime-workbench/compile-error.png \
    --recovered docs/assets/rsc-runtime-workbench/recovered.png \
    --evidence /tmp/rsc-runtime-delivery/browser-evidence.json
  node --input-type=module --eval "import { readFile } from 'node:fs/promises'; const e = JSON.parse(await readFile('/tmp/rsc-runtime-delivery/browser-evidence.json', 'utf8')); if (!e.hmrWithoutReload || !e.lastGoodPreserved || !e.recovered || !e.appRefreshPreservedDocument || !e.sandboxOpaqueOrigin) process.exit(1); console.log(JSON.stringify(e, null, 2));"
  ```

  Inspect all six PNGs with `view_image`. Compare `desktop.png` at 1440×900 with `docs/assets/rsc-runtime-workbench/desktop-concept.png` and the frontend plan's fidelity report. Record copy, layout, typography, palette, container model, diagnostic state, and interaction-state differences. Keep the PNGs; keep per-run evidence JSON under `/tmp`.

- [ ] **Step 5: Run focused backend security/protocol gates**

  Run:

  ```bash
  npm run build --workspace agent-bundle-workbench
  npm run typecheck --workspace agent-bundle-workbench
  npm test -- run packages/agent-bundle/tests/playground-service.test.ts packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/runtime-mcp-registry.test.ts packages/agent-bundle/tests/mcp-session-routes.test.ts packages/agent-bundle/tests/mcp-session-service.test.ts packages/agent-bundle/tests/mcp-app-binding-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts packages/agent-bundle/tests/mcp-app-metadata.test.ts packages/agent-bundle/tests/mcp-app-preview-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts packages/agent-bundle/tests/mcp-app-routes.test.ts packages/agent-bundle/tests/runtime-mcp-routes.test.ts packages/agent-bundle/tests/mcp-app-sandbox.test.ts packages/agent-bundle/tests/mcp-app-bridge.test.ts packages/agent-bundle/tests/mcp-app-host-profiles.test.ts packages/agent-bundle/tests/dev-workbench.test.ts
  npm test -- run packages/workbench/tests/rsbuild-workbench.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-session-model.test.ts packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-json-input.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-session-adapter-fixture.test.ts packages/workbench/tests/project-client.test.ts packages/workbench/tests/runtime-client.test.ts packages/workbench/tests/runtime-contract-compile.test.ts packages/workbench/tests/runtime-model.test.ts packages/workbench/tests/runtime-stage.test.ts packages/workbench/tests/runtime-inspector.test.ts packages/workbench/tests/runtime-playground.test.ts packages/workbench/tests/mcp-app-client.test.ts packages/workbench/tests/mcp-app-frame.test.ts packages/workbench/tests/runtime-app-bridge.test.ts packages/workbench/tests/secure-app-renderer.test.ts packages/workbench/tests/mcp-app-preview.test.ts packages/workbench/tests/rsbuild-closure.test.ts
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/http-security.test.ts tests/host-extensions.test.tsx tests/widget-accessibility.test.tsx
  ```

  Expected: zero failures. Do not replace the real compiler/browser/AppRenderer with mocks or broaden sandbox permissions to make a test pass.

- [ ] **Step 6: Request fresh task review and commit**

  A frontend reviewer must inspect the extended script, capture test, fidelity report, and all six images. A security reviewer must verify the iframe remains opaque-origin and that the browser never chooses an executable, cwd, environment, output root, or upstream URL.

  ```bash
  git add packages/workbench/scripts/capture-runtime-playground.mjs packages/workbench/tests/runtime-playground-capture.test.ts docs/assets/rsc-runtime-workbench/*.png
  git commit -m "test: capture RSC Workbench HMR evidence"
  ```

### Task 4: Generate and document the actual post-change topology

**Files:**
- Create: `scripts/rsc-runtime-topology.mjs`
- Create: `packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts`
- Modify: `package.json`
- Create: `docs/architecture/rsc-runtime-workbench.md`
- Modify: `README.md`
- Modify: `packages/agent-bundle/README.md`
- Modify: `examples/rsc-agent-runtime/README.md`

**Interfaces:**
- Produces: `node scripts/rsc-runtime-topology.mjs --root . --output docs/architecture/rsc-runtime-workbench.md` and `--check` mode.
- Consumes: `git ls-files -z` under a fixed allowlist: `packages/agent-bundle/src/dev`, `packages/agent-bundle/src/services/playground-service.ts`, `packages/agent-bundle/tests`, `packages/workbench/rsbuild.config.ts`, `packages/workbench/src`, `packages/workbench/tests`, `examples/rsc-agent-runtime`, `docs/superpowers/specs`, and `docs/superpowers/plans`. From core/Workbench sources and tests it retains runtime/provider, MCP App/session/client/frame, hook-playground, the single provider-neutral `PlaygroundService` plus `playground-service.test.ts`, the standard Workbench Rsbuild config and `rsbuild-workbench.test.ts`, the landed `mcp/mcp-app-preview.tsx`/CSS, `mcp-app-preview.test.ts`, sole `mcp-app-preview-browser.test.ts` fixture, `mcp-page.tsx`/CSS/test plus sole `mcp-page-app-browser.test.ts` mounted composition/terminal-close gate, and sole `mcp-app-real.e2e.test.ts` generated-server/foreground/session/browser fixture, the single `WorkbenchScreen` shell/navigation, stable `McpAppClient`, and shared MCP/Inspector controller-model ownership in `packages/workbench/src/main.tsx`, `packages/workbench/tests/inspector-shell.e2e.test.ts`, and the Inspector session entry/adapter/model/CSS, adapter-local compatibility modules, replay-free protocol presenter, TypeScript config, and production fixture; it excludes unrelated historical/config-only tests and `packages/workbench/src/inspector/vendor/**` so the document is an actual feature topology rather than a repository dump. The generated topology distinguishes the durable whole-plugin authoring timeline from provider-session Runtime run history, shows Runtime extending that shell as its fifth sibling, and shows the landed canonical-profile preview plus its component, mounted-page, and real-route browser gates as the artifact boundary; it must not imply a second trace/playground service, JSONL writer, replay/export owner, shell, App client, routes/lifecycle stack, controller/model subscription, interactive preview placement/lifecycle or terminal-cleanup owner, preview-component fixture, App-page fixture, or real generated-server/browser fixture for one binding, adapter entry, or Inspector fixture.
- Produces: one Markdown document with generated topology markers plus a hand-maintained boundary/flow section outside those markers.

- [ ] **Step 1: Write a failing generator behavior test in a temporary Git repository**

  Create literal tracked fixtures for a provider, the provider-neutral playground service, Workbench model, example entry, tests, and ignored `dist` file. Invoke the real script with `--root` and assert its generated block equals:

  ```text
  packages/
    agent-bundle/
      src/dev/runtime-provider.ts
      src/services/playground-service.ts
      tests/playground-service.test.ts
      tests/runtime-provider.test.ts
    workbench/
      src/runtime/runtime-model.ts
  examples/
    rsc-agent-runtime/
      src/dev/provider.ts
  ```

  Assert untracked files, `dist`, `node_modules`, `.agent-bundle`, screenshots outside the documented asset directory, and absolute paths are absent. Mutate the generated file and assert `--check` exits `1` with `RSC runtime topology is stale`; regenerate and assert `--check` exits `0`.

- [ ] **Step 2: Run the focused generator test and verify red**

  Run:

  ```bash
  npm test -- run packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts
  ```

  Expected: FAIL because `scripts/rsc-runtime-topology.mjs` does not exist.

- [ ] **Step 3: Implement the deterministic topology renderer**

  Parse only `--root`, `--output`, and optional `--check`; reject duplicates or extra arguments. Use `execFile('git', ['ls-files', '-z', '--', ...allowlist])`, split NUL-delimited paths, exclude generated/runtime output and `packages/workbench/src/inspector/vendor`, retain the feature paths described by the interface above, sort with `localeCompare`, and render two-space indentation. Replace only text between these exact markers:

  ````markdown
  <!-- BEGIN GENERATED RSC RUNTIME TOPOLOGY -->
  ```text
  generated tracked-file tree
  ```
  <!-- END GENERATED RSC RUNTIME TOPOLOGY -->
  ````

  In `--check`, compare bytes and make no write. In write mode, resolve the existing output parent with `realpath`, require it beneath the repository root, then append the basename; never require the not-yet-created file itself to realpath. Add root scripts:

  ```json
  {
    "docs:runtime-topology": "node scripts/rsc-runtime-topology.mjs --root . --output docs/architecture/rsc-runtime-workbench.md",
    "check:runtime-topology": "node scripts/rsc-runtime-topology.mjs --root . --output docs/architecture/rsc-runtime-workbench.md --check"
  }
  ```

- [ ] **Step 4: Write the architecture document and generate the real tree**

  Outside the generated markers, document:

  - optional declaration → provider-neutral Agent Bundle contract → example-owned Rsbuild session;
  - artifact epoch, runtime generation, state version, definition digest, MCP session, and run identity as separate axes;
  - Rslib Agent Bundle library/package lane versus the example's Rsbuild production artifact build versus its separate long-lived Rsbuild development/HMR session;
  - the provider-neutral durable `PlaygroundService` whole-plugin authoring timeline versus the current provider-session-scoped, at-most-50 Runtime run history and render-local trace, including the explicit not-yet-wired ownership boundary for durable Runtime export/eval promotion;
  - immutable generation activation/lease flow and last-good failure recovery;
  - static MCP definition/broker versus generation-pinned invocations;
  - separate RSC result tree and MCP App iframe;
  - portable baseline plus simulated ChatGPT/Claude profiles and native terminal evidence boundaries.

  Include this Mermaid flow with the final committed symbol/file labels substituted only if the earlier plans named them differently:

  ```mermaid
  flowchart LR
    Save["Source edit"] --> Rsbuild["Example-owned Rsbuild compiler"]
    Rsbuild --> Stage["Stage and validate complete generation"]
    Stage --> Activate["Atomically activate runtime generation"]
    Activate --> Event["runtime.generation.activated"]
    Event --> Replay["Workbench replays selected fixture"]
    Replay --> Lease["Lease immutable generation"]
    Lease --> Worker["Disposable RSC worker"]
    Worker --> Flight["Flight stream"]
    Flight --> Lower["Decode and lower native hook/MCP result"]
    Lower --> Model["Agent-visible result"]
    Lower --> Bridge["Generation-bound MCP App bridge"]
    Bridge --> Frame["Opaque-origin App iframe"]
  ```

  Run `npm run docs:runtime-topology` after writing the boundary sections, then `npm run check:runtime-topology`.

- [ ] **Step 5: Update public documentation at the real optional boundary**

  Replace stale statements that Agent Bundle has no development server. The root and package READMEs must show ordinary `agent-bundle dev` first, then label `dev.runtime.provider` as an advanced optional extension. The example README must contain contributor dev, capture, packaging, and native evidence commands; explain that Rslib produces the published Agent Bundle package while the example's production RSC/runtime artifacts are built by its explicit Rsbuild production command; and link the architecture document. If authoring trace persistence is mentioned, identify the provider-neutral `PlaygroundService` as the landed durable foundation and the current Runtime Playground run history as provider-session-scoped/ephemeral; do not claim the provider adapter, authenticated API, UI timeline, export, or eval-promotion wiring exists until its owning plans implement it. Do not imply that installing `agent-bundle` installs the example provider.

- [ ] **Step 6: Run documentation topology and focused package tests**

  Run:

  ```bash
  npm test -- run packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts
  npm run docs:runtime-topology
  npm run check:runtime-topology
  git diff --check
  ```

  Expected: zero failed tests, topology check exit `0`, and no whitespace errors.

- [ ] **Step 7: Request fresh task review and commit**

  The reviewer verifies every generated tree entry exists at `HEAD`, every runtime/provider boundary is represented, and the prose does not conflate package build, dev compiler, local simulation, or native evidence.

  ```bash
  git add scripts/rsc-runtime-topology.mjs packages/agent-bundle/tests/rsc-runtime-topology-script.test.ts package.json README.md packages/agent-bundle/README.md examples/rsc-agent-runtime/README.md docs/architecture/rsc-runtime-workbench.md
  git commit -m "docs: map the optional RSC runtime topology"
  ```

### Task 5: Resynchronize and run fresh release verification

**Files:**
- Modify only if a merge conflict or newly exposed failing test requires a scoped fix.
- Do not write the audit document until every command in this task has run against the final synchronized commit.

**Interfaces:**
- Consumes: local base branch `codex/agent-bundle-implementation` and all preceding commits.
- Produces: a clean synchronized candidate commit plus timestamped local command logs under `/tmp/rsc-runtime-delivery/final`.

- [ ] **Step 1: Prove the worktree is clean and inspect base distance**

  Run:

  ```bash
  git status --short
  git rev-list --left-right --count codex/agent-bundle-implementation...HEAD
  git log --oneline --decorate -12
  ```

  Expected before merge: empty status. Interpret the first count as commits the feature lacks and the second as feature-only commits. Never infer “current” from timestamps.

- [ ] **Step 2: Merge a newer committed base if and only if the left count is nonzero**

  Run:

  ```bash
  git merge --no-edit codex/agent-bundle-implementation
  git rev-list --left-right --count codex/agent-bundle-implementation...HEAD
  git status --short
  ```

  Expected after merge: `0 <feature-count>` and empty status. If conflicts occur, use `superpowers:systematic-debugging` plus `fix-merge-conflicts`; preserve both branches' intended behavior, regenerate `package-lock.json` only with `npm install --package-lock-only --ignore-scripts`, run focused conflict-area tests, and keep the merge commit separate.

- [ ] **Step 3: Ask TraceDecay for fresh compiler diagnostics before compilation**

  Run the TraceDecay diagnostics tool for the synchronized worktree and resolve every current error. Then create the final log directory:

  ```bash
  mkdir -p /tmp/rsc-runtime-delivery/final
  ```

  Do not query TraceDecay databases directly and do not treat a stale previous diagnostic result as current.

- [ ] **Step 4: Run production builds, complete automated tests, lint, typecheck, and topology check**

  Run each command separately with `set -o pipefail` so the logged exit is the real command exit:

  ```bash
  set -o pipefail
  npm run build 2>&1 | tee /tmp/rsc-runtime-delivery/final/root-build.log
  npm test 2>&1 | tee /tmp/rsc-runtime-delivery/final/root-test.log
  npm run lint 2>&1 | tee /tmp/rsc-runtime-delivery/final/root-lint.log
  npm run typecheck 2>&1 | tee /tmp/rsc-runtime-delivery/final/root-typecheck.log
  npm run check:runtime-topology 2>&1 | tee /tmp/rsc-runtime-delivery/final/topology.log
  npm run build -w @agent-bundle/rsc-agent-runtime-demo 2>&1 | tee /tmp/rsc-runtime-delivery/final/example-build.log
  npm test -w @agent-bundle/rsc-agent-runtime-demo 2>&1 | tee /tmp/rsc-runtime-delivery/final/example-test.log
  npm run typecheck -w @agent-bundle/rsc-agent-runtime-demo 2>&1 | tee /tmp/rsc-runtime-delivery/final/example-typecheck.log
  ```

  Read every complete log, record the Rstest passed/failed counts and exit codes, and stop on the first nonzero command. A root `npm run check` may be run afterwards as an additional single-command proof, but it does not replace these separate evidence categories.

- [ ] **Step 5: Run focused concurrency, HMR, security, packaging, and ordinary-project regressions**

  Run:

  ```bash
  npm run build --workspace agent-bundle-workbench 2>&1 | tee /tmp/rsc-runtime-delivery/final/workbench-build.log
  npm run typecheck --workspace agent-bundle-workbench 2>&1 | tee /tmp/rsc-runtime-delivery/final/workbench-typecheck.log
  npm test -- run packages/agent-bundle/tests/playground-service.test.ts packages/agent-bundle/tests/runtime-provider.test.ts packages/agent-bundle/tests/runtime-generation-store.test.ts packages/agent-bundle/tests/runtime-routes.test.ts packages/agent-bundle/tests/runtime-mcp-registry.test.ts packages/agent-bundle/tests/rsc-runtime-optional-packaging.test.ts packages/agent-bundle/tests/mcp-session-routes.test.ts packages/agent-bundle/tests/mcp-session-service.test.ts packages/agent-bundle/tests/mcp-app-binding-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts packages/agent-bundle/tests/mcp-app-metadata.test.ts packages/agent-bundle/tests/mcp-app-preview-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts packages/agent-bundle/tests/mcp-app-routes.test.ts packages/agent-bundle/tests/runtime-mcp-routes.test.ts packages/agent-bundle/tests/mcp-app-sandbox.test.ts packages/agent-bundle/tests/mcp-app-bridge.test.ts packages/agent-bundle/tests/mcp-app-host-profiles.test.ts packages/agent-bundle/tests/dev-workbench.test.ts 2>&1 | tee /tmp/rsc-runtime-delivery/final/focused-core.log
  npm test -- run packages/workbench/tests/rsbuild-workbench.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-session-model.test.ts packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-json-input.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-session-adapter-fixture.test.ts packages/workbench/tests/project-client.test.ts packages/workbench/tests/runtime-client.test.ts packages/workbench/tests/runtime-contract-compile.test.ts packages/workbench/tests/runtime-model.test.ts packages/workbench/tests/runtime-stage.test.ts packages/workbench/tests/runtime-inspector.test.ts packages/workbench/tests/runtime-playground.test.ts packages/workbench/tests/mcp-app-client.test.ts packages/workbench/tests/mcp-app-frame.test.ts packages/workbench/tests/runtime-app-bridge.test.ts packages/workbench/tests/secure-app-renderer.test.ts packages/workbench/tests/mcp-app-preview.test.ts packages/workbench/tests/rsbuild-closure.test.ts 2>&1 | tee /tmp/rsc-runtime-delivery/final/focused-workbench.log
  npx rstest --config rstest.runtime-playground.config.ts 2>&1 | tee /tmp/rsc-runtime-delivery/final/focused-workbench-coverage.log
  npm test -- run packages/workbench/tests/overview.e2e.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts packages/workbench/tests/mcp-app-preview-browser.test.ts packages/workbench/tests/mcp-page-app-browser.test.ts packages/workbench/tests/mcp-app-real.e2e.test.ts packages/workbench/tests/runtime-playground.e2e.test.ts packages/workbench/tests/runtime-playground-hmr.e2e.test.ts packages/workbench/tests/runtime-playground-capture.test.ts 2>&1 | tee /tmp/rsc-runtime-delivery/final/focused-browser.log
  npm test -w @agent-bundle/rsc-agent-runtime-demo -- run tests/dev-provider.integration.test.ts tests/rsc-hmr.integration.test.ts tests/rsc-hook.integration.test.ts tests/host-artifacts.test.ts tests/runtime-artifact-manifest.test.ts tests/http-security.test.ts 2>&1 | tee /tmp/rsc-runtime-delivery/final/focused-example.log
  ```

  Use the exact committed filenames from preceding plans if their approved task ledgers record a split; update this command in the plan execution ledger before running. Record test counts by file, not only the aggregate exit.

- [ ] **Step 6: Regenerate browser evidence from the synchronized build**

  Delete no tracked images manually. Run the capture command over the existing output directory so each file is atomically replaced, then inspect all PNGs and the JSON proof:

  ```bash
  node packages/workbench/scripts/capture-runtime-playground.mjs --desktop docs/assets/rsc-runtime-workbench/desktop.png --mobile docs/assets/rsc-runtime-workbench/mobile.png --hmr-before docs/assets/rsc-runtime-workbench/hmr-before.png --hmr-after docs/assets/rsc-runtime-workbench/hmr-after.png --compile-error docs/assets/rsc-runtime-workbench/compile-error.png --recovered docs/assets/rsc-runtime-workbench/recovered.png --evidence /tmp/rsc-runtime-delivery/final/browser-evidence.json 2>&1 | tee /tmp/rsc-runtime-delivery/final/browser-capture.log
  npm run capture:widget -w @agent-bundle/rsc-agent-runtime-demo -- --output /tmp/rsc-runtime-delivery/final/widget.png 2>&1 | tee /tmp/rsc-runtime-delivery/final/widget-capture.log
  ```

  The capture test and helper teardown must prove all temporary source edits were removed; the capture operates on a copied fixture, so `git status --short` must show no Workbench/example source changes. Inspect the updated tracked PNGs with `view_image`; if pixels changed intentionally, commit only after the frontend reviewer accepts them.

- [ ] **Step 7: Run real native host evaluations and record limitations**

  Re-run the two Task 2 native commands into `/tmp/rsc-runtime-delivery/final/claude.json` and `codex.json`. Record exact installed versions, timestamp, command exit, and every claim classification. An unavailable or incomplete native session is a limitation, not permission to fabricate observed evidence; it may block a claimed certification while leaving automated delivery gates green.

- [ ] **Step 8: Verify repository integrity and commit capture drift if present**

  Run:

  ```bash
  git diff --check
  git status --short
  git diff --stat
  ```

  If only accepted regenerated PNGs changed, commit them as:

  ```bash
  git add docs/assets/rsc-runtime-workbench/*.png
  git commit -m "docs: refresh runtime Workbench evidence"
  ```

  Any source or generated topology drift requires the corresponding focused test and a separate scoped commit, followed by Steps 4–8 again.

### Task 6: Run independent audits and close every load-bearing finding

**Files:**
- Create: `docs/audits/2026-08-14-rsc-runtime-workbench-delivery.md`
- Modify: only files required by accepted audit fixes, with their existing tests or new regression tests.

**Interfaces:**
- Consumes: `BASE_SHA=$(git merge-base codex/agent-bundle-implementation HEAD)`, `HEAD_SHA=$(git rev-parse HEAD)`, the approved spec, four implementation plans, fresh logs, browser assets, and sanitized native evidence.
- Produces: four independent review reports and one consolidated finding ledger with `ID`, `dimension`, `severity`, `file/symbol evidence`, `finding`, `disposition`, `fix commit`, `verification`, and `remaining limitation`.

- [ ] **Step 1: Freeze exact review inputs**

  Run:

  ```bash
  BASE_SHA=$(git merge-base codex/agent-bundle-implementation HEAD)
  HEAD_SHA=$(git rev-parse HEAD)
  printf 'base=%s\nhead=%s\n' "$BASE_SHA" "$HEAD_SHA"
  git status --short
  git log --reverse --oneline "$BASE_SHA..$HEAD_SHA"
  ```

  Require empty status. Pass only these SHAs, the approved spec path, relevant plan path, and review dimension to each reviewer; do not pass the coordinator's conclusion.

- [ ] **Step 2: Dispatch four read-only reviewers in parallel**

  Use the requesting-code-review template and these exact scopes:

  1. **Architecture/correctness/concurrency:** optional provider ownership; reuse of the single provider-neutral `PlaygroundService` for any future durable whole-plugin Runtime authoring timeline rather than a runtime-specific service, JSONL writer, credential cache/redactor, lifecycle owner/admission mutex, root/quarantine/owner cleanup layer, cleanup retry/suppression policy, or per-surface instance; explicit separation and identity compatibility between that durable timeline and the provider's transient 50-run `DevRuntimeRun` history/render-local trace; no claim of durable Runtime UI history until the provider and Playground owning plans add the adapter/routes/client; serialized append/replay-to-live/finalize/close ordering; synchronous close-start admission fencing; close waiting every cold open/reopen before snapshotting installed sessions; pre-install availability recheck; losing admission rejecting closed without publishing a session; directory device/inode recorded synchronously after creation; identity plus exact owner token required after ownership; displaced owned root found only inside the immediate sessions directory, quarantined by rename, revalidated, then removed; identity-only pre-owner rollback with provisional-token release; same-token/different-inode and `EEXIST` replacements preserving pre-existing finalized/open `session.json`/`.owner.lock`; an out-of-scope displaced owned root preserved with the opening `AggregateError` and repeatable service-close failure both retaining the admission cleanup/session identity; unknown callback-shaped options remaining inert; the existing record tail ordering already-admitted work before record close; durable aborted shutdown of open sessions; subscriber drain; release of the sole writer claim; repeated-close idempotence; and structural cleanup-failure visibility from the expanded owner-bound cases in `playground-service.test.ts`; artifact epoch versus runtime generation; coherent activation; lease drain/retention; stale candidate fencing; definition-digest restart; `McpSessionService.acquireAppLease` reuse rather than a parallel control session; immediate lease revocation at close start; reentrant close sharing one promise and running cleanup once; failed App lease release remaining visible, invalidated, retained, and retryable before teardown publication; `McpAppPreviewService.closeAll()` attempting blocked creates and every retained preview, aggregating failures, and retaining failed teardown for authoritative retry; reuse of the landed single foreground App route/deferred preview/sandbox composition rather than a duplicate runtime stack; `mcp-app-real.e2e.test.ts` remaining the one generated MCP server/foreground/session/browser lifecycle fixture extended for runtime assertions rather than cloned; ordered `DevServerStartError` startup/unwind causes; Apps-before-sessions-before-coordinator cleanup with every resource attempted and every failure retained; reuse of the one Workbench-owned `McpAppClient`, landed `McpPageAppPreview` placement, browser App client/frame lifecycle, and `McpAppPreviewController` artifact preview lifecycle rather than parallel authentication, routes, parsing, relay, close, placement, or generic preview-state ownership; only a current ready successful tool call becoming a preview source; one shared start promise, close joining an in-flight create, exact late-binding force cleanup, and no late ready publication; one page-owned serialized close promise joined by explicit close, profile/source replacement, session-ID drift, restart/close/reset, unmount, and terminal `closed`/`error` observation; frame/state retained busy until that promise settles; open-generation fencing preventing stale remount; no Runtime cleanup effect competing with the page; canonical Apps-profile/resource proof before a frame reaches ready; exactly one Runtime App preview placement and state/cleanup owner per binding; `McpSessionController` single-admission state transitions, ordered snapshot/live trace merge, failure cleanup, late-work rejection, active-work drain before client/transport close, and one shared resource-labelled rejection plus visible diagnostic when any cleanup fails; awaited remote cancellation/reader cleanup before delete; idempotent cleanup; one Workbench-owned controller and subscribed immutable model retaining object/model/history/timeline identity across MCP → Inspector → Runtime → Inspector → MCP; Runtime extending the existing shell only as the fifth `WorkbenchScreen` sibling without another navigation/router, MCP page/screen, controller/model subscription, Inspector adapter entry, or browser fixture; and proof that one session-close failure does not prevent every other MCP/App/provider/coordinator resource from being attempted or disappear behind a successful close result.
  2. **Security/protocol:** provider/asset containment after realpath; `PlaygroundService` storage remaining absolute, project-owned, realpath-contained, and nonsymlinked; cleanup proving the immediately recorded directory device/inode and, after lock creation, the exact owner token; quarantining/revalidating only that owned displaced root within the immediate sessions directory; never deleting same-token/different-inode or `EEXIST` replacement `session.json`/`.owner.lock`; preserving an unlocatable owned root plus structured admission failure rather than broadening deletion; and exposing no directory identity, owner token, quarantine/removal primitive, or cleanup retry to Runtime/Workbench code; path-safe session IDs, finite JSON-only event snapshots, fail-closed completed-record corruption/project mismatch, provider-credential value and normalized sensitive-key rejection before every durable boundary, corrupt credential-bearing reopen failing without value echo, and no rejected value, storage-owner credential, or writer token retained by a future Runtime adapter, Workbench client/model, diagnostic, replay, export, or draft eval after service close; browser opaque IDs; token/origin/body/time/output/process/concurrency limits; environment allowlist/redaction; memory-only same-origin App authentication; `mcp-page-app-browser.test.ts` proving the mounted page sends exact current-session input/result/tool/profile/host data, never browser-selected `toolMetadata` or `resourceUri`, keeps the sandbox at a distinct origin with no foreground credential, uses the current binding-scoped sequence `ui/initialize` → `ui/notifications/initialized` → `tools/call`/`resources/read`/`ui/request-display-mode`/`notifications/message`, closes with `ui/resource-teardown`, and coalesces terminal error/closed observation plus explicit cleanup through `terminateAndClickClose`; `mcp-app-real.e2e.test.ts` proving the same boundaries through an actual generated SDK-v2 server, epoch-bound session and authenticated foreground App routes, including distinct proxy origin, credential exclusion from App content, canonical resource/input/result delivery, real nested tool/resource/logging traffic, fail-closed unsupported display mode, acknowledged teardown, live-session usability after preview close, and foreground/sandbox/epoch cleanup; preview input/result transactionally deep-detached before create into frozen finite JSON, preserving own-property data while rejecting cycles, nonfinite/non-JSON values, and exotic prototypes; exact canonical `ui:` URI serialization with a nonempty host rather than prefix matching; malformed-success rejection versus structured non-2xx diagnostics; server-issued proxy origin distinct from foreground; exact iframe source/origin/policy/referrer/sandbox enforcement; proxy-ready canonical-resource handoff without route credentials; MCP frame byte/queue bounds and serialized relay; binding-smuggling rejection; canonical App-visible tool/resource projection; binding-derived tool context with browser `toolInfo` rejected; synchronous App-lease invalidation when the control session closes; no bridge access while failed release is retained; foreground-only authenticated App mutation routes with the sandbox origin exposing no project/MCP-session APIs; fail-closed blocked App traffic; opaque-origin iframe/CSP/Permissions Policy/consent; one reserved canonical bridge teardown frame outside ordinary outbound capacity, exact route forwarding without synthesis, exactly one accepted acknowledgement with duplicates rejected, close queued behind accepted traffic even at capacity but bounded from the initial close call, one coalesced force-delete across timeout/delivery failure, no late post-close delivery, and repeated closed cleanup as a no-op; normal browser teardown-before-DELETE versus backend revoke-first invalidation; and cancellation teardown.
  3. **Frontend/DX/accessibility:** capability-hidden Runtime navigation while MCP and Inspector remain unconditional; real RSC HMR; last-good diagnostics; immutable provider-session run history explicitly labelled ephemeral across provider restart and not conflated with the durable `PlaygroundService` whole-plugin timeline, cursor, export, or draft-eval contract; Runtime rendered as the fifth route through the existing `WorkbenchScreen`; the existing Inspector adapter consuming the exact Workbench-owned controller model without a parallel state machine; `inspector-shell.e2e.test.ts` proving direct Inspector navigation opens no session, MCP → Inspector preserves the one negotiated session/catalog/ordered protocol/logging model, MCP close/reset is reflected by Inspector, one session POST occurs, and production plus explicit-development Workbench artifacts mount without page errors or mobile overflow; production use of the adapter's style-owning entry and adapter-local compatibility boundary rather than the bare TSX or modified vendor source; every raw protocol frame retained with JSON-RPC-derived direction plus original transport origin, sequence, and timestamp; production Chrome fixture mounting all five presentations without a duplicate Runtime fixture; one accessible preview lifecycle for each binding; `mcp-page.test.ts` proving the current-successful-tool source gate, exact supported profile options, and the one history entry point inside the existing MCP page; `mcp-app-preview-browser.test.ts` mounting the real component in Chrome for ready exact iframe attributes, create-error ordinary fallback, fallback without iframe, unmount-race cleanup, and long-profile/frame/fallback layout at 390px; `mcp-page-app-browser.test.ts` exercising the one mounted page slot through portable/ChatGPT/Claude replacement, wrong-MIME/legacy fallback, post-preview ordinary MCP work, terminal error/closed automatic cleanup racing the explicit Close action without a duplicate close, 390px containment, zero page errors, and fixture cleanup; `mcp-app-real.e2e.test.ts` exercising the one real generated-server/session/route/sandbox journey, close/reopen/session-close UI, 390px containment, zero page errors, and complete origin/epoch cleanup; Runtime extending that exact real fixture, the mounted page fixture, and existing overview/Runtime journeys without a second preview placement, controller, client, routes stack, terminal cleanup effect, or fixture; noncanonical profile/resource responses and create/relay failures retaining the detached ordinary input/result fallback without an untrusted relay; artifact-binding reset isolation; unsupported raw replay/log-level controls absent; real foreground open/form/raw/replay/cancel/close/reset/reopen behavior; server-issued App iframe attributes and browser-owned close relay; accessible schema forms/tabs/trace; desktop/mobile layout; concept fidelity; App Fast Refresh isolation.
  4. **Packaging/cross-host:** separation among Rslib Agent Bundle packaging, the standard Workbench `rsbuild build`, the example's Rsbuild production RSC build, and the provider's Rsbuild development session; preservation of the standard `pluginReact()` config without custom React environment transforms or an obsolete config-only test; the provider-neutral `PlaygroundService` introducing no React/RSC/provider dependency or unconditional runtime startup into the packed ordinary consumer; manifest transitive chunks; self-contained App HTML; portable negotiation; ChatGPT/Claude simulated extension matrices; native Claude/Codex evidence truthfulness.

  Require every reviewer to return findings only, ordered Critical → Important → Minor, with an exact path, symbol or tight line, reproducible evidence, and why an existing test does or does not catch it. “Looks good” without examining the diff and tests is not a review.

- [ ] **Step 3: Consolidate findings before editing**

  Write the audit document with these exact sections:

  ```markdown
  # RSC Runtime Workbench Delivery Audit
  ## Candidate
  ## Fresh Verification Evidence
  ## Native Host Evidence
  ## Browser and HMR Evidence
  ## Architecture and Ownership
  ## Correctness and Concurrency
  ## Security and Protocol
  ## Frontend, DX, and Accessibility
  ## Packaging
  ## Cross-host Behavior
  ## Finding Ledger
  ## Remaining Limitations
  ```

  Do not mark any finding resolved yet. Deduplicate only when two reviewers cite the same root cause and keep both dimensions on the retained row.

- [ ] **Step 4: Fix Critical and Important findings one at a time with red/green proof**

  For each accepted finding:

  1. use TraceDecay impact/test-map on the cited symbol;
  2. write the smallest real regression test named for the break;
  3. run it and observe the expected failure;
  4. implement the minimal fix;
  5. rerun the focused test and affected test map;
  6. commit with a concrete `fix(runtime): ...` message naming the repaired invariant;
  7. send the fix SHA and evidence back to the originating reviewer.

  Never batch unrelated security, concurrency, and UI fixes into one commit. A reviewer finding proven incorrect is marked `rejected` only with counter-evidence from code and a passing behavior test.

- [ ] **Step 5: Obtain reviewer closure and rerun full verification after the last fix**

  Each originating reviewer returns `resolved`, `accepted limitation`, or a narrower remaining finding. Then repeat every command in Task 5 Steps 4–8 from the new `HEAD`; earlier logs are invalid after a fix. Update the audit with the fresh commit, counts, exits, browser identity assertions, host claim matrix, and reviewer dispositions.

- [ ] **Step 6: Run one final change-risk review across the complete branch**

  Dispatch a fresh reviewer with the full `BASE_SHA..HEAD_SHA` diff and ask only for merge-blocking risks that survived task reviews. Critical or Important output returns to Step 4. Record a clean review as `no merge-blocking findings` with its reviewed SHA, never as proof that tests passed.

- [ ] **Step 7: Commit the evidence-backed audit**

  Before commit, verify that every command claim in the document has a corresponding current log, every finding has a disposition, and every remaining limitation is explicit.

  ```bash
  git add docs/audits/2026-08-14-rsc-runtime-workbench-delivery.md
  git commit -m "docs: record RSC runtime delivery audit"
  ```

### Task 7: Prepare the final handoff from fresh repository state

**Files:**
- No new source files.
- Modify the audit/topology only if the final commit changes their factual content, followed by their checks and a documentation commit.

**Interfaces:**
- Produces: the user-facing pitch and delivery report for the exact final branch head.

- [ ] **Step 1: Perform the completion gate after the audit commit**

  Run:

  ```bash
  git status --short
  git rev-list --left-right --count codex/agent-bundle-implementation...HEAD
  git log --reverse --format='%h %s' "$(git merge-base codex/agent-bundle-implementation HEAD)..HEAD"
  npm run check
  npm run check -w @agent-bundle/rsc-agent-runtime-demo
  npm run check:runtime-topology
  git diff --check "$(git merge-base codex/agent-bundle-implementation HEAD)..HEAD"
  ```

  If base advanced again, merge it and repeat Task 5 plus Task 6's final change-risk review. Do not present a knowingly behind branch as final.

- [ ] **Step 2: Read the actual committed topology and audit, then present the outcome**

  The final response must include:

  - exact worktree path, branch, base relationship, final `HEAD`, and incremental commit series;
  - a compact tree copied from the generated topology document, covering provider/core, example compiler/generation/runtime, Workbench, MCP App/host profiles, tests, docs, and generated manifests without listing vendored Inspector internals;
  - a Mermaid runtime flow from source edit through Rsbuild incremental compile, coherent generation activation, fixture replay, generation lease, worker, Flight decode/lowering, model result, and App bridge;
  - fresh build, test, lint, typecheck, browser, packaging, and native-host counts/exits;
  - the explicit ordinary-project packed-consumer proof with no RSC provider dependencies installed;
  - native Claude/Codex claim matrices and the statement that terminal CLIs do not prove iframe rendering;
  - audit findings by severity and disposition plus every remaining limitation;
  - a concise pitch: React is the request/render composition model, external state supplies continuity, Rsbuild supplies real RSC HMR, and Agent Bundle keeps it optional behind a provider boundary.

- [ ] **Step 3: Mark the delivery goal complete only after all evidence is current**

  Use the goal-completion tool only when no required work, Critical/Important finding, behind-base commit, failed automated gate, or undocumented limitation remains. If a real host is unavailable, report that limitation exactly; do not claim host certification.

---

## Plan Self-Review

- **Spec coverage:** Task 1 covers ordinary-project isolation, the Rslib Agent Bundle package versus Rsbuild example production/development boundaries, transitive async chunks, and self-contained Apps. Task 2 covers native Claude/Codex truthfulness and host/UI evidence boundaries. Task 3 covers real RSC HMR, automatic replay, no reload, last-good recovery, App Fast Refresh, provider routes, runtime MCP registry/session routes, the merged App-access lease and Workbench MCP session controller seams, the landed browser App client/frame relay and hardened canonical-profile/concurrent-close preview boundary, its component, mounted-page, and real generated-server/session/route Rsbuild/Chrome browser fixtures, the standard Workbench Rsbuild production/development build, the real styled Inspector production fixture and Inspector shell/browser flow, the fifth-sibling Runtime route, sandbox, responsive/accessibility, and visual fidelity. Task 4 covers documentation and actual topology, including the single durable provider-neutral Playground trace foundation and its deliberate separation from transient Runtime run evidence. Task 5 supplies synchronized fresh verification, including the authoritative `playground-service.test.ts`. Task 6 supplies independent architecture, correctness/concurrency, security, frontend/DX/accessibility, packaging, and cross-host audits with remediation loops. Task 7 supplies the required pitch and final handoff.
- **Mutation coverage:** The planned tests fail on unconditional provider loading, shipped RSC example dependencies, missing async chunks, partial host copies, external App assets, false host/UI evidence promotion, a second Runtime-specific playground/trace service or JSONL writer, one `PlaygroundService` instance per surface, a Runtime/Workbench lifecycle owner, mutex, root/quarantine remover, writer-claim releaser, or cleanup retry/suppression layer wrapping the service's own admission set and record tails, durable whole-plugin and transient provider-run sequences being conflated, a Runtime durability/export/eval claim without the missing owning-plan adapter/API/client, arbitrary/symlinked/wrong-project trace storage, malformed completed JSONL being silently accepted, invalid event JSON consuming a sequence, replay-to-live loss/reordering, slow-subscriber failure closing healthy subscribers, finalize/close skipping delivery or another session, credential-looking values or camel/snake/kebab sensitive keys reaching identity/event/outcome/draft persistence, corrupt credential-bearing reopen echoing the value, rejected material being copied into Runtime/Workbench state or diagnostics, close resolving while a cold open/reopen can still install, a losing cold admission retaining its own created session root/writer claim or appearing in `session()`, directory identity being recorded only after an async yield, cleanup trusting an owner token without device/inode identity, path substitution causing the replacement/victim root to be removed instead of the displaced owned root, pre-owner rollback leaking its provisional token, an `EEXIST` conflict deleting or rewriting a pre-existing finalized/open root, `session.json`, or `.owner.lock`, an out-of-sessions displaced owned root triggering broad deletion or a swallowed cleanup failure instead of retained opening/close errors and resources, callback-shaped constructor properties executing lifecycle work, already-admitted record work being reordered behind close, reopen/subscribe/replay/export/promotion being admitted after service close starts, shutdown failing to durably abort open sessions or release the writer claim, promoted raw log references escaping, pre-activation replay, full-page reload, last-good loss, foreground credential leakage, a same-origin or forged App proxy frame, a preview accepting a frame for a missing-host, normalized-different, malformed, or non-`ui:` Apps resource URI, post-construction mutation changing preview input/result, cyclic/nonfinite/exotic input reaching create, unmount during create leaking its late binding or publishing ready, create/relay failure hiding the ordinary fallback, a ready browser iframe changing sandbox/referrer/source, browser fallback mounting an iframe, long preview profile/frame/fallback content overflowing 390px, preview controls offered for a failed/non-tool/non-ready invocation, a page create leaking `toolMetadata`, `resourceUri`, or foreground credentials, profile replacement failing to await the new binding's `ui/notifications/initialized`, stable `tools/call`/`resources/read`/`ui/request-display-mode`/`notifications/message` names regressing to obsolete probes, canonical `ui/resource-teardown` changing, wrong-MIME/legacy fallback becoming interactive, ordinary MCP work breaking after preview close, a real generated MCP App fixture replaced by route/session mocks, its proxy sharing the foreground origin, its App content receiving the foreground token, canonical input/result or nested tool/resource/logging traffic disappearing, unsupported display mode becoming an unapproved side effect, close acknowledgement/session reuse or full origin/epoch cleanup regressing, terminal `error`/`closed` leaving the App frame alive, terminal observation plus explicit close issuing two teardowns, preview state clearing before its serialized close settles, a stale queued open remounting after terminal cleanup, Runtime adding a competing terminal cleanup effect, MCP session close preceding any App close, preview replacement racing a stale close, session restart/close/reset preceding preview cleanup, a second Workbench App client, MCP page/screen, preview-component fixture, App-page browser fixture, real generated-server/browser fixture, routes/lifecycle stack, interactive preview placement, or mounted controller for one binding, parallel artifact/runtime preview UI state for one binding, wrong-source/origin or oversized relay traffic, queue/teardown ordering loss, a close timeout started only after hung traffic, duplicate force-delete, late post-close delivery, custom React environment transforms returning to the standard Workbench config, a second MCP/Inspector controller-model subscription, lost identity/history across the five-route shell, implicit Inspector session creation, duplicated Runtime shell/navigation/Inspector fixture, dropped raw Inspector frames, unsupported replay/log controls, iframe sandbox weakening, source edits left by capture, and stale topology.
- **Type/interface consistency:** Native evidence claim IDs and evidence levels are defined once in Task 2; capture identity fields are defined once in Task 3; topology markers and commands are defined once in Task 4; later tasks consume those exact names.
- **No source-text-only behavior tests:** Packaging is exercised from an installed tarball, native evidence is reduced from structured events, HMR uses the real compiler/browser, App assets are opened/copied, and topology generation runs Git. README and audit prose have no artificial string-matching tests.
- **Remaining execution risk:** Real native sessions and installed browser availability are environmental; the implementation must record them as unavailable rather than weaken automated gates or invent evidence. The moving base is handled by explicit synchronization both before verification and immediately before handoff.
