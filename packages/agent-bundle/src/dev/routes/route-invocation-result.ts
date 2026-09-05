import type { AgentDocument, AgentRenderEvent } from '@agent-bundle/runtime';

import type { JsonValue } from '../../core/strict-json.ts';
import type { RequestContextProvenance } from '../../contracts/request-provenance.ts';
import type { EventTraceEvent } from '../../events/trace.ts';
import type {
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

/** `GET /api/routes/invocations/<id>` and `POST /api/routes/invocations`. */
export interface RouteInvocationResponse {
  readonly invocation: RouteInvocation;
}
