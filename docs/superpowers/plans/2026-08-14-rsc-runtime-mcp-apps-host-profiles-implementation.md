# RSC Runtime MCP Apps and Host Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a run-derived, revision-stable MCP Apps preview to the optional Runtime Playground, using the official MCP Apps browser bridge, an opaque-origin sandbox, explicit consent, and honestly versioned portable, ChatGPT, and Claude simulation profiles.

**Architecture:** The runtime provider remains the authority for immutable generations, run records, and one stable MCP registry whose sessions survive implementation-only activations. A preview is derived server-side from `DevRuntimeRun.result.app.mcpBinding`; the browser supplies only the run, expected run generation, and profile, then uses an opaque binding ID for a closed list of operations. Each operation leases the registry's current execution pointer and returns its actual `RuntimeVector`, while the binding retains the originating run vector for historical truth. Definition or transport changes perform a controlled restart/relist, increment revisions, and proactively invalidate old App bindings. The Workbench reuses its merged authenticated MCP client/transport primitives, the vendored Inspector `AppRenderer`, and the public `@modelcontextprotocol/ext-apps` `AppBridge`; standard MCP Apps metadata controls portable behavior, while OpenAI/Claude metadata stays raw and separately inspectable unless an explicitly documented, capability-detected simulation implements it.

**Tech Stack:** TypeScript 7, Node.js HTTP, React 19, Rsbuild 2, Rstest 0.11, Playwright Chromium, `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/ext-apps`, vendored MCP Inspector components.

## Global Constraints

- This is an optional supplemental runtime capability. Projects without `dev.runtime.provider` must not load React RSC, the MCP App preview service, or sandbox proxy, and their build, package, evaluation, and `agent-bundle dev` behavior must remain unchanged.
- Complete the runtime-provider/HMR plan before this plan. Consume `DevRuntimeSession.mcpRegistry`, `DevRuntimeMcpRegistry`, `DevRuntimeMcpSession`, `DevRuntimeMcpSessionSnapshot`, `DevRuntimeMcpOperationResult`, and `DevRuntimeMcpAppRunBinding` from `packages/agent-bundle/src/dev/runtime-provider.ts` and `packages/agent-bundle/src/dev/runtime-protocol.ts`; do not create a second generation store, registry, session broker, or reconcile policy.
- A stable runtime MCP session binding is authoritative: `{ sessionId, sessionRevision, registryRevision, definitionDigest, transportDigest, serverDigest, serverName, target }` in the stored run evidence, checked internally against provider-owned `providerSessionId` and `stateStoreId` in the live session snapshot. Provider/state IDs are never serialized. The enclosing `DevRuntimeRun.vector` is the immutable originating generation/state evidence. The browser never supplies or launches a session and never supplies a revision, digest, executable, arguments vector, cwd, environment, output root, generation root, resource path, or upstream URL.
- MCP tool/resource definitions are static for one session revision. A reconcile with unchanged `definitionDigest` and `transportDigest` is `implementation-updated`: it advances only the registry execution pointer, preserves `sessionId`/`sessionRevision`, does not reconnect or relist, and leaves the App binding alive. A definition or transport digest change drains/restarts/relists the affected session, advances registry/session revisions, and invalidates the old `{sessionId, sessionRevision}` binding; restart failure also invalidates it. Never silently rebind an App to the replacement revision.
- Every `list-tools`, `list-resources`, `call-tool`, and `read-resource` result is a `DevRuntimeMcpOperationResult`. Validate its `sessionId` and `sessionRevision` against the App binding and retain its leased `RuntimeVector` in the operation trace. Do not claim that a later App operation executed on the originating run generation.
- Subscribe once to `DevRuntimeMcpRegistry.subscribe({afterSequence}, listener)`. Process its atomic replay-then-live stream in sequence order, persist the last sequence, close matching bindings from `invalidatedBindings`, and fail closed on `DevRuntimeMcpRegistryReplayGap`; do not poll or infer invalidation from HMR browser events.
- The portable profile is the standards-compliance lane. Accept current nested `_meta.ui.resourceUri` and legacy flat `_meta['ui/resourceUri']`; when both exist, official nested form wins and a conflict warning retains both values/provenance. Never use `openai/outputTemplate` as selector. The read result must contain the selected `ui://` URI with exact Apps MIME.
- Tool input/result, resource metadata, embedded resources, resource links, image/audio blocks, `structuredContent`, and result `_meta` remain protocol values. Never lower them to Markdown or synthesize an App from fallback content.
- Validate tool output as MCP `CallToolResult` before projection. App-visible preserves the complete validated result. Model-visible/transcript-safe whitelists only `content` and `structuredContent`; `isError` is retained separately as protocol control, while `_meta`/unknown extensions never enter transcript.
- Merge resource-list and resource-read metadata field-by-field with read-content precedence and listed/read provenance. Apply `ui.visibility` only to tool metadata; do not interpret resource `ui.visibility` as a visibility gate.
- The ChatGPT and Claude profiles are simulations, never real-host certification. Their visible descriptors use `evidence: 'simulated'`, an Agent Bundle-owned profile version, and copy that says `Simulation`; they never branch on user agent.
- Standard metadata is normalized with provenance. Keys in the exact `openai` or `claude` namespace (`openai`, `openai/*`, `claude`, `claude/*`) are retained as raw JSON for inspection and never used as implicit selectors or translated into standard `ui` metadata.
- ChatGPT may expose only an opt-in, feature-detected `window.openai` shim implemented in this plan. Version 1 exposes `widgetState` plus synchronous `setWidgetState(next)`; the setter finite-JSON-clones and synchronously updates the App-local value before asynchronously persisting through the closed host bridge. On persistence failure it restores the prior value and emits a visible diagnostic. No other property, method, or global is invented.
- Claude version 1 adds standard host styles and safe-area context. Expected-domain derivation from an explicit canonical public HTTPS MCP URL remains resource metadata/inspection-only; it is never inserted into standard host context. No `window.claude` global or raw-Claude interpretation.
- The trusted outer sandbox controller runs on a separate loopback origin. Its inner App iframe is opaque-origin with `sandbox="allow-scripts"`; it never receives `allow-same-origin`, top-navigation, popups, downloads, forms, or storage authority.
- Resource CSP and Permissions Policy are restrictive by default. Only canonical HTTPS origins from declared standard metadata may be added. Wildcards, credentials, paths, queries, fragments, local/special IPs, and non-HTTPS origins are rejected and displayed as warnings, never treated as evidence of safety.
- App HMR consumes the provider plan's exact trusted seam: `DevRuntimeSession.clientSurface(surfaceId): DevRuntimeClientSurfaceEndpoint | undefined`, then server-only `DevServerSession.openRuntimeClientSurface(surfaceId): Promise<DevRuntimeClientSurfaceProxyBinding | undefined>`. Only proxy `{bootstrapUrl,origin,surfaceId,webSocketPath:'/rsbuild-hmr'}` reaches preview code. The fixed different-origin proxy validates declared loopback upstream, exchanges a one-use capability for an HttpOnly cookie, allows GET/HEAD only under declared path prefixes, and upgrades only exact `/rsbuild-hmr`. Browser requests never contain or reveal `httpOrigin`/`webSocketOrigin` and cannot choose an upstream.
- App-originated tools, downloads, external links, and display-mode requests require server-created binding-scoped action grants. Camera, microphone, geolocation, and `clipboardWrite` are document-scoped Permissions Policy: approval changes the next iframe document's `allow` before navigation and remains until teardown. Any separate per-write confirmation is labelled an Agent Bundle extension, not protocol permission. Host capabilities intersect profile, declaration, document grants, and installed handlers.
- Limits are fixed for this delivery: 2 MiB App HTML, 256 KiB bridge messages, 32 queued bridge messages, 8 pending consent challenges, 30-second consent/call timeout, 4 concurrent App-originated calls per binding, 20 download items, and 10 MiB aggregate embedded download bytes.
- Preserve the fail-closed behavior added by base commit `873df5e` in the artifact lane and apply the same extracted bounded-sender primitive to the runtime lane's actual official-AppBridge transport. After three send errors/queue blocks, revoke the runtime binding, close the official bridge/transport, discard queued input/result traffic, and never let a later result bypass blocked input.
- Browser teardown owns `ui/resource-teardown`: normal UI close awaits `AppRendererHandle.teardown()` with a bound, then DELETE only revokes/releases backend state. Backend invalidation/shutdown revokes immediately and publishes an authenticated invalidation event; a connected Workbench performs best-effort bridge teardown before clearing the iframe. Backend DELETE never claims to deliver a browser message.
- Every navigable App response carries a server-derived, frozen `McpAppDocumentPolicySnapshot`. The browser renders its exact `allow` value and approved permissions; it never recomputes, widens, or submits policy. A document-consent decision increments the policy revision and requires an inert-first remount. A stale, mismatched, or locally forged policy is a terminal preview error.
- Preserve the merged artifact-epoch App lane and its `McpAppBindingService`/`McpAppPreviewService`/`createMcpAppBridge` behavior. The new runtime lane is a discriminated adapter with separate bindings/routes. In that runtime lane, public `@modelcontextprotocol/ext-apps` `AppBridge` is the sole browser lifecycle state machine. One iframe must never have both core `createMcpAppBridge` and official `AppBridge`; this plan does not retroactively migrate the artifact lane.
- Preserve the merged manual MCP development lane (`McpRouteClient`, `AgentBundleRemoteTransport`, `McpSessionModel`, and `McpJsonInput`). Runtime MCP routes add a second discriminated binding kind for manual runtime inspection; App preview consumes the run's existing session and never calls either session-create route.
- Preserve the MCP-session cleanup behavior added by base commits `4c92435`, `a3e4704`, and `b4806b2`: closing the preview or foreground server must not short-circuit the serialized, reentrant `McpSessionService.close()`, and every live, opening, or failed-opening session retained for cleanup must still receive cleanup even when App teardown fails. Runtime `watchClosed`/invalidation adapters are non-owning and must not introduce another close race.
- Preserve current-base artifact guarantees from `1b54c96`, `a9af86d`, `8c9af8b`, and `43ac94e`: idempotent bounded preview shutdown tracks blocked creates and late release failures; canonical binding tool context replaces browser `toolInfo`; session close-start revokes App access; remote transport aborts, awaits cancellation/reader cleanup, suppresses late results, then deletes once. Runtime adapters reuse these helpers/orderings and add tests; they do not reimplement or weaken them.
- Preserve the retryable teardown/release invariants from `0a036ae`, `fbd57dc`, `ddc42f7`, and `a9be979`: teardown delivery is reserved exactly once, a failed App lease release/backend DELETE remains retained and retryable, and shutdown attempts it again. Browser-first teardown must not let concurrent close paths steal/lose the reserved notification, interpret a failed release as successful cleanup, or discard its binding record.
- Preserve the canonical teardown-frame boundary from `0c48ab1`: only the lifecycle owner may create `ui/resource-teardown`; routes forward its exact frame byte-for-byte and synthesize nothing when an uninitialized close returns `true`. The runtime official `AppBridge`/`AppRendererHandle` is its lifecycle owner, so the Workbench forwards the bridge's actual frame through the guarded transport and DELETE remains revocation-only.
- Preserve teardown acknowledgment ordering from `e47c9a3`, duplicate rejection from `cf54285`, and late-ack behavior from `b614770`: an initialized normal close remains routable and retains its binding until the one matching canonical teardown response is accepted and final release completes. Wrong IDs and every duplicate acknowledgment return false, never start/duplicate release, and never consume unrelated frames. Runtime browser close awaits `AppRendererHandle.teardown()`'s one matching acknowledgment before issuing normal DELETE/release. If that wait times out, retain the pending acknowledgment authority while starting bounded authoritative force close; a late first matching acknowledgment is still accepted, joins the exact in-flight release attempt, and waits afresh under the teardown bound. A second wait timeout leaves the binding `closing`/retryable; it is not a synthetic acknowledgment or a second release. Failed release remains retained/retryable.
- Preserve the landed browser boundary from `b201327`, `2157658`, and `9648f9e`: one `McpAppClient` owns memory-only authentication and strict JSON/origin/diagnostic parsing; artifact `McpAppFrameRelay` owns exact-window/origin relay, bounded FIFO, canonical-resource delivery, and its existing graceful/force-close lifecycle. Runtime methods and the official AppBridge extend these files through a discriminated lane; they never replace artifact methods, instantiate the artifact core-bridge relay, or create a second client/frame module.
- Preserve the landed `src/mcp/mcp-app-preview.tsx`/`.css` boundary from `6d1ac78`/`f247566` and its hardened lifecycle from `95271ff`. Its artifact controller, relay lifecycle, accessible loading/error/fallback UI, credential-free frame, and current props stay compatible. In particular: input/result are transactionally detached as finite, acyclic, ordinary JSON and recursively frozen before create; only exact canonical `ui://` resource URIs can become ready; start/close are single-flight; close awaits an in-flight create, captures and force-closes a late binding without publishing ready state or mounting a frame; and create/relay failure keeps an ordinary immutable `preview-error` fallback visible while cleanup proceeds. Add the official-runtime branch to this component rather than creating another preview module, lifecycle owner, or stylesheet, and give that branch the same data-detachment, canonical-profile, race, fallback, and cleanup invariants over its runtime methods. Simulated ChatGPT/Claude details remain nested extensions and cannot substitute for or weaken standard Apps proof.
- Preserve and extend the landed real-Chrome component fixture `packages/workbench/tests/mcp-app-preview-browser.test.ts` from `695e58e`; do not create a parallel mounted-preview fixture. Keep its canonical ready iframe attributes, error fallback, server fallback with no iframe, pending-create unmount cleanup, 390px no-overflow assertion, and collected `pageerror` diagnostics green, and add an explicit final zero-`pageerror` assertion. Add runtime-branch browser cases to that same fixture; reserve `overview.e2e.test.ts` for the separate real foreground/provider integration journey.
- Preserve the live `McpPage` App-preview composition from `2cef8fb`: `Workbench` owns one `McpAppClient`, `McpScreen` passes it to the one `McpPage`, `mcpAppPreviewSourceFor` admits only a successful `callTool` while the session is ready, and the existing profile picker/history action selects it. The page's one preview slot/ref/generation awaits close before profile replacement and explicit restart/close/reset; a session-ID mismatch or unmount triggers that same idempotent close and prevents the stale generation from remounting. Runtime Live MCP extends that exact selection/slot/lifecycle through a discriminated source; it must not mount another preview region, create another preview controller/ref, bypass the close-before-session ordering, or add another client in `main.tsx`.
- Preserve the landed page-level Chrome proof from `d8d2315`: keep `packages/workbench/tests/mcp-page-app-browser.test.ts`, its `mountedPageFixture`, and the existing `runs the modern Apps-v2 preview lifecycle through the page without leaking credentials or sessions` case. It alone covers the built `McpPage` composition with a real distinct-origin sandbox: exact ready-frame policy, credential absence, Apps-v2 initialize/App request traffic, exact invocation input/result/profile/session and browser host context, portable→ChatGPT→Claude replacement, post-close MCP responsiveness, wrong-MIME/legacy-template fallback, App-close-before-controller-close, no browser-supplied tool metadata/resource URI, 390px containment, zero page errors, and temporary-fixture cleanup. Add runtime page-selection coverage in this file through the same fixture/slot/client/lifecycle seams; never create another MCP-page App browser test, fixture, slot, client, or controller. The separate `mcp-app-preview-browser.test.ts` remains the isolated preview-controller/component race fixture, and `overview.e2e.test.ts` remains the real foreground/provider integration fixture.
- Preserve the Inspector compatibility runtime from `d88cb78`: the entry installs the React compatibility global before vendor screens and styles; the JSX shim/declarations, adapter-local typecheck, and real Chrome fixture remain the only supported byte-preserved vendor boundary. Preserve every valid JSON-RPC frame in the immutable raw timeline/export and interactive Protocol presentation. Keep the required `onReplay` and `onSetLevel` callback props as local unavailable-diagnostic callbacks; invoking either updates only adapter presentation state and issues zero controller, route-client, or transport RPCs. No protocol-replay or `logging/setLevel` operation handler is installed, and the current Protocol wrapper/embedded Logging presentation keeps Replay and Set Active Level UI unavailable. Do not filter otherwise valid evidence merely because the vendored Inspector would classify its method as replayable.
- Preserve startup failure retention from `dbb0312`: after the foreground listener exists, any later startup failure is primary, foreground cleanup is attempted once, and `DevServerStartError` retains both ordered causes if cleanup also fails.
- Preserve the single-admission Workbench controller lifecycle added by `85dc044`, retained cleanup causes from `ddfbdb6`, and recovery controls from `3f02b16`: one serialized controller owns open/restart/attached-App work, ordered replay-plus-live trace, failure cleanup, late-work rejection, drain-before-close, and one idempotent close. Runtime bindings extend its discriminated state; they do not add a queue, retry loop, client owner, or parallel close path. A failed cleanup stays terminal with every `McpSessionControllerCloseFailure`; `mcpPageSessionControls` permits recovery only through parent `onResetSession`, which replaces the terminal instance with one fresh idle controller rather than reopening it.
- Preserve `createMcpPageActionSession` generation suppression from `809f094` and synchronous replacement from `c3fc8e6`. During render, a changed controller identity resets the action generation and applies `mcpPageControllerReplacementState()` before effects or any new action; stale open/restart/invoke/close completion, rejection, and `finally` cleanup cannot overwrite the fresh controller's error, cancellation, binding, or pending-action state.
- Preserve the landed `WorkbenchScreen` shell and dedicated `InspectorScreen` from `baeab2d`/`301a737`, plus the Playground plan's capability-gated Runtime fifth sibling. `Workbench` owns one shared `McpSessionController` and subscribed model across `#mcp`, `#inspector`, and `#runtime`; host/App wiring may extend their discriminated runtime source but must not add a route, controller/model pair, inline Inspector tree, or browser fixture.
- Preserve the standard `rsbuild.config.ts` restored by `933e1e2`: `createWorkbenchConfig` retains its one optional proxy-target parameter, the default export remains `defineConfig(createWorkbenchConfig())`, and mode selects the React runtime through the ordinary Rsbuild build. Do not reintroduce source-level `process.env.NODE_ENV` defines/includes or a special Inspector runtime config/test; use `rsbuild-workbench.test.ts`, `rsbuild-closure.test.ts`, and the production/development Inspector shell builds as the gates.
- `DevRuntimeStatus.hmrReady` means only that the compiler endpoint is available. Treat a browser HMR client as connected only after core emits `runtime.hmr.client-connected` for an authenticated `/rsbuild-hmr` upgrade, and disconnected only from its paired close event; display surface ID/count from those events. Provider listen/start is not client connection evidence.
- Vendor files under `packages/workbench/src/inspector/vendor/` remain byte-identical. Adapt them only from `packages/workbench/src/inspector/adapter/`.
- Browser tests use the repository's existing `@rstest/playwright` pattern and a real foreground server, real separate-origin proxy, and real nested iframe. Do not assert on a mocked iframe, mock bridge, or source text.
- Every task follows strict red -> observe the expected failure -> minimal green -> refactor -> focused green -> commit. Run mutation checks described in each task before committing.

---

## File Structure

### Core/runtime files

- Preserve `packages/agent-bundle/src/dev/mcp-app-binding-service.ts`: it remains the artifact-epoch App binding lane.
- Create `packages/agent-bundle/src/dev/mcp-app-runtime-binding-service.ts`: adapt a non-owning stable runtime-registry session view, retain the originating run vector, validate per-operation vectors, and invalidate runtime bindings by session revision.
- Create `packages/agent-bundle/src/dev/mcp-app-metadata.ts`: clone/partition metadata and produce independent model-visible and App-visible result projections.
- Modify `packages/agent-bundle/src/dev/mcp-app-host-profiles.ts`: add versioned simulation descriptors, normalized standard context, and narrowly supported ChatGPT/Claude overlays.
- Modify `packages/agent-bundle/src/dev/mcp-app-sandbox.ts`: split browser-safe policy declarations from the Node proxy behavior, enforce declared-and-consented permissions, bounds, opaque inner origin, and warnings.
- Modify `packages/agent-bundle/src/dev/mcp-app-bridge.ts`: add the consent-authority contract and gate every privileged App request while retaining fail-closed FIFO behavior.
- Preserve `packages/agent-bundle/src/dev/mcp-app-preview-service.ts`: it remains the artifact-epoch/core-bridge preview lane.
- Create `packages/agent-bundle/src/dev/mcp-app-runtime-preview-service.ts`: compose run lookup, official-bridge browser data, registry subscriptions, runtime binding service, host profile, resource validation, consent challenges, and binding-scoped operations.
- Modify `packages/agent-bundle/src/dev/mcp-app-routes.ts`: preserve merged `/api/mcp/*` artifact routes and add a discriminated `/api/runtime/apps*` adapter over opaque identifiers and a closed operation union.
- Create `packages/agent-bundle/src/dev/runtime-mcp-routes.ts`: manual development routes over the stable runtime MCP registry; the App preview never uses its open/restart/delete endpoints.
- Modify `packages/agent-bundle/src/dev/foreground-server.ts`: extend its one landed `#mcpAppRoutes`/`ForegroundServerOptions.mcpAppPreviews` composition with runtime dispatch and mount manual runtime MCP control routes beside it; do not construct a second App route owner.
- Modify `packages/agent-bundle/src/dev/workbench-server.ts`: extend the landed `DeferredMcpAppPreviewService`, `McpAppLifecycle`, `closeDevServerLifecycle`, and post-listener startup unwind; reuse the existing artifact sandbox/route ownership and `DevServerStartError` failure retention while adding optional runtime previews/client-surface proxy bindings without another lifecycle.
- Modify `packages/agent-bundle/src/dev/index.ts`: export only the serializable preview service/route contracts needed by tests and Workbench integration.

### Workbench files

- Modify `packages/workbench/src/mcp/mcp-route-client.ts`: keep its authentication, finite-JSON parsing, and diagnostics scoped to artifact/runtime Inspector session control and manual runtime RPC. App preview create/get/operate/consent/close routes and authentication extend the landed `packages/workbench/src/mcp/mcp-app-client.ts`; `McpRouteClient` never owns or invokes them.
- Modify `packages/workbench/src/mcp/agent-bundle-remote-transport.ts`: extract/reuse its closed JSON-RPC method mapping for an attached App binding; preserve existing artifact-session transport and manual Inspector behavior.
- Modify `packages/workbench/src/mcp/mcp-session-model.ts`: add a discriminated runtime binding/revision lane without weakening merged immutable snapshot/redaction/lifecycle behavior.
- Modify `packages/workbench/src/mcp/mcp-session-controller.ts`: extend the one merged controller with runtime open/restart/close/rpc adapters; do not create another controller.
- Modify `packages/workbench/src/mcp/mcp-page.tsx`: preserve the landed `appPreviewClient`, `McpPageAppPreviewSource`, `supportedMcpAppPreviewProfiles`, `mcpAppPreviewSourceFor`, profile/history controls, and page-owned preview slot/close ordering; add runtime/artifact source selection, revision/vector evidence, and closed runtime operation availability inside that composition.
- Modify `packages/workbench/src/mcp/mcp-page.css`: extend the landed `.mcp-page-app-controls`, `.mcp-page-app-preview`, and `.mcp-page-app-fallback` placement/mobile rules with source/revision evidence; do not add another preview container.
- Preserve `packages/workbench/src/inspector/adapter/inspector-session-adapter-entry.ts`, `inspector-session-adapter-fixture.tsx`, `tsconfig.json`, `vendor-react-runtime.{d.ts,jsx}`, and `vendor-screens.{d.ts,jsx}`: keep the sole compatibility entry, byte-preserved vendor boundary, production fixture, and isolated typecheck; runtime support must not create another entry/shim/fixture.
- Modify `packages/workbench/src/inspector/adapter/inspector-session-adapter.tsx`: reuse the landed Inspector presentation as the sole catalog/protocol/logging binding around the current controller/model, with explicit runtime operation availability.
- Modify `packages/workbench/src/inspector/adapter/inspector-session-adapter-model.ts`: extend binding keys and immutable trace/log projections for discriminated runtime session revisions.
- Modify `packages/workbench/src/inspector/adapter/inspector-session-adapter.css`: extend the landed adapter-owned scope only for runtime unavailable/evidence states; do not duplicate vendor or Mantine presentation styles.
- Modify `packages/workbench/src/project-client.ts`: publish parsed, ordered project events to subscribers over its one existing `/api/project/events` connection, including replay-gap fail-closed delivery.
- Modify `packages/workbench/src/runtime-model.ts`: retain runtime-App invalidation/replay-gap diagnostics and revoked binding evidence for the Playground reducer.
- Modify `packages/workbench/src/mcp/mcp-app-client.ts`: add discriminated runtime App methods to the landed credential-memory-only client; preserve its null-prototype finite-JSON clone, opaque segments, distinct proxy-origin validation, structured diagnostics, canonical close shape, and authentication forgetting.
- Modify `packages/workbench/src/mcp/mcp-app-frame.tsx`: preserve the landed artifact `McpAppFrameRelay` and reuse its frame-policy enforcement primitives for the runtime AppRenderer barrier; do not create a second frame relay or lifecycle owner.
- Create `packages/workbench/src/inspector/adapter/runtime-app-bridge.ts`: instantiate the public Ext Apps `AppBridge`, `PostMessageTransport`, CSP wrapper, host context, and consent callbacks without changing vendor source.
- Modify `packages/workbench/src/mcp/mcp-app-preview.tsx`: preserve the landed artifact preview/controller and add a discriminated official-runtime branch with simulation/profile state, fallback result, metadata inspector, consent dialog, diagnostics, and teardown.
- Modify `packages/workbench/src/mcp/mcp-app-preview.css`: extend the landed preview-owned selectors for runtime profile/evidence/consent states; do not create another preview stylesheet or move them into global shell CSS.
- Modify `packages/workbench/src/runtime-playground.tsx`: backward-compatibly augment the pre-existing `RuntimeAppPreviewProps`/`RuntimePlaygroundProps` seam with the optional narrow lifecycle registrar and pass `McpAppPreview` through `renderAppPreview`.
- Modify `packages/workbench/src/runtime-stage.tsx`: forward the optional lifecycle registrar verbatim into the one `RuntimeAppPreviewRenderer` invocation; do not retain a handle or add cleanup ownership in the stage.
- Modify `packages/workbench/src/main.tsx`: install the renderer dependency without changing non-runtime navigation.
- Modify `packages/workbench/src/styles.css`: add only shell placement/mobile layout for the preview using existing Workbench tokens; component profile/consent/fallback styles remain in `mcp/mcp-app-preview.css`.
- Modify `packages/workbench/src/inspector/adapter/closure-spike.ts`: export the exact `AppRenderer`, `AppRendererHandle`, and host-context helpers used by the adapter; do not export `AppsScreen` as the preview shell.
- Modify `packages/workbench/tsconfig.json`: extend the explicit allowlist with the landed preview source/test and every new host module/test; add no special Inspector-runtime config test.

### Tests

- Modify `packages/agent-bundle/tests/mcp-app-binding-service.test.ts` only to pin the unchanged artifact lane.
- Create `packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts`.
- Create `packages/agent-bundle/tests/mcp-app-metadata.test.ts`.
- Modify `packages/agent-bundle/tests/mcp-app-host-profiles.test.ts`.
- Modify `packages/agent-bundle/tests/mcp-app-sandbox.test.ts`.
- Modify `packages/agent-bundle/tests/mcp-app-bridge.test.ts`.
- Modify `packages/agent-bundle/tests/mcp-app-preview-service.test.ts` only to pin the unchanged artifact lane.
- Create `packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts`.
- Modify `packages/agent-bundle/tests/mcp-app-routes.test.ts`.
- Create `packages/agent-bundle/tests/runtime-mcp-routes.test.ts`.
- Modify `packages/agent-bundle/tests/dev-workbench.test.ts`: preserve the landed artifact App origin/lifecycle/cleanup-order coverage and add runtime-only composition assertions.
- Modify `packages/workbench/tests/agent-bundle-remote-transport.test.ts`.
- Modify `packages/workbench/tests/mcp-session-model.test.ts`.
- Modify `packages/workbench/tests/mcp-session-controller.test.ts`.
- Modify `packages/workbench/tests/mcp-page.test.ts`: preserve the landed successful-tool source derivation and exact portable/chatgpt/claude picker/history entry point; add runtime selection and single-slot close-order assertions.
- Modify `packages/workbench/tests/mcp-page-app-browser.test.ts`: preserve its landed Apps-v2 page lifecycle case/fixture and add runtime selection to the same built-page browser harness; do not create another page-preview browser file or helper.
- Modify `packages/workbench/tests/inspector-session-adapter.test.ts`.
- Modify `packages/workbench/tests/project-client.test.ts`.
- Modify `packages/workbench/tests/runtime-model.test.ts`.
- Modify `packages/workbench/tests/mcp-app-client.test.ts`.
- Modify `packages/workbench/tests/mcp-app-frame.test.ts`.
- Create `packages/workbench/tests/runtime-app-bridge.test.ts`.
- Modify `packages/workbench/tests/mcp-app-preview.test.ts`: preserve the landed artifact lifecycle, transactional JSON detachment, strict canonical-profile, race-safe cleanup, immutable error fallback, and credential-free iframe cases; add runtime-only cases in the same file.
- Modify `packages/workbench/tests/mcp-app-preview-browser.test.ts`: extend its one landed Chrome-mounted preview fixture with runtime-only cases while preserving artifact iframe/fallback/unmount/mobile/page-error coverage.
- Modify `packages/workbench/tests/runtime-stage.test.ts`: pin exact optional registrar forwarding to the renderer without stage-owned lifecycle state.
- Modify `packages/workbench/tests/runtime-playground.test.ts`: pin close-before-commit handoff ordering and rejection behavior without a wrapper/controller.
- Preserve and run `packages/workbench/tests/inspector-session-adapter-fixture.test.ts` unchanged as the production-build compatibility regression.
- Preserve and run `packages/workbench/tests/inspector-shell.e2e.test.ts` unchanged as the sole dedicated live Inspector shell/controller/browser flow.
- Preserve and run `packages/workbench/tests/rsbuild-workbench.test.ts` unchanged as the standard config/asset gate.
- Modify `packages/workbench/tests/overview.e2e.test.ts`: extend the landed real MCP Playground browser fixture with runtime Apps/profile/isolation cases; do not create a second browser fixture file.
- Modify `packages/workbench/tests/rsbuild-closure.test.ts`.

---

### Task 1: Make App Bindings Revision-Stable and Split Result/Metadata Visibility

**Files:**
- Create: `packages/agent-bundle/src/dev/mcp-app-runtime-binding-service.ts`
- Create: `packages/agent-bundle/src/dev/mcp-app-metadata.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-binding-service.test.ts`
- Create: `packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts`
- Create: `packages/agent-bundle/tests/mcp-app-metadata.test.ts`

**Interfaces:**
- Consumes: `RuntimeVector`, `DevRuntimeMcpAppRunBinding`, `DevRuntimeMcpSessionView` (`snapshot()`, `execute()`, atomic `watchClosed()`), and `DevRuntimeMcpOperationResult`. The preview service supplies these only after resolving stored run evidence; none are parsed from browser JSON.
- Produces:

```ts
export type McpAppProfileId = 'portable' | 'chatgpt' | 'claude';

export interface McpAppStableSessionIdentity {
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly registryRevision: number;
  readonly target: string;
  readonly serverName: string;
  readonly definitionDigest: string;
  readonly transportDigest: string;
  readonly serverDigest: string;
}

export interface McpAppPreviewBindingVector extends McpAppStableSessionIdentity {
  readonly runVector: RuntimeVector;
  readonly profileId: McpAppProfileId;
  readonly profileVersion: string;
  readonly evidence: 'simulated';
}

export interface McpAppRuntimeBindingSnapshot extends McpAppPreviewBindingVector {
  readonly id: string;
}

export interface McpAppBoundOperationResult {
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly value: McpAppJsonValue;
  readonly vector: RuntimeVector;
}

export interface McpAppResultInspection {
  readonly appVisible: McpAppJsonValue;
  readonly isError: boolean;
  readonly modelVisible: McpAppJsonValue;
}

export interface McpAppMetadataInspection {
  readonly raw: Readonly<Record<string, McpAppJsonValue>>;
  readonly standard: Readonly<{ readonly ui?: McpAppJsonValue }>;
  readonly extensions: Readonly<{
    readonly openai: Readonly<Record<string, McpAppJsonValue>>;
    readonly claude: Readonly<Record<string, McpAppJsonValue>>;
  }>;
  readonly provenance: Readonly<Record<string, 'standard' | 'openai-extension' | 'claude-extension' | 'unclassified'>>;
}

export interface McpAppResourceMetadataInspection {
  readonly merged: McpAppMetadataInspection;
  readonly provenance: Readonly<Record<string, 'listed' | 'read' | 'both-identical' | 'read-overrode-listed'>>;
  readonly warnings: readonly string[];
}

export const inspectMcpAppMetadata: (value: unknown) => McpAppMetadataInspection;
export const mergeMcpAppResourceMetadata: (listed: unknown, read: unknown) => McpAppResourceMetadataInspection;
export const projectMcpAppResult: (value: unknown) => McpAppResultInspection;
export const selectMcpAppResourceReference: (metadata: unknown) =>
  | Readonly<{ readonly uri: string; readonly provenance: 'modern' | 'legacy' | 'modern-overrode-legacy'; readonly warnings: readonly string[] }>
  | undefined;
```

Create distinct internal `McpAppRuntimeBinding` and `McpAppRuntimeBindingService` types, plus the serializable `McpAppRuntimeBindingSnapshot` above; do not remove `epochId` or change `McpAppBinding` in the merged artifact lane. `CreateMcpAppRuntimeBindingOptions` receives a server-created `runVector`, stored `runBinding`, non-owning `DevRuntimeMcpSessionView`, and profile ID, but no independent session or digest fields. Keep the non-owning view and provider/state authority only in a private service map; snapshot projection is an explicit whitelist. The runtime service converts `DevRuntimeMcpOperationResult` to `McpAppBoundOperationResult` only after checking `sessionId` and `sessionRevision`. Closing it drops only runtime-App state; the non-owning view exposes no `close()`.

- [ ] **Step 1: Write failing visibility, identity, and operation-vector tests**

Add literal `CallToolResult` fixtures proving `_meta`, unknown `vendorPrivate`, and `isError` are absent from `modelVisible`; App-visible retains the full result; `inspection.isError` preserves protocol control separately; and validated image/audio/resource-link blocks plus `structuredContent` are unchanged. Reject malformed values before projection. Add raw/standard/vendor metadata partition fixtures.

Test resource URI selection for nested modern, flat legacy, identical both, conflicting both, and vendor selector alone. Conflicting both selects nested modern and emits a warning containing neither secret nor executable content. Test resource metadata merge with listed CSP and read CSP/permissions: read wins per field and provenance names each source/override. Separately test `ui.visibility` on tool definitions; a resource-level visibility field is preserved as metadata but never used to hide/show the resource.

Create the runtime fixture from the demo's `render_edit_timeline` tool and `ui://rsc-agent-runtime/edit-timeline-v1.html`, with `vector.runtimeGenerationId='g7'` and `app.mcpBinding={sessionId:'mcp-1',sessionRevision:3,registryRevision:8,definitionDigest:'definitions-a',transportDigest:'transport-a',serverDigest:'server-a',serverName:'rsc-agent-runtime',target:'portable'}`. Make the live snapshot add provider/state IDs for internal authority checks, then assert neither is present in the binding/snapshot JSON. Assert exact evidence/discrimination, resource read on `g7`, implementation-only tool call on `g8`, immutable originating vector, and rejection/closure for a returned revision 4.

Add invalidation tests that close every runtime binding matching `{sessionId:'mcp-1',sessionRevision:3}` exactly once, leave revision 4 and unrelated sessions open, clear every retained non-owning view even when one teardown callback fails, and never call a session close method. Cover `watchClosed()` returning `{closed:true}` during creation, closing immediately after atomic listener registration, explicit manual DELETE, and full broker shutdown. Keep `McpSessionService.acquireAppLease()` and its artifact tests unchanged; do not invent a second App-access lease/controller for runtime views.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
npm test -- packages/agent-bundle/tests/mcp-app-metadata.test.ts packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts packages/agent-bundle/tests/mcp-app-binding-service.test.ts
```

Expected: FAIL because the metadata and runtime-binding modules do not exist; the merged artifact-binding regression remains PASS.

- [ ] **Step 3: Implement immutable projections and runtime-derived binding identity**

Implement recursive finite-JSON validation/cloning once. `projectMcpAppResult` constructs transcript data from only `content`/`structuredContent`, returns `isError` separately, and does not project by deleting `_meta`. Partition namespaces without rewriting. `selectMcpAppResourceReference` accepts modern/legacy, always prefers nested modern, warns on disagreement, and ignores vendors. Resource merge uses read precedence/provenance; tool visibility is evaluated only by the tool normalizer.

Implement `McpAppRuntimeBindingService.createBinding` against `DevRuntimeMcpSessionView`: compare complete run/snapshot evidence, atomically register `watchClosed()` before publication, and assemble the runtime binding only from verified evidence. Its idempotent release unsubscribes and drops the non-owning view; it never closes the session. Reuse exported canonical-tool/resource/finite-JSON helpers without mutating artifact behavior. Add `invalidateBindings()` and serialize invalidation with in-flight runtime work.

For every operation, pass `expectedSessionRevision: binding.sessionRevision`, verify the returned operation identity before exposing `value`, and freeze the returned vector. Do not compare the returned vector to `runVector`; a later implementation generation is valid when the stable revision is unchanged.

- [ ] **Step 4: Run focused tests and mutation checks**

Run the Step 2 command. Expected: PASS. Confirm a named assertion fails for each mutation: alter artifact binding behavior; accept a browser digest; allow `_meta`/unknown root fields into `modelVisible`; treat `openai/outputTemplate` as standard; prefer list metadata over read; treat resource-level `ui.visibility` as a gate; ignore tool-level `ui.visibility`; remove image content; expose `close()` on the non-owning view; accept a mismatched operation revision; overwrite the originating run vector.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/dev/mcp-app-runtime-binding-service.ts packages/agent-bundle/src/dev/mcp-app-metadata.ts packages/agent-bundle/tests/mcp-app-binding-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts packages/agent-bundle/tests/mcp-app-metadata.test.ts
git commit -m "feat(dev): bind MCP Apps to stable runtime sessions"
```

---

### Task 2: Define Honest, Versioned Portable, ChatGPT, and Claude Profiles

**Files:**
- Modify: `packages/agent-bundle/src/dev/mcp-app-host-profiles.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-host-profiles.test.ts`

**Interfaces:**
- Consumes: `MCP_APP_PROTOCOL_VERSION = '2026-01-26'`, `McpAppMetadataInspection`, standard `McpAppHostContextInput`, and the existing safe canonical-public-HTTPS Claude domain derivation.
- Produces:

```ts
export interface McpAppProfileDescriptor {
  readonly id: McpAppProfileId;
  readonly label: 'Portable MCP Apps' | 'ChatGPT Simulation' | 'Claude Simulation';
  readonly version:
    | 'agent-bundle:mcp-apps:2026-01-26'
    | 'agent-bundle:chatgpt-sim:1'
    | 'agent-bundle:claude-sim:1';
  readonly evidence: 'simulated';
  readonly claimsRealHostParity: false;
}

export const MCP_APP_PROFILE_DESCRIPTORS: Readonly<Record<McpAppProfileId, McpAppProfileDescriptor>>;

export interface McpAppProfileBootstrap {
  readonly kind: 'none' | 'chatgpt-widget-state-v1';
  readonly script: string | undefined;
}

export interface McpAppAppsHostProfile {
  readonly kind: 'apps';
  readonly descriptor: McpAppProfileDescriptor;
  readonly hostContext: McpAppHostContext;
  readonly permissions: McpAppHostPermissions;
  readonly bootstrap: McpAppProfileBootstrap;
  readonly metadata: McpAppMetadataInspection;
  readonly resourceUri: string;
  readonly warnings: readonly string[];
}

export interface McpAppFallbackHostProfile {
  readonly kind: 'fallback';
  readonly descriptor: McpAppProfileDescriptor;
  readonly permissions: McpAppHostPermissions;
  readonly reason: 'apps-resource-invalid' | 'apps-resource-unavailable' | 'unsafe-capability-declaration';
  readonly warnings: readonly string[];
}

export type McpAppHostProfileResolution = McpAppAppsHostProfile | McpAppFallbackHostProfile;
```

- [ ] **Step 1: Write the profile presence/absence matrix first**

Use a table with literal expectations:

```ts
const cases = [
  ['portable', undefined, 'none', undefined],
  ['chatgpt', undefined, 'chatgpt-widget-state-v1', undefined],
  ['claude', { publicMcpUrl: 'https://mcp.weather.example/v1' }, 'none', '5b1bc18b3cdb31bee3b9a12490be07ec.claudemcpcontent.com'],
] as const;
```

For every row assert `evidence === 'simulated'`, `claimsRealHostParity === false`, and label contains `Simulation` except portable. Resolve otherwise identical fixtures with two different user-agent strings and assert identical capabilities/extensions. Assert the ChatGPT bootstrap is fixed dormant framework code, no profile resolver creates a browser global, no `window.claude` bootstrap exists, and a malformed/private/local Claude URL produces a warning/no expected domain. For Claude, canonicalize the full public MCP URL, hash its exact UTF-8 serialization with SHA-256, take the first 32 lowercase hex characters, and append `.claudemcpcontent.com`; path/query changes change the derived domain, while equivalent default-port/URL spellings canonicalize identically. Compare a declared `Resource._meta.ui.domain` to the derived value: retain both/provenance and warn on mismatch, never silently replace. Keep both values in resource metadata inspection only; neither may occur in `hostContext`, iframe origin, CSP, or local proxy configuration. Raw vendor metadata cannot make an invalid standard resource valid. The synchronous browser behavior belongs to Task 6's real Chromium test, not this Node test.

- [ ] **Step 2: Run the focused profile test and observe RED**

Run:

```bash
npm test -- packages/agent-bundle/tests/mcp-app-host-profiles.test.ts
```

Expected: FAIL because the current resolution has no descriptor/version/evidence/bootstrap contract.

- [ ] **Step 3: Implement the frozen registry and narrow overlays**

Keep portable host context and warnings common to all profiles. Return a fixed, dormant ChatGPT bootstrap for the ChatGPT simulation descriptor; it exposes nothing until Task 5's Workbench-local feature owner explicitly activates it over the closed bootstrap channel. Once activated, it defines getter-backed `widgetState` and synchronous `setWidgetState(next)`: validate/clone `next`, assign locally before returning, enqueue one closed host persistence request, and roll back/report on rejection. It returns `void`, never a promise. It never activates from raw metadata, user agent, or a browser-supplied create field. A representative fixed shape is:

```ts
const chatGptBootstrap = (): McpAppProfileBootstrap => Object.freeze({
  kind: 'chatgpt-widget-state-v1',
  script: fixedDormantBootstrap,
});
```

`fixedDormantBootstrap` is Agent Bundle-owned code inserted before untrusted App code; activation data arrives only as finite JSON over the binding-scoped bridge, so script terminators/control text cannot escape. Never interpolate metadata keys or executable strings. The Claude overlay returns `{declaredDomain, expectedDomain, provenance:'sha256-canonical-full-mcp-url'}` only inside resource metadata inspection. `expectedDomain` is exactly `sha256(canonicalFullMcpUrl).hex.slice(0, 32) + '.claudemcpcontent.com'`; never use the URL hostname, never copy either domain into `McpAppHostContext`, and do not create a Claude global. Preserve public-host/IP rejection, canonical URL checks, and declared-versus-derived mismatch warnings.

- [ ] **Step 4: Run the test and mutation checks**

Run the Step 2 command. Expected: PASS. Confirm tests fail if: portable gets a vendor global; ChatGPT enables from raw metadata alone; Claude accepts localhost/credentials/hash, uses the URL hostname instead of the 32-hex SHA-256 prefix, hashes a noncanonical spelling, ignores path/query, accepts a declared/derived domain mismatch silently, or copies either domain into host context; evidence becomes `observed`; a wildcard permission is granted.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/dev/mcp-app-host-profiles.ts packages/agent-bundle/tests/mcp-app-host-profiles.test.ts
git commit -m "feat(dev): add versioned MCP App host simulations"
```

---

### Task 3: Harden the Sandbox and Extract Shared Bridge Security Contracts

**Files:**
- Modify: `packages/agent-bundle/src/dev/mcp-app-sandbox.ts`
- Modify: `packages/agent-bundle/src/dev/mcp-app-bridge.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-sandbox.test.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-bridge.test.ts`

**Interfaces:**
- Consumes: `McpAppHostProfileResolution.permissions`, fixed profile bootstrap, binding-scoped bridge operations, and existing `createMcpAppSandboxProxy`, `createMcpAppSandboxFrame`, `createMcpAppSandboxBridge`, and pure validation/resource parsing inside `mcp-app-bridge.ts`.
- Produces:

```ts
export type McpAppConsentCapability =
  | 'call-tool'
  | 'download-file'
  | 'open-external-link'
  | 'clipboard-write'
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'request-display-mode';

export interface McpAppConsentRequest {
  readonly capability: McpAppConsentCapability;
  readonly summary: string;
  readonly details: McpAppJsonValue;
  readonly scope: 'action' | 'document';
}

export interface McpAppConsentGrant {
  readonly challengeId: string;
  readonly bindingId: string;
  readonly capability: McpAppConsentCapability;
  readonly scope: 'action' | 'document';
  readonly authorizationId: string;
}

export interface McpAppSandboxWarning {
  readonly code: 'csp-source-rejected' | 'csp-wildcard-rejected' | 'permission-not-consented';
  readonly value: string;
}

export interface McpAppSandboxInternalSources {
  readonly origin: string;
  readonly webSocketPath: '/rsbuild-hmr';
  readonly provenance: 'compiler-internal';
}

export interface McpAppDocumentPolicySnapshot {
  readonly revision: number;
  readonly allow: string;
  readonly approvedPermissions: McpAppSandboxPermissions;
  readonly warnings: readonly McpAppSandboxWarning[];
}

export interface McpAppValidatedDownload {
  readonly contents: readonly McpAppJsonValue[];
  readonly itemCount: number;
  readonly embeddedBytes: number;
}

export interface McpAppParsedResource {
  readonly html: string;
  readonly csp?: McpAppSandboxCsp;
  readonly permissions?: McpAppSandboxPermissions;
  readonly metadata: McpAppResourceMetadataInspection;
}

export interface McpAppFailClosedSender<Message> {
  readonly blockedAttempts: number;
  readonly closed: boolean;
  send(message: Message): Promise<boolean>;
  close(): void;
}
```

- [ ] **Step 1: Write failing security behavior tests**

Extend sandbox tests with a real proxy response and derived frame assertions:

```ts
expect(frame.sandbox).toBe('allow-scripts allow-same-origin'); // trusted outer proxy only
expect(proxyDocument).toContain('<iframe id="app" sandbox="allow-scripts"');
expect(proxyDocument).not.toContain('id="app" sandbox="allow-scripts allow-same-origin"');
expect(policy.permissionsPolicy).toBe('camera=(), clipboard-write=(self), geolocation=(), microphone=()');
expect(policy.contentSecurityPolicy).toContain("connect-src https://api.weather.example");
expect(warnings).toEqual([
  { code: 'csp-wildcard-rejected', value: '*' },
  { code: 'csp-source-rejected', value: 'http://127.0.0.1:9000' },
]);
```

In bridge tests, preserve the existing standard lifecycle/resource/result validation suite and `873df5e` regression. Extract its bounded sender and run the same contract against an async transport fixture: three consecutive send errors or queue blocks close once, clear all queued input/result, and prohibit later result delivery; one successful flush resets the consecutive count. Add pure-validator cases for canonical external links, display modes, downloadable content blocks, 20-item/10-MiB bounds, exact Apps MIME/URI, modern/legacy selector provenance, list/read metadata precedence, tool `ui.visibility` filtering, and resource-level visibility preservation without gating.

Add consent fixtures proving tool/link/download/display challenges use `scope:'action'`, while camera/microphone/geolocation/clipboard-write use `scope:'document'`. A document grant returns a new frozen `McpAppDocumentPolicySnapshot`, changes the computed outer `allow`/Permissions Policy only before navigation, and stays fixed until iframe teardown; it is not consumed per API call. If a product later adds a per-write confirmation, test and label it as an Agent Bundle extension distinct from protocol permission. No request creates a challenge implicitly from unvalidated details.

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
npm test -- packages/agent-bundle/tests/mcp-app-sandbox.test.ts packages/agent-bundle/tests/mcp-app-bridge.test.ts
```

Expected: FAIL because rejected-source warnings and the shared privileged-request/resource validators are not exposed.

- [ ] **Step 3: Implement policy normalization and consent-before-side-effect**

Change CSP normalization to return `{ accepted, warnings }`, cap every domain list at 32 entries, and reject wildcard/local/special-IP/noncanonical sources. `deriveMcpAppSandboxPolicy` intersects standard declarations with document-scoped media grants and returns warnings. It may append only the core surface proxy `origin` plus exact WS path passed server-side; never parse internal sources from App metadata/request JSON, and never expose provider upstream. Enforce `MAX_APP_HTML_BYTES = 2_097_152`, 256 KiB/32-message relay bounds, trusted outer `sandbox="allow-scripts allow-same-origin"`, and opaque inner `sandbox="allow-scripts"`.

Add `createMcpAppDocumentPolicySnapshot(revision, declaration, grants, internalSources)`. It canonicalizes and freezes the exact `allow` string, approved document permissions, and warnings once on the server. Revisions start at 1 and advance only after an allowed document-scoped consent; rejected/action consent does not advance them. No route accepts any policy field from request JSON.

Export pure validators which return frozen, finite-JSON request records consumed by the preview service and official browser bridge adapter:

```ts
export const validateMcpAppExternalLink: (value: unknown) => Readonly<{ url: string }> | undefined;
export const validateMcpAppDisplayModeRequest: (value: unknown) => Readonly<{ mode: 'inline' | 'fullscreen' | 'pip' }> | undefined;
export const validateMcpAppDownloadRequest: (value: unknown) => McpAppValidatedDownload | undefined;
export const parseMcpAppResource: (value: unknown, expectedUri: string) => McpAppParsedResource | undefined;
```

Use the SDK content-block shapes already vendored by Inspector. Reject empty download batches, more than 20 items, or more than 10 MiB decoded embedded bytes. External links accept only canonical `http:`/`https:` URLs. Extract `createMcpAppFailClosedSender` and make existing `createMcpAppBridge` delegate its current queue policy to it without changing artifact behavior. Task 5 wraps the official runtime transport with the same primitive; it does not instantiate core bridge lifecycle.

- [ ] **Step 4: Run tests and mutation checks**

Run the Step 2 command. Expected: PASS. Confirm coverage catches: add `allow-same-origin` to inner iframe; accept `*`; omit queue clearing on fail-closed; permit a 21-item download; accept a resource with the wrong URI or MIME type.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-bundle/src/dev/mcp-app-sandbox.ts packages/agent-bundle/src/dev/mcp-app-bridge.ts packages/agent-bundle/tests/mcp-app-sandbox.test.ts packages/agent-bundle/tests/mcp-app-bridge.test.ts
git commit -m "feat(dev): harden MCP App sandbox and consent"
```

---

### Task 4: Add a Run-Bound Runtime Preview Lane and Stable Runtime MCP Routes

**Files:**
- Create: `packages/agent-bundle/src/dev/mcp-app-runtime-preview-service.ts`
- Modify: `packages/agent-bundle/src/dev/mcp-app-routes.ts`
- Create: `packages/agent-bundle/src/dev/runtime-mcp-routes.ts`
- Modify: `packages/agent-bundle/src/dev/foreground-server.ts`
- Modify: `packages/agent-bundle/src/dev/workbench-server.ts`
- Modify: `packages/agent-bundle/src/dev/index.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-preview-service.test.ts`
- Create: `packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts`
- Modify: `packages/agent-bundle/tests/mcp-app-routes.test.ts`
- Create: `packages/agent-bundle/tests/runtime-mcp-routes.test.ts`
- Modify: `packages/agent-bundle/tests/dev-workbench.test.ts`

**Interfaces:**
- Consumes: `DevRuntimeSession.run()`, `DevRuntimeRun.result.app`, `DevRuntimeMcpRegistry.session(sessionId): DevRuntimeMcpSessionView | undefined`, `subscribe()`, `open()`, `restart()`, `closeSession()`, `DevServerSession.openRuntimeClientSurface(surfaceId)`, Tasks 1-3 services, and the landed single-owner chain `ForegroundServerOptions.mcpAppPreviews -> ForegroundServer.#mcpAppRoutes -> DeferredMcpAppPreviewService -> McpAppLifecycle`. Preview uses only the non-owning `session()` view's `snapshot()/execute()`; manual runtime MCP routes own control methods. It does not consume `RuntimeGenerationStore`, raw provider endpoints, a browser-created App session, or a second App route/lifecycle composition.
- Produces:

```ts
export interface McpAppRuntimeRoutePreviewService {
  create(request: CreateMcpAppPreviewRequest): Promise<McpAppPreviewSnapshot>;
  get(bindingId: string): McpAppPreviewSnapshot | undefined;
  operate(bindingId: string, operation: McpAppBindingOperation): Promise<McpAppOperationResponse>;
  createConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse>;
  decideConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse>;
  close(bindingId: string): Promise<void>;
}

export type McpAppBindingOperation =
  | { readonly kind: 'tools/list' }
  | { readonly kind: 'resources/list' }
  | { readonly kind: 'tools/call'; readonly name: string; readonly arguments?: McpAppJsonValue; readonly consentId?: string }
  | { readonly kind: 'resources/read'; readonly uri: string };

export interface CreateMcpAppPreviewRequest {
  readonly runId: string;
  readonly profileId: McpAppProfileId;
  readonly expectedGenerationId: string;
}

export interface McpAppPreviewSessionSnapshot {
  readonly binding: DevRuntimeMcpAppRunBinding;
  readonly connection: DevRuntimeMcpConnectionState;
  readonly state: 'ready';
}

export interface McpAppOperationTrace {
  readonly kind: McpAppBindingOperation['kind'];
  readonly operationId: string;
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly vector: RuntimeVector;
}

export interface McpAppPreviewSnapshotBase {
  readonly binding: McpAppRuntimeBindingSnapshot;
  readonly session: McpAppPreviewSessionSnapshot;
  readonly metadata: Readonly<{
    readonly tool: McpAppMetadataInspection;
    readonly resource: McpAppMetadataInspection;
    readonly result: McpAppMetadataInspection;
  }>;
  readonly result: McpAppResultInspection;
  readonly operations: readonly McpAppOperationTrace[];
}

export interface McpAppPreviewAppsSnapshot extends McpAppPreviewSnapshotBase {
  readonly kind: 'apps';
  readonly clientSurface: Readonly<{
    readonly bootstrapUrl: string;
    readonly origin: string;
    readonly webSocketPath: '/rsbuild-hmr';
  }>;
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
  readonly profile: McpAppAppsHostProfile;
  readonly resource: McpAppParsedResource;
}

export interface McpAppPreviewFallbackSnapshot extends McpAppPreviewSnapshotBase {
  readonly kind: 'fallback';
  readonly profile: McpAppFallbackHostProfile;
}

export type McpAppPreviewSnapshot = McpAppPreviewAppsSnapshot | McpAppPreviewFallbackSnapshot;

export interface McpAppOperationResponse {
  readonly result: McpAppBoundOperationResult;
}

export interface McpAppConsentChallenge {
  readonly id: string;
  readonly bindingId: string;
  readonly capability: McpAppConsentCapability;
  readonly summary: string;
  readonly expiresAt: string;
}

export interface McpAppConsentCreatedResponse {
  readonly challenge: McpAppConsentChallenge;
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
}

export interface McpAppConsentDecisionResponse {
  readonly grant: McpAppConsentGrant | undefined;
  readonly documentPolicy: McpAppDocumentPolicySnapshot;
}

export interface McpAppRuntimeInvalidationDetails {
  readonly bindingId: string;
  readonly reason: 'manual-close' | 'session-closed' | 'session-restarted' | 'restart-failed' | 'registry-replay-gap' | 'runtime-shutdown';
  readonly sessionId: string;
  readonly sessionRevision: number;
  readonly state: 'revoked';
}

export interface McpAppRuntimeInvalidationProjectEvent {
  readonly sequence: number;
  readonly type: 'runtime.event';
  readonly payload: Readonly<{
    readonly type: 'runtime.app.updated';
    readonly details: McpAppRuntimeInvalidationDetails;
  }>;
}
```

Add `readonly runtime?: McpAppRuntimeRoutePreviewService` to the existing `McpAppRoutePreviewService`; do not alter or nest its landed artifact methods. `DeferredMcpAppPreviewService.attach(artifact, runtime?)` remains single-use, forwards artifact methods exactly as today, and exposes the optional runtime getter to the same `McpAppRoutes` instance. `McpAppLifecycle.attach(artifact, runtime?)` is likewise single-use and owns both closeables under the existing `mcp-apps` lifecycle slot.

Routes are fixed:

```text
POST   /api/runtime/apps
GET    /api/runtime/apps/:bindingId
POST   /api/runtime/apps/:bindingId/operations
POST   /api/runtime/apps/:bindingId/consents
POST   /api/runtime/apps/:bindingId/consents/:consentId
DELETE /api/runtime/apps/:bindingId
```

Manual development routes are also fixed and are never called by App preview:

```text
POST   /api/runtime/mcp/sessions
POST   /api/runtime/mcp/sessions/:sessionId/restart
DELETE /api/runtime/mcp/sessions/:sessionId
POST   /api/runtime/mcp/sessions/:sessionId/rpc
```

Open accepts only `DevRuntimeMcpSessionRequest`; restart and delete accept only `DevRuntimeMcpSessionControlRequest {sessionId,expectedSessionRevision}` with the path ID required to match the body; `rpc` accepts only `DevRuntimeMcpOperationRequest` and returns `DevRuntimeMcpOperationResult`. There is no generic JSON-RPC body, upstream transport configuration, or browser-supplied vector/digest. Manual restart preserves `sessionId`/`registryRevision`, increments `sessionRevision`, relists, and publishes the same sequenced invalidation consumed by Apps; restart failure publishes `restart-failed`. Delete closes the broker session through `closeSession()` and invalidates matching Apps before returning.

- [ ] **Step 1: Rewrite the merged service tests around stored run evidence and the stable registry**

Keep the merged `mcp-app-preview-service.test.ts` artifact-epoch bounds, serialization, canonical-resource, core-bridge lifecycle, fallback, teardown, and aggregate-close cases green without rewriting them. Put the runtime cases in `mcp-app-runtime-preview-service.test.ts`. Use a fake `DevRuntimeSession` only at the process boundary; keep the real `McpAppRuntimeBindingService`, metadata projection, profile resolver, resource parser, consent store, and close behavior. Assert:

- `runId` resolves one succeeded run's canonical surface, tool, input, full result, `resourceUri`, and `DevRuntimeMcpAppRunBinding`; the browser cannot replace any of them.
- create input is exactly `{runId,profileId,expectedGenerationId}`; `expectedGenerationId !== run.vector.runtimeGenerationId` rejects before existing-session acquisition.
- the stored run binding must equal the live session snapshot's session/revision/registry/server/target/definition/transport/server digests, and the session must be `ready` with complete negotiated connection data.
- no runtime preview code calls `mcpRegistry.open()`, `restart()`, or `closeSession()`; creation resolves only the non-owning view returned by `session(runBinding.sessionId)`.
- initial tool/resource lists and resource read each return a `DevRuntimeMcpOperationResult`; the snapshot records their actual vectors and merged list/read metadata provenance.
- `openRuntimeClientSurface(run.result.app.surfaceId)` is called server-side and only its proxy bootstrap/origin/fixed WS path is serialized; raw provider origins never appear in JSON, HTML, logs, or browser requests.
- an `implementation-updated` registry message with unchanged definition/transport digests keeps the same session/revision and binding alive, does not reconnect or relist, and the next operation may return a newer vector.
- `sessions-restarted` and `restart-failed` messages close every matching old App binding and consent challenge exactly once. Definition and transport changes each have a dedicated case. A replacement session/revision is never adopted silently.
- every revocation publishes exactly one ordered `runtime.event` with `payload.type:'runtime.app.updated'` and closed `McpAppRuntimeInvalidationDetails`; duplicate close paths do not emit twice and no secret/upstream enters details.
- create, authenticated GET snapshot, consent creation, and consent decision responses contain the current frozen `McpAppDocumentPolicySnapshot`; only an allowed document-scoped decision increments `revision`, while action decisions preserve byte-for-byte policy.
- live invalidation delivered during binding creation cannot be missed; replayed invalidation after service resubscription has the same effect; an out-of-retention `DevRuntimeMcpRegistryReplayGap` closes all bindings, rejects new previews, and emits a diagnostic.
- four concurrent App calls run; a fifth is rejected. At most eight live consent challenges exist; each expires after 30 seconds, is binding-scoped, and is consumed once.
- closing a runtime preview releases its retained view and pending consent but leaves the stable broker session open; a failed release/DELETE retains cleanup state, reports failure, and is retried by explicit close and provider/service shutdown. Provider/service shutdown still attempts every runtime binding revocation. The artifact lane continues to use `McpSessionService.acquireAppLease()` and serialized reentrant close unchanged; a runtime `watchClosed` callback racing shutdown cannot skip, duplicate, or reorder artifact cleanup.

- [ ] **Step 2: Write route tests for authorization and closed shapes**

Extend the merged `mcp-app-routes.test.ts` real HTTP harness rather than creating a parallel runtime App router. Preserve all `/api/mcp/sessions/:id/apps` and `/api/mcp/apps/:id/*` artifact assertions byte-for-byte, including retryable teardown/retained failed cleanup and the `0c48ab1`/`e47c9a3`/`cf54285`/`b614770` contracts: the route returns the service's canonical teardown frame unchanged, never rebuilds it from request `{id,reason}`, emits no frame when uninitialized close returns `true`, and does not complete the first matching acknowledgment until delayed lease release finishes. Wrong and concurrently duplicated acknowledgments resolve false, do not trigger a second release, and do not disturb retry state. After graceful-close timeout, a late first acknowledgment waits afresh for the same underlying release; if its bounded wait also expires, force close remains retryable and the duplicate is still rejected. A release failure leaves the initialized close retryable for force close. Extend the existing `McpAppRoutePreviewService` facade with `readonly runtime?: McpAppRuntimeRoutePreviewService`, leave all artifact methods unchanged, and add `/api/runtime/apps*` cases through that one option/`McpAppRoutes` instance. Every runtime App route, including `GET /api/runtime/apps/:bindingId`, must run exact-origin and same-session authentication before body parsing or binding lookup. Assert a lookup spy stays at zero for missing/wrong Origin or token, successful GET returns a frozen sanitized snapshot with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, no raw upstream/provider/state secret, revoked is 410, and unknown is 404. Oversized/extra/forged fields reject; generation mismatch is 409; and artifact/runtime URLs cannot cross-dispatch. `POST .../consents` accepts only a validated `McpAppConsentRequest` without browser-supplied binding ID, creates one challenge, and returns `{challenge,documentPolicy}` without a side effect. Decision accepts exactly `{decision:'allow-once'|'deny'}` and returns `{grant,documentPolicy}`; an action allow returns one opaque grant bound to challenge/action digest, while a document allow returns the incremented server policy. Re-decision/reuse/expiry/wrong binding and any browser policy field reject. App operations include validated operation identity/vector/value.

Protect the existing `GET /api/project/events` rather than adding an App stream. `/api/project/session` responds with `Cache-Control: no-store` and establishes a host-only `HttpOnly; SameSite=Strict; Path=/api` foreground-session cookie in addition to its existing in-memory mutation token. `ProjectClient.connect()` completes that bootstrap before opening its sole native EventSource. The event route verifies the cookie plus the existing exact same-origin rule (`Origin` match, or omitted only with `Sec-Fetch-Site: same-origin`) before parsing `Last-Event-ID` or subscribing; failures are 403 with `Cache-Control: no-store` and do not call the event hub or runtime binding lookup. Successful SSE uses `Cache-Control: no-store`, preserves `Last-Event-ID` replay, and sends invalidation exactly as `event: runtime.event`, `id: <sequence>`, and JSON data matching `McpAppRuntimeInvalidationProjectEvent`.

For runtime MCP routes, assert exact open/restart/delete/rpc delegation and status mapping: stale registry/session revisions are 409, restarting sessions reject new rpc with 409, unknown sessions are 404, wrong methods are 405, and restart failure returns a phase-safe diagnostic after publishing invalidation. Assert the App fixture performs zero requests to all four runtime MCP control endpoints. Preserve separate `/api/mcp/sessions*` artifact-lane tests unchanged.

- [ ] **Step 3: Run service/routes tests and observe RED**

Run:

```bash
npm test -- packages/agent-bundle/tests/mcp-app-preview-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts packages/agent-bundle/tests/mcp-app-routes.test.ts packages/agent-bundle/tests/runtime-mcp-routes.test.ts packages/agent-bundle/tests/dev-workbench.test.ts
```

Expected: existing artifact preview tests PASS; new runtime preview/route tests FAIL because their modules and registry adapters do not exist.

- [ ] **Step 4: Implement the separate runtime service with provider-owned authority**

Leave `mcp-app-preview-service.ts` and its `bridge`/`receive()`/`takeOutbound()` artifact lifecycle intact. `mcp-app-runtime-preview-service.ts` exposes no core bridge lifecycle; the official browser bridge in Task 5 solely owns runtime `ui/initialize`/input/result/teardown. Reuse exported pure parsing/limit helpers rather than copying the existing manager.

At construction, subscribe to `runtime.mcpRegistry` from the last persisted sequence. Serialize replay and live results with preview creation. For `implementation-updated`, advance only service diagnostics/execution-pointer display. For each `invalidatedBindings` item on `sessions-restarted` or `restart-failed`, call `McpAppRuntimeBindingService.invalidateBindings()` and clear challenges; never wait for browser polling. On replay gap, fail closed, close all runtime bindings, and reject new creation until the runtime service is restarted; artifact bindings are independent.

Inject the provider session's typed `emit` boundary. On the first transition of any runtime binding to revoked, emit nested `runtime.app.updated` details through outer `runtime.event` before removing it from lookup; the existing event hub assigns the strictly increasing outer sequence. Manual DELETE, `watchClosed`, restart invalidation, replay gap, and shutdown share this idempotent path. Publish all revocations before shutting down the project SSE, and await publication before closing proxy/service resources. The existing authenticated project SSE carries it—do not add a polling endpoint or a second EventSource route.

`createPreview` performs checks in this order: validate closed request/profile; load immutable succeeded run; compare expected run generation; require `result.app`; call `mcpRegistry.session(storedSessionId)`; compare every stored binding field with `view.snapshot().binding`; require ready/complete connection; execute canonical lists with expected revision; locate exact App-visible tool/resource; create `McpAppRuntimeBinding` with `run.vector`; read, merge, and validate exact URI/MIME/size/metadata; resolve profile; call `openRuntimeClientSurface(run.result.app.surfaceId)`; expose only proxy bootstrap/origin/fixed WS path; return a frozen snapshot. Close the proxy binding on every failure/revocation. A reconcile between stages must preserve revision or trigger subscribed invalidation before exposure.

Implement explicit `createConsent(bindingId, request)` and `decideConsent(bindingId, challengeId, decision)` under the fixed eight-entry/30-second bounds. Link/download/display grants are action-scoped and consumed by the Workbench immediately before the installed handler. Camera/microphone/geolocation/clipboard-write grants are document-scoped and may only derive the next server-authored `McpAppDocumentPolicySnapshot` for a pre-navigation remount; their UI copy says `Allowed until this preview reloads or closes`. Tool call without consent returns a challenge; retry consumes its grant before `execute()`. The operation switch stays closed, returns `McpAppOperationResponse`, records actual vectors, and preserves App-visible resource restrictions.

- [ ] **Step 5: Mount routes and aggregate lifecycle cleanup**

Open the core runtime client-surface proxy only after a stored run declares an App surface; do not replace or recreate the already-started artifact `McpAppSandboxProxy`. Preserve the landed ownership graph exactly: `ForegroundServer` constructs one `#mcpAppRoutes`; `ForegroundServerOptions.mcpAppPreviews` remains its sole App-service injection; and `DeferredMcpAppPreviewService.attach(artifact, runtime?)` exposes the existing artifact service plus the optional runtime lane through that same facade after the listener reveals the trusted origin. `McpAppRoutes` dispatches `/api/mcp/*` to the existing direct methods and `/api/runtime/apps*` to the facade's optional runtime service. Do not add a second `McpAppRoutes`, a second deferred service, or another foreground App-route option. The manual `RuntimeMcpRoutes` handler is a control surface, not an App preview owner.

Extend the one landed `McpAppLifecycle` to own the artifact previews, optional runtime previews, artifact sandbox, and every runtime client-surface proxy binding. Its idempotent `close()` settles both preview lanes, then closes proxies/sandbox, before `closeDevServerLifecycle` proceeds to MCP sessions/runtime registry and coordinator. Preserve the existing structural `resource:'mcp-apps'` failure and all nested `previews`/`sandbox` causes rather than introducing a parallel aggregate error. Preserve post-listener startup unwind too: if sandbox, runtime service, proxy attachment, or browser-open startup fails, call the same foreground close once; if cleanup also fails, `DevServerStartError.failures` retains the original `{resource:'start'}` cause followed by `{resource:'cleanup'}` rather than masking either. Keep `DevServerTesting.createSandboxProxy`/`startForegroundServer` test-only and retain the public `DevServerStartError`/`DevServerStartFailure` exports from `dev/index.ts`. Mutations reuse `#assertMutationSession`; protected reads use the cookie/token exact-origin authority above. DELETE and server shutdown revoke operations, clear challenges, unsubscribe/close view state, and close runtime proxy bindings; they do not claim browser teardown. A failed backend DELETE remains retryable and retained for later shutdown cleanup, matching the current artifact route invariant. Publish and flush runtime binding invalidation before SSE shutdown so a connected Workbench may tear down its official bridge.

Extend the landed `dev-workbench.test.ts` cases; do not replace their fixture or restate them in a second file. Keep green the real artifact preview on a different origin, 404 isolation for project/MCP APIs at the sandbox origin, explicit preview/session deletion, sandbox shutdown with epoch retention, App-before-session-before-coordinator close order, structural retention of all cleanup failures, and the exact sandbox-start/foreground-cleanup dual-failure `DevServerStartError` order. Add only runtime assertions: no provider means no runtime service/subscription/client-surface port and `/api/runtime/apps` is 404; a configured provider attaches the runtime lane to the same deferred service/lifecycle; each runtime startup stage failure invokes the existing single unwind and retains both startup/cleanup causes; shutdown publishes invalidations, drains both preview lanes and all proxy bindings, then closes sessions/registry/coordinator even when every category fails.

- [ ] **Step 6: Run focused tests and mutation checks**

Run the Step 3 command. Expected: PASS. Confirm assertions fail if artifact preview behavior changes; a browser supplies an App session/digest/vector; preview calls a control method; manual restart does not relist/invalidate; implementation-only edit reconnects; transport change does not restart; invalidation polling replaces subscription; replay gap leaves a binding alive; operation revision is not checked; direct provider upstream is exposed; proxy starts for an ordinary project; cleanup skips either App lane; or a post-listener runtime startup failure masks either its primary cause or the foreground cleanup failure.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-bundle/src/dev/mcp-app-runtime-preview-service.ts packages/agent-bundle/src/dev/mcp-app-routes.ts packages/agent-bundle/src/dev/runtime-mcp-routes.ts packages/agent-bundle/src/dev/foreground-server.ts packages/agent-bundle/src/dev/workbench-server.ts packages/agent-bundle/src/dev/index.ts packages/agent-bundle/tests/mcp-app-preview-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts packages/agent-bundle/tests/mcp-app-routes.test.ts packages/agent-bundle/tests/runtime-mcp-routes.test.ts packages/agent-bundle/tests/dev-workbench.test.ts
git commit -m "feat(dev): serve run-bound MCP App previews"
```

---

### Task 5: Connect the Official App Bridge and Vendored AppRenderer

**Files:**
- Modify: `packages/workbench/src/mcp/mcp-route-client.ts`
- Modify: `packages/workbench/src/mcp/agent-bundle-remote-transport.ts`
- Modify: `packages/workbench/src/mcp/mcp-session-model.ts`
- Modify: `packages/workbench/src/mcp/mcp-session-controller.ts`
- Modify: `packages/workbench/src/mcp/mcp-page.tsx`
- Modify: `packages/workbench/src/mcp/mcp-page.css`
- Modify: `packages/workbench/src/inspector/adapter/inspector-session-adapter.tsx`
- Modify: `packages/workbench/src/inspector/adapter/inspector-session-adapter-model.ts`
- Modify: `packages/workbench/src/inspector/adapter/inspector-session-adapter.css`
- Modify: `packages/workbench/src/project-client.ts`
- Modify: `packages/workbench/src/runtime-model.ts`
- Modify: `packages/workbench/src/mcp/mcp-app-client.ts`
- Modify: `packages/workbench/src/mcp/mcp-app-frame.tsx`
- Modify: `packages/workbench/src/mcp/mcp-app-preview.tsx`
- Modify: `packages/workbench/src/mcp/mcp-app-preview.css`
- Create: `packages/workbench/src/inspector/adapter/runtime-app-bridge.ts`
- Modify: `packages/workbench/src/inspector/adapter/closure-spike.ts`
- Modify: `packages/workbench/src/runtime-playground.tsx`
- Modify: `packages/workbench/src/runtime-stage.tsx`
- Modify: `packages/workbench/src/main.tsx`
- Modify: `packages/workbench/src/styles.css`
- Modify: `packages/workbench/tsconfig.json`
- Modify: `packages/workbench/tests/agent-bundle-remote-transport.test.ts`
- Modify: `packages/workbench/tests/mcp-session-model.test.ts`
- Modify: `packages/workbench/tests/mcp-session-controller.test.ts`
- Modify: `packages/workbench/tests/mcp-page.test.ts`
- Modify: `packages/workbench/tests/mcp-page-app-browser.test.ts`
- Modify: `packages/workbench/tests/inspector-session-adapter.test.ts`
- Modify: `packages/workbench/tests/project-client.test.ts`
- Modify: `packages/workbench/tests/runtime-model.test.ts`
- Modify: `packages/workbench/tests/mcp-app-client.test.ts`
- Modify: `packages/workbench/tests/mcp-app-frame.test.ts`
- Create: `packages/workbench/tests/runtime-app-bridge.test.ts`
- Modify: `packages/workbench/tests/mcp-app-preview.test.ts`
- Modify: `packages/workbench/tests/mcp-app-preview-browser.test.ts`
- Modify: `packages/workbench/tests/runtime-stage.test.ts`
- Modify: `packages/workbench/tests/runtime-playground.test.ts`
- Preserve/run unchanged: `packages/workbench/tests/inspector-session-adapter-fixture.test.ts`
- Preserve/run unchanged: `packages/workbench/tests/inspector-shell.e2e.test.ts`
- Preserve/run unchanged: `packages/workbench/tests/rsbuild-workbench.test.ts`
- Modify: `packages/workbench/tests/rsbuild-closure.test.ts`

**Interfaces:**
- Consumes: Playground plan's provider-neutral `RuntimeProfileOption`, four-field `RuntimeAppPreviewProps { run: DevRuntimeRun; surface: DevRuntimeSurface; profileId: string; profile: RuntimeProfileOption }`, and `RuntimeLiveMcpPageAdapter = {kind:'disabled'} | {kind:'host-owned';render}`; this later host phase owns the backward-compatible optional lifecycle augmentation described below and changes none of those required fields or the adapter union. Also consumes its five-route `WorkbenchScreen` composition (`#overview`, `#skills`, `#mcp`, `#inspector`, capability-gated `#runtime`); Task 4 routes; the Workbench-owned shared MCP controller/model/reset lifecycle; the landed `McpAppClient`, `McpAppFrame`, `McpAppFrameRelay`, `McpAppPreview`, `McpAppPreviewController`, canonical-profile/fallback state, preview CSS, exact route/frame types, and `mcp-page-app-browser.test.ts` built-page fixture/case; the Inspector compatibility entry/fixture/vendor shim cluster; vendored `AppRenderer`, `AppRendererHandle`, `snapshotHostContext`; official `AppBridge`, `PostMessageTransport`, `Client`, and `Transport` types. Runtime code narrows the selected string to `McpAppProfileId`; Playground never imports host-plan types.
- Produces:

```ts
export interface McpAppRuntimeClient {
  createRuntime(request: CreateMcpAppPreviewRequest): Promise<McpAppPreviewSnapshot>;
  getRuntime(bindingId: string): Promise<McpAppPreviewSnapshot>;
  operateRuntime(bindingId: string, operation: McpAppBindingOperation): Promise<McpAppBoundOperationResult>;
  createRuntimeConsent(bindingId: string, request: McpAppConsentRequest): Promise<McpAppConsentCreatedResponse>;
  decideRuntimeConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny'): Promise<McpAppConsentDecisionResponse>;
  currentDocumentPolicy(bindingId: string): McpAppTrustedDocumentPolicy;
  subscribeInvalidations(listener: (details: McpAppRuntimeInvalidationDetails) => void): () => void;
  closeRuntime(bindingId: string): Promise<void>;
}

export interface McpAppTrustedDocumentPolicy {
  readonly bindingId: string;
  readonly snapshot: McpAppDocumentPolicySnapshot;
}

export interface RuntimeAppBridgeOptions {
  readonly client: McpAppClient & McpAppRuntimeClient;
  readonly controller: McpSessionController;
  readonly preview: McpAppPreviewSnapshot;
  readonly installedHandlers: McpAppInstalledHostHandlers;
  readonly requestConsent: (challenge: McpAppConsentChallenge) => Promise<'allow-once' | 'deny'>;
  readonly onTrace: (entry: McpAppBridgeMessage) => void;
  readonly listChanged: Readonly<{ readonly resources: boolean; readonly tools: boolean }>;
  readonly simulationFeatures: McpAppSimulationFeatures;
  readonly persistWidgetState?: (state: McpAppJsonValue) => Promise<void>;
}

export interface McpAppSimulationFeatures {
  readonly chatGptWidgetState: 'disabled' | 'enabled';
}

export interface McpSessionControllerAppAccess {
  readonly client: Client;
  readonly sessionId: string;
  readonly sessionRevision: number;
  close(): Promise<void>;
}

export type McpSessionControllerBinding =
  | Readonly<{ readonly kind: 'artifact'; readonly binding: McpRouteSessionBinding }>
  | Readonly<{ readonly kind: 'runtime'; readonly binding: DevRuntimeMcpAppRunBinding }>;

export interface McpSessionControllerRuntimeRoutes {
  openRuntime(request: DevRuntimeMcpSessionRequest): Promise<DevRuntimeMcpSessionSnapshot>;
  restartRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<DevRuntimeMcpRegistryReconcileResult>;
  closeRuntime(request: DevRuntimeMcpSessionControlRequest): Promise<void>;
  executeRuntime(sessionId: string, request: DevRuntimeMcpOperationRequest): Promise<DevRuntimeMcpOperationResult>;
}

export interface InspectorSessionOperationAvailability {
  readonly prompts: 'available' | 'not-routed';
  readonly resourceTemplates: 'available' | 'not-routed';
  readonly resources: 'available';
  readonly tools: 'available';
}

export interface McpAppInstalledHostHandlers {
  readonly openExternalLink?: (url: string) => Promise<void>;
  readonly downloadFile?: (download: McpAppValidatedDownload) => Promise<void>;
  readonly requestDisplayMode?: (mode: 'inline' | 'fullscreen') => Promise<'inline' | 'fullscreen'>;
}

export interface SecureAppRendererProps {
  readonly bindingId: string;
  readonly bootstrapUrl: string;
  readonly bridgeFactory: BridgeFactory;
  readonly documentPolicy: McpAppTrustedDocumentPolicy;
  readonly rendererProps: Omit<AppRendererProps, 'bridgeFactory' | 'sandboxPath'>;
}

export const createBindingMcpClient: (
  controller: McpSessionController,
  client: McpAppClient & McpAppRuntimeClient,
  preview: McpAppPreviewAppsSnapshot,
) => Promise<McpSessionControllerAppAccess>;
export const createRuntimeAppBridgeFactory: (options: RuntimeAppBridgeOptions) => BridgeFactory;
export const SecureAppRenderer: (props: SecureAppRendererProps) => ReactNode;
export interface RuntimeAppPreviewLifecycle {
  close(): Promise<void>;
}
export type RuntimeAppPreviewLifecycleRegistrar = (
  lifecycle: RuntimeAppPreviewLifecycle,
) => () => void;

// Backward-compatible additions to the Playground-owned interfaces in runtime-playground.tsx.
export interface RuntimeAppPreviewProps {
  readonly profile: RuntimeProfileOption;
  readonly profileId: string;
  readonly registerLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  readonly run: DevRuntimeRun;
  readonly surface: DevRuntimeSurface;
}
export interface RuntimePlaygroundProps {
  readonly registerAppPreviewLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  // Preserve every existing prop unchanged.
}
export interface McpAppRuntimePreviewProps extends RuntimeAppPreviewProps {
  readonly kind: 'runtime';
  readonly client: McpAppClient & McpAppRuntimeClient;
}
export const McpAppPreview: {
  (props: McpAppPreviewProps): ReactNode;
  (props: McpAppRuntimePreviewProps): ReactNode;
};
```

Keep the landed `McpAppPreviewProps`, `McpAppPreviewController`, and no-discriminator artifact call sites compatible. Add only the explicit `kind:'runtime'` overload; the Playground's injected renderer is a thin bound call into that overload, not another component. The Playground phase already owns the four required `RuntimeAppPreviewProps` fields and a `ReactNode` renderer return, so this host phase modifies `runtime-playground.tsx` to add only optional `registerLifecycle`/`registerAppPreviewLifecycle` fields shown above. Existing Playground callers and sentinel renderers compile unchanged. `runtime-stage.tsx` copies `registerAppPreviewLifecycle` to the renderer's `registerLifecycle` field verbatim and never stores, closes, or clears a handle.

The runtime `McpAppPreview` owner creates one stable frozen `RuntimeAppPreviewLifecycle` whose `close()` joins the branch's exact idempotent renderer/bridge/runtime-binding close. In a layout effect, before the handoff control becomes interactive, it calls `props.registerLifecycle?.(handle)` once and retains the returned unregister function; cleanup calls that unregister function and joins `handle.close()`. The registrar's returned function clears only the same registered handle, so a late old cleanup cannot clear a replacement. The owner must register the handle before starting async create/navigation and must not expose `AppRendererHandle`, binding IDs, clients, controllers, or transports. There is no wrapper component, context/global/event side channel, second ref, or extra controller.

This is the later host phase's deliberate refinement of the earlier Playground-only assumption that navigation/unmount cleanup was sufficient: the Playground still owns no lifecycle and its disabled/no-renderer behavior is unchanged, but the enabled host handoff now awaits the owner-emitted handle before committing navigation. That wait joins the sole existing close path; it is not an adapter-owned teardown implementation, retry loop, mutex, or parallel promise chain.

Reuse or extract the landed pure JSON-detachment, canonical-URI, and immutable-fallback helpers inside this same module rather than implementing looser runtime variants. Capture and recursively freeze finite, acyclic, ordinary JSON input/result before any runtime create can observe them. The runtime branch has one shared start promise and one shared close promise; close waits for a pending create, prevents any late ready/error state or navigation, and revokes/releases the exact late-created binding through the runtime close path. A create or official relay failure retains a visible ordinary `preview-error` fallback before cleanup. The runtime branch may enter `ready` only when its server snapshot has `profile.kind === 'apps'`, an exact canonical `ui://` `profile.resourceUri`, and that URI exactly matches the stored run App/resource identity. Missing, legacy-only, mismatched, noncanonical, or host-extension-only profile evidence renders the landed ordinary fallback and performs no AppRenderer navigation. The selected simulation `profileId` is request context, never a replacement for the canonical returned Apps profile.

Extend `ProjectClient` with `subscribeEvents(listener: (event: ProjectEventMessage) => void): () => void`. `connect()` still creates exactly one `/api/project/events` EventSource after the authenticated session bootstrap. Its parser requires the DOM event name, JSON `type`, and safe-integer `sequence` to agree, freezes finite payloads, ignores exact duplicate sequences, and delivers replay then live messages FIFO to a snapshot of listeners. A sequence jump without an explicit `replay.gap`, malformed invalidation, or explicit replay gap is itself delivered as one fail-closed diagnostic before normal status refresh; it is never silently converted to a status-only refresh.

Extend the landed `McpAppClient` in place to implement `McpAppRuntimeClient`; do not create a second App client or move it out of `src/mcp/`. Preserve its one memory-only `/api/project/session` authentication promise, null-prototype recursive finite-JSON detachment (including own `__proto__` keys), opaque path-segment validation, same-browser foreground-origin check, distinct frame target-origin check, structured non-2xx diagnostics, malformed-success classification, canonical single-message close response, and credential forgetting after artifact graceful/force close. Runtime methods use only `/api/runtime/apps*` and separate method names, so the landed artifact `create(sessionId, request)`, `message`, `close(bindingId,{id,reason})`, and `forceClose` contracts remain byte-for-byte compatible. Inject the already-connected `ProjectClient` as an optional runtime-event dependency and register one listener through `subscribeEvents`; open no EventSource. Validate only `runtime.event` messages whose nested payload is exactly `{type:'runtime.app.updated',details:McpAppRuntimeInvalidationDetails}`, deduplicate by outer sequence, then publish matching invalidations. On replay gap invalidate every local runtime App binding. `runtime-model.ts` reduces the same ordered event into frozen `{sequence,bindingId,sessionId,sessionRevision,reason}` evidence for the Playground diagnostic; shutdown unsubscribes the App listener, performs best-effort iframe teardown, drains controller work, closes/retries backend bindings, and only then closes `ProjectClient`.

`McpAppTrustedDocumentPolicy` is an opaque handle created only by the extended `McpAppClient` from a validated runtime create/GET/consent response and registered in a module-local `WeakSet`. The client keeps exactly one current handle per binding. `SecureAppRenderer`, exported from the existing `mcp-app-frame.tsx`, requires both registry membership and identity with that current handle; a copied object, browser-computed `allow`, older revision, changed binding ID, or widened permissions throws before navigation. It reads `snapshot.allow` verbatim and never derives it.

The existing `McpRouteClient` implements `McpSessionControllerRoutes & McpSessionControllerRuntimeRoutes` with its one authentication/session cache; `main.tsx` passes that one object as `controller.routes`. Runtime attach/restart/execute/close enter the controller's existing admission serializer and emit its existing ordered trace/model events. `Workbench` retains one controller and its subscribed `mcpModel` independently of page selection. `McpScreen` renders the landed `McpPage` session controls against that controller; the dedicated sibling `InspectorScreen` renders the sole `InspectorSessionAdapter` against the exact same controller/model. Application code imports the adapter only through `inspector-session-adapter-entry.ts`, which installs `vendor-react-runtime.jsx` before the byte-preserved vendor screens, then Mantine and the one adapter stylesheet. Preserve `vendor-screens.jsx` as the only runtime import boundary, its declarations, the adapter-local `tsconfig.json`, and the real Chrome production fixture; do not import vendor TSX directly or create another Inspector adapter, screen, route, entry, stylesheet, catalog mapper, protocol projection, SDK client, or adapter-local route transport.

Extend `inspectorSessionBindingKey` to the discriminated controller binding: artifact preserves the landed exact `<epochId>\0<target>\0<serverName>` key; runtime is `runtime\0<sessionId>\0<sessionRevision>\0<target>\0<serverName>`. A runtime revision change resets Inspector scroll/UI/action generation, while an implementation-only vector change at the same session revision preserves it. Add `availability: InspectorSessionOperationAvailability` to `InspectorSessionAdapterProps`; runtime passes prompts/templates as `not-routed`, leaves their tabs visibly unavailable, and installs no handler that could invoke an unsupported method. Artifact defaults preserve every landed screen and behavior. Binding-key/action-generation invalidation occurs synchronously during render before an old tool/read/prompt promise can update the new binding.

`McpSessionController.attachApp()` owns creation/connection/closure of the SDK `Client` and attached transport, returns `McpSessionControllerAppAccess`, tracks it for controller shutdown, and never opens/closes the stable backend session. `McpAppPreview`/bridge code does not instantiate `Client`, transport, route client, model, or `InspectorSessionAdapter` directly. `agent-bundle-remote-transport.ts` exports only a pure closed dispatcher reused internally by the existing transport and controller-owned attached transport:

```ts
export interface AgentBundleMcpDispatchResult {
  readonly value: unknown;
  readonly vector?: RuntimeVector;
}

export const dispatchAgentBundleMcpRequest: (
  message: JSONRPCMessage,
  options: Readonly<{
    readonly allowedMethods: ReadonlySet<'tools/list' | 'resources/list' | 'tools/call' | 'resources/read'>;
    readonly connection: McpRouteConnection;
    readonly execute: (operation: McpRouteOperation) => Promise<AgentBundleMcpDispatchResult>;
  }>,
) => Promise<JSONRPCMessage | undefined>;
```

- [ ] **Step 1: Write the closed browser transport tests first**

First extend `agent-bundle-remote-transport.test.ts`, `mcp-session-model.test.ts`, `mcp-session-controller.test.ts`, and `mcp-page.test.ts` to pin merged manual Inspector behavior while adding a discriminated runtime source. Extend the one active `McpSessionController`; do not create a runtime-specific controller. Preserve its serialized single admission, ordered trace replay/live handoff, failed-open cleanup, late-work rejection, cancellation-before-delete, drain-before-close, retryable teardown, idempotent close, and every retained client/transport cleanup cause. In `mcp-page.test.ts`, keep green the landed `supportedMcpAppPreviewProfiles === ['portable','chatgpt','claude']`, successful ready-session `callTool` source derivation, rejection of closed/non-tool/failed invocations, and one profile picker/history `Open App preview` entry point. Pin that there is one `.mcp-page-app-controls` and one `.mcp-page-app-preview` placement, backed by one page lifecycle ref/generation; artifact selection retains the existing `McpPageAppPreviewSource` values and optional-client behavior. Add RED runtime selection cases through that same placement. Prove artifact↔runtime/profile switching and explicit restart/close/reset/controller replacement await or join the active preview close before the next preview/session action; session-ID mismatch and unmount invoke that same close and stale completion cannot remount. No transition may leave two mounted previews or two lifecycle handles.

In `runtime-stage.test.ts` and `runtime-playground.test.ts`, preserve every earlier renderer/sentinel assertion and add the optional registrar without changing the four required `RuntimeAppPreviewProps` fields. Prove `RuntimeStage` forwards the exact registrar identity once to the one renderer call but never invokes, stores, clears, or closes a handle itself. Use a host-composition harness with a fake preview owner that calls `registerLifecycle(handle)` and the real host-owned handoff action: hold `handle.close()` pending and assert selected runtime source and navigation remain unchanged; resolve it and assert event order `close:start`, `close:finish`, `store-selection`, `navigate:mcp`. Reject close and assert no store/navigation; replace the registered handle while the first is pending and assert the stale completion cannot commit. Call the returned unregister and prove it clears only its own handle. This tests the actual optional prop/registrar contract—no wrapper component, global/context/event side channel, or extra controller.

Reuse `mcpPageSessionControls`, `createMcpPageActionSession`, and `mcpPageControllerReplacementState` unchanged: terminal runtime `closed`/`error` hides open/restart, displays cleanup diagnostics, and enables `onResetSession` only when the parent can replace it with a fresh idle controller. Assert replacement happens synchronously during the first render with the new controller, reset never calls `open()` on the terminal instance, no-reset renders the existing unavailable control, and delayed old runtime close/invoke/open/restart completion, rejection, or finalizer cannot clear a fresh binding/new pending action or replace its diagnostic. Runtime manual controls use the exact Task 4 routes and record revisions/vectors without upstream configuration; runtime App attachment enters that same admission lifecycle and performs zero calls to session-create routes.

Extend the landed `inspector-session-adapter.test.ts` rather than creating another Inspector adapter test. Preserve its current assertions unchanged: JSON-RPC direction derives from message shape while origin remains transport direction; timestamps/sequences and the exact artifact binding key stay immutable; every valid JSON-RPC frame enters the interactive Protocol presentation; all five bounded screens render through `vendor-screens.jsx`; the Agent Bundle Mantine theme remains adapter-owned; and tool callbacks use the passed controller. Preserve the required function-valued `onReplay` and `onSetLevel` props: invoke each in the unit boundary, assert the exact local unavailable diagnostic appears, and assert controller invocation, route-client calls, and transport sends remain zero. These callbacks satisfy the vendor screen contract but are not protocol-replay or `logging/setLevel` operation handlers. Keep the existing `tools/call` request assertion as the explicit replayable-method regression: its request, response, direction, transport origin, sequence, timestamp, and payload remain visible and unchanged in the presentation, `model.timeline.entries`, and `onExportTrace` input. Keep `inspector-session-adapter-fixture.test.ts` green to prove the compatibility global loads before actual vendor screens, production CSS is emitted, the Protocol wrapper exposes no Replay control, embedded Logging exposes no Set Active Level control, and all five screens mount in real Chrome. Add only runtime-extension cases: runtime binding keys prove implementation-only vector updates preserve Inspector state and session-revision changes reset it; source availability leaves unrouted screens visible-but-disabled; and old-revision async results are suppressed. Assert `Workbench` supplies `McpScreen`/`McpPage` and sibling `InspectorScreen` with the same controller, while `InspectorScreen` receives that controller's subscribed model; tool/resource actions call that controller once, unavailable runtime prompt/template controls issue zero calls, and MCP → Inspector → Runtime → Inspector → MCP navigation neither opens/closes/resets nor replaces controller/model/history. No runtime code may duplicate the compatibility entry, vendor shims, fixture, Mantine/style imports, route, or presentation markup.

Keep all three landed `inspector-shell.e2e.test.ts` cases byte-for-byte green. Direct `#inspector` must select the Inspector navigation item, show the heading, five screen tabs, and `Negotiated protocol: Not negotiated`, issue zero MCP-session POSTs, and report no page errors. Its live case must open exactly one portable fixture session from `#mcp`, carry the negotiated identity into the sibling Inspector, execute `Echo: inspector`, show the fixture Resource and Prompt, retain ascending Protocol sequences containing `tools/call` and `inspector`, show `echo inspector` in Logging, close and reset only after returning to MCP, return Inspector to `Not negotiated`, keep exactly one session POST, avoid page errors, and remain horizontally bounded at 390×844. The development-mode case must build through the ordinary Rsbuild `--mode development` path, mount direct Inspector, and prove the emitted shared React chunk contains `react.development.js` with no page error. Runtime tests may assert shared identity across the fifth route but must not clone this project builder or journey.

In `project-client.test.ts`, prove the authenticated bootstrap precedes one EventSource, outer event sequence is FIFO, duplicates do not redeliver, explicit replay gap and unexplained sequence gap are observable before status refresh, subscriber exceptions do not break other subscribers, and close prevents late delivery. In `mcp-app-client.test.ts`, feed those events through the real `ProjectClient.subscribeEvents` seam: only valid nested `runtime.app.updated` details notify matching subscribers, replay gap closes all bindings, unsubscribe works, malformed details fail closed, and the EventSource factory is called once. In `runtime-model.test.ts`, assert exact sequence/binding/session revision/reason evidence and no raw metadata/upstream retention. Exercise the controller-owned attached App client and prove zero App calls to all session-create/control routes.

- [ ] **Step 2: Write real renderer/component tests**

Use `.test.ts` files because the root Rstest pattern ignores TSX-suffixed tests. Mount the built Workbench in Chromium through `@rstest/playwright` (or the repository's explicit Chrome harness), so React effects, nested frames, `postMessage`, focus, and policy attributes are real. Do not substitute static markup for bridge/lifecycle assertions.

First extend the landed `mcp-app-preview.test.ts`; do not replace its fake client/controller seam or create another preview unit file. Keep all five `95271ff` cases green: malformed/noncanonical `ui:` spellings never mount; input/result are deep-detached and recursively frozen before create observes caller mutation while cyclic/non-finite JSON fails before create; close waits for a pending create, force-closes the exact late binding, and leaves loading state unpublished; create and relay errors expose the ordinary immutable `preview-error` fallback and a rejecting custom relay still force-closes; and the SSR-safe loading/credential-free iframe boundary remains intact. Add focused artifact RED assertions for the remaining landed source invariants—non-ordinary objects fail before create, repeated start/close return their shared work and execute once, and subscriber exceptions cannot interrupt cleanup—rather than merely relying on implementation inspection. Add RED runtime-overload counterparts proving the artifact props/controller remain unchanged; runtime uses only `createRuntime`/`closeRuntime` and the official AppRenderer path; the artifact `create`/relay factory receive zero runtime calls; caller mutation cannot change the runtime request/fallback; repeated starts create once; close joins a pending create and revokes/releases its late binding without a state commit or navigation; and runtime create/relay errors retain the ordinary fallback while cleanup remains retryable. `ready` requires returned `profile.kind:'apps'` plus a canonical `ui://` `resourceUri` exactly matching the stored run/resource URI. Portable, ChatGPT, and Claude simulation snapshots must all retain that canonical standard profile; extension metadata may add inspection rows but a missing/mismatched/noncanonical URI or extension-only/legacy profile uses the landed ordinary fallback and performs zero navigation. Test the runtime additions through the existing `.mcp-app-preview` boundary and stylesheet rather than a second component/class tree.

Add lifecycle-registration assertions to that same runtime-overload unit boundary: the owner registers one stable narrow handle before async create, repeated renders with stable inputs do not reregister, `handle.close()` is the exact idempotent pending-create/renderer/backend close promise, and cleanup calls the returned unregister plus joins the same close. A late old unregister cannot clear a newly registered handle. Omitting the optional registrar preserves the existing renderer contract.

Extend the landed `mcp-app-preview-browser.test.ts` and its `mountedPreviewFixture`; do not copy the fixture into this or another test. Preserve its real Chrome ready iframe checks (`sandbox`, `referrerpolicy`, and exact server-issued `src`), error fallback with the ordinary result, fallback response with zero iframes, unmount-before-create-resolution force-close of the exact late binding, 390px horizontal bound, and collected `pageerror` diagnostics; add an explicit final `expect(browserErrors).toEqual([])`. Add a discriminated runtime mode to that fixture and prove the runtime branch preserves those same visible/race guarantees while using only runtime client methods and the official renderer boundary. Pass a registrar into the runtime overload, observe one handle before ready/navigation, await that handle for close, and observe its exact conditional unregister on unmount; no browser wrapper discovers the handle. Keep higher-level resource proxy, protocol, HMR, and real-server assertions in the existing `overview.e2e.test.ts` journey instead of duplicating them here.

Keep the existing `mcp-page-app-browser.test.ts` case and `mountedPageFixture` green; do not rename the case, replace its proxy document, move its assertions into `overview.e2e.test.ts`, or create a second page-level harness. Preserve its exact artifact evidence: the distinct-origin iframe has `sandbox="allow-scripts allow-same-origin"` and `referrerpolicy="no-referrer"`; the inner document lacks the foreground token; initialize/initialized plus App tool/resource/host-context/display/log traffic traverses the relay; create receives the exact completed invocation data, selected profile, session, locale/theme/display host context, and no browser `toolMetadata`/`resourceUri`; profile changes close before replacement; MCP operations remain responsive after App close; unsupported media and legacy output template stay ordinary fallbacks; App close count is complete before controller close; the 390px page does not overflow; `pageErrors` is empty; and both temporary servers/files are removed.

Add a runtime mode/second case to that same `mountedPageFixture` only. Feed the immutable runtime selection into the landed one `McpPageAppPreview` region and extended one `McpAppClient`; assert no artifact `create`/`createMcpAppFrameRelay` or session-open route is used, the official renderer/bridge reaches initialized through the runtime methods, fallback and ordinary MCP controls remain usable, and session close observes the runtime App lifecycle already closed. Make the registered page handle's close deferred in four subflows: profile replacement, MCP restart, MCP close, and terminal reset. In each, assert the replacement create/controller operation/reset callback remains absent and the old frame/selection remains closing until close resolves; then assert exactly one next action and no stale remount. Assert one page preview region, one frame, one lifecycle handle, one client, no second fixture-owned preview/controller/client, distinct/credential-free origins, 390px containment, no page errors, and full fixture cleanup. This fixture intentionally mounts only `McpPage`; cross-screen single-mount evidence belongs to `overview.e2e.test.ts`, along with pre-navigation sandbox/proxy security and real HMR/reconcile assertions. The page fixture proves composition and ordering, not a second end-to-end server stack.

First pin the landed artifact `McpAppFrame`/`McpAppFrameRelay` unchanged: it accepts only its exact iframe window plus distinct `targetOrigin`, rejects binding-ID smuggling/non-finite or oversized frames, sends canonical resource HTML only after one proxy-ready notification, serializes bounded route traffic, queues essential close behind accepted work, forwards the route's one canonical teardown frame, accepts only the matching response while closing, and falls back to force DELETE on its existing timeout. Preserve the landed `McpAppClient` response validators and exact `{lifecycle,message?}` close shape. Runtime Apps do not instantiate this artifact relay or route messages through the core bridge.

Export `SecureAppRenderer` and a shared `applyMcpAppFramePolicy`/validation primitive from the existing `mcp-app-frame.tsx`; do not create another frame module or duplicate its source/origin/size/policy checks. The landed artifact `McpAppFrame` uses the same primitive without changing its public props or relay lifecycle. The runtime wrapper mounts vendored `AppRenderer` at `about:blank` with an inert bridge factory, uses a layout-phase barrier to apply/verify outer `sandbox="allow-scripts allow-same-origin"`, the server snapshot's exact `allow`, and `referrerpolicy="no-referrer"`, and only on the next keyed commit changes `sandboxPath` to the core proxy `bootstrapUrl` and installs the official factory. `bindingId` or policy revision change must remount through blank; copied/stale/forged/widened policy or changing URL/policy on an armed instance throws. A browser network listener—not a source/DOM mock—asserts no bootstrap/App request occurs before attributes exist. The trusted proxy creates its own inner `sandbox="allow-scripts"` opaque iframe before inserting App HTML.

Use an App fixture that performs `ui/initialize`, records changing host context, renders input/result, emits log/size, requests tool/display/link/download/media actions, and responds to teardown. Assert:

- `Portable MCP Apps` is the default and no vendor global exists.
- ChatGPT profile visibly says `ChatGPT Simulation`, exposes only `window.openai.widgetState` plus synchronous `setWidgetState` when enabled, and the standard bridge fallback still renders with the shim disabled.
- Claude profile visibly says `Claude Simulation`, has standard styles/safe-area context, and exposes no `window.claude`.
- model-visible fallback and App preview are sibling panels; iframe is absent from the decoded RSC tree/Tree inspector.
- metadata inspector has separate Standard, OpenAI extension, Claude extension, and Raw views with provenance.
- consent dialog names capability and action, focus is trapped/restored, Escape denies, and approval is single-use.
- host capabilities advertise only installed/approved handlers: no `openLinks`/`downloadFile`/logging/listChanged lie; enabling each handler adds only that capability. `downloadFile` receives validated blocks unchanged, and tools/resources listChanged is true only when a real forwarding subscription is installed.
- host-context changes continue through the official bridge after mount without rebuilding the iframe.
- initial host context includes `preview.profile.hostContext` styles and safe-area values; renderer measurements update only documented dynamic fields. Claude expected-domain inspection never appears in host context.
- assigning `bridge.onrequestdisplaymode` from vendored `AppRenderer` cannot replace or bypass the consent-aware async owner; denied display requests return the captured renderer fallback/current mode and approved requests invoke the installed display handler once.
- normal unmount/selection change atomically reserves and awaits `AppRendererHandle.teardown()` once before backend DELETE. Capture the lifecycle owner's actual `ui/resource-teardown` frame at the guarded transport and forward it byte-for-byte; never synthesize from UI reason/ID, and send none when teardown reports an uninitialized close. For initialized Apps, `teardown()` remains pending until the first matching response acknowledgment is accepted; only then may normal DELETE begin, and the UI remains in `closing` until release completes. Concurrent unmount/invalidation/close paths join that reservation and cannot mark notification delivered early. Wrong-ID and duplicate acknowledgments are rejected, do not unblock, do not issue another DELETE/release, and cannot consume a later binding's response. If the initial acknowledgment wait times out/errors, record an explicit force-close diagnostic, retain the one pending-ack authority, and start/join bounded authoritative DELETE. A late first match is accepted and awaits that exact release attempt under a fresh bound; a second timeout leaves cleanup retryable, and a duplicate remains false. A backend invalidation revokes first, emits an authenticated event, then the connected UI performs best-effort browser teardown; route DELETE itself sends no bridge message.
- action challenges exist before link/download/display handlers and their grant cannot be reused. Camera/microphone/geolocation/clipboard-write approval returns a new policy revision, remounts through the blank barrier with its exact new `allow`, is labelled document-scoped, and remains until that document closes.

- [ ] **Step 3: Run client/component tests and observe RED**

Run:

```bash
npm test -- packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-session-model.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/mcp-page-app-browser.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-session-adapter-fixture.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts packages/workbench/tests/project-client.test.ts packages/workbench/tests/runtime-model.test.ts packages/workbench/tests/runtime-stage.test.ts packages/workbench/tests/runtime-playground.test.ts packages/workbench/tests/mcp-app-client.test.ts packages/workbench/tests/mcp-app-frame.test.ts packages/workbench/tests/runtime-app-bridge.test.ts packages/workbench/tests/mcp-app-preview.test.ts packages/workbench/tests/mcp-app-preview-browser.test.ts packages/workbench/tests/rsbuild-workbench.test.ts packages/workbench/tests/rsbuild-closure.test.ts
npx tsc --project packages/workbench/src/inspector/adapter/tsconfig.json --noEmit
```

Expected: landed artifact App client/frame/preview canonical-profile and hardened lifecycle cases, the isolated Chrome preview fixture, the landed MCP-page Chrome lifecycle case, standard Rsbuild config, and Inspector production/development fixtures PASS; the new optional registrar forwarding/handoff assertions, runtime client methods, guarded bridge adapter, secure AppRenderer branch, and runtime preview-overload/unit/browser assertions FAIL.

- [ ] **Step 4: Implement the authenticated client and official bridge adapter**

Keep `McpRouteClient` scoped to artifact/runtime Inspector session control; add no App preview methods to it. Extend the landed `McpAppClient` with the separately named `createRuntime/getRuntime/operateRuntime/createRuntimeConsent/decideRuntimeConsent/closeRuntime` methods so they reuse its exact memory-only foreground authentication, null-prototype finite-JSON clone, diagnostic handling, opaque segments, and origin validation. Preserve its artifact methods and types unchanged, and never turn runtime close into `close(bindingId,{id,reason})`: the official runtime `AppBridge` sends teardown in the browser, then `closeRuntime` performs only the authenticated runtime DELETE. Extract the existing MCP session request mapping/result shaping into `dispatchAgentBundleMcpRequest`; keep the merged `AgentBundleRemoteTransport` behavior unchanged and reuse the dispatcher from a small controller-owned attached binding transport. The attached transport may consume the extended `McpAppClient`; it is not another route/authentication client.

The attached transport answers `initialize`, `notifications/initialized`, and `ping` locally from `McpAppPreviewSessionSnapshot`, maps only four App server methods to Task 4 operations, and delivers the `McpAppBoundOperationResult.value` to the SDK while sending its vector to `onTrace`. The local initialize result echoes the actual negotiated protocol version, server info, and capabilities; it never fabricates a second identity. On every response, validate binding session/revision again before delivering JSON-RPC. Do not forward arbitrary method strings, create/close the stable broker session, or confuse the merged manual Inspector's artifact `epochId` binding with a runtime App run binding.

In `runtime-app-bridge.ts`, instantiate the official browser bridge and transport inside the stable `BridgeFactory` closure:

```ts
return async (iframe) => {
  const targetWindow = iframe.contentWindow;
  if (targetWindow === null) throw new Error('MCP App sandbox iframe has no window.');
  if (preview.kind !== 'apps') throw new Error('MCP App bridge requires an Apps preview snapshot.');
  const approvedCsp = preview.resource.csp;
  const policy = options.client.currentDocumentPolicy(preview.binding.id);
  if (policy.snapshot.revision !== preview.documentPolicy.revision) {
    throw new Error('MCP App document policy is stale.');
  }
  const approvedPermissions = policy.snapshot.approvedPermissions;
  const access = await createBindingMcpClient(options.controller, options.client, preview);
  const capabilities = hostCapabilitiesFromInstalledHandlers({
    approvedPermissions,
    installedHandlers: options.installedHandlers,
    listChanged: options.listChanged,
  });
  const bridge = new AppBridge(
    access.client as unknown as ConstructorParameters<typeof AppBridge>[0],
    { name: 'Agent Bundle Workbench', version: preview.binding.profileVersion }
      as unknown as ConstructorParameters<typeof AppBridge>[1],
    { ...capabilities, sandbox: { csp: approvedCsp, permissions: approvedPermissions } },
    { hostContext: composeRuntimeHostContext(
      preview.profile.hostContext,
      snapshotHostContext(iframe, ['inline', 'fullscreen']),
    ) },
  );
  const transport = new GuardedPostMessageTransport({
    delegate: new PostMessageTransport(targetWindow, targetWindow),
    maxBytes: 256 * 1024,
    maxMessages: 32,
    onFailClosed: () => revokeAndDispose(options.client, preview.binding.id, bridge),
  });
  installValidatedConsentHandlers({ bridge, capabilities, options, policy, preview });
  installComposedDisplayModeHandler({ bridge, capabilities, options, preview });
  await bridge.connect(transport);
  return bridge;
};
```

`GuardedPostMessageTransport` composes—not subclasses or replaces—the official transport and the shared `createMcpAppFailClosedSender`. It preserves official receive/connect/close behavior, bounds outbound traffic, and on the third consecutive send error/queue block closes official bridge/transport and revokes backend state. Its test sends blocked complete input followed by a would-succeed result and proves neither escapes. Core `createMcpAppBridge` is never instantiated in the runtime path.

`composeRuntimeHostContext` starts from the frozen `preview.profile.hostContext`, including standard styles and safe-area values, then copies only the official renderer snapshot's documented dynamic theme/display/dimensions fields. It does not copy raw extension metadata or Claude expected domain. Send later official host-context updates through the same composer.

`installComposedDisplayModeHandler` is the sole display owner. Before the bridge is returned to vendored `AppRenderer`, define a non-configurable accessor for the bridge's actual SDK `onrequestdisplaymode` property. Its setter captures AppRenderer's synchronous fallback callback without replacing the owner; its getter always returns the async validator/challenge/decision handler. Denial or missing capability invokes the captured fallback once and returns the current mode; approval consumes the action grant, awaits the installed display handler once, and returns its validated mode. Tests perform AppRenderer's real assignment and prove it cannot overwrite the owner or cause a side effect before consent. Do not add a second handler after `AppRenderer` mounts.

Construct the MCP `Client` over the attached binding transport. Load only the validated, metadata-merged resource HTML through the core proxy bootstrap, prepend fixed profile bootstrap, apply approved CSP before untrusted markup, and send sandbox ready. Build capabilities from the actual installed-handler/resource/profile/policy intersection: advertise open links/download/logging/display/listChanged only when their handler/forwarding subscription exists. Preserve validated `downloadFile` blocks and live host-context updates. Every link/download/display handler creates and consumes an action grant before effect; document permission grants are applied only by keyed secure-renderer remount from the returned trusted policy handle.

The landed `McpAppPreview` runtime branch is the Workbench-local owner of `McpAppSimulationFeatures`, defaulting `chatGptWidgetState` to `disabled` for every runtime preview; the artifact controller/state remains unchanged. Disabled means the dormant bootstrap receives no activation and `window.openai` is absent. An explicit `Enable ChatGPT widgetState simulation` control sets it to `enabled`, remounts through the blank barrier, and activates exactly `widgetState` plus synchronous `setWidgetState`; disabling remounts again so no global remains. The setter updates the in-memory Workbench feature owner's finite-JSON state synchronously, then sends one binding-scoped persistence message through the closed bridge. Failed persistence rolls back and raises a visible diagnostic. It never writes global storage or adds another OpenAI API.

- [ ] **Step 5: Implement the preview UI through the Playground seam**

The `McpAppPreview` runtime branch creates a runtime binding only when `run.result.app` exists and sends exactly `{runId:run.id,profileId,expectedGenerationId:run.vector.runtimeGenerationId}`. It passes stable tool/factory identities into `AppRenderer`, and keeps the last-good model-visible result visible on App/bridge failure. Display the immutable originating run vector separately from the latest operation vector and label the latter `Executed by current implementation`; never rewrite run history. Show session/registry revisions, definition/transport/server digests, invalidation/restart diagnostics, canonical resource URI/MIME, warnings, and consent state.

Render through `SecureAppRenderer` using only `preview.clientSurface.bootstrapUrl` and `client.currentDocumentPolicy(bindingId)`. For normal close/profile/run change: disable actions, atomically reserve/join one renderer teardown, and await `rendererRef.teardown()` through the existing bound. For an initialized bridge that promise resolves only after the first matching teardown acknowledgment; then call normal backend DELETE and keep the frame/client record in `closing` until release resolves. For an uninitialized bridge it resolves without a frame and DELETE may begin immediately. On initial acknowledgment timeout/rejection, retain the exact diagnostic and pending acknowledgment matcher, invoke/join DELETE as authoritative force close, and do not fabricate an acknowledgment. If the first match arrives late, accept it once and await the same in-flight DELETE/release under a fresh teardown bound; if that fresh wait expires, return to the still-retained `cleanup-failed`/retry state without starting another release. Concurrent normal close and invalidation cannot steal or duplicate the reserved browser notification. If DELETE/release fails, retain the client binding/policy record in a `cleanup-failed` state and offer/retry close; do not resurrect the iframe or pretend cleanup succeeded. Remove the frame only after successful DELETE or explicit terminal force-close presentation. Backend DELETE is idempotent revocation/release and sends no `ui/resource-teardown`. Subscribe through the already-connected `ProjectClient` to authenticated runtime App invalidation events; on invalidation, backend state is already revoked, so join/reserve best-effort renderer teardown and clear the iframe without calling operations. Replay gap closes every iframe fail-closed. Foreground shutdown without a browser only revokes/releases.

Extend the existing `McpPage` and sole Workbench-owned `McpSessionController` with a discriminated session source; keep the landed sibling `InspectorScreen` as the only live Inspector surface:

```ts
export type McpPageSource =
  | Readonly<{ readonly kind: 'artifact'; readonly epochOptions: readonly string[]; readonly targetOptions: readonly string[] }>
  | Readonly<{ readonly kind: 'runtime'; readonly binding: DevRuntimeMcpAppRunBinding }>;
```

Keep `McpPage`'s landed session form, catalog/operations/trace, active-operation cancellation, recovery/reset, config download, diagnostics, action-session guards, and App preview composition. Add only the discriminated source controls/evidence needed to attach the run-bound runtime session. Preserve the existing artifact `McpPageAppPreviewSource` and `mcpAppPreviewSourceFor` return shape. Internally wrap a selected preview in one page-owned union, rather than adding a second preview state:

```ts
export type McpPagePreviewSelection =
  | Readonly<{ readonly kind: 'artifact'; readonly source: McpPageAppPreviewSource }>
  | Readonly<{ readonly kind: 'runtime'; readonly preview: RuntimeAppPreviewProps; readonly binding: DevRuntimeMcpAppRunBinding }>;

export type McpPagePreviewLifecycle = RuntimeAppPreviewLifecycle;
```

The landed private `McpPageAppPreview` remains the only preview placement. Its artifact arm keeps `createMcpAppPreviewController`, `McpAppPreviewFrame`, and the current markup. Its runtime arm calls the official-runtime `McpAppPreview` overload in that same section and passes a page-owned `registerLifecycle` callback. That registrar stores the emitted handle in the existing generalized `appPreviewController` ref (typed as `McpPagePreviewLifecycle`) and returns a conditional unregister that clears only that exact handle. The handle is the official preview owner's narrow close surface, not an adapter-created controller. Retain the one `appPreviewGeneration`, `appPreviewBusy`, profile picker, blank-between-selections behavior, and `closeAppPreview()`; profile replacement and explicit restart/close/reset each await `closeAppPreview()` before proceeding, while session mismatch/unmount joins the same idempotent handle and generation suppression rejects late work. Do not render the runtime overload beside `McpPageAppPreview`, create a second state/ref/generation, wrap it to discover lifecycle, or let the page instantiate `AppBridge`, `McpSessionController`, `McpRouteClient`, or transport. Extend the landed adapter/model in place for runtime binding keys and unsupported-operation presentation, but render it only from `InspectorScreen`; do not place an `InspectorSessionAdapter` inside `McpPage`, fork vendor screens, or add another protocol/catalog view.

Consume the Playground plan's landed exact `WorkbenchPage = 'inspector' | 'mcp' | 'overview' | 'runtime' | 'skills'`, `WorkbenchScreen`, `Navigation`, `McpScreen`, `InspectorScreen`, `RuntimeScreen`, controller/model state, and reset callback in `main.tsx`. Do not add another hash, page enum member, router, navigation item, screen, controller owner, preview owner, or inline Inspector page. Preserve `2cef8fb`'s one memory-only `McpAppClient` ref in `Workbench`; extend that same instance with runtime methods/event subscription and pass it through the existing `McpScreen.appPreviewClient` → `McpPage.appPreviewClient` chain. Workbench owns exactly one separate `standaloneRuntimePreviewLifecycle` ref plus boolean readiness for the existing Runtime-screen placement. Its stable registrar stores the emitted handle and returns a conditional unregister; pass it as `RuntimePlayground.registerAppPreviewLifecycle`. Neither `RuntimePlayground` nor `RuntimeStage` retains the handle. Keep one `McpRouteClient` as the shared controller's routes dependency, and construct each explicit reset replacement over that same client. Extend `McpScreen` with a selected `McpPageSource` and optional initial `McpPagePreviewSelection`; it renders the existing `McpPage`, whose existing page ref independently owns only the page placement's handle. `InspectorScreen` continues to render the one landed `InspectorSessionAdapter` with the exact same controller and subscribed model. Existing `.mcp-content`, `.inspector-content`, `.runtime-content`, `.mcp-page-app-controls`, `.mcp-page-app-preview`, and `.mcp-page-app-fallback` styling remain the owners; add only source/evidence/profile/consent descendants to `mcp-page.css` and shell placement to `styles.css`.

The Playground's `RuntimeLiveMcpPageAdapter` stays a host-owned handoff from the fifth `#runtime` sibling into the existing `#mcp` shell, not a renderer for a second `McpPage` or App preview. Its render validates the exact immutable `run.result.app.mcpBinding` and exposes one `Open in MCP playground` action, disabled until the standalone registrar has installed the current handle. The click captures that exact handle, awaits `handle.close()`, rechecks that the ref still names it, and only then atomically stores the runtime `McpPageSource` plus `McpPagePreviewSelection` and calls the existing `navigate('mcp')`. Close rejection or handle replacement leaves selection/navigation unchanged and shows a diagnostic; unmount cleanup may join the same close but cannot stand in for the awaited handoff. The landing page then emits its distinct handle into `McpPage`'s existing ref. The same binding is never simultaneously mounted in the Runtime and MCP screens. The initial Runtime result/App-preview view neither creates another controller nor requests `/api/mcp/sessions*` or `/api/runtime/mcp/sessions*`. Artifact mode preserves the landed epoch form, successful-call history actions, profile picker, and preview slot. Runtime mode hides the epoch field, displays immutable server/target/digest and registry/session revisions, and sends only the closed runtime RPC/restart/delete controls. A separate explicit `Start manual runtime session` action may call `POST /api/runtime/mcp/sessions` with `DevRuntimeMcpSessionRequest` only from an idle shared controller; a terminal controller must use the existing reset control first. After attachment, navigating to `#inspector` presents that same session/model; returning through `#runtime` or `#mcp` must not open, close, reset, replace, or duplicate it.

`Workbench` supplies the landed `onResetSession`; only after `mcpPageSessionControls` reports terminal recovery available does it synchronously replace the terminal controller and subscribed model with one fresh idle pair. On the first render with the new identity, `createMcpPageActionSession.reset()` and `mcpPageControllerReplacementState()` run before effects or new actions, and the sibling `InspectorSessionAdapter` resets its binding/action generation before old screen work can commit. Neither the Runtime handoff nor any screen contains a queue/retry/lifecycle implementation. Controller close drains attached SDK work before runtime DELETE, rejects late work, and retains every cleanup failure without transitioning to unconditional closed success; App access remains non-owning and never closes the broker session.

Use the Playground plan's injected `profileOptions: readonly RuntimeProfileOption[]`, `defaultProfileId: string`, `renderAppPreview`, and `RuntimeLiveMcpPageAdapter` seams plus this plan's optional lifecycle augmentation. Each `McpAppProfileDescriptor` must `satisfies RuntimeProfileOption` with `claimsRealHostParity:false`; `main.tsx` passes `Object.values(MCP_APP_PROFILE_DESCRIPTORS)`, portable default, Workbench's registrar, a thin dependency-bound renderer that forwards `props.registerLifecycle` into the landed `McpAppPreview` runtime overload, and the shell-handoff adapter above. The bound Runtime-screen renderer owns no state, handle, controller, CSS, or markup; the existing preview owner emits/clears its close lifecycle directly. Once handed off, the existing `McpPageAppPreview` runtime arm is the sole placement/owner and uses its own page registrar. Narrow `props.profile.id` with an exhaustive `isMcpAppProfileId()` guard before calling the server. Adapt descriptors onto the landed `supportedMcpAppPreviewProfiles` values rather than deleting or redefining that artifact contract. Option text includes descriptor version and `Simulation`, with a persistent `Simulated locally — not host certification` note. Do not redefine required Playground fields or treat the selected host option as canonical App-resource proof.

Use existing Workbench CSS variables. At <= 760 px stack fallback above preview, keep metadata/consent reachable, and prevent horizontal overflow. Do not copy `WorkbenchScreen`, `InspectorScreen`, `.inspector-content`, the shell header/navigation, or `AppsScreen`.

- [ ] **Step 6: Run focused tests and build/typecheck**

Run:

```bash
npm test -- packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-session-model.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/mcp-page-app-browser.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-session-adapter-fixture.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts packages/workbench/tests/project-client.test.ts packages/workbench/tests/runtime-model.test.ts packages/workbench/tests/runtime-stage.test.ts packages/workbench/tests/runtime-playground.test.ts packages/workbench/tests/mcp-app-client.test.ts packages/workbench/tests/mcp-app-frame.test.ts packages/workbench/tests/runtime-app-bridge.test.ts packages/workbench/tests/mcp-app-preview.test.ts packages/workbench/tests/mcp-app-preview-browser.test.ts packages/workbench/tests/rsbuild-workbench.test.ts packages/workbench/tests/rsbuild-closure.test.ts
npx tsc --project packages/workbench/src/inspector/adapter/tsconfig.json --noEmit
npm run build --workspace agent-bundle-workbench
npm run typecheck --workspace agent-bundle-workbench
```

Expected: all PASS. Mutation check: the artifact App client loses null-prototype JSON/detailed diagnostics/distinct-origin validation or its canonical close shape; preview input/result remains aliased, accepts cycles/non-finite/non-ordinary values, or is not recursively frozen; a noncanonical `ui:` spelling navigates; repeated start creates twice; close resolves before pending create, leaks its late binding, or publishes late state/frame; create/relay error drops the ordinary immutable fallback; custom-relay rejection skips force close; the runtime owner fails to register/conditionally clear its exact stable lifecycle handle, stage stores/invokes it, standalone handoff stores/navigates before awaited close or after rejection/replacement, or page profile/restart/close/reset proceeds before its page-owned handle closes; the landed artifact preview props/controller/relay/fallback/credential-free iframe or Chrome fixture's canonical iframe/error/fallback/unmount/mobile/page-error behavior changes; the landed `McpPage` supported-profile array, successful-call derivation, picker/history entry point, one preview slot/ref/generation, close-before-profile/restart/close/reset ordering, or session-mismatch/unmount cleanup changes; the landed `mcp-page-app-browser.test.ts` case/helper is replaced, its distinct-origin/frame/credential/Apps-v2/profile/fallback/responsiveness/close-order/request-shape/mobile/page-error/temp-cleanup evidence regresses, or another MCP-page App browser file/helper appears; runtime adds a second page preview region/controller/client or remains mounted in both Runtime and MCP screens; the runtime branch weakens any of those data/race/fallback guarantees; a runtime or host-extension-only response navigates without the canonical matching Apps profile; a second preview module, stylesheet, component lifecycle, or mounted-preview browser fixture appears; the artifact frame accepts a wrong window/origin/binding ID, bypasses proxy-ready, exceeds FIFO bounds, drops essential close, or changes its existing force fallback; the standard Rsbuild config regains a source NODE_ENV define/include or special runtime config/test; the Inspector bypasses its compatibility entry/vendor shim, removes the required local `onReplay`/`onSetLevel` callbacks, lets either callback issue a controller/route/transport operation, exposes Replay or Set Active Level UI, installs a protocol replay or `logging/setLevel` operation handler, filters/drops/mutates any otherwise valid frame in the Protocol presentation or immutable timeline/export, or loses its production/development Chrome fixtures; App path opens a session; unsupported method reaches fetch; operation vector is dropped; stale revision is accepted; actual bootstrap navigates before sandbox/allow; raw upstream appears; official bridge bypasses guarded sender; a capability is advertised without a handler; download blocks are rewritten; host context stops updating; side effect occurs before challenge/grant; media is labelled one-shot; DELETE precedes matching teardown acknowledgment; wrong/duplicate acknowledgment is accepted; acknowledgment reports completion before delayed release; initial timeout discards a late acknowledgment; late acknowledgment starts a second release or waits without a fresh bound; release failure loses retry state; factory identity changes; vendor global exists in portable; synchronous setter returns stale state; teardown runs twice; controller replacement waits for an effect; stale close/invoke cleanup clears fresh binding/pending state; a second App client/frame relay, Inspector adapter, or MCP shell route appears.

- [ ] **Step 7: Commit**

```bash
git add packages/workbench/src/mcp/mcp-route-client.ts packages/workbench/src/mcp/agent-bundle-remote-transport.ts packages/workbench/src/mcp/mcp-session-model.ts packages/workbench/src/mcp/mcp-session-controller.ts packages/workbench/src/mcp/mcp-page.tsx packages/workbench/src/mcp/mcp-page.css packages/workbench/src/mcp/mcp-app-client.ts packages/workbench/src/mcp/mcp-app-frame.tsx packages/workbench/src/mcp/mcp-app-preview.tsx packages/workbench/src/mcp/mcp-app-preview.css packages/workbench/src/inspector/adapter/inspector-session-adapter.tsx packages/workbench/src/inspector/adapter/inspector-session-adapter-model.ts packages/workbench/src/inspector/adapter/inspector-session-adapter.css packages/workbench/src/project-client.ts packages/workbench/src/runtime-model.ts packages/workbench/src/inspector/adapter/runtime-app-bridge.ts packages/workbench/src/inspector/adapter/closure-spike.ts packages/workbench/src/runtime-playground.tsx packages/workbench/src/runtime-stage.tsx packages/workbench/src/main.tsx packages/workbench/src/styles.css packages/workbench/tsconfig.json packages/workbench/tests/agent-bundle-remote-transport.test.ts packages/workbench/tests/mcp-session-model.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/mcp-page-app-browser.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/project-client.test.ts packages/workbench/tests/runtime-model.test.ts packages/workbench/tests/runtime-stage.test.ts packages/workbench/tests/runtime-playground.test.ts packages/workbench/tests/mcp-app-client.test.ts packages/workbench/tests/mcp-app-frame.test.ts packages/workbench/tests/runtime-app-bridge.test.ts packages/workbench/tests/mcp-app-preview.test.ts packages/workbench/tests/mcp-app-preview-browser.test.ts packages/workbench/tests/rsbuild-closure.test.ts
git commit -m "feat(workbench): preview MCP Apps across host profiles"
```

---

### Task 6: Prove Portable Lifecycle, Host Matrices, and Browser Isolation End to End

**Files:**
- Modify: `packages/workbench/tests/overview.e2e.test.ts`
- Preserve/run unchanged: `packages/workbench/tests/inspector-shell.e2e.test.ts`

**Interfaces:**
- Consumes: real Rsbuild Workbench build, real foreground server/provider example, real runtime MCP server, separate-origin sandbox proxy, nested opaque App iframe, real Playwright Chromium.
- Produces: browser evidence for lifecycle/security/profile behavior and an ordinary-project regression.

- [ ] **Step 1: Extend the landed real MCP Playground fixture and write the failing Apps workflow**

Extend the existing `overview.e2e.test.ts` `@rstest/playwright` harness, `buildWorkbench`, real foreground server, `writeMcpPlaygroundProject`, and landed `opens one real epoch MCP session and keeps its playground operations responsive` coverage. Preserve that artifact case's current assertions unchanged: exact epoch/server/target binding, Tools/Prompts/Resources discovery, equivalent form/raw/replay results, structured raw trace, fully sanitized downloaded Inspector config, cancellation responsiveness, close/reset/reopen with a new session, no page errors, mobile overflow, and cleanup failure reporting. Also run the landed `inspector-shell.e2e.test.ts` unchanged as the sole dedicated live Inspector route/browser flow; do not copy its `writeInspectorProject`, direct-Inspector zero-POST case, live tool/resource/prompt/protocol/logging journey, reset, or mobile assertions into the Runtime fixture. Add only runtime-extension assertions in a separate Apps case in `overview.e2e.test.ts`; do not copy/rewrite either landed workflow, duplicate their build/server/project helpers, or create another browser fixture file. Do not copy `mcp-page-app-browser.test.ts`'s `mountedPageFixture`, proxy document, artifact profile/fallback journey, or mobile page-lifecycle assertions here: that test owns built-page composition, while this task owns the real foreground/provider/proxy/HMR path. Add the real RSC example's `render_edit_timeline` tool and `ui://rsc-agent-runtime/edit-timeline-v1.html` App resource as a runtime-provider variant of the shared project writer, not a weather fixture or page route mock. The new Apps case must:

1. start the example provider and foreground server;
2. open Runtime Playground at 1440x900;
3. invoke the App-producing runtime surface, which records the already-open stable MCP session/revision in `run.result.app.mcpBinding`; before explicitly opening Live MCP, assert the browser sends zero requests to both `/api/mcp/sessions*` and `/api/runtime/mcp/sessions*`, and App preview never sends a session-create/control request;
4. open portable preview and wait for `ui/initialize`/`initialized`;
   assert `hmrReady` was already true but `HMR client connected` appears only after the authenticated proxy WebSocket upgrade emits `runtime.hmr.client-connected` for the App surface/count;
5. observe partial input, complete input, model-visible fallback, App-visible `_meta`, tool result, size/log events;
6. approve one same-session App tool call and deny a second;
7. assert the initial official host context contains profile styles/safe area; change dynamic host context; deny one display request and verify only AppRenderer's captured fallback runs, then approve another and verify exactly one installed-handler effect;
8. cancel a run, capture exactly one official lifecycle-owner `ui/resource-teardown` frame byte-for-byte, delay its matching acknowledgment, and assert backend DELETE/release and frame removal have not begun. Send a mismatched response and assert it returns false/still waits; send two concurrent matching acknowledgments and assert exactly one is accepted, the duplicate returns false, and release starts once. Delay backend release and assert the UI remains `closing` until DELETE completes. Then verify the stable broker session remains ready. Close an uninitialized preview and assert no synthetic frame/wait. In a separate close, let the initial acknowledgment wait expire, block the force DELETE/release, then send the first match late: it must be accepted once, join that exact release, and wait under a fresh bound; its duplicate is false. Let the fresh bound expire and assert closing/retry state survives, then complete one successful force-close retry. Separately keep the artifact App-access lease reservation/retry regression green;
9. switch to ChatGPT/Claude simulations and assert the exact presence/absence matrix and Simulation labels. ChatGPT begins with no `window.openai`; explicitly enable the Workbench-local feature, call `setWidgetState({page:3})` without awaiting, observe `widgetState.page === 3` in the same browser task and one persistence message, then force rejection and observe rollback/diagnostic. Disable/remount and prove the global is absent. Claude exposes no global, seeds its standard safe area/styles, and keeps expected domain in inspection only.

Use the host-owned handoff and assert it joins/closes the Runtime-screen preview before navigating from the existing fifth `#runtime` screen to the existing `#mcp` shell with one MCP navigation item, one `McpPage`, one `.mcp-page-app-preview`, and the same Workbench `McpAppClient`; no second route/page/controller/preview placement is created and the binding is never mounted in both screens. Preserve the landed artifact picker/history action and verify runtime selection renders through that same page region. Navigate to the existing `#inspector` sibling and assert only that its one `InspectorSessionAdapter` sees the same negotiated binding/model, then return through Runtime and MCP without another session open/close/reset. Do not repeat the dedicated Inspector catalog/protocol/logging journey here. Force client and transport cleanup failures from MCP, and assert the terminal page retains both causes and offers only `Reset MCP session`; the Inspector sibling observes the same terminal model. Reset synchronously to a fresh controller/model pair, verify preview close completes before replacement and transient state is cleared before effects, start a new pending binding/action, then settle old close and invoke work late; old completion/rejection/finalizers must not clear the new pending state, replace its diagnostic/binding, remount an old preview, or issue a route call. The disabled adapter and initial evidence-only phase still instantiate no additional controller and issue no MCP route traffic.

Use iframe probes and network/request listeners for these security assertions:

```ts
expect(await appFrame.evaluate(() => window.origin)).toBe('null');
expect(await appFrame.evaluate(() => {
  try { return parent.document.body.textContent; } catch { return 'blocked'; }
})).toBe('blocked');
expect(await appFrame.evaluate(() => localStorage.setItem('probe', '1')).catch(() => 'blocked')).toBe('blocked');
expect(undeclaredOriginRequests).toEqual([]);
expect(parentNavigationUrl).toBe(server.url);
expect(secretMatchesInProtocolTrace).toEqual([]);
```

Also attempt cookies, IndexedDB, top navigation, popup, form submission, undeclared network/image/frame origins, direct clipboard/media calls, oversized bridge frames, stale generation IDs, browser-supplied session/revision/digest fields, and reuse of an approved consent ID. Assert each is blocked and the last-good model-visible result remains present.

Before allowing the first bootstrap request, observe the real outer iframe and assert `sandbox="allow-scripts allow-same-origin"`, `referrerpolicy="no-referrer"`, and `allow` equal the server's `McpAppDocumentPolicySnapshot` exactly. Attempt to pass a copied, stale-revision, and widened policy handle through the host test seam; each must fail before navigation. Approve camera and then clipboard-write as document permissions, assert each response increments policy revision and forces an `about:blank` barrier/remount, and assert the approved `allow` persists for the document rather than being consumed per call. Link/download/display remain single-use action grants.

Exercise protected reads with the real server: authenticated `GET /api/runtime/apps/:bindingId` returns `no-store` sanitized state; missing cookie/token or cross-origin requests return 403 before lookup. Open the one authenticated `/api/project/events` stream only after session bootstrap, prove no second EventSource exists, and assert the received outer sequence plus binding/session revision/reason exactly match the revoked preview. On explicit replay gap, all live App iframes close before the client performs status refresh or ProjectClient shutdown.

- [ ] **Step 2: Run the E2E and observe RED**

Run:

```bash
npm test -- packages/workbench/tests/overview.e2e.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts
```

Expected: the unchanged Inspector shell flow PASS; the Runtime Apps case FAIL before the complete preview route/bridge workflow is available.

- [ ] **Step 3: Complete only fixture/wiring defects exposed by the real browser**

Keep all fixes in the files owned by Tasks 1-5. Do not relax sandbox/CSP/origin/token checks to make the test pass. If a Chromium capability cannot be exercised without permission flags, assert the Permissions Policy/iframe `allow` denial and record the browser result rather than granting a blanket browser context permission.

- [ ] **Step 4: Add the ordinary-project and App-HMR regressions**

Extend `overview.e2e.test.ts` to start a project without `dev.runtime.provider`, assert no Runtime navigation and no request to `/api/runtime/apps` or sandbox proxy port, then complete an ordinary rebuild.

In the App E2E, edit App client React and CSS and assert the nested App surface updates through Rsbuild HMR/Fast Refresh without changing `page` navigation ID, foreground session, stable MCP `sessionId`/`sessionRevision`, originating `binding.runVector`, or model-visible fallback. A subsequent App tool operation must display its newer returned vector separately. Assert no reconnect/relist occurs. A full inner sandbox remount is allowed only when Fast Refresh rejects the boundary; the entire Workbench must never reload.

Then change only the MCP implementation with the same definition/transport digests and repeat the preserved-session/new-operation-vector assertions. Change `definitionDigest`, then independently `transportDigest`: each must emit `restarting`, drain work, reconnect and relist once, increment revisions, close the old iframe/binding through the registry subscription, and require a new run/preview rather than silently rebinding. Force restart failure once and assert the old App is closed, the fallback/diagnostic remains visible, and no App operation reaches either old or partial replacement transport. Finally reconnect the Workbench event stream after more than 64 reconcile events and assert an explicit replay-gap diagnostic closes the App rather than missing invalidation.

Close/remount the App client surface and assert paired `runtime.hmr.client-disconnected`/`client-connected` events change the displayed count while `hmrReady` remains true. A provider listen/start event alone must never render `client connected`.

- [ ] **Step 5: Run browser, focused backend, and packaging checks**

Run:

```bash
npm test -- packages/workbench/tests/overview.e2e.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts
npm test -- packages/agent-bundle/tests/mcp-app-binding-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-binding-service.test.ts packages/agent-bundle/tests/mcp-app-metadata.test.ts packages/agent-bundle/tests/mcp-app-host-profiles.test.ts packages/agent-bundle/tests/mcp-app-sandbox.test.ts packages/agent-bundle/tests/mcp-app-bridge.test.ts packages/agent-bundle/tests/mcp-app-preview-service.test.ts packages/agent-bundle/tests/mcp-app-runtime-preview-service.test.ts packages/agent-bundle/tests/mcp-app-routes.test.ts packages/agent-bundle/tests/runtime-mcp-routes.test.ts
npm run build
npm run typecheck
```

Expected: all PASS. Inspect the built Workbench assets and ordinary generated plugin fixture behavior through tests, not source grep: Workbench contains the App preview chunk; ordinary generated plugins do not contain project provider code, React RSC runtime, or the sandbox proxy.

- [ ] **Step 6: Commit**

```bash
git add packages/workbench/tests/overview.e2e.test.ts
git commit -m "test(workbench): verify MCP App preview isolation"
```

---

## Execution Notes and Review Gates

After every task, a fresh reviewer must compare the change against this plan and the approved design before the next task starts. Reject a task if it introduces a generic browser JSON-RPC proxy, lets the browser create/select an App MCP session or supply revisions/digests, reconnects on an implementation-only activation, loses an operation vector, polls for invalidation, reads raw extension metadata as a selector, grants permissions before consent, treats a simulation as observed real-host evidence, or alters ordinary-project behavior.

The final integration/audit plan owns native Claude/Codex evidence. This plan may display only evidence records it receives with the exact shape `{ status: 'observed' | 'inferred' | 'unavailable', host, hostVersion, timestamp, artifactId }`; it must not infer iframe support from CLI execution or relabel simulated profile output as native-host evidence.

## Self-Review Coverage

- **Spec coverage:** Tasks 1 and 4 cover stable session/revision/digest binding, originating run evidence, per-operation vectors, reconcile/restart/relist/invalidation, strict transcript/App projections, selector precedence, list/read provenance, and tool-only visibility. Tasks 2 and 5 cover portable baseline, raw vendor metadata, versioned ChatGPT/Claude simulations, exact SHA-256 Claude derived-domain inspection/mismatch warnings, Workbench-local opt-in state, profile-seeded host context, labels, and no invented Claude global. Task 3 covers opaque inner origin, canonical CSP, server-derived revisioned document policy, action versus document consent, bridge limits, and fail-closed traffic. Tasks 4-5 cover authenticated/no-store create/GET/consent, one ordered project stream, replay-gap teardown, canonical single-ack teardown/release ordering, the landed single App client/frame relay/preview boundary and startup-unwind APIs, transactional preview data detachment, strict canonical URI validation, pending-create close/late-binding cleanup, immutable error fallback, the optional owner-emitted lifecycle registrar with standalone/page-local handle ownership and await-before-handoff/session transitions, the isolated preview-controller Chrome fixture, `2cef8fb`'s one-client/one-slot `McpPage` preview composition and close-before-session ordering, `d8d2315`'s sole built-page Chrome Apps-v2 lifecycle fixture, canonical Apps-profile gating for artifact and runtime branches, merged transport/client/controller reuse, the standard one-argument Rsbuild config and production/development builds, the five-route `WorkbenchScreen` shell, shared controller/model identity across `#mcp`/`#inspector`/`#runtime`, the complete Inspector compatibility entry/shim/fixture/typecheck cluster as the sole presentation boundary, official App bridge, shared pre-navigation frame-policy enforcement, display callback composition, and retryable cleanup. Task 6 extends the landed real MCP Playground E2E in place with runtime-only assertions while preserving `inspector-shell.e2e.test.ts` as the sole dedicated live Inspector flow; together they cover the standard lifecycle, implementation HMR without reconnect, definition/transport restart, host matrix, browser isolation, secret masking, ordinary-project regression, and cross-screen identity without duplicate preview or Inspector fixtures.
- **Known implementation risk:** The official Ext Apps bridge and existing core `mcp-app-bridge.ts` must not become two competing owners of one iframe lifecycle. The official bridge owns browser `ui/initialize` and view events; the preview service owns binding authorization, single-use consent, and closed server operations; core bridge code contributes only pure resource/result/request validators to this path. Review Task 5 specifically for duplicate delivery of input/result or teardown.
- **Known integration risk:** Vendored `AppRenderer` currently assigns the official bridge's synchronous display callback. The non-configurable accessor must be verified against the installed SDK and real renderer assignment; if the actual property is not configurable, stop and adapt at the factory boundary without patching vendor code or installing a competing handler.
- **Known authentication risk:** Native EventSource cannot set the existing mutation header. The host-only HttpOnly session cookie is intentionally limited to `/api` and same-site use; tests must prove bootstrap ordering, cross-origin denial, `no-store`, one stream only, and no token in URL/logs.
- **Known test risk:** Browser storage exceptions vary by Chromium version. Assert the security outcome (no readable/persistent value and opaque origin), not exact DOMException wording.
- **Known host boundary:** Raw OpenAI/Claude metadata is inspectable but inert. ChatGPT simulation version 1 implements only opt-in `widgetState`; Claude simulation version 1 implements no vendor global. Expanding either requires fresh public documentation, a new Agent Bundle profile version, and new presence/absence tests.
