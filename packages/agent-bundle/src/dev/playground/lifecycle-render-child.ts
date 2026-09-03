import * as AgentRuntime from '@agent-bundle/runtime';
import { createJiti } from 'jiti';
import * as React from 'react';

import { createCanonicalEventProps } from '../../events/project.ts';
import { renderRouteEvents } from '../../test/render.ts';
import type { AgentRouteModule } from '../../test/types.ts';
import type {
  LifecycleRenderChildRequest,
  LifecycleRenderChildResponse,
} from './lifecycle-render-protocol.ts';

const importRouteModule = async (source: string): Promise<AgentRouteModule> => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    interopDefault: false,
    jsx: { runtime: 'classic' },
    moduleCache: false,
    nativeModules: ['typescript'],
    virtualModules: {
      '@agent-bundle/runtime': AgentRuntime,
      react: React,
    },
  });
  return jiti.import<AgentRouteModule>(source);
};

const respond = (response: LifecycleRenderChildResponse): Promise<void> => new Promise((resolve, reject) => {
  if (process.send === undefined) {
    reject(new Error('Lifecycle render child requires a Node IPC channel.'));
    return;
  }
  process.send(response, (error) => {
    if (error === null) resolve();
    else reject(error);
  });
});

const disconnect = (): void => {
  process.disconnect?.();
};

const render = async (request: LifecycleRenderChildRequest): Promise<LifecycleRenderChildResponse> => {
  try {
    const props = createCanonicalEventProps(
      request.event,
      request.nativeInput,
      request.target,
      request.nativeEvent,
      request.hostContractRevision,
      new AbortController().signal,
    );
    const module = await importRouteModule(request.routeSource);
    const rendered = await renderRouteEvents(module, {
      context: {
        actor: request.requestContext.actor,
        host: request.requestContext.host,
        invocation: {
          ...(request.requestContext.invocation.hostContractRevision === undefined
            ? {}
            : { hostContractRevision: request.requestContext.invocation.hostContractRevision }),
          ...(request.requestContext.invocation.operationId === undefined
            ? {}
            : { operationId: request.requestContext.invocation.operationId }),
          ...(request.requestContext.invocation.surface === undefined
            ? {}
            : { surface: request.requestContext.invocation.surface }),
        },
        lineage: request.requestContext.lineage,
        session: request.requestContext.session,
        workspace: request.requestContext.workspace,
      },
      input: props,
      kind: 'event-route',
      routeId: request.routeId,
    });
    return Object.freeze({
      result: Object.freeze({
        canonical: props.canonical,
        document: rendered.document,
        events: rendered.events,
      }),
      type: 'result',
    });
  } catch (error) {
    return Object.freeze({
      error: Object.freeze({
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : 'Error',
      }),
      type: 'error',
    });
  }
};

process.once('message', (request: LifecycleRenderChildRequest) => {
  void render(request)
    .then(respond)
    .then(disconnect)
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      disconnect();
    });
});
