import type { AgentLayoutProps } from '@agent-bundle/runtime';
import type { createElement as CreateElement } from 'react';

import type { AgentLayoutRoute } from '../routes/public.ts';
import { isLayoutRouteKind, layoutChainFor, layoutRouteName } from '../routes/layouts.ts';
import type { CompiledLayout, CompiledRouteKind } from '../routes/types.ts';
import { AgentTestError } from './errors.ts';
import type { AgentBundleTestManifest, TestableLayoutDescriptor } from './manifest.ts';
import { registeredLayoutLoader } from './registry.ts';
import type { AgentLayoutModule, RenderedRouteProvenance } from './types.ts';

/** One loaded layout in a route's chain, outermost first. */
export interface LoadedLayout {
  readonly descriptor: TestableLayoutDescriptor;
  readonly module: AgentLayoutModule;
}

/** The manifest route a layout chain is resolved for. */
export interface LayoutChainTarget {
  readonly id: string;
  readonly kind: CompiledRouteKind;
  readonly serverId?: string;
}

const compiledLayoutOf = (descriptor: TestableLayoutDescriptor): CompiledLayout => ({
  id: descriptor.id,
  provenance: { kind: 'conventional', relativePath: descriptor.relativePath },
  scope: descriptor.scope,
  ...(descriptor.serverId === undefined ? {} : { serverId: descriptor.serverId }),
  source: descriptor.source,
});

/**
 * Loads the layout chain the manifest declares for one route, through the
 * loaders the generated Rstest setup registered. This is the same resolution
 * generated workers bake at build time (`layoutChainFor`), so a route-unit or
 * projection render composes exactly the artifact's layout chain. A module
 * rendered directly (no manifest) has no chain: layouts are a compiler
 * convention, not a property of a module.
 */
export const loadLayoutChain = async (
  manifest: AgentBundleTestManifest,
  route: LayoutChainTarget,
  provenance: RenderedRouteProvenance,
): Promise<readonly LoadedLayout[]> => {
  if (manifest.layouts.length === 0) return [];
  const compiled = manifest.layouts.map(compiledLayoutOf);
  const chain = layoutChainFor(route, compiled);
  return Promise.all(chain.map(async (layout) => {
    const descriptor = manifest.layouts.find((candidate) => candidate.id === layout.id)!;
    const loader = registeredLayoutLoader(manifest, layout.id);
    if (loader === undefined) {
      throw new AgentTestError(
        'manifest-unavailable',
        `Layout ${layout.id} wraps route ${route.id} but no test-time layout loader is registered for it.`,
        {
          provenance,
          recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers layout loaders.',
        },
      );
    }
    const module = await loader();
    if (typeof module.default !== 'function') {
      throw new AgentTestError(
        'invalid-route-module',
        `Layout ${layout.id} (${descriptor.relativePath}) must default-export a function component.`,
        {
          details: [`received:     default export of type ${typeof module.default}`],
          provenance,
          recovery: 'Default-export one function component receiving { children, route, signal } that renders Agent.Result around children.',
        },
      );
    }
    return { descriptor, module };
  }));
};

/**
 * The Flight root for one route render, composed exactly as the generated
 * workers compose it. Without a chain the route component is the root, byte
 * for byte as before. With a chain, one root component awaits the route's
 * element and wraps it from the innermost layout outward with the route's
 * stable identity and the request signal — so a throwing route still rejects
 * the root and fails the render, rather than degrading into a represented
 * boundary error under the layout's shell.
 */
export const composeLayouts = (
  createElement: typeof CreateElement,
  chain: readonly LoadedLayout[],
  route: LayoutChainTarget,
  component: (props: never) => unknown,
  props: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): unknown => {
  if (chain.length === 0 || !isLayoutRouteKind(route.kind)) return createElement(component as never, props as never);
  const identity: AgentLayoutRoute = {
    id: route.id,
    kind: route.kind,
    name: layoutRouteName(route),
    ...(route.serverId === undefined ? {} : { serverId: route.serverId }),
  };
  const Composed = async (): Promise<unknown> => {
    let composed: unknown = await component(props as never);
    for (const layout of [...chain].reverse()) {
      const layoutProps: AgentLayoutProps = { children: composed as never, route: identity, signal };
      composed = createElement(layout.module.default as never, layoutProps as never);
    }
    return composed;
  };
  return createElement(Composed as never);
};
