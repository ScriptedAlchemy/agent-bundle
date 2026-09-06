import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import type { JsonValue } from '../../core/strict-json.ts';
import type { RequestContextProvenance } from '../../contracts/request-provenance.ts';
import type { EventTraceEvent } from '../../events/trace.ts';
import type {
  RunningRouteInvocation,
  RouteInvocationProjection,
  RouteInvocationProvider,
  RouteInvocationSummary,
} from './route-invocation.ts';

/**
 * Render events one invocation retains — in the producer while it streams, in
 * the live stream replay, and in the completed envelope. Older events are
 * evicted oldest-first; the final `complete` event and `document` survive.
 */
export const MAX_RETAINED_RENDER_EVENTS = 256;

export interface RouteInvocation extends RouteInvocationSummary {
  readonly context: RequestContextProvenance;
  /** The final Agent Document; absent when rendering failed before a document existed. */
  readonly document?: AgentDocument;
  /** The newest `MAX_RETAINED_RENDER_EVENTS` of the production `shell | progress | replace | error | complete` stream, in order. */
  readonly events: readonly AgentRenderEvent[];
  readonly projection: RouteInvocationProjection;
  readonly providers: readonly RouteInvocationProvider[];
  /** Structured value recorded by the selected surface; its presence alone proves neither a `resultSchema` declaration nor validation. */
  readonly result?: JsonValue;
  /** Event-kernel phase events emitted by a compiled preflight execution. */
  readonly trace?: readonly EventTraceEvent[];
}

export type RouteInvocationStreamMessage =
  | Readonly<{ readonly event: AgentRenderEvent; readonly type: 'render' }>
  | Readonly<{ readonly event: EventTraceEvent; readonly type: 'trace' }>
  | Readonly<{ readonly type: 'truncated' }>
  | Readonly<{ readonly invocation: RouteInvocation; readonly type: 'final' }>;

export interface RouteInvocationStart {
  readonly invocation: RunningRouteInvocation;
  readonly result: Promise<RouteInvocation>;
}

export interface RunningRouteInvocationResponse {
  readonly invocation: RunningRouteInvocation;
}

/** `GET /api/routes/invocations/<id>` and `POST /api/routes/invocations`. */
export interface RouteInvocationResponse {
  readonly invocation: RouteInvocation;
}
