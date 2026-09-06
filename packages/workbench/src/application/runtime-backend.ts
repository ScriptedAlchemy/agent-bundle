import type {
  DevRuntimeInvocationRequest,
  DevRuntimeRun,
  DevRuntimeSurface,
} from '../../../agent-bundle/src/contracts/runtime.ts';
import type {
  RouteInvocation,
  RouteInvocationKind,
  RouteInvocationOutcome,
  RouteInvocationRequest,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import type { AgentRenderEvent } from '../runtime/agent-document-client.ts';
import type {
  RuntimeModel,
  RuntimeModelAction,
} from '../runtime-model.ts';
import type { RuntimePlaygroundController } from '../runtime-controller.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';
import { InvocationClientError } from './invocation-client.ts';
import { invocationSummaryOf } from './invocation-model.ts';

export interface RuntimeInvocationClient {
  createRun(request: DevRuntimeInvocationRequest): Promise<DevRuntimeRun>;
  readRun(runId: string): Promise<DevRuntimeRun>;
  readRunDocument(
    runId: string,
    signal?: AbortSignal,
  ): Promise<readonly AgentRenderEvent[]>;
}

export interface RuntimeBackendOptions {
  readonly runtimeClient: RuntimeInvocationClient;
  readonly controller: RuntimePlaygroundController;
}

const unavailable = () =>
  Object.freeze({ reason: 'unsupported-surface' as const, state: 'unavailable' as const });

const routeKindFor = (leaf: ApplicationLeaf): RouteInvocationKind | undefined => {
  switch (leaf.ref.kind) {
    case 'tool':
      return 'tool';
    case 'resource':
      return 'resource';
    case 'event':
      return 'event-route';
    case 'app':
    case 'prompt':
    case 'cli':
    case 'script':
    case 'skill':
    case 'command':
    case 'rule':
      return undefined;
    default: {
      const exhaustive: never = leaf.ref;
      return exhaustive;
    }
  }
};

const surfaceMatches = (
  surface: DevRuntimeSurface,
  leaf: ApplicationLeaf,
): boolean => {
  switch (leaf.ref.kind) {
    case 'tool':
      return surface.kind === 'mcp-tool' && surface.id === `mcp.${leaf.ref.name}`;
    case 'resource':
      return surface.kind === 'mcp-resource' && surface.id === `mcp.${leaf.ref.name}`;
    case 'event':
      return surface.kind === 'hook';
    case 'app':
    case 'prompt':
    case 'cli':
    case 'script':
    case 'skill':
    case 'command':
    case 'rule':
      return false;
    default: {
      const exhaustive: never = leaf.ref;
      return exhaustive;
    }
  }
};

const selectedSurface = (
  surfaces: readonly DevRuntimeSurface[],
  leaf: ApplicationLeaf,
  request?: RouteInvocationRequest,
): DevRuntimeSurface | undefined => {
  if (
    request?.surface !== undefined
    && request.surface.kind !== 'mcp'
    && request.surface.kind !== 'event'
  ) return undefined;
  const matches = surfaces.filter((surface) => surfaceMatches(surface, leaf));
  const host = request?.surface?.kind === 'event' ? request.surface.host : undefined;
  return host === undefined
    ? matches[0]
    : matches.find((surface) =>
      surface.id === `hook.${host}` || surface.targets.includes(host)) ?? matches[0];
};

const selectedTarget = (
  surface: DevRuntimeSurface,
  request: RouteInvocationRequest,
): string | undefined => {
  const host = request.surface?.kind === 'event' ? request.surface.host : undefined;
  if (host !== undefined && surface.targets.includes(host)) return host;
  if (
    surface.defaultTarget !== undefined &&
    surface.targets.includes(surface.defaultTarget)
  ) {
    return surface.defaultTarget;
  }
  return surface.targets[0];
};

const diagnosticFor = (
  diagnostic: Extract<DevRuntimeRun, { readonly status: 'failed' }>['diagnostics'][number],
) => Object.freeze({
  code: diagnostic.code,
  message: diagnostic.message,
  severity: diagnostic.severity,
  target: diagnostic.phase,
});

const documentFor = (
  events: readonly AgentRenderEvent[],
): RouteInvocation['document'] => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    switch (event.type) {
      case 'shell':
      case 'replace':
      case 'complete':
        return event.document;
      case 'progress':
      case 'error':
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  return undefined;
};

const invocationKind = (kind: RouteInvocationKind) => {
  switch (kind) {
    case 'tool':
      return 'tool' as const;
    case 'event-route':
      return 'event' as const;
    case 'cli':
      return 'cli' as const;
    case 'script':
      return 'script' as const;
    case 'prompt':
    case 'resource':
      return 'workbench' as const;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

/**
 * The runtime backend has no process surface and no MCP projection, so the
 * document's own status is the whole verdict when present. A succeeded
 * runtime run without document events is still a completed successful
 * boundary, so it carries the success outcome required by the wire invariant.
 */
const outcomeForRun = (
  run: Exclude<DevRuntimeRun, { readonly status: 'running' }>,
  document: RouteInvocation['document'],
): RouteInvocationOutcome | undefined => {
  if (run.status !== 'succeeded') return undefined;
  return document === undefined || document.status === 'success'
    ? Object.freeze({ kind: 'success' })
    : Object.freeze({ kind: 'represented-error', summary: `The document reports status ${document.status}.` });
};

const completedRun = (
  run: DevRuntimeRun,
): Exclude<DevRuntimeRun, { readonly status: 'running' }> => {
  if (run.status === 'running') {
    throw new InvocationClientError(
      'AB8230',
      'Runtime returned a run before it reached a terminal state.',
    );
  }
  return run;
};

const invocationForRun = (
  runValue: DevRuntimeRun,
  leaf: ApplicationLeaf,
  events: readonly AgentRenderEvent[],
  correlationId?: string,
): RouteInvocation => {
  const run = completedRun(runValue);
  const kind = routeKindFor(leaf);
  if (kind === undefined || leaf.routeId === undefined) {
    throw new InvocationClientError(
      'AB8230',
      'Runtime run does not map to an invokable application leaf.',
    );
  }
  const diagnostics = run.status === 'failed'
    ? Object.freeze(run.diagnostics.map(diagnosticFor))
    : Object.freeze([]);
  const document = documentFor(events);
  const timings = run.status === 'succeeded'
    ? Object.freeze(run.result.trace.flatMap((span) => span.durationMs === undefined
      ? []
      : [Object.freeze({
          durationMs: span.durationMs,
          phase: span.phase,
          startedAt: span.startedAt,
        })]))
    : Object.freeze([]);
  const result = run.status === 'succeeded' ? run.result.agentVisible : undefined;
  const outcome = outcomeForRun(run, document);
  return Object.freeze({
    completedAt: run.completedAt,
    context: Object.freeze({
      actor: unavailable(),
      host: unavailable(),
      invocation: Object.freeze({
        kind: invocationKind(kind),
        surface: run.surfaceId,
      }),
      lineage: unavailable(),
      session: unavailable(),
      workspace: unavailable(),
    }),
    ...(correlationId === undefined ? {} : { correlationId }),
    diagnostics,
    ...(document === undefined ? {} : { document }),
    events,
    id: run.id,
    input: run.input,
    kind,
    manifestDigest: run.vector.runtimeGenerationId,
    ...(outcome === undefined ? {} : { outcome }),
    projection: Object.freeze({}),
    providers: Object.freeze([]),
    ...(result === undefined ? {} : { result }),
    routeId: leaf.routeId,
    source: leaf.source ?? '',
    sourceRevision: run.vector.sourceRevision,
    startedAt: run.startedAt,
    status: run.status,
    surface: kind === 'event-route'
      ? Object.freeze({
          ...(run.target === 'claude' || run.target === 'codex' || run.target === 'cursor'
            ? { host: run.target }
            : {}),
          kind: 'event' as const,
        })
      : Object.freeze({ kind: 'mcp' as const }),
    timings,
  });
};

const summaryForRun = (
  run: DevRuntimeRun,
  leaf: ApplicationLeaf,
  correlationId?: string,
): RouteInvocationSummary =>
  invocationSummaryOf(invocationForRun(run, leaf, Object.freeze([]), correlationId));

const abortIfRequested = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw signal.reason;
};

export const createRuntimeBackend = ({
  controller,
  runtimeClient,
}: RuntimeBackendOptions): InvocationBackend => {
  const leafBySurfaceId = new Map<string, ApplicationLeaf>();
  const correlationByRunId = new Map<string, string>();

  const registerLeaf = (leaf: ApplicationLeaf): DevRuntimeSurface | undefined => {
    const matches = controller.model.surfaces.filter((surface) =>
      surfaceMatches(surface, leaf));
    for (const surface of matches) leafBySurfaceId.set(surface.id, leaf);
    return matches[0];
  };

  const leafForRun = (run: DevRuntimeRun): ApplicationLeaf => {
    const leaf = leafBySurfaceId.get(run.surfaceId);
    if (leaf === undefined) {
      throw new InvocationClientError(
        'AB8230',
        `Runtime surface ${JSON.stringify(run.surfaceId)} is not mapped to an application leaf.`,
      );
    }
    return leaf;
  };

  return Object.freeze({
    accepts: (leaf: ApplicationLeaf): boolean =>
      leaf.execution === 'invoke' &&
      leaf.routeId !== undefined &&
      routeKindFor(leaf) !== undefined &&
      registerLeaf(leaf) !== undefined,
    history: async (leaf: ApplicationLeaf, signal?: AbortSignal) => {
      abortIfRequested(signal);
      const surface = registerLeaf(leaf);
      if (surface === undefined) return Object.freeze([]);
      const history = controller.model.history
        .filter((run) => run.surfaceId === surface.id && run.status !== 'running')
        .map((run) => summaryForRun(run, leaf, correlationByRunId.get(run.id)));
      abortIfRequested(signal);
      return Object.freeze(history);
    },
    invoke: async (
      leaf: ApplicationLeaf,
      request: RouteInvocationRequest,
      signal?: AbortSignal,
    ) => {
      abortIfRequested(signal);
      const surface = selectedSurface(controller.model.surfaces, leaf, request);
      const target = surface === undefined
        ? undefined
        : selectedTarget(surface, request);
      if (surface === undefined || target === undefined) {
        throw new InvocationClientError(
          'AB8230',
          'Runtime has no surface or target for this application leaf.',
        );
      }
      leafBySurfaceId.set(surface.id, leaf);
      const runtimeRequest = Object.freeze({
        ...(request.correlationId === undefined ? {} : { correlationId: request.correlationId }),
        ...(controller.model.status?.activeVector === undefined
          ? {}
          : {
              expectedGenerationId:
                controller.model.status.activeVector.runtimeGenerationId,
            }),
        input: request.input ?? Object.freeze({}),
        surfaceId: surface.id,
        target,
      }) satisfies DevRuntimeInvocationRequest;
      const run = await runtimeClient.createRun(runtimeRequest);
      abortIfRequested(signal);
      if (request.correlationId !== undefined) {
        correlationByRunId.set(run.id, request.correlationId);
      }
      controller.dispatch({
        run,
        type: 'run.received',
      } satisfies RuntimeModelAction);
      const events = await runtimeClient.readRunDocument(run.id, signal);
      abortIfRequested(signal);
      return invocationForRun(
        run,
        leaf,
        events,
        request.correlationId,
      );
    },
    kind: 'runtime',
    read: async (invocationId: string, signal?: AbortSignal) => {
      abortIfRequested(signal);
      const run = await runtimeClient.readRun(invocationId);
      const leaf = leafForRun(run);
      const events = await runtimeClient.readRunDocument(run.id, signal);
      abortIfRequested(signal);
      return invocationForRun(
        run,
        leaf,
        events,
        correlationByRunId.get(run.id),
      );
    },
    subscribe: (listener: (summary: RouteInvocationSummary) => void) => {
      const observed = new Set(
        controller.model.history
          .filter((run) => run.status !== 'running')
          .map((run) => run.id),
      );
      return controller.subscribe((model: RuntimeModel) => {
        for (const run of model.history) {
          if (run.status === 'running' || observed.has(run.id)) continue;
          observed.add(run.id);
          const leaf = leafBySurfaceId.get(run.surfaceId);
          if (leaf !== undefined) {
            listener(summaryForRun(run, leaf, correlationByRunId.get(run.id)));
          }
        }
      });
    },
  });
};
