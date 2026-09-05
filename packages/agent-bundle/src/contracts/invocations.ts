/**
 * Browser-consumable contract surface for dev-server route invocations — the
 * one execution path behind the Workbench route workspace. Type-only: routes
 * render on the server through the production runtime.
 */
export type {
  RouteInvocation,
  RouteInvocationCliProjection,
  RouteInvocationEvent,
  RouteInvocationEventHost,
  RouteInvocationEventOptions,
  RouteInvocationEventPayload,
  RouteInvocationHostProjection,
  RouteInvocationKind,
  RouteInvocationListResponse,
  RouteInvocationProjection,
  RouteInvocationProvider,
  RouteInvocationProviderStatus,
  RouteInvocationRequest,
  RouteInvocationResponse,
  RouteInvocationStatus,
  RouteInvocationSummary,
  RouteInvocationTiming,
} from '../dev/routes/route-invocation.ts';
