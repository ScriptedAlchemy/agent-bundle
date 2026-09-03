import type { AgentLayoutRouteKind } from './public.ts';
import type { CompiledAgentRoute, CompiledLayout, CompiledRouteKind } from './types.ts';

/** The route shape layout resolution needs: kind, id, and the owning server. */
export type LayoutRouteTarget = Pick<CompiledAgentRoute, 'id' | 'kind' | 'serverId'>;

/**
 * The layout chain one rendered route composes through, outermost first: the
 * root layout, then the owning server's layout. Event routes and browser App
 * routes never take a layout — events are host protocol responses and Apps
 * are browser builds — so they resolve to an empty chain. Generated workers
 * and the `agent-bundle/test` harness share this resolution so a route-unit
 * render composes exactly what the artifact composes.
 */
export const layoutChainFor = (
  route: Pick<LayoutRouteTarget, 'kind' | 'serverId'>,
  layouts: readonly CompiledLayout[],
): readonly CompiledLayout[] => {
  switch (route.kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
    case 'cli':
    case 'script':
      return [
        ...layouts.filter((layout) => layout.scope === 'root'),
        ...layouts.filter((layout) => layout.scope === 'server' && layout.serverId === route.serverId),
      ];
    case 'app':
    case 'event-route':
      return [];
    default: {
      const unreachable: never = route.kind;
      throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
    }
  }
};

/** True for the route kinds a layout wraps. */
export const isLayoutRouteKind = (kind: CompiledRouteKind): kind is AgentLayoutRouteKind => {
  switch (kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
    case 'cli':
    case 'script':
      return true;
    case 'app':
    case 'event-route':
      return false;
    default: {
      const unreachable: never = kind;
      throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
    }
  }
};

/**
 * The protocol-facing route name a layout receives: the MCP tool, resource,
 * or prompt name, the space-joined CLI command path, or the script name.
 */
export const layoutRouteName = (route: Pick<LayoutRouteTarget, 'id' | 'kind'>): string => {
  const identity = route.id.slice(route.id.indexOf(':') + 1);
  switch (route.kind) {
    case 'tool':
    case 'resource':
    case 'prompt':
    case 'app':
      return identity.slice(identity.lastIndexOf('/') + 1);
    case 'cli':
      return identity.split('/').join(' ');
    case 'script':
    case 'event-route':
      return identity;
    default: {
      const unreachable: never = route.kind;
      throw new TypeError(`Unhandled route kind ${String(unreachable)}.`);
    }
  }
};
