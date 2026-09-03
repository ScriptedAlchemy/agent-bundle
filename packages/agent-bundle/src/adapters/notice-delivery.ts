/**
 * The #99 notice delivery route taxonomy, spelled in the compiler package so
 * that public declarations such as `TargetAdapter` never resolve through
 * `@agent-bundle/runtime`, which is an optional peer of `agent-bundle`. The
 * shape is structurally identical to the runtime's
 * `AgentNoticeDeliveryAdvertisement`; `adapter-capability-states.test.ts`
 * asserts the two are mutually assignable so a vocabulary change on either
 * side fails the build.
 */
export const NOTICE_DELIVERY_ROUTES = Object.freeze([
  'current-response',
  'next-event',
  'mcp-inbox',
  'mcp-resource-updated',
  'directed-push',
  'host-toast',
] as const);

export type NoticeDeliveryRoute = (typeof NOTICE_DELIVERY_ROUTES)[number];

export type NoticeDeliveryRouteState =
  | { readonly state: 'supported' }
  | { readonly reason: string; readonly state: 'unavailable' };

/** A host's honest, dated advertisement of which notice delivery routes it can carry. */
export type NoticeDeliveryAdvertisement = Readonly<Record<NoticeDeliveryRoute, NoticeDeliveryRouteState>>;
