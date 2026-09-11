import type { CompiledAgentRoute } from './types.ts';

export interface CompiledEventRouteExecution {
  readonly fallback: 'none' | 'standalone';
  readonly handler?: string;
  readonly runtime: 'shared' | 'standalone';
}

export const eventRouteExecutionFor = (route: CompiledAgentRoute): CompiledEventRouteExecution => {
  return {
    fallback: (route.handler === undefined || route.handler.view !== undefined) && route.config['fallback'] === 'standalone' ? 'standalone' : 'none',
    ...(route.handler === undefined ? {} : { handler: route.handler.provenance.relativePath }),
    runtime: (route.handler === undefined || route.handler.view !== undefined) && route.config['runtime'] === 'shared' ? 'shared' : 'standalone',
  };
};
