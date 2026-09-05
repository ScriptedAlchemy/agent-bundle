import * as AgentRuntime from '@agent-bundle/runtime';
import { createJiti } from 'jiti';
import * as React from 'react';

import {
  AGENT_TEST_REGISTRY_VERSION,
  registerTestRoutes,
  type AgentLayoutModuleLoader,
  type AgentProviderModuleLoader,
  type AgentStateModuleLoader,
} from '../../test/registry.ts';
import { renderRouteEvents } from '../../test/render.ts';
import type { AgentRouteModule, AgentRouteModuleLoader } from '../../test/types.ts';
import type {
  RouteInvocationChildRequest,
  RouteInvocationChildResponse,
  RouteInvocationChildResult,
} from './route-invocation-service.ts';

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  interopDefault: false,
  jsx: { runtime: 'automatic' },
  moduleCache: false,
  nativeModules: ['typescript'],
  virtualModules: {
    '@agent-bundle/runtime': AgentRuntime,
    react: React,
  },
});

const load = <Module>(source: string): (() => Promise<Module>) =>
  async () => jiti.import<Module>(source);

const installManifest = (request: RouteInvocationChildRequest): void => {
  const manifest = request.manifest;
  registerTestRoutes({
    layoutLoaders: Object.fromEntries(
      manifest.layouts.map((layout) => [layout.id, load<Awaited<ReturnType<AgentLayoutModuleLoader>>>(layout.source)]),
    ),
    loaders: Object.fromEntries(
      Object.values(manifest.routes).map((route) => [route.id, load<AgentRouteModule>(route.source) as AgentRouteModuleLoader]),
    ),
    manifest,
    providerLoaders: Object.fromEntries(
      (manifest.providers ?? []).map((provider) => [
        provider.id,
        load<Awaited<ReturnType<AgentProviderModuleLoader>>>(provider.source),
      ]),
    ),
    ...(manifest.state === undefined
      ? {}
      : { stateLoader: load<Awaited<ReturnType<AgentStateModuleLoader>>>(manifest.state.source) }),
    version: AGENT_TEST_REGISTRY_VERSION,
  });
};

const respond = (response: RouteInvocationChildResponse): Promise<void> => new Promise((resolvePromise, rejectPromise) => {
  if (process.send === undefined) {
    rejectPromise(new Error('Route invocation child requires a Node IPC channel.'));
    return;
  }
  process.send(response, (error) => {
    if (error === null) resolvePromise();
    else rejectPromise(error);
  });
});

const render = async (request: RouteInvocationChildRequest): Promise<RouteInvocationChildResult> => {
  installManifest(request);
  const startedAt = performance.now();
  const input = request.input;
  const rendered = await renderRouteEvents(request.routeId, {
    ...(request.args === undefined ? {} : { args: request.args }),
    context: {
      actor: request.context.actor,
      host: request.context.host,
      invocation: request.context.invocation,
      lineage: request.context.lineage,
      session: request.context.session,
      workspace: request.context.workspace,
    },
    input,
    manifest: request.manifest,
  });
  return Object.freeze({
    document: rendered.document,
    events: rendered.events,
    input,
    renderDurationMs: performance.now() - startedAt,
    ...(rendered.result === undefined ? {} : { result: rendered.result as never }),
  });
};

process.once('message', (request: RouteInvocationChildRequest) => {
  void render(request)
    .then((result) => respond({ result, type: 'result' }))
    .catch((error: unknown) => respond({
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      },
      type: 'error',
    }))
    .then(() => process.disconnect?.())
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      process.disconnect?.();
    });
});
