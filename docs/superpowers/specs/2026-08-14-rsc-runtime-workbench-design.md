# RSC Runtime Workbench Design

**Date:** 2026-08-14

**Status:** Approved

## Purpose

Agent Bundle already builds ordinary skills, MCP servers, MCP Apps, native hooks, scripts, host packages, and evaluations. The RSC Agent Runtime demo adds an optional framework for advanced plugins: hook and MCP invocations render React Server Components to Flight, decode the tree, lower it to native hook or MCP protocol results, and share external state across otherwise disposable processes.

This design integrates that optional runtime with `agent-bundle dev`. It gives runtime authors a live Workbench Playground with real RSC HMR, generation-safe hook and MCP execution, sandboxed MCP App previews, documented host profiles, trace inspection, and last-good recovery. Projects that do not opt into a runtime continue through the existing development and build paths without loading React, React Server Components, or `rsbuild-plugin-rsc`.

## Success Criteria

The feature is complete when all of the following are true:

1. A normal Agent Bundle project with no runtime declaration has unchanged config, build, package, test, and `agent-bundle dev` behavior.
2. A project may explicitly declare one development runtime provider by project-relative module path.
3. The RSC example supplies such a provider and starts a long-lived Rsbuild development compiler with coordinated `rsc`, paired `widget`, and browser `app` environments.
4. Saving a Server Component causes an incremental compile, safe activation of one coherent runtime generation, automatic replay of the selected Workbench fixture, a fresh Flight request, and an updated rendered result without a page reload or manual rebuild.
5. Saving MCP App client React or CSS uses normal Rsbuild HMR and React Fast Refresh inside the isolated preview.
6. Failed runtime compilation preserves the last-good generation and visible result while showing phase-specific diagnostics.
7. No invocation can combine an entry, async chunk, client-reference manifest, or resource from different generations.
8. Hook invocations and MCP tool executions are pinned to immutable generations. Existing invocations may drain while new invocations use a newly activated generation.
9. MCP definitions remain static for the lifetime of one MCP session. Definition changes trigger an explicit restart, reconnect, and capability relist.
10. The Workbench can exercise hook fixtures, MCP tool inputs, model-visible MCP results, and MCP App UI without allowing browser input to select an executable, working directory, environment, output root, or arbitrary upstream URL.
11. Portable MCP Apps behavior is the baseline. ChatGPT and Claude profiles expose only documented, capability-detected extensions and are visibly labelled simulations.
12. The delivery includes end-to-end HMR, failure recovery, sandbox, generation-coherence, and ordinary-project regression tests.
13. The final handoff includes the actual post-change repository topology and an independent architecture, correctness, concurrency, security, DX, packaging, and cross-host audit.

## Non-Goals

- An in-browser TypeScript or JSX editor.
- Hot-patching an already executing Node or ESM module instance.
- Dynamic MCP tool registration inside JSX or after a session has listed tools.
- Making the MCP App iframe part of the RSC component tree.
- Persisting React memory, iframe DOM, or arbitrary client component state across incompatible generations.
- Full local clones of ChatGPT, Claude, Claude Code, or Codex.
- Claiming real-host certification from a simulated local host profile.
- A general-purpose durable event database, collaboration server, or remote render farm.
- Replacing normal Agent Bundle artifact builds with the runtime development compiler.

## Selected Architecture

The implementation adds a generic, optional development runtime provider boundary at the `startDevServer` composition root. The core coordinator continues to own source preparation, diagnostics, production-like artifact epochs, and the last-good packaged artifact. The provider owns its compiler graph, runtime generations, invocations, MCP sessions, App assets, and runtime diagnostics.

The RSC provider uses a long-lived Rsbuild dev compiler. Rslib remains responsible for Agent Bundle library packaging and normal generated executables. The RSC provider must not use Rslib watch mode as its HMR server: Rslib watch rebuilds library output, while Rsbuild supplies the multi-environment development graph, browser client, middleware, WebSocket, custom hot events, React Refresh, and Rspack RSC integration.

The RSC execution runtime remains isolated and disposable. A Server Component change is RSC HMR in the framework sense: compile incrementally, replace the isolated server runtime generation, notify the Workbench, request fresh Flight, and reconcile the displayed result. It does not depend on Node `require.cache` or ESM cache eviction.

## Alternatives Considered

### Embed RSC in `DevCoordinator`

Rejected. The coordinator is a serialized artifact-epoch orchestrator. Embedding the RSC compiler would load supplemental dependencies for ordinary projects, duplicate watching, couple a multi-environment HMR graph to production artifact publication, and encourage treating artifact epochs and runtime generations as the same identity.

### Run an unrelated standalone RSC dev server

Accepted only as an internal implementation technique behind the provider contract. Exposing it as the product architecture would leave process lifecycle, port discovery, authentication, status, cleanup, diagnostics, and Workbench routing disconnected and RSC-specific.

### Generic provider with provider-owned Rsbuild runtime

Selected. It preserves optionality, gives Rsbuild ownership of HMR, lets Agent Bundle own safe lifecycle and discovery, and creates a reusable boundary for future supplemental runtimes without turning `TargetAdapter` into a development-process abstraction.

## Configuration and Discovery

`AgentBundleConfig` gains an optional development-only declaration:

```ts
export interface AgentBundleDevRuntimeConfig {
  readonly provider: string;
}

export interface AgentBundleDevConfig {
  readonly runtime?: AgentBundleDevRuntimeConfig;
}

export interface AgentBundleConfig {
  readonly dev?: AgentBundleDevConfig;
  // Existing fields remain unchanged.
}
```

`provider` is resolved relative to the project root and must remain within that root after symlink resolution. The module exports one factory:

```ts
export const createDevRuntimeProvider: CreateDevRuntimeProvider;
```

The project config is already executable trusted project code. Loading a project-declared provider does not grant the browser any new code-selection authority. The CLI loads the provider only for the `dev` command and only when the declaration is present. Build, package, evaluation, normalization, and non-development commands ignore it.

Malformed modules, path escapes, missing exports, duplicate provider starts, and provider startup failures produce development diagnostics. They do not alter the normalized plugin or make runtime dependencies mandatory for projects without the declaration.

## Core Provider Contracts

Core types remain serializable and React-free:

```ts
export interface DevRuntimeProvider {
  readonly descriptor: DevRuntimeDescriptor;
  start(context: DevRuntimeStartContext): Promise<DevRuntimeSession>;
}

export interface DevRuntimeSession {
  close(): Promise<void>;
  invoke(request: DevRuntimeInvocationRequest): Promise<DevRuntimeInvocationResult>;
  openMcpSession(request: DevRuntimeMcpSessionRequest): Promise<DevRuntimeMcpSession>;
  readAsset(request: DevRuntimeAssetRequest): Promise<DevRuntimeAsset | undefined>;
  status(): DevRuntimeStatus;
  surfaces(): readonly DevRuntimeSurface[];
}
```

The exact discriminated request and result variants are defined in the implementation plan, but they must satisfy these rules:

- All invocation inputs are JSON-serializable and schema-validated.
- Core never receives a `ReactNode`; the provider returns a serializable inspection envelope.
- Every result echoes `providerSessionId`, `runtimeGenerationId`, `runId`, and state identity/version.
- The provider descriptor declares the child-environment variable names it needs; secret values never appear in descriptors, status, events, or browser responses.
- Asset reads are relative to a compiler-declared surface and pass containment checks.
- Browser requests name provider-declared surface, hook, tool, resource, profile, fixture, session, and run identifiers only. They never contain executable paths or commands.
- `close()` is idempotent and releases compiler, workers, MCP sessions, leases, temporary data, middleware registrations, and WebSocket listeners.

`startDevServer` starts the provider after project configuration is prepared, exposes provider status in the session, and closes it even when another dev resource fails. Runtime startup or compilation failure places only the supplemental runtime in a failed or degraded state; ordinary artifact inspection remains available.

## Two Build Lanes

The Workbench displays two deliberately separate lanes:

### Artifact lane

The existing `ProjectWatcher`, `DevCoordinator`, `ArtifactService`, and `EpochStore` produce immutable production-like Agent Bundle artifacts. This lane validates what will be packaged and retains its current last-good behavior.

### Runtime lane

The RSC provider creates one long-lived Rsbuild dev compiler. Rsbuild owns dependency-graph watching for runtime JavaScript, TypeScript, JSX, TSX, and CSS. The existing project watcher may still trigger artifact validation, but it must not manually invalidate the same Rsbuild graph. Runtime output roots are added to the coordinator's ignored/output paths so writes cannot recursively invalidate the project.

The UI always distinguishes `artifactEpochId` from `runtimeGenerationId`. A runtime generation may advance several times while a packaged artifact build is still running or stale.

## Runtime Identity and Activation

Every runtime operation carries this minimum identity:

```ts
export interface RuntimeVector {
  readonly providerSessionId: string;
  readonly runtimeGenerationId: string;
  readonly sourceRevision: string;
  readonly artifactEpochId?: string;
  readonly stateStoreId: string;
  readonly stateVersion: number;
}
```

The provider state machine is:

```text
observed → compiling → validating → active
                       ├──────────→ failed
                       └──────────→ superseded
```

Each successful incremental compilation materializes all required `rsc` server entries, paired `widget` outputs, client-reference data, manifests, and initial and async chunks into a staging generation. The provider records relative paths, byte sizes, SHA-256 digests, environment hashes, and a manifest digest, validates the cohort, then atomically renames and activates it. Stable filenames are safe because active and retained generations live under different immutable roots.

The provider does not activate partial environment success. A newer compile fences an older candidate from activation. Failed and superseded staging generations are cleaned without disturbing the active generation.

Referenced generations are leased. Hook workers, MCP invocations, MCP sessions, downloads, and App resources release their leases at completion or close. Cleanup retains the active generation and the five newest unreferenced inactive generations, matching the Workbench's bounded history.

## RSC HMR Flow

The installed `rsbuild-plugin-rsc` already connects `ServerPlugin.onServerComponentChanges` to a custom `rsc:update` message on the Rsbuild HMR socket. The provider adds a readiness boundary so the Workbench never rerenders against an unactivated generation:

```text
source save
  → Rsbuild incremental compile
  → rsbuild-plugin-rsc detects server component change
  → provider materializes and validates the complete generation
  → provider atomically activates it
  → runtime.generation.activated event
  → Workbench automatically replays the selected fixture
  → disposable worker executes the new generation
  → Flight is decoded and lowered
  → React updates the stage without a page reload
```

The Workbench treats raw `rsc:update` as invalidation only. It reruns after `runtime.generation.activated`, not before. If no fixture is selected, it updates status without creating an invocation.

The browser `app` environment remains served by Rsbuild development middleware and uses the built-in HMR client and React Fast Refresh. Invalid Fast Refresh boundaries may reload only the sandboxed App surface, never the entire Workbench.

## Hooks, MCP, and Shared State

Hook simulation normalizes a selected Claude or Codex fixture, starts a disposable process from the leased generation, captures bounded stdout and stderr separately, decodes Flight, lowers the Hook JSX tree, and returns both the native response and inspection envelope.

The provider never promises shared JavaScript memory. Shared state lives in an external kernel. Code generations and process restarts do not reset it. The Playground supplies isolated fixture stores with seed, clone, reset, and deterministic replay operations so development runs do not silently mutate production-like plugin state.

The demo's JSONL store remains acceptable as example storage, but the development contract requires idempotent invocation keys, consistent-prefix reads, explicit corruption errors, and recovery of only a torn final record. A later storage implementation may satisfy that contract without changing Workbench APIs.

MCP tool and resource definitions are registered before a session lists capabilities. A stable development broker owns the MCP transport and forwards render/tool execution to generation-pinned disposable workers. Implementation-only RSC changes do not restart the broker. A digest change to tool names, schemas, annotations, metadata, resource URIs, transport, command, arguments, cwd, or environment triggers a controlled session restart and `tools/list`/resource relist.

## Foreground Server and Events

The foreground server gains a fixed runtime namespace. Provider code mounts through an explicit server extension object; it cannot register outside that namespace or install an arbitrary proxy.

Required routes are:

```text
GET    /api/runtime/status
GET    /api/runtime/surfaces
POST   /api/runtime/runs
GET    /api/runtime/runs/:runId
POST   /api/runtime/runs/:runId/replay
POST   /api/runtime/state/reset
POST   /api/runtime/mcp/sessions
POST   /api/runtime/mcp/sessions/:sessionId/restart
DELETE /api/runtime/mcp/sessions/:sessionId
POST   /api/runtime/mcp/sessions/:sessionId/rpc
GET    /api/runtime/assets/:surfaceId/*
```

All mutations use the foreground server's existing same-origin session token and body limits. Runtime routes add per-run time, output, frame, process, and concurrency limits. Routes reject mismatched `expectedGenerationId` with HTTP 409 rather than silently rebinding an input to a new generation.

The existing replayable project event stream carries summary runtime events but no large payloads. Runtime events include `providerSessionId`, `runtimeGenerationId` when available, and correlation IDs:

```text
runtime.status
runtime.generation.compiling
runtime.generation.activated
runtime.generation.failed
runtime.run.started
runtime.run.completed
runtime.run.failed
runtime.mcp.restarting
runtime.mcp.ready
runtime.mcp.failed
runtime.app.updated
```

Large Flight data, stderr, protocol bodies, trees, and traces are stored as bounded run artifacts and retrieved through authenticated routes. `ProjectClient` delivers runtime event payloads directly instead of converting every event into a full project-status refresh.

## Workbench Playground

The Workbench gains capability-based navigation. Projects without a runtime keep the current Overview and other ordinary pages with no disabled or empty runtime chrome.

The Runtime Playground has one run-centered layout:

- A persistent top bar shows provider state, HMR connection, active runtime generation, packaged artifact epoch, shared-state version, selected target, and host profile.
- The left rail lists Hooks, MCP Tools, MCP Resources, fixtures, and immutable run history.
- The center stage renders the selected operation. Hook runs show agent-visible output and the native hook response. MCP runs show the model-visible fallback result beside the MCP App preview when one is declared.
- The right inspector contains Tree, Result, Flight, Protocol, State, and Diagnostics tabs.
- A collapsible bottom trace shows ordered build, worker, Flight, decode, lowering, MCP, and App bridge spans.

Fixture inputs use schema-generated forms plus a raw JSON editor. `Ctrl+Enter` or `Cmd+Enter` runs the draft. Read-only operations run immediately. Operations without a read-only annotation require explicit confirmation. Historical runs are immutable; `Edit as new draft` and `Replay exact run` never mutate the original record.

The component tree is derived from the decoded React node and is labelled as such. Raw Flight is available as a bounded preview and downloadable artifact. The iframe is never shown as a child of the RSC tree.

Runtime errors are labelled by phase: source/build, fixture validation, hook wrapper, RSC worker/render, Flight decode, lowering contract, MCP transport/protocol, resource selection, sandbox/CSP, or App bridge. The last-good output remains visible behind diagnostics.

## MCP App Sandbox and Host Profiles

The Workbench reuses the vendored Inspector components and App bridge but provides a production transport and sandbox controller. It does not embed the entire Inspector application shell.

The sandbox uses a trusted outer controller and an opaque-origin inner iframe without `allow-same-origin`. It applies the resource's declared CSP and Permissions Policy, blocks undeclared network destinations, prevents parent navigation and host DOM/storage access, and requires consent for app-originated tool calls, downloads, external links, clipboard/media access, and display-mode requests. Wildcard CSP entries are warnings, never evidence that a resource is safe.

A browser session is bound to:

```ts
export interface PreviewBinding {
  readonly runtimeGenerationId: string;
  readonly target: string;
  readonly serverName: string;
  readonly serverDigest: string;
  readonly profileId: 'portable' | 'chatgpt' | 'claude';
  readonly profileVersion: string;
  readonly evidence: 'simulated';
}
```

Portable MCP Apps is the compliance lane. Selection uses `_meta.ui.resourceUri`; resource reads require the matching `ui://` item and `text/html;profile=mcp-app`. Raw metadata and normalized UI metadata remain separately inspectable with provenance.

The ChatGPT profile adds only documented OpenAI metadata inspection and an opt-in, feature-detected `window.openai` shim for supported capabilities such as widget state. The Claude profile adds standard host styles, safe-area context, and an expected domain derived from an explicit canonical HTTPS public MCP URL. Neither profile branches on user agent or claims product parity.

Real Claude Code and Codex CLI runs remain separate evidence-producing actions. CLI hosts do not prove iframe rendering. Every evidence item is labelled `observed`, `inferred`, or `unavailable` with host version and timestamp.

## Security and Resource Limits

- The foreground server remains loopback-only and enforces its existing Host, Origin, session-token, request-size, and path-containment checks.
- Provider module and asset paths are resolved beneath the project or immutable generation root after symlink resolution.
- The browser selects only server-declared opaque identifiers.
- Child stdout is reserved for protocol output; bounded and redacted stderr feeds diagnostics.
- The standard RSC provider builds every child-process environment from an explicit provider-descriptor allowlist; it never forwards the parent environment wholesale. Native evaluators strip provider API-key variables and report the opaque saved-auth mechanism they use.
- MCP sessions and workers have startup, call, idle, total-runtime, output-byte, frame-byte, process-count, and concurrency limits.
- Disconnect, cancellation, provider close, Workbench close, or generation teardown kills owned children and removes temporary plugin data.
- App bridge capabilities are the intersection of the selected profile and installed host handlers.
- No public-tunnel or real-host security claim is based on hostname or origin allowlists alone.

## Visual Design Process

Before frontend implementation, generate one complete desktop concept for the Runtime Playground using the existing Workbench visual language and the approved information architecture. The concept must show the top runtime bar, left operation/fixture rail, center result-and-App stage, right inspector, and bottom trace at a readable laptop viewport. It must not invent marketing copy, decorative dashboards, badges, or unrelated product metrics.

Extract tokens, typography, spacing, panels, selection states, diagnostics, and responsive behavior from that concept. The running implementation must later be captured at the concept's native dimensions and compared with `view_image`. The fidelity ledger records at least copy, layout, typography, palette, container model, and interaction-state comparisons. The concept is a development reference, not a shipped bitmap asset.

## Testing Strategy

All behavior changes use strict red-green-refactor development. Required test layers are:

### Unit and contract tests

- Runtime config/provider validation and containment.
- Provider lifecycle, optional isolation, idempotent close, and aggregated cleanup errors.
- Runtime state machine, generation fencing, atomic activation, leases, and bounded retention.
- Complete manifest coverage for initial and async assets with digest validation.
- Definition digest classification and MCP restart policy.
- Route validation, authorization, body limits, generation conflicts, and opaque identifier resolution.
- Frontend reducers/models for event ordering, drafts, immutable history, stale generations, and host profiles.

### Integration tests

- A normal project starts and rebuilds without loading the runtime provider module.
- The example provider starts the real Rsbuild multi-environment dev server.
- Server Component edits produce a new activated generation and automatic selected-fixture Flight rerender without page reload.
- Failed server compilation keeps the last-good generation and result.
- Paired outputs, manifests, and async chunks never cross generations under concurrent rebuild and invocation.
- MCP implementation edits preserve the broker; definition edits restart and relist it.
- Hook and MCP invocations drain against their leased generations.
- App React/CSS edits use HMR or Fast Refresh inside the sandbox.

### Browser and security tests

- The complete Playground workflow at desktop and mobile widths.
- Portable resource negotiation, URI selection, MIME validation, initialize/initialized, partial and complete input, tool result, app calls, host-context changes, cancellation, and teardown.
- Inner iframe isolation from host DOM, cookies, storage, navigation, undeclared origins, and unsupported capabilities.
- ChatGPT and Claude profile presence/absence matrices with no undocumented globals.
- Protocol trace correlation and secret masking.

### Regression and packaging tests

- Existing root `npm run check` remains green.
- The RSC example's focused check remains green.
- Production runtime packaging still includes every manifest-declared transitive chunk and self-contained App HTML.
- Published Agent Bundle assets include the Workbench changes without bundling project RSC provider code or React RSC runtime dependencies into ordinary generated plugins.
- Native Claude and Codex artifact validation and sanitized evaluations retain their previously documented evidence levels.

## Delivery Sequence

Implementation is divided into separately reviewable plans:

1. **Runtime provider and RSC HMR:** configuration, provider lifecycle, foreground mounting, runtime generations, real Rsbuild compiler, Flight replay, events, and ordinary-project isolation.
2. **Runtime Playground:** event-aware client, operation/fixture model, result/tree/Flight/diagnostic surfaces, visual implementation, and browser HMR validation.
3. **MCP Apps and host profiles:** generation-bound MCP broker, sandbox controller, Inspector transport, portable negotiation, ChatGPT/Claude simulations, security limits, and native-evidence presentation.
4. **Final integration and audit:** full verification, base resynchronization, documentation, topology generation, independent reviews, and remediation of load-bearing findings.

Each plan uses incremental commits. Before beginning each plan and before final verification, merge any newer committed work from `codex/agent-bundle-implementation`. Existing user changes and uncommitted work in other worktrees are never copied or modified.

## Final Handoff

The final response must include:

- The exact worktree branch, base relationship, and commit series.
- A repository topology tree showing new and changed packages, runtime/provider boundaries, Workbench modules, example modules, tests, generated manifests, and documentation.
- A runtime flow diagram from source edit through HMR, generation activation, invocation, Flight, lowering, and App bridge.
- Fresh build, test, lint, typecheck, browser, native-host, and packaging evidence with exact pass/fail counts.
- An independent audit organized by architecture, correctness/concurrency, security, frontend/DX/accessibility, packaging, and cross-host behavior.
- Every audit finding with severity, file/symbol evidence, disposition, and any remaining limitation.
- An explicit statement that ordinary Agent Bundle projects were verified without the runtime enabled.
