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

export interface RouteInvocation extends RouteInvocationSummary {
  readonly context: RequestContextProvenance;
  /** The final Agent Document; absent when rendering failed before a document existed. */
  readonly document?: AgentDocument;
  /** The production `shell | progress | replace | error | complete` stream, in order. */
  readonly events: readonly AgentRenderEvent[];
  readonly projection: RouteInvocationProjection;
  readonly providers: readonly RouteInvocationProvider[];
  /** The document value parsed by the route's own `resultSchema`; absent when the module exports none or rendering failed. */
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
