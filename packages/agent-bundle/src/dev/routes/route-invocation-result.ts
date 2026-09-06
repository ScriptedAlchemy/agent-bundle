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
 * The one retention policy for an invocation's render history, applied by
 * every keeper of it: the render child while it streams, the child's IPC
 * reply, the live stream replay, the completed envelope (and so history reads
 * and the final stream message), and the browser's live buffer. Past either
 * bound the oldest event is evicted first; the newest event always survives,
 * so a completed stream keeps its `complete` event whatever its size. The
 * final `document`, `outcome`, and correlation identifiers live outside this
 * window and are never evicted.
 */
export const RENDER_EVENT_RETENTION = Object.freeze({
  /** JSON text of the retained events, in UTF-16 code units. */
  maxBytes: 1024 * 1024,
  maxEvents: 256,
});

export interface RetainedRenderEvents {
  /** JSON text size of `events`. */
  bytes: number;
  /** Older events the bounds evicted — the truncation indication. */
  evicted: number;
  readonly events: AgentRenderEvent[];
}

export const renderEventBytes = (event: AgentRenderEvent): number => JSON.stringify(event).length;

export const emptyRetainedRenderEvents = (): RetainedRenderEvents => ({ bytes: 0, events: [], evicted: 0 });

/** Appends `event`, then evicts oldest-first while `RENDER_EVENT_RETENTION` is exceeded. */
export const retainRenderEvent = (retained: RetainedRenderEvents, event: AgentRenderEvent): void => {
  retained.events.push(event);
  retained.bytes += renderEventBytes(event);
  while (
    retained.events.length > 1
    && (retained.events.length > RENDER_EVENT_RETENTION.maxEvents || retained.bytes > RENDER_EVENT_RETENTION.maxBytes)
  ) {
    retained.bytes -= renderEventBytes(retained.events.shift()!);
    retained.evicted += 1;
  }
};

/** The retained window of an already-collected stream. */
export const retainRenderEvents = (events: readonly AgentRenderEvent[]): RetainedRenderEvents => {
  const retained = emptyRetainedRenderEvents();
  for (const event of events) retainRenderEvent(retained, event);
  return retained;
};

export interface RouteInvocation extends RouteInvocationSummary {
  readonly context: RequestContextProvenance;
  /** The final Agent Document; absent when rendering failed before a document existed. */
  readonly document?: AgentDocument;
  /** The retained window of the production `shell | progress | replace | error | complete` stream, in order (`RENDER_EVENT_RETENTION`). */
  readonly events: readonly AgentRenderEvent[];
  /** Older render events `RENDER_EVENT_RETENTION` evicted from `events`; absent when none were. */
  readonly evictedEvents?: number;
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
