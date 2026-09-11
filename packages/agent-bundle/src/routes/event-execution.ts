import type { CompiledAgentRoute } from './types.ts';

export interface CompiledEventRouteExecution {
  readonly fallback: 'none' | 'standalone';
  readonly preflight?: string;
  readonly runtime: 'shared' | 'standalone';
}

export const eventRouteExecutionFor = (route: CompiledAgentRoute): CompiledEventRouteExecution => {
  return {
    fallback: route.preflight?.mode !== 'handler' && route.config['fallback'] === 'standalone' ? 'standalone' : 'none',
    ...(route.preflight === undefined ? {} : { preflight: route.preflight.provenance.relativePath }),
    runtime: route.preflight?.mode !== 'handler' && route.config['runtime'] === 'shared' ? 'shared' : 'standalone',
  };
};
