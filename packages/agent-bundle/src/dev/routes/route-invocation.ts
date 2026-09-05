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
import { deepFreeze } from '../../core/freeze.ts';
import type { JsonObject, JsonValue } from '../../core/strict-json.ts';
import type { RequestContextProvenance } from '../../contracts/request-provenance.ts';

/** The route kinds the invocation service renders; `app` routes are browser surfaces previewed through the MCP App preview instead. */
export type RouteInvocationKind = 'cli' | 'event-route' | 'prompt' | 'resource' | 'script' | 'tool';

/** The hosts an event route can be invoked as; `canonical` submits the canonical payload directly. */
export type RouteInvocationEventHost = 'claude' | 'codex' | 'cursor';

export interface RouteInvocationEventOptions {
  /**
   * When present, `input` is the host's native hook payload and the service
   * canonicalizes it exactly as the emitted wrapper would (the lifecycle
   * replay path); when absent, `input` is the canonical event payload.
   */
  readonly host?: RouteInvocationEventHost;
  /** A fixture id from the route's manifest fixtures; the service seeds `input` from it when `input` is absent. */
  readonly fixtureId?: string;
}

export interface RouteInvocationRequest {
  /** CLI routes only: the argv the routed CLI would receive after the command path. */
  readonly args?: readonly string[];
  /** Browser-minted correlation id, echoed on the envelope and on the `route.invocation` project event. */
  readonly correlationId?: string;
  readonly event?: RouteInvocationEventOptions;
  /** Tool/prompt/script input, event payload (canonical or native — see `event.host`), or resource parameters. */
  readonly input?: JsonValue;
  /** Optional caller request id, echoed on the envelope and trace correlation. */
  readonly requestId?: string;
  /** The compiled route id, for example `tool:curator/search_audible`, `event:tool/before`, `cli:audible/search`, `script:sync`. */
  readonly routeId: string;
}

export type RouteInvocationStatus = 'failed' | 'succeeded';

export interface RouteInvocationTiming {
  readonly durationMs: number;
  /** `providers`, `handler`, `render`, `projection`, or a provider id (`provider:<name>`). */
  readonly phase: string;
  readonly startedAt: string;
}

export type RouteInvocationProviderStatus = 'failed' | 'mounted' | 'skipped';

export interface RouteInvocationProvider {
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
  /** Failure diagnostics; empty when the route rendered. A `represented-error` document is a success with an error node, not a failure. */
  readonly diagnostics: readonly Diagnostic[];
  readonly event?: RouteInvocationEvent;
  readonly id: string;
  /** The input the route rendered, after fixture seeding and (for hosted events) canonicalization. */
  readonly input: JsonValue;
  readonly kind: RouteInvocationKind;
  /** The route manifest digest the invocation resolved the route through. */
  readonly manifestDigest: string;
  readonly requestId?: string;
  readonly routeId: string;
  readonly source: string;
  readonly sourceRevision: string;
  readonly startedAt: string;
  readonly status: RouteInvocationStatus;
  readonly timings: readonly RouteInvocationTiming[];
}

export interface RouteInvocationListResponse {
  readonly invocations: readonly RouteInvocationSummary[];
}

/** The `route.invocation` project event payload published on `/api/project/events` when an invocation completes. */
export interface RouteInvocationEventPayload {
  readonly invocation: RouteInvocationSummary;
}

const nativeText = (native: JsonObject, key: string): string | undefined => {
  const value = native[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const nativeEventLineage = (
  native: JsonObject,
  target: string,
): RequestContextProvenance['lineage'] => {
  if (target !== 'claude' && target !== 'codex' && target !== 'cursor') {
    return { reason: 'no-subagent-events', state: 'unavailable' };
  }
  if (target === 'cursor') return { reason: 'no-shared-runtime', state: 'unavailable' };
  const root = nativeText(native, 'session_id');
  const agentId = nativeText(native, 'agent_id');
  if (root === undefined || agentId !== undefined) return { reason: 'no-shared-runtime', state: 'unavailable' };
  const generation = target === 'codex' ? nativeText(native, 'turn_id') : nativeText(native, 'prompt_id');
  return {
    source: 'receipt',
    state: 'available',
    value: {
      conversation: root,
      depth: 0,
      ...(generation === undefined ? {} : { generation }),
      resolution: 'native',
      root,
    },
  };
};

/** Lowers one native event receipt into the request provenance shared by replay and invocation surfaces. */
export const nativeEventRequestContext = (input: Readonly<{
  readonly event: string;
  readonly hostContractRevision: string;
  readonly native: JsonObject;
  readonly routeId: string;
  readonly target: string;
}>): RequestContextProvenance => {
  const sessionId = nativeText(input.native, 'session_id') ?? nativeText(input.native, 'conversation_id');
  const workspaceRoots = input.native.workspace_roots;
  const firstWorkspaceRoot = Array.isArray(workspaceRoots)
    && typeof workspaceRoots[0] === 'string'
    && workspaceRoots[0].trim() !== ''
    ? workspaceRoots[0]
    : undefined;
  const workspaceRoot = nativeText(input.native, 'cwd') ?? firstWorkspaceRoot;
  return deepFreeze({
    actor: { reason: 'not-provided', state: 'unavailable' },
    host: { source: 'receipt', state: 'available', value: { name: input.target } },
    invocation: {
      hostContractRevision: input.hostContractRevision,
      kind: 'event',
      operationId: input.routeId,
      surface: input.event,
    },
    lineage: nativeEventLineage(input.native, input.target),
    session: sessionId === undefined
      ? { reason: 'not-provided', state: 'unavailable' }
      : { source: 'receipt', state: 'available', value: { sessionId } },
    workspace: workspaceRoot === undefined
      ? { reason: 'not-provided', state: 'unavailable' }
      : { source: 'receipt', state: 'available', value: { root: workspaceRoot } },
  });
};
