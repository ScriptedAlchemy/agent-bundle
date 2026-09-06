import * as AgentRuntime from '@agent-bundle/runtime';
import type { AgentRenderEvent } from '@agent-bundle/runtime';

import { renderedDocumentExitCode } from '../../cli-entry.ts';
import { isJsonRecord, type JsonObject } from '../../core/strict-json.ts';
import {
  createEventTracer,
  eventTraceExecution,
  installEventTraceObserver,
  type EventTraceEvent,
} from '../../events/trace.ts';
import { canonicalAgentEvents } from '../../routes/public.ts';
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
import { ProductionRouteInvocationError } from './route-invocation-production-error.ts';
import { renderProductionRoute } from './route-invocation-production.ts';
import { createRouteModuleLoader } from './route-module-loader.ts';

const { load } = createRouteModuleLoader();

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

const forwardEventTrace = (event: EventTraceEvent): void => {
  process.send?.({ event, type: 'trace' } satisfies RouteInvocationChildResponse);
};

/** Awaited per event so the IPC channel, not an in-child queue, paces a fast producer. */
const forwardRenderEvent = (event: AgentRenderEvent): Promise<void> =>
  respond({ event, type: 'render' });

/**
 * The exit code a generated executable would set for this unit render. There
 * is no compiled bin to ask in `unit-render`, so the same `cli-entry.ts`
 * decision the bin runs is applied to the route's policy: a routed command's
 * `exitCode` policy, `zero` for rendered scripts; a tool rendered in isolation
 * has no process surface and reports its document outcome instead.
 */
const unitRenderExitCode = (
  request: RouteInvocationChildRequest,
  document: RouteInvocationChildResult['document'],
  result: unknown,
): number | undefined => {
  const kind = request.manifest.routes[request.routeId]?.kind;
  const command = kind === 'cli'
    ? request.manifest.cliCommands.find((candidate) => candidate.routeId === request.routeId)
    : undefined;
  const policy = command?.exitCode ?? (kind === 'script' ? 'zero' : undefined);
  if (policy === undefined) return undefined;
  try {
    return renderedDocumentExitCode(policy, document, result);
  } catch {
    // A `result` policy without a valid `exitCode` is a contract failure the bin exits 1 on.
    return 1;
  }
};

const renderUnitRoute = async (request: RouteInvocationChildRequest): Promise<RouteInvocationChildResult> => {
  installManifest(request);
  const startedAt = performance.now();
  const input = request.input;
  const eventName = request.routeId.startsWith('event:')
    ? canonicalAgentEvents.find((event) => event === request.routeId.slice('event:'.length))
    : undefined;
  const nativeInput = isJsonRecord(input) ? input.native : undefined;
  const nativeEvent = nativeInput !== undefined && isJsonRecord(nativeInput) && typeof nativeInput.hook_event_name === 'string'
    ? nativeInput.hook_event_name
    : eventName;
  const host = request.context.host.state === 'available' ? request.context.host.value.name : 'workbench';
  const trace = eventName === undefined || nativeEvent === undefined
    ? undefined
    : createEventTracer({ execution: eventTraceExecution({ event: eventName, host, nativeEvent }) });
  trace?.executeStart('standalone');
  trace?.renderStart();
  let rendered: Awaited<ReturnType<typeof renderRouteEvents>>;
  try {
    rendered = await renderRouteEvents(request.routeId, {
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
    trace?.renderFinish();
  } catch (error) {
    trace?.failure('render', error);
    throw error;
  }
  // The harness drains the stream before returning, so the unit surface's
  // events reach the service after the render rather than live.
  for (const event of rendered.events) await forwardRenderEvent(event);
  const exitCode = unitRenderExitCode(request, rendered.document, rendered.result ?? rendered.document.value);
  return Object.freeze({
    document: rendered.document,
    ...(exitCode === undefined ? {} : { exitCode }),
    input,
    ...(request.manifest.routes[request.routeId]?.kind === 'tool'
      ? {
          mcp: AgentRuntime.documentToCallToolResult(rendered.document, {
            structuredContent: rendered.result,
          }) as JsonObject,
        }
      : {}),
    renderDurationMs: performance.now() - startedAt,
    ...(rendered.result === undefined ? {} : { result: rendered.result as never }),
  });
};

const render = (request: RouteInvocationChildRequest): Promise<RouteInvocationChildResult> =>
  request.surface.kind === 'unit-render'
    ? renderUnitRoute(request)
    : renderProductionRoute(request, forwardEventTrace, forwardRenderEvent);

process.once('message', (request: RouteInvocationChildRequest) => {
  const disposeTraceObserver = installEventTraceObserver(forwardEventTrace);
  void render(request)
    .then(
      (result) => respond({ result, type: 'result' }),
      (error: unknown) => respond({
        error: {
          ...(error instanceof ProductionRouteInvocationError ? { code: error.code } : {}),
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
        },
        type: 'error',
      }),
    )
    .finally(disposeTraceObserver)
    .then(() => process.disconnect?.())
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      process.disconnect?.();
    });
});
