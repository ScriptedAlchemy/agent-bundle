/**
 * Canonical generated MCP route ids are `<kind>:<server>/<name>`
 * (`tool:hauler/hauler_status`). Generated servers register the final segment
 * as the wire name and have no name override.
 *
 * Zero-import leaf so compiler, test harness, and a browser App client share
 * one derivation without pulling Node, Zod, or the route graph.
 */

/** MCP route kinds whose generated id is `<kind>:<server>/<name>`. */
export const mcpRouteProtocolKinds = Object.freeze(['app', 'prompt', 'resource', 'tool'] as const);

export type McpRouteProtocolKind = (typeof mcpRouteProtocolKinds)[number];

export interface McpRouteProtocolIdentity {
  readonly kind: McpRouteProtocolKind;
  readonly name: string;
  readonly server: string;
}

const isMcpRouteProtocolKind = (value: string): value is McpRouteProtocolKind => {
  switch (value) {
    case 'app':
    case 'prompt':
    case 'resource':
    case 'tool':
      return true;
    default:
      return false;
  }
};

/**
 * Parse a canonical generated MCP route id (`<kind>:<server>/<name>`).
 * Returns `undefined` when the id is not that shape.
 */
export const parseMcpRouteProtocolId = (routeId: string): McpRouteProtocolIdentity | undefined => {
  const colon = routeId.indexOf(':');
  if (colon <= 0 || routeId.indexOf(':', colon + 1) !== -1) return undefined;
  const kind = routeId.slice(0, colon);
  if (!isMcpRouteProtocolKind(kind)) return undefined;
  const rest = routeId.slice(colon + 1);
  const slash = rest.indexOf('/');
  if (slash <= 0 || rest.indexOf('/', slash + 1) !== -1) return undefined;
  const server = rest.slice(0, slash);
  const name = rest.slice(slash + 1);
  if (name === '') return undefined;
  return { kind, name, server };
};

/**
 * The protocol name a generated MCP server registers — the final id segment.
 * Throws when `routeId` is not a canonical generated MCP route id.
 */
export const mcpRouteProtocolName = (routeId: string): string => {
  const parsed = parseMcpRouteProtocolId(routeId);
  if (parsed === undefined) {
    throw new TypeError(
      `Expected a canonical MCP route id (<kind>:<server>/<name>); got ${JSON.stringify(routeId)}.`,
    );
  }
  return parsed.name;
};
