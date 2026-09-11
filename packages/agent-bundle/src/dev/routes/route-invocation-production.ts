import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  AGENT_DOCUMENT_VERSION,
  createAgentDocument,
  createAgentRenderDispatcher,
  documentToCallToolResult,
  type AgentDocument,
  type AgentProgressReporter,
  type AgentProgressUpdate,
  type AgentRenderDispatch,
  type AgentRenderEvent,
  type AgentRenderInvocation,
} from '@agent-bundle/runtime';

import { renderedDocumentExitCode } from '../../cli-entry.ts';
import type { EventHandlerResult } from '../../events/handler.ts';
import type { EventTraceEvent, EventTraceObserver, EventTracer } from '../../events/trace.ts';
import type { JsonObject, JsonValue } from '../../core/strict-json.ts';
import { pluginRootEnvAnchor, pluginStateRootEnvAnchor } from '../../core/types.ts';
import { applyOperatorEnv } from '../../launch-env.ts';
import type {
  RouteInvocationChildRequest,
  RouteInvocationChildResult,
} from './route-invocation-service.ts';
import {
  ProductionRouteInvocationError,
  ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE,
  ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE,
  ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
} from './route-invocation-production-error.ts';
import type { RouteInvocationProvider, RouteInvocationTiming } from './route-invocation.ts';

interface CompiledCliInvocationModule {
  prepareRouteInvocation(routeId: string, argv: readonly string[]): unknown;
  /** The exit code the bin sets for this completed document (`cli-entry.ts` rules, decided by the bin). */
  routeInvocationExitCode(routeId: string, document: AgentDocument): number;
}

interface CompiledEventHandler {
  readonly gate?: EventHandlerResult;
  readonly providerObservations?: readonly Omit<WorkerMessage, 'id'>[];
  readonly native: JsonObject;
  readonly projected?: JsonObject;
  readonly props: Readonly<{ readonly canonical: JsonObject }>;
  readonly runtime: 'shared' | 'standalone';
  readonly trace?: EventTracer;
}

interface CompiledEventWrapperModule {
  prepareRouteInvocation?(
    native: JsonObject,
    signal: AbortSignal,
    observer: EventTraceObserver,
  ): Promise<CompiledEventHandler>;
}

interface WorkerMessage {
  readonly bytes?: Uint8Array;
  readonly count?: number;
  readonly durationMs?: number;
  readonly id: number;
  readonly key?: string;
  readonly message?: string;
  readonly source?: string;
  readonly status?: 'failed' | 'mounted';
  readonly type:
    | 'chunk'
    | 'complete'
    | 'end'
    | 'error'
    | 'observed-handler'
    | 'observed-provider'
    | 'observed-providers-finish'
    | 'observed-providers-start'
    | 'observed-render-finish'
    | 'observed-render-start'
    | 'progress';
  readonly update?: unknown;
}

type ProductionRequest = RouteInvocationChildRequest & Readonly<{
  readonly artifactEpoch: string;
  readonly artifactRoot: string;
  readonly production: NonNullable<RouteInvocationChildRequest['production']>;
}>;

const recordProviderObservation = (
  request: ProductionRequest,
  message: Omit<WorkerMessage, 'id'>,
  providers: RouteInvocationProvider[],
  timings: RouteInvocationTiming[],
): void => {
  if (message.key === undefined || message.status === undefined) return;
  const provider = request.manifest.providers?.find((candidate) =>
    candidate.key === message.key || candidate.relativePath === message.source);
  if (provider !== undefined) {
    providers.push(Object.freeze({
      ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
      id: provider.id,
      ...(message.message === undefined ? {} : { message: message.message }),
      name: provider.name,
      status: message.status,
    }));
    if (message.durationMs !== undefined) {
      timings.push(Object.freeze({
        durationMs: message.durationMs,
        phase: `provider:${provider.name}`,
        startedAt: new Date(Date.now() - message.durationMs).toISOString(),
      }));
    }
  }
};

const preparationFailure = (error: unknown): ProductionRouteInvocationError =>
  error instanceof ProductionRouteInvocationError
    ? error
    : new ProductionRouteInvocationError(
        ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
        `Unable to prepare the compiled route invocation: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );

const importedModule = async <Module>(path: string): Promise<Module> =>
  // Artifact modules are runtime-selected compiler output; a static import cannot name the active epoch.
  import(pathToFileURL(path).href) as Promise<Module>;

const completeDocument = (value: JsonValue | undefined): AgentDocument => createAgentDocument({
  root: {
    children: value === undefined ? [] : [{ kind: 'json', value }],
    kind: 'result',
  },
  status: 'success',
  ...(value === undefined ? {} : { value }),
  version: AGENT_DOCUMENT_VERSION,
});

const isCliInvocationModule = (module: Partial<CompiledCliInvocationModule>): module is CompiledCliInvocationModule =>
  typeof module.prepareRouteInvocation === 'function' && typeof module.routeInvocationExitCode === 'function';

interface PreparedInput {
  /** The generated bin that prepared a CLI-surface input; it also decides the run's exit code. */
  readonly cli?: CompiledCliInvocationModule;
  readonly input: JsonValue;
  readonly handler?: CompiledEventHandler;
}

const prepareInput = async (
  request: ProductionRequest,
  observeTrace: EventTraceObserver,
  signal: AbortSignal,
): Promise<PreparedInput> => {
  switch (request.production.kind) {
    case 'direct':
      return { input: request.input };
    case 'cli': {
      if (request.surface.kind !== 'cli') {
        throw new ProductionRouteInvocationError(
          ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE,
          `Manifest CLI binding does not match route surface ${JSON.stringify(request.surface.kind)}.`,
        );
      }
      const module = await importedModule<Partial<CompiledCliInvocationModule>>(
        join(request.artifactRoot, request.production.preparation),
      );
      if (!isCliInvocationModule(module)) {
        throw new ProductionRouteInvocationError(
          ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
          `Compiled CLI preparation ${JSON.stringify(request.production.preparation)} does not export the route invocation contract.`,
        );
      }
      return {
        cli: module,
        input: await module.prepareRouteInvocation(request.routeId, request.surface.args) as JsonValue,
      };
    }
    case 'event': {
      const wrapper = await importedModule<CompiledEventWrapperModule>(
        join(request.artifactRoot, request.production.preparation),
      );
      if (typeof wrapper.prepareRouteInvocation !== 'function') {
        throw new ProductionRouteInvocationError(
          ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
          `Compiled event preparation ${JSON.stringify(request.production.preparation)} does not export prepareRouteInvocation.`,
        );
      }
      const native = (request.input as { readonly native?: JsonObject }).native ?? {};
      const handler = await wrapper.prepareRouteInvocation(native, signal, observeTrace);
      return {
        input: {
          canonical: handler.props.canonical,
          native: handler.native,
          ...(handler.gate?.outcome === 'render'
            ? { renderInput: handler.gate.data }
            : {}),
        },
        handler,
      };
    }
    default: {
      const exhaustive: never = request.production;
      throw new Error(`Unsupported production binding ${String(exhaustive)}.`);
    }
  }
};

const invocationFor = (
  request: ProductionRequest,
  input: JsonValue,
): AgentRenderInvocation => {
  const route = request.manifest.routes[request.routeId];
  if (route === undefined) throw new Error(`Route ${JSON.stringify(request.routeId)} is absent from the compiled manifest.`);
  if (request.surface.kind === 'cli') {
    return {
      kind: 'cli',
      props: { args: request.surface.args, command: request.surface.command },
    };
  }
  switch (route.kind) {
    case 'cli': {
      const command = request.manifest.cliCommands.find((candidate) => candidate.routeId === request.routeId);
      if (command === undefined) throw new Error(`CLI route ${JSON.stringify(request.routeId)} has no compiled command.`);
      return { kind: 'cli', props: { args: [], command: command.path.join(' ') } };
    }
    case 'script': {
      const script = request.manifest.scripts.find((candidate) => candidate.routeId === request.routeId);
      return { kind: 'script', props: { input: [], name: script?.name ?? request.routeId } };
    }
    case 'event-route':
      return {
        kind: 'event',
        props: {
          event: route.event!,
          payload: input as never,
        },
      };
    case 'prompt':
    case 'resource':
    case 'tool':
      return { kind: 'tool', props: { input: input as never, operationId: request.routeId } };
    case 'app':
      throw new Error('MCP App routes are not invocable through the route execution boundary.');
    default: {
      const exhaustive: never = route.kind;
      throw new Error(`Unsupported route kind ${String(exhaustive)}.`);
    }
  }
};

const streamFromWorker = (
  workerPath: string,
  request: ProductionRequest,
  invocation: AgentRenderInvocation,
  input: JsonValue,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  trace?: EventTracer,
): Readonly<{
  readonly close: () => Promise<void>;
  readonly events: ReadableStream<AgentRenderEvent>;
  readonly observed: {
    readonly providers: readonly RouteInvocationProvider[];
    readonly timings: readonly RouteInvocationTiming[];
  };
}> => {
  const worker = new Worker(pathToFileURL(workerPath), {
    env,
    stderr: true,
    stdout: true,
  });
  worker.stdout?.on('data', (chunk) => process.stderr.write(chunk));
  worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  let sequence = 0;
  const providers: RouteInvocationProvider[] = [];
  const timings: RouteInvocationTiming[] = [];
  const pending = new Map<number, {
    readonly abort: () => void;
    readonly controller: ReadableStreamDefaultController<Uint8Array>;
    readonly dispatchSignal: AbortSignal;
    readonly progress: AgentProgressReporter | undefined;
  }>();
  const failAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.dispatchSignal.removeEventListener('abort', entry.abort);
      entry.controller.error(error);
    }
  };
  worker.on('error', failAll);
  worker.on('exit', (code) => {
    if (pending.size > 0) failAll(new Error(`Compiled route worker exited with code ${String(code)}.`));
  });
  worker.on('message', (message: WorkerMessage) => {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    if (message.type === 'progress') {
      // The route's reported progress becomes `progress` render events through
      // the dispatcher's reporter, as the generated CLI session forwards it.
      Promise.resolve()
        .then(() => entry.progress?.report(message.update as AgentProgressUpdate))
        .catch((error: unknown) => {
          pending.delete(message.id);
          entry.dispatchSignal.removeEventListener('abort', entry.abort);
          entry.controller.error(error);
        });
      return;
    }
    if (message.type === 'observed-providers-start') {
      trace?.providersStart();
      return;
    }
    if (message.type === 'observed-providers-finish') {
      trace?.providersFinish(message.count ?? 0);
      if (message.durationMs !== undefined) {
        timings.push(Object.freeze({
          durationMs: message.durationMs,
          phase: 'providers',
          startedAt: new Date(Date.now() - message.durationMs).toISOString(),
        }));
      }
      return;
    }
    if (message.type === 'observed-render-start') {
      trace?.renderStart();
      return;
    }
    if (message.type === 'observed-provider') {
      recordProviderObservation(request, message, providers, timings);
      return;
    }
    if (
      (message.type === 'observed-handler' || message.type === 'observed-render-finish')
      && message.durationMs !== undefined
    ) {
      if (message.type === 'observed-render-finish') trace?.renderFinish();
      timings.push(Object.freeze({
        durationMs: message.durationMs,
        phase: message.type === 'observed-handler' ? 'handler' : 'render',
        startedAt: new Date(Date.now() - message.durationMs).toISOString(),
      }));
      return;
    }
    if (message.type === 'chunk' && message.bytes !== undefined) {
      entry.controller.enqueue(message.bytes);
      return;
    }
    pending.delete(message.id);
    entry.dispatchSignal.removeEventListener('abort', entry.abort);
    // `complete` is the whole render in one message from a Flight worker
    // compiled before #718; the epoch store restores such artifacts across
    // dev-server restarts until the project rebuilds.
    if (message.type === 'complete' && message.bytes !== undefined) entry.controller.enqueue(message.bytes);
    if (message.type === 'end' || message.type === 'complete') {
      entry.controller.close();
      return;
    }
    entry.controller.error(new Error(message.message ?? 'Compiled route worker failed.'));
  });
  const host = Object.freeze({
    execute: async (dispatch: AgentRenderDispatch): Promise<ReadableStream<Uint8Array>> => {
      const id = ++sequence;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const cancelRender = (): void => {
        worker.postMessage({ id, type: 'cancel' });
        pending.delete(id);
      };
      const abort = (): void => {
        cancelRender();
        controller.error(new DOMException('Agent render was aborted.', 'AbortError'));
      };
      // The dispatcher cancels the stream when its session closes, which can
      // precede the worker's `end`; dropping the entry keeps later chunks off
      // the closed controller.
      const stream = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelRender();
          dispatch.signal.removeEventListener('abort', abort);
        },
        start: (opened) => { controller = opened; },
      });
      pending.set(id, { abort, controller, dispatchSignal: dispatch.signal, progress: dispatch.progress });
      dispatch.signal.addEventListener('abort', abort, { once: true });
      worker.postMessage({
        actor: request.context.actor,
        artifactEpoch: request.artifactEpoch,
        host: request.context.host,
        id,
        invocation: dispatch.invocation,
        lineage: request.context.lineage,
        observe: true,
        props: routeProps(request, input),
        request: request.context.invocation,
        requestInvocation: request.context.invocation,
        routeId: request.routeId,
        session: request.context.session,
        terminal: { reason: 'not-provided', state: 'unavailable' },
        type: 'render',
        validateInput: true,
        workspace: request.context.workspace,
      });
      return stream;
    },
  });
  const dispatcher = createAgentRenderDispatcher(host);
  return Object.freeze({
    close: async () => { await worker.terminate(); },
    events: dispatcher.stream({ artifactEpoch: request.artifactEpoch, invocation, signal }),
    observed: { providers, timings },
  });
};

const routeProps = (request: ProductionRequest, input: JsonValue): Readonly<Record<string, unknown>> => {
  const kind = request.manifest.routes[request.routeId]?.kind;
  if (kind === 'script') return { argv: [] };
  return kind === 'event-route'
    ? {
        canonical: (input as { readonly canonical?: unknown }).canonical,
        native: (input as { readonly native?: unknown }).native,
        ...((input as { readonly renderInput?: unknown }).renderInput === undefined
          ? {}
          : { renderInput: (input as { readonly renderInput: unknown }).renderInput }),
      }
    : { input };
};

/**
 * Drives one compiled worker's render stream. Each event is handed to
 * `publishRender` as it arrives and then dropped; only the `complete` event's
 * document is kept, so the producer holds one document, not the stream.
 */
const renderCompiled = async (
  request: ProductionRequest,
  input: JsonValue,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  trace?: EventTracer,
  publishRender?: (event: AgentRenderEvent) => Promise<void> | void,
): Promise<Readonly<{
  readonly document: AgentDocument;
  readonly durationMs: number;
  readonly observed: {
    readonly providers: readonly RouteInvocationProvider[];
    readonly timings: readonly RouteInvocationTiming[];
  };
}>> => {
  const invocation = invocationFor(request, input);
  const startedAt = performance.now();
  const session = streamFromWorker(
    join(request.artifactRoot, request.production.executable),
    request,
    invocation,
    input,
    signal,
    env,
    trace,
  );
  let document: AgentDocument | undefined;
  try {
    const reader = session.events.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.type === 'complete') document = next.value.document;
      await publishRender?.(next.value);
    }
    if (document === undefined) throw new Error('Compiled route render ended without a complete event.');
    return Object.freeze({
      document,
      durationMs: performance.now() - startedAt,
      observed: {
        providers: Object.freeze([...session.observed.providers]),
        timings: Object.freeze([...session.observed.timings]),
      },
    });
  } finally {
    await session.close();
  }
};

export const renderProductionRoute = async (
  request: RouteInvocationChildRequest,
  publishTrace?: EventTraceObserver,
  publishRender?: (event: AgentRenderEvent) => Promise<void> | void,
): Promise<RouteInvocationChildResult> => {
  if (
    request.artifactEpoch === undefined
    || request.artifactRoot === undefined
    || request.production === undefined
  ) {
    throw new ProductionRouteInvocationError(
      ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE,
      'Production route invocation requires a manifest-selected published artifact executable.',
    );
  }
  const productionRequest = request as ProductionRequest;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pluginRootEnvAnchor]: productionRequest.artifactRoot,
    [pluginStateRootEnvAnchor]: productionRequest.stateRoot,
  };
  applyOperatorEnv({ env, pluginRoot: productionRequest.artifactRoot });
  const traceEvents: EventTraceEvent[] = [];
  const observeTrace: EventTraceObserver = (event) => {
    traceEvents.push(event);
    publishTrace?.(event);
  };
  const controller = new AbortController();
  let prepared: PreparedInput;
  try {
    prepared = await prepareInput(productionRequest, observeTrace, controller.signal);
  } catch (error) {
    throw preparationFailure(error);
  }
  const handlerProviders: RouteInvocationProvider[] = [];
  const handlerTimings: RouteInvocationTiming[] = [];
  for (const observation of prepared.handler?.providerObservations ?? []) {
    recordProviderObservation(productionRequest, observation, handlerProviders, handlerTimings);
  }
  if (
    prepared.handler?.gate !== undefined
    && prepared.handler.gate.outcome !== 'render'
  ) {
    const value = prepared.handler.gate as JsonValue;
    return Object.freeze({
      document: completeDocument(value),
      observed: { providers: handlerProviders, timings: handlerTimings },
      input: prepared.input,
      result: value,
      trace: Object.freeze(traceEvents),
    });
  }
  if (prepared.handler !== undefined) {
    prepared.handler.trace?.executeStart(prepared.handler.runtime);
  }
  try {
    const rendered = await renderCompiled(
      productionRequest,
      prepared.input,
      controller.signal,
      env,
      prepared.handler?.trace,
      publishRender,
    );
    const result = rendered.document.value;
    const kind = request.manifest.routes[request.routeId]?.kind;
    // A process surface records the exit code its generated executable sets:
    // the bin's own decision for CLI surfaces; the rendered-script envelope's
    // fixed `zero` policy (`runGeneratedRenderedScript`) for rendered scripts.
    const exitCode = prepared.cli !== undefined
      ? prepared.cli.routeInvocationExitCode(request.routeId, rendered.document)
      : kind === 'script'
        ? renderedDocumentExitCode('zero', rendered.document, result)
        : undefined;
    return Object.freeze({
      document: rendered.document,
      ...(exitCode === undefined ? {} : { exitCode }),
      input: prepared.input,
      ...(kind === 'tool'
        ? { mcp: documentToCallToolResult(rendered.document, { structuredContent: result }) as JsonObject }
        : {}),
      observed: {
        providers: [...handlerProviders, ...rendered.observed.providers],
        timings: [...handlerTimings, ...rendered.observed.timings],
      },
      renderDurationMs: rendered.durationMs,
      ...(result === undefined ? {} : { result }),
      trace: Object.freeze(traceEvents),
    });
  } catch (error) {
    prepared.handler?.trace?.failure('render', error);
    throw error;
  }
};
