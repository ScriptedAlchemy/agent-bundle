import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import type { JsonValue } from '../../core/strict-json.ts';
import type { RequestContextProvenance } from '../../contracts/request-provenance.ts';
import type { EventTraceEvent } from '../../events/trace.ts';
import type { RouteInvocationRenderRetention } from './route-invocation-render-history.ts';
import type {
  RunningRouteInvocation,
  RouteInvocationProjection,
  RouteInvocationProvider,
  RouteInvocationSummary,
} from './route-invocation.ts';

export interface RouteInvocation extends RouteInvocationSummary {
  readonly context: RequestContextProvenance;
  /** The final Agent Document; absent when rendering failed before a document existed. Never truncated by `retention`. */
  readonly document?: AgentDocument;
  /**
   * The production `shell | progress | replace | error | complete` stream, in
   * order, as retained by the render-history window
   * (`routeInvocationRenderHistoryLimits`): the newest events plus the newest
   * document-bearing event. Complete unless `retention` is present.
   */
  readonly events: readonly AgentRenderEvent[];
  readonly projection: RouteInvocationProjection;
  readonly providers: readonly RouteInvocationProvider[];
  /** Structured value recorded by the selected surface; its presence alone proves neither a `resultSchema` declaration nor validation. */
  readonly result?: JsonValue;
  /** Present when the render-history window evicted events; the one truthful account of what `events` no longer holds. */
  readonly retention?: RouteInvocationRenderRetention;
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
