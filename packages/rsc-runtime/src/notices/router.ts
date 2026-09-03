import { AgentNoticeError } from './contract.js';

/**
 * Delivery routes from the #99 taxonomy. `current-response` is the only
 * same-request route; the rest are cross-request. `directed-push` and
 * `host-toast` exist in the vocabulary so adapters can advertise them
 * honestly, but no pinned host supports either (2026-09-02 survey on #99).
 */
export const AGENT_NOTICE_DELIVERY_ROUTES = Object.freeze([
  'current-response',
  'next-event',
  'mcp-inbox',
  'mcp-resource-updated',
  'directed-push',
  'host-toast',
] as const);

export type AgentNoticeDeliveryRoute = (typeof AGENT_NOTICE_DELIVERY_ROUTES)[number];

export type AgentNoticeDeliveryRouteState =
  | { readonly state: 'supported' }
  | { readonly reason: string; readonly state: 'unavailable' };

export type AgentNoticeDeliveryAdvertisement = Readonly<
  Record<AgentNoticeDeliveryRoute, AgentNoticeDeliveryRouteState>
>;

/** Stable preference order for cross-request routes; all supported routes run. */
const crossRequestPreference = Object.freeze([
  'directed-push',
  'mcp-resource-updated',
  'mcp-inbox',
  'next-event',
  'host-toast',
] as const satisfies readonly AgentNoticeDeliveryRoute[]);

export type AgentNoticeRouteSelection =
  | { readonly kind: 'selected'; readonly routes: readonly AgentNoticeDeliveryRoute[] }
  | { readonly kind: 'unavailable'; readonly reason: 'no-supported-cross-request-route' };

const validateAdvertisement = (
  advertisement: AgentNoticeDeliveryAdvertisement,
): void => {
  for (const route of AGENT_NOTICE_DELIVERY_ROUTES) {
    const entry = advertisement[route] as AgentNoticeDeliveryRouteState | undefined;
    if (entry === undefined) {
      throw new AgentNoticeError('invalid-input', `Delivery advertisement is missing route ${route}`);
    }
    if (entry.state === 'unavailable' && entry.reason.trim() === '') {
      throw new AgentNoticeError('invalid-input', `Unavailable route ${route} requires a dated reason`);
    }
  }
};

/**
 * Selects every supported cross-request route in stable preference order.
 * A notice with no supported cross-request route stays pending until expiry
 * with a typed unavailable outcome; the router never fabricates a channel.
 */
export const selectNoticeDeliveryRoutes = (
  advertisement: AgentNoticeDeliveryAdvertisement,
): AgentNoticeRouteSelection => {
  validateAdvertisement(advertisement);
  const routes = crossRequestPreference.filter(
    (route) => advertisement[route].state === 'supported',
  );
  return routes.length === 0
    ? Object.freeze({ kind: 'unavailable', reason: 'no-supported-cross-request-route' })
    : Object.freeze({ kind: 'selected', routes: Object.freeze(routes) });
};
