import type { CompiledAgentRoute } from './types.ts';

export interface CompiledEventRouteExecution {
  readonly fallback: 'none' | 'standalone';
  readonly preflight?: string;
  readonly providers?: readonly string[];
  readonly runtime: 'shared' | 'standalone';
}

export const eventRouteExecutionFor = (route: CompiledAgentRoute): CompiledEventRouteExecution => {
  const configuredProviders = route.config['providers'];
  const providers = Array.isArray(configuredProviders)
    && configuredProviders.every((provider): provider is string => typeof provider === 'string')
    ? [...configuredProviders]
    : undefined;
  return {
    fallback: route.config['fallback'] === 'standalone' ? 'standalone' : 'none',
    ...(route.preflight === undefined ? {} : { preflight: route.preflight.provenance.relativePath }),
    ...(providers === undefined ? {} : { providers }),
    runtime: route.config['runtime'] === 'standalone' ? 'standalone' : 'shared',
  };
};
