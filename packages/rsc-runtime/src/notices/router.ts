import { AgentNoticeError } from './contract.js';
import {
  AGENT_NOTICE_DEFAULT_SENSITIVITY,
  compareNoticeSensitivity,
  isNoticeSensitivity,
  type AgentNoticeDisclosure,
  type AgentNoticeDisclosureShape,
  type AgentNoticeSensitivity,
} from './redaction.js';

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

/**
 * A supported route may name the most sensitive notice it carries in full.
 * Absent means `internal`: the pre-sensitivity contract, under which default
 * notices flowed and nothing was classified `secret`. A `secret` notice is
 * therefore withheld from every route until a host row says otherwise.
 */
export type AgentNoticeDeliveryRouteState =
  | {
    readonly sensitivity?: AgentNoticeSensitivity;
    /** Dated evidence for the ceiling, as the host's capability table records it. */
    readonly sensitivityEvidence?: string;
    readonly state: 'supported';
  }
  | { readonly reason: string; readonly state: 'unavailable' };

export type AgentNoticeDeliveryAdvertisement = Readonly<
  Record<AgentNoticeDeliveryRoute, AgentNoticeDeliveryRouteState>
>;

/**
 * What each route structurally carries. The inbox and the hook-response
 * routes return the recipient's document; a toast has room for one line; a
 * `resources/updated` notification names the inbox URI and nothing else.
 */
export const AGENT_NOTICE_ROUTE_SHAPES: Readonly<Record<AgentNoticeDeliveryRoute, AgentNoticeDisclosureShape>> =
  Object.freeze({
    'current-response': 'body',
    'directed-push': 'body',
    'host-toast': 'title',
    'mcp-inbox': 'body',
    'mcp-resource-updated': 'signal',
    'next-event': 'body',
  });

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

/**
 * Fails closed on an advertisement the router cannot honour: a missing route,
 * a reasonless unavailability, or a supported row naming a sensitivity the
 * vocabulary does not spell. Route selection, the ledger, and the signaller all
 * validate at construction so a JavaScript embedder's typo (`"secrect"`) is a
 * typed `invalid-input` up front, never a silently disclosed secret.
 */
export const validateNoticeDeliveryAdvertisement = (
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
    if (entry.state === 'supported' && entry.sensitivity !== undefined && !isNoticeSensitivity(entry.sensitivity)) {
      throw new AgentNoticeError(
        'invalid-input',
        `Supported route ${route} names an unknown sensitivity ${JSON.stringify(entry.sensitivity)}`,
      );
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
  validateNoticeDeliveryAdvertisement(advertisement);
  const routes = crossRequestPreference.filter(
    (route) => advertisement[route].state === 'supported',
  );
  return routes.length === 0
    ? Object.freeze({ kind: 'unavailable', reason: 'no-supported-cross-request-route' })
    : Object.freeze({ kind: 'selected', routes: Object.freeze(routes) });
};

/**
 * The sensitivity ceiling a route row admits; absent rows admit `internal`.
 * A ceiling outside the vocabulary admits nothing: `undefined` here withholds
 * every class, so an unvalidated row can only ever fail closed.
 */
export const routeSensitivityCeiling = (
  entry: AgentNoticeDeliveryRouteState,
): AgentNoticeSensitivity | undefined => {
  if (entry.state !== 'supported') return undefined;
  if (entry.sensitivity === undefined) return AGENT_NOTICE_DEFAULT_SENSITIVITY;
  return isNoticeSensitivity(entry.sensitivity) ? entry.sensitivity : undefined;
};

/**
 * Decides what one route may disclose of a notice, from the notice's declared
 * sensitivity and the host's capability row for that route. Fails closed: an
 * unsupported route, or a notice more sensitive than the row's ceiling,
 * withholds the notice entirely; nothing about it leaves the store that way.
 * Within the ceiling the route carries its structural shape, and `internal`
 * content is secret-passed on every route so an unclassified credential never
 * crosses into another actor's context. An absent advertisement (an embedder
 * that wired no host) is the pre-sensitivity contract: every route admits
 * `internal`.
 */
export const resolveNoticeDisclosure = (
  route: AgentNoticeDeliveryRoute,
  sensitivity: AgentNoticeSensitivity,
  advertisement: AgentNoticeDeliveryAdvertisement | undefined,
): AgentNoticeDisclosure => {
  const entry: AgentNoticeDeliveryRouteState | undefined = advertisement === undefined
    ? { state: 'supported' }
    : advertisement[route];
  // A row the advertisement does not spell is not a supported route.
  const ceiling = entry === undefined ? undefined : routeSensitivityCeiling(entry);
  if (ceiling === undefined) {
    return Object.freeze({ kind: 'withheld', reason: 'route-unavailable' });
  }
  if (compareNoticeSensitivity(sensitivity, ceiling) > 0) {
    return Object.freeze({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
  }
  return Object.freeze({
    kind: 'disclosed',
    redacted: sensitivity === 'internal',
    shape: AGENT_NOTICE_ROUTE_SHAPES[route],
  });
};
