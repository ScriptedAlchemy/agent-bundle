/**
 * Browser-consumable contract surface for dev-server route invocations — the
 * one execution path behind the Workbench route workspace. Routes render on
 * the server through the production runtime; the only runtime export is the
 * render-history retention the browser's live buffer shares with the server.
 */
export {
  RENDER_EVENT_RETENTION,
  emptyRetainedRenderEvents,
  retainRenderEvent,
  type RetainedRenderEvents,
} from '../dev/routes/route-invocation-result.ts';
export type {
  RouteInvocationCliProjection,
  RouteInvocationEvent,
  RouteInvocationEventHost,
  RouteInvocationEventPayload,
  RouteInvocationHostProjection,
  RouteInvocationKind,
  RouteInvocationListResponse,
  RouteInvocationOutcome,
  RouteInvocationProjection,
  RouteInvocationProvider,
  RouteInvocationProviderStatus,
  RouteInvocationRequest,
  RouteInvocationStatus,
  RunningRouteInvocation,
  RouteInvocationSummary,
  RouteInvocationSurface,
  RouteInvocationTiming,
} from '../dev/routes/route-invocation.ts';
export type {
  RouteInvocation,
  RouteInvocationResponse,
  RouteInvocationStart,
  RouteInvocationStreamMessage,
  RunningRouteInvocationResponse,
} from '../dev/routes/route-invocation-result.ts';
export type { EventTraceEvent } from '../events/trace.ts';
