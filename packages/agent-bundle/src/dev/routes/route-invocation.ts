/**
 * The one dev-server invocation contract behind the Workbench route
 * workspace (#600). Every conventional route kind the execution kernel can
 * render in development — MCP tools, resources, prompts, CLI routes, scripts,
 * and semantic event routes — is invoked through this one request shape and
 * answered with this one envelope: the canonical input that was rendered, the
 * request context and providers it ran with, the production render-event
 * stream and final Agent Document, the route's structured result, and the
 * host projections of that document (MCP, CLI, native hook results).
 *
 * Runtime-free. The peer-typed result fields live in
 * `route-invocation-result.ts`, so project-event declarations can expose
 * invocation summaries without requiring the optional runtime peer.
 */
import type { Diagnostic } from '../../core/diagnostics.ts';
import type { JsonObject, JsonValue } from '../../core/strict-json.ts';

/** The route kinds the invocation service renders; `app` routes are browser surfaces previewed through the MCP App preview instead. */
export type RouteInvocationKind = 'cli' | 'event-route' | 'prompt' | 'resource' | 'script' | 'tool';

/** The hosts an event route can be invoked as; `canonical` submits the canonical payload directly. */
export type RouteInvocationEventHost = 'claude' | 'codex' | 'cursor';

export type RouteInvocationSurface =
  | Readonly<{ readonly kind: 'mcp' }>
  | Readonly<{ readonly args: readonly string[]; readonly command: string; readonly kind: 'cli' }>
  | Readonly<{
    readonly fixtureId?: string;
    /** When present, `input` is the host's native hook payload; otherwise it is canonical. */
    readonly host?: RouteInvocationEventHost;
    readonly kind: 'event';
  }>
  | Readonly<{ readonly kind: 'script' }>
  | Readonly<{ readonly kind: 'unit-render' }>;

export interface RouteInvocationRequest {
  /** Browser-minted correlation id, echoed on the envelope and on the `route.invocation` project event. */
  readonly correlationId?: string;
  /** Tool/prompt input, event payload (canonical or native), script input, or resource parameters. */
  readonly input?: JsonValue;
  /** The compiled route id, for example `tool:curator/search_audible`, `event:tool/before`, `cli:audible/search`, `script:sync`. */
  readonly routeId: string;
  /** Selected execution surface. Omission selects the canonical default for the route kind. */
  readonly surface?: RouteInvocationSurface;
}

/**
 * Whether the execution boundary completed. `succeeded` means the route ran
 * to a final document (or a plain script exited) and the envelope carries
 * what it produced; what the run *meant* is `outcome`. `failed` means the
 * boundary never completed — child crash, timeout, abort, `AB825x`.
 */
export type RouteInvocationStatus = 'failed' | 'succeeded';

/**
 * The application result of a completed run, judged by the surface the route
 * was invoked through. `represented-error`: the MCP projection carries
 * `isError: true` (a non-`success` Agent Document), or an event route's
 * decision is `deny`. `process-exit`: the generated CLI bin (or script
 * executable) sets a non-zero exit code for this run — the bin's own rule,
 * captured on the production path, never re-derived here.
 */
export type RouteInvocationOutcome =
  | Readonly<{ readonly kind: 'success' }>
  | Readonly<{ readonly kind: 'represented-error'; readonly summary: string }>
  | Readonly<{ readonly exitCode: number; readonly kind: 'process-exit' }>;

export interface RouteInvocationTiming {
  readonly durationMs: number;
  /**
   * A measured phase. `render` is the child's render (or plain-script run)
   * duration; `projection` is host-projection time in the service; `elapsed`
   * is wall time until failure when the child never produced a render
   * duration. `handler`, `providers`, and `provider:<name>` appear only when
   * the child observed them. Zero is a measurement, not "unknown".
   */
  readonly phase: string;
  readonly startedAt: string;
}

/**
 * Observed provider outcome. `unobserved` means the service never measured
 * this provider — `durationMs` is omitted, never reported as `0`.
 */
export type RouteInvocationProviderStatus = 'failed' | 'mounted' | 'skipped' | 'unobserved';

export interface RouteInvocationProvider {
  /**
   * Measured mount duration in milliseconds. Absent when the phase was not
   * measured (`unobserved`, or an observed row that did not record time).
   */
  readonly durationMs?: number;
  readonly id: string;
  readonly message?: string;
  readonly name: string;
  readonly status: RouteInvocationProviderStatus;
}

export interface RouteInvocationCliProjection {
  readonly exitCode: number;
  /** The routed CLI's JSON output mode, when the route produced a document value. */
  readonly json?: JsonValue;
  /** The routed CLI's human output for this document. */
  readonly text: string;
}

export interface RouteInvocationHostProjection {
  readonly diagnostics: readonly Diagnostic[];
  readonly host: RouteInvocationEventHost;
  /** The native hook response the host would receive; absent when the projection failed. */
  readonly native?: JsonObject;
}

export interface RouteInvocationProjection {
  readonly cli?: RouteInvocationCliProjection;
  /** Event routes: the lowered host response per selected host. */
  readonly hosts?: readonly RouteInvocationHostProjection[];
  /** `CallToolResult`, `ReadResourceResult`, or `GetPromptResult` as the generated MCP server would send it. */
  readonly mcp?: JsonObject;
}

export interface RouteInvocationEvent {
  /** The canonical event id the route is bound to, for example `tool/before`. */
  readonly event: string;
  readonly host?: RouteInvocationEventHost;
  /** The canonical payload actually rendered — identical to `input` for a canonical submission. */
  readonly canonical: JsonObject;
  /** The native payload submitted when `host` is present. */
  readonly native?: JsonObject;
}

/** One row of `GET /api/routes/invocations`: the envelope without its streams, for lists and the trace. */
export interface RouteInvocationSummary {
  readonly completedAt: string;
  readonly correlationId?: string;
  /** Failure diagnostics; empty when the route rendered. A `represented-error` document completes the boundary and is reported through `outcome`, not here. */
  readonly diagnostics: readonly Diagnostic[];
  readonly event?: RouteInvocationEvent;
  readonly id: string;
  /** The input the route rendered, after fixture seeding and (for hosted events) canonicalization. */
  readonly input: JsonValue;
  readonly kind: RouteInvocationKind;
  /** The route manifest digest the invocation resolved the route through. */
  readonly manifestDigest: string;
  /** Present on every `succeeded` invocation; absent when the boundary did not complete. */
  readonly outcome?: RouteInvocationOutcome;
  readonly routeId: string;
  readonly source: string;
  readonly sourceRevision: string;
  readonly startedAt: string;
  readonly status: RouteInvocationStatus;
  /** The resolved surface, including defaults when the request omitted it. */
  readonly surface: RouteInvocationSurface;
  readonly timings: readonly RouteInvocationTiming[];
}

export interface RouteInvocationListResponse {
  readonly invocations: readonly RouteInvocationSummary[];
}

/** The `route.invocation` project event payload published on `/api/project/events` when an invocation completes. */
export interface RouteInvocationEventPayload {
  readonly invocation: RouteInvocationSummary;
}
