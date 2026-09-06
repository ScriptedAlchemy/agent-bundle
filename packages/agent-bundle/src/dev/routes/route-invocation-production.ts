import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import {
  AGENT_DOCUMENT_VERSION,
  createAgentDocument,
  createAgentRenderDispatcher,
  documentToCallToolResult,
  type AgentDocument,
  type AgentRenderEvent,
  type AgentRenderInvocation,
} from '@agent-bundle/runtime';

import { artifactManifestName } from '../../build/manifest.ts';
import { readArtifactManifest } from '../../build/manifest-file.ts';
import { renderedDocumentExitCode } from '../../cli-entry.ts';
import type { EventPreflightResult } from '../../events/preflight.ts';
import type { EventTraceEvent, EventTraceObserver, EventTracer } from '../../events/trace.ts';
import type { JsonObject, JsonValue } from '../../core/strict-json.ts';
import { pluginRootEnvAnchor, pluginStateRootEnvAnchor } from '../../core/types.ts';
import { applyOperatorEnv } from '../../launch-env.ts';
import type {
  RouteInvocationChildRequest,
  RouteInvocationChildResult,
} from './route-invocation-service.ts';
import { resolveRouteExecutable, type RouteExecutableBinding } from './route-invocation-executable.ts';
import {
  ProductionRouteInvocationError,
  ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE,
  ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
} from './route-invocation-production-error.ts';
import type { RouteInvocationProvider, RouteInvocationTiming } from './route-invocation.ts';

interface CompiledCliInvocationModule {
  prepareRouteInvocation(routeId: string, argv: readonly string[]): unknown;
  /** The exit code the bin sets for this completed document (`cli-entry.ts` rules, decided by the bin). */
  routeInvocationExitCode(routeId: string, document: AgentDocument): number;
}

interface CompiledEventPreflight {
  readonly gate: EventPreflightResult;
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
  ): Promise<CompiledEventPreflight>;
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
}>;

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
  readonly preflight?: CompiledEventPreflight;
}

/**
 * Binds the route's executables from the published artifact manifest before
 * anything runs. The manifest is the #604 contract: a root without a
 * readable, canonical manifest is not a published artifact (`AB8250`), and a
 * route the manifest does not compile has no executable (`AB8251`).
 */
const bindExecutable = async (request: ProductionRequest): Promise<RouteExecutableBinding> => {
  const read = await readArtifactManifest(request.artifactRoot);
  if (read.status !== 'ok') {
    throw new ProductionRouteInvocationError(
      ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE,
      read.status === 'missing'
        ? `The published artifact at ${read.root} has no ${artifactManifestName}.`
        : `The published artifact manifest at ${read.path} is not readable: ${read.detail}`,
    );
  }
  return resolveRouteExecutable({
    artifactRoot: request.artifactRoot,
    manifest: read.manifest,
    routeId: request.routeId,
    surface: request.surface,
  });
};

/**
 * Runs the bound bin or wrapper's own preparation. Each is the module the
 * manifest named, so a bound module that does not export the preparation
 * contract is a broken artifact, not a cue to look elsewhere: the run fails
 * before the handler (`AB8252`).
 */
const prepareInput = async (
  request: ProductionRequest,
  binding: RouteExecutableBinding,
  observeTrace: EventTraceObserver,
  signal: AbortSignal,
): Promise<PreparedInput> => {
  if (binding.bin !== undefined) {
    const module = await importedModule<Partial<CompiledCliInvocationModule>>(binding.bin);
    if (!isCliInvocationModule(module)) {
      throw new ProductionRouteInvocationError(
        ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
        `Routed CLI bin ${binding.bin} does not export the route invocation contract.`,
      );
    }
    // A bin is bound for a CLI surface only (`resolveRouteExecutable`).
    const args = request.surface.kind === 'cli' ? request.surface.args : [];
    return {
      cli: module,
      input: module.prepareRouteInvocation(request.routeId, args) as JsonValue,
    };
  }
  if (binding.wrapper === undefined) return { input: request.input };
  const wrapper = await importedModule<CompiledEventWrapperModule>(binding.wrapper);
  if (typeof wrapper.prepareRouteInvocation !== 'function') {
    throw new ProductionRouteInvocationError(
      ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
      `Event wrapper ${binding.wrapper} does not export the route invocation preparation contract.`,
    );
  }
  const native = (request.input as { readonly native?: JsonObject }).native ?? {};
  const preflight = await wrapper.prepareRouteInvocation(native, signal, observeTrace);
  return {
    input: {
      canonical: preflight.props.canonical,
      native: preflight.native,
      ...(preflight.gate !== 'execute' && preflight.gate.outcome === 'execute'
        ? { preflight: preflight.gate.data }
        : {}),
    },
    preflight,
  };
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
    if (message.type === 'progress') return;
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
    if (message.type === 'observed-provider' && message.key !== undefined && message.status !== undefined) {
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
    if (message.type === 'complete' && message.bytes !== undefined) {
      entry.controller.enqueue(message.bytes);
      entry.controller.close();
      return;
    }
    if (message.type === 'end') {
      entry.controller.close();
      return;
    }
    entry.controller.error(new Error(message.message ?? 'Compiled route worker failed.'));
  });
  const host = Object.freeze({
    execute: async (dispatch: Readonly<{
      readonly invocation: AgentRenderInvocation;
      readonly signal: AbortSignal;
    }>): Promise<ReadableStream<Uint8Array>> => {
      const id = ++sequence;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start: (opened) => { controller = opened; } });
      const abort = (): void => {
        worker.postMessage({ id, type: 'cancel' });
        controller.error(new DOMException('Agent render was aborted.', 'AbortError'));
      };
      pending.set(id, { abort, controller, dispatchSignal: dispatch.signal });
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
        ...((input as { readonly preflight?: unknown }).preflight === undefined
          ? {}
          : { preflight: (input as { readonly preflight: unknown }).preflight }),
      }
    : { input };
};

/**
 * Renders the route in the one worker the manifest bound. A failure inside
 * it — a handler throw, a worker crash, a route the worker turns out not to
 * register — is this invocation's failure; no other executable is tried.
 */
const renderCompiled = async (
  request: ProductionRequest,
  workerPath: string,
  input: JsonValue,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv,
  trace?: EventTracer,
  publishRender?: (event: AgentRenderEvent) => void,
): Promise<Readonly<{
  readonly document: AgentDocument;
  readonly durationMs: number;
  readonly events: readonly AgentRenderEvent[];
  readonly observed: {
    readonly providers: readonly RouteInvocationProvider[];
    readonly timings: readonly RouteInvocationTiming[];
  };
}>> => {
  const invocation = invocationFor(request, input);
  const startedAt = performance.now();
  const session = streamFromWorker(workerPath, request, invocation, input, signal, env, trace);
  const events: AgentRenderEvent[] = [];
  try {
    const reader = session.events.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      events.push(next.value);
      publishRender?.(next.value);
    }
    const complete = events.findLast((event) => event.type === 'complete');
    if (complete === undefined) throw new Error('Compiled route render ended without a complete event.');
    return Object.freeze({
      document: complete.document,
      durationMs: performance.now() - startedAt,
      events: Object.freeze(events),
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
  publishRender?: (event: AgentRenderEvent) => void,
): Promise<RouteInvocationChildResult> => {
  if (request.artifactEpoch === undefined || request.artifactRoot === undefined) {
    throw new ProductionRouteInvocationError(
      ROUTE_INVOCATION_ARTIFACT_UNAVAILABLE_CODE,
      'Production route invocation requires a published artifact.',
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
  const binding = await bindExecutable(productionRequest);
  let prepared: PreparedInput;
  try {
    prepared = await prepareInput(productionRequest, binding, observeTrace, controller.signal);
  } catch (error) {
    throw preparationFailure(error);
  }
  if (
    prepared.preflight !== undefined
    && prepared.preflight.gate !== 'execute'
    && prepared.preflight.gate.outcome !== 'execute'
  ) {
    const value = prepared.preflight.gate as JsonValue;
    return Object.freeze({
      document: completeDocument(value),
      events: Object.freeze([]),
      input: prepared.input,
      result: value,
      trace: Object.freeze(traceEvents),
    });
  }
  if (prepared.preflight !== undefined) {
    prepared.preflight.trace?.executeStart(prepared.preflight.runtime);
  }
  try {
    const rendered = await renderCompiled(
      productionRequest,
      binding.worker,
      prepared.input,
      controller.signal,
      env,
      prepared.preflight?.trace,
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
      events: rendered.events,
      ...(exitCode === undefined ? {} : { exitCode }),
      input: prepared.input,
      ...(kind === 'tool'
        ? { mcp: documentToCallToolResult(rendered.document, { structuredContent: result }) as JsonObject }
        : {}),
      observed: {
        providers: rendered.observed.providers,
        timings: rendered.observed.timings,
      },
      renderDurationMs: rendered.durationMs,
      ...(result === undefined ? {} : { result }),
      trace: Object.freeze(traceEvents),
    });
  } catch (error) {
    prepared.preflight?.trace?.failure('render', error);
    throw error;
  }
};
