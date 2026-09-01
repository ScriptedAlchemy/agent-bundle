import type { CompiledRouteGraph } from './types.ts';

/**
 * The route focus of `agent-bundle inspect` dumps the compiler IR itself:
 * like the bundler focus, the full graph is the debugging document, so the
 * inspection type is the graph type. The alias keeps the inspection contract
 * stable if a later release decorates the dump.
 */
export type RouteGraphInspection = CompiledRouteGraph;

export const inspectRouteGraph = (graph: CompiledRouteGraph): RouteGraphInspection => graph;
