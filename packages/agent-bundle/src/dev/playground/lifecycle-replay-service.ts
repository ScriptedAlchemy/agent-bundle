import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJiti } from 'jiti';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import type { TargetHookContract } from '../../adapters/hook-contract.ts';
import type {
  Lifecycle,
  LifecycleBinding,
  LifecycleDiagnostic,
  LifecycleListResponse,
  LifecycleReplay,
  LifecycleReplayDiagnosticResult,
  LifecycleReplayRequest,
  LifecycleTarget,
} from '../../contracts/lifecycles.ts';
import { deepFreeze } from '../../core/freeze.ts';
import { isJsonRecord, isRecord, snapshotStrictJsonValue } from '../../core/strict-json.ts';
import {
  createCanonicalEventProps,
  projectEventDocument,
  validateNativeEventEnvelope,
} from '../../events/projection.ts';
import {
  canonicalAgentEvents,
  type CanonicalAgentEvent,
} from '../../routes/public.ts';
import type { CompiledAgentRoute, CompiledRouteGraph } from '../../routes/types.ts';
import type { renderRouteEvents } from '../../test/render.ts';
import type { AgentRouteModule } from '../../test/types.ts';
import type { DevLogKindFor, DevLogSink } from '../logs/dev-log-service.ts';
import type {
  LifecycleRenderChildRequest,
  LifecycleRenderChildResponse,
  LifecycleRenderChildResult,
} from './lifecycle-render-protocol.ts';

const concreteHosts = new Set(['claude', 'codex', 'cursor']);
const projectionDiagnosticCode = 'lifecycle.projection.unsupported';

export interface LifecyclePreparedProject {
  readonly graph: CompiledRouteGraph;
  readonly sourceRevision?: string;
  readonly targets: readonly string[];
}

export interface LifecycleReplayServiceOptions {
  readonly loadRouteModule?: (source: string) => Promise<AgentRouteModule>;
  readonly logger?: DevLogSink;
  readonly prepared: () => LifecyclePreparedProject;
  readonly registry?: TargetRegistry;
  readonly render?: typeof renderRouteEvents;
}

export class LifecycleReplayRequestError extends Error {
  readonly code: 'AB8211' | 'AB8213';
  readonly status: 400 | 409;

  constructor(code: 'AB8211' | 'AB8213', message: string, status: 400 | 409) {
    super(message);
    this.name = 'LifecycleReplayRequestError';
    this.code = code;
    this.status = status;
  }
}

const importRouteModule = async (source: string): Promise<AgentRouteModule> => {
  // These are optional peers. Loading them only when replay is requested keeps
  // manifest-only dev servers importable, matching the route-unit renderer.
  const [runtime, react] = await Promise.all([
    import('@agent-bundle/runtime'),
    import('react'),
  ]);
  const jiti = createJiti(import.meta.url, {
    interopDefault: false,
    jsx: { runtime: 'automatic' },
    moduleCache: false,
    nativeModules: ['typescript'],
    virtualModules: {
      '@agent-bundle/runtime': runtime,
      react,
    },
  });
  return jiti.import<AgentRouteModule>(source);
};

const lazyRenderRouteEvents: typeof renderRouteEvents = async (target, options) => {
  const renderer = await import('../../test/render.ts');
  return renderer.renderRouteEvents(target, options);
};

const lifecycleRenderChildPath = (): string => {
  const current = fileURLToPath(import.meta.url);
  const candidates = current.endsWith('.ts')
    ? [
        fileURLToPath(new URL('./lifecycle-render-child.ts', import.meta.url)),
        fileURLToPath(new URL('../../../dist/lifecycle-render-child.js', import.meta.url)),
      ]
    : [
        fileURLToPath(new URL('./lifecycle-render-child.js', import.meta.url)),
        fileURLToPath(new URL('./lifecycle-render-child.ts', import.meta.url)),
        resolve(process.cwd(), 'packages/agent-bundle/src/dev/playground/lifecycle-render-child.ts'),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to locate the lifecycle react-server render child.');
};

const isLifecycleRenderChildResponse = (value: unknown): value is LifecycleRenderChildResponse => {
  if (!isRecord(value)) return false;
  if (value.type === 'result') return isRecord(value.result);
  return value.type === 'error'
    && isRecord(value.error)
    && typeof value.error.name === 'string'
    && typeof value.error.message === 'string';
};

const renderInChild = (
  request: LifecycleRenderChildRequest,
  signal: AbortSignal,
): Promise<LifecycleRenderChildResult> => {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Lifecycle replay was aborted.', 'AbortError'));
  }
  const childPath = lifecycleRenderChildPath();
  const jitiRegister = join(
    dirname(createRequire(import.meta.url).resolve('jiti/package.json')),
    'lib',
    'jiti-register.mjs',
  );
  const child = fork(childPath, [], {
    execArgv: [
      '--conditions=react-server',
      ...(childPath.endsWith('.ts')
        ? ['--import', jitiRegister]
        : []),
    ],
    serialization: 'json',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  child.stderr?.on('data', (chunk: Uint8Array) => process.stderr.write(chunk));
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort);
      child.removeListener('error', fail);
      child.removeListener('exit', exited);
      child.removeListener('message', receive);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const abort = (): void => {
      try { child.kill('SIGKILL'); }
      catch { /* The exit path reports an already-closed process. */ }
      settle(() => rejectPromise(signal.reason ?? new DOMException('Lifecycle replay was aborted.', 'AbortError')));
    };
    const fail = (error: Error): void => settle(() => rejectPromise(error));
    const exited = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
      settle(() => rejectPromise(new Error(
        `Lifecycle render child exited before replying (code ${String(code)}, signal ${String(exitSignal)}).`,
      )));
    };
    const receive = (message: unknown): void => {
      if (!isLifecycleRenderChildResponse(message)) {
        settle(() => rejectPromise(new Error('Lifecycle render child returned an invalid response.')));
        return;
      }
      if (message.type === 'error') {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        settle(() => rejectPromise(error));
        return;
      }
      settle(() => resolvePromise(message.result));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', fail);
    child.once('exit', exited);
    child.once('message', receive);
    child.send(request, (error) => {
      if (error !== null) fail(error);
    });
  });
};

const expandedTargets = (targets: readonly string[]): readonly string[] => Object.freeze(
  [...new Set(targets.flatMap((target) => target === 'plugin' ? ['claude', 'codex'] : [target]))]
    .sort((left, right) => left.localeCompare(right)),
);

const preparedManifestDigest = (prepared: LifecyclePreparedProject): string =>
  prepared.sourceRevision ?? prepared.graph.digest;

const eventForRouteId = (routeId: string): CanonicalAgentEvent | undefined => {
  if (!routeId.startsWith('event:')) return undefined;
  const event = routeId.slice('event:'.length);
  return canonicalAgentEvents.find((candidate) => candidate === event);
};

const targetDiagnostic = (
  code: string,
  message: string,
  target: string,
  severity: 'error' | 'warning' = 'error',
): LifecycleDiagnostic => Object.freeze({ code, message, severity, target });

const replayDiagnostic = (
  code: string,
  message: string,
  target: string,
  event: CanonicalAgentEvent,
): LifecycleReplayDiagnosticResult => deepFreeze({
  diagnostics: [{
    code,
    event,
    message,
    severity: 'error',
    target,
  }],
});

const eventContract = (
  registry: TargetRegistry,
  target: string,
  event: CanonicalAgentEvent,
): Readonly<{ readonly contract: TargetHookContract; readonly hostContractRevision: string; readonly nativeEvent: string }> | undefined => {
  if (!registry.has(target)) return undefined;
  const contract = registry.hookContract(target);
  const nativeEvent = contract?.eventRouteNames?.[event];
  const hostContractRevision = contract?.hostContractRevision;
  if (
    contract === undefined
    || typeof nativeEvent !== 'string'
    || nativeEvent.trim() === ''
    || typeof hostContractRevision !== 'string'
    || hostContractRevision.trim() === ''
  ) return undefined;
  return Object.freeze({ contract, hostContractRevision, nativeEvent });
};

const targetFor = (
  registry: TargetRegistry,
  target: string,
  event: CanonicalAgentEvent,
): LifecycleTarget | LifecycleDiagnostic => {
  const mapped = eventContract(registry, target, event);
  if (mapped === undefined) {
    return targetDiagnostic(
      'lifecycle.target.unsupported',
      `Lifecycle replay target ${JSON.stringify(target)} cannot map canonical event ${JSON.stringify(event)}.`,
      target,
    );
  }
  const starter = mapped.contract.nativeEventStarter?.(event);
  return deepFreeze({
    ...(starter === undefined
      ? {}
      : { fixture: { label: `${target} ${mapped.nativeEvent} starter`, native: starter } }),
    hostContractRevision: mapped.hostContractRevision,
    nativeEvent: mapped.nativeEvent,
    target,
  });
};

/** Semantic replay over the latest valid prepared route graph; it never compiles or writes the project. */
export class LifecycleReplayService {
  readonly #loadRouteModule: (source: string) => Promise<AgentRouteModule>;
  readonly #logger: DevLogSink | undefined;
  readonly #prepared: () => LifecyclePreparedProject;
  readonly #registry: TargetRegistry;
  readonly #render: typeof renderRouteEvents;
  readonly #renderInProcess: boolean;

  constructor(options: LifecycleReplayServiceOptions) {
    this.#loadRouteModule = options.loadRouteModule ?? importRouteModule;
    this.#logger = options.logger;
    this.#prepared = options.prepared;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#render = options.render ?? lazyRenderRouteEvents;
    this.#renderInProcess = options.loadRouteModule !== undefined || options.render !== undefined;
  }

  list(): LifecycleListResponse {
    const prepared = this.#prepared();
    const lifecycles = prepared.graph.events.map((route): Lifecycle => {
      const projected = this.#targetsFor(route, prepared.targets);
      return deepFreeze({
        diagnostics: projected.diagnostics,
        event: route.event!,
        routeId: route.id,
        routePath: route.provenance.relativePath,
        targets: projected.targets,
      });
    });
    return deepFreeze({ lifecycles, manifestDigest: preparedManifestDigest(prepared) });
  }

  async replay(
    request: LifecycleReplayRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LifecycleReplay | LifecycleReplayDiagnosticResult> {
    this.#log('lifecycle.replay.started', 'info', 'Lifecycle replay started.', request.binding, {});
    try {
      const result = await this.#replay(request, options.signal ?? new AbortController().signal);
      this.#log(
        'lifecycle.replay.completed',
        'info',
        'Lifecycle replay completed.',
        request.binding,
        'diagnostics' in result ? { diagnostics: result.diagnostics } : { events: result.events.length },
      );
      return result;
    } catch (error) {
      this.#log('lifecycle.replay.failed', 'error', 'Lifecycle replay failed.', request.binding, {
        failure: error instanceof LifecycleReplayRequestError ? error.code : 'unavailable',
      });
      throw error;
    }
  }

  async #replay(request: LifecycleReplayRequest, signal: AbortSignal): Promise<LifecycleReplay | LifecycleReplayDiagnosticResult> {
    const prepared = this.#prepared();
    if (request.binding.manifestDigest !== preparedManifestDigest(prepared)) {
      throw new LifecycleReplayRequestError('AB8213', 'Lifecycle replay manifest binding is stale.', 409);
    }
    const route = prepared.graph.events.find((candidate) => candidate.id === request.binding.routeId);
    if (route === undefined) {
      const event = eventForRouteId(request.binding.routeId);
      if (event === undefined) {
        throw new LifecycleReplayRequestError('AB8211', 'Lifecycle replay request has an invalid route binding.', 400);
      }
      return replayDiagnostic(
        'lifecycle.route.unavailable',
        `Lifecycle replay route ${JSON.stringify(request.binding.routeId)} is not available in the bound manifest.`,
        request.binding.target,
        event,
      );
    }
    const event = route.event!;
    const listed = this.#targetsFor(route, prepared.targets);
    if (!concreteHosts.has(request.binding.target)) {
      return replayDiagnostic(
        'lifecycle.target.unsupported',
        `Lifecycle replay target ${JSON.stringify(request.binding.target)} is not a concrete supported host.`,
        request.binding.target,
        event,
      );
    }
    const target = listed.targets.find((candidate) => candidate.target === request.binding.target);
    if (target === undefined) {
      return replayDiagnostic(
        'lifecycle.target.unsupported',
        `Lifecycle replay target ${JSON.stringify(request.binding.target)} cannot map canonical event ${JSON.stringify(event)}.`,
        request.binding.target,
        event,
      );
    }
    let nativeInput: Readonly<Record<string, unknown>>;
    try {
      const snapshot = snapshotStrictJsonValue(request.native);
      if (!isJsonRecord(snapshot)) throw new TypeError('stdin JSON value must be an object');
      nativeInput = validateNativeEventEnvelope(snapshot, {
        canonicalEvent: event,
        nativeEvent: target.nativeEvent,
        target: target.target,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LifecycleReplayRequestError('AB8211', message, 400);
    }
    let rendered: LifecycleRenderChildResult;
    if (this.#renderInProcess) {
      const props = createCanonicalEventProps(
        event,
        nativeInput,
        target.target,
        target.nativeEvent,
        target.hostContractRevision,
        signal,
      );
      const module = await this.#loadRouteModule(route.source);
      const result = await this.#render(module, {
        input: props,
        kind: 'event-route',
        routeId: route.id,
        signal,
      });
      rendered = Object.freeze({
        canonical: props.canonical,
        document: result.document,
        events: result.events,
      });
    } else {
      rendered = await renderInChild({
        event,
        hostContractRevision: target.hostContractRevision,
        nativeEvent: target.nativeEvent,
        nativeInput,
        routeId: route.id,
        routeSource: route.source,
        target: target.target,
      }, signal);
    }
    let nativeResponse: Readonly<Record<string, unknown>> | undefined;
    let projectionDiagnostic: Readonly<{ readonly code: string; readonly message: string }> | undefined;
    try {
      nativeResponse = projectEventDocument(rendered.document, event, target.target, target.nativeEvent);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      projectionDiagnostic = Object.freeze({
        code: projectionDiagnosticCode,
        message: error.message,
      });
    }
    return deepFreeze({
      binding: { ...request.binding },
      canonical: rendered.canonical,
      document: rendered.document,
      events: rendered.events,
      nativeInput,
      ...(nativeResponse === undefined ? {} : { nativeResponse }),
      ...(projectionDiagnostic === undefined ? {} : { projectionDiagnostic }),
      requestContext: {
        hostContractRevision: target.hostContractRevision,
        invocationKind: 'event',
        nativeEvent: target.nativeEvent,
        routeId: route.id,
        target: target.target,
      },
      source: request.source,
    });
  }

  #targetsFor(
    route: CompiledAgentRoute,
    projectTargets: readonly string[],
  ): Readonly<{ readonly diagnostics: readonly LifecycleDiagnostic[]; readonly targets: readonly LifecycleTarget[] }> {
    const configured = route.config['targets'];
    const selected = expandedTargets(
      Array.isArray(configured)
        ? configured.filter((target): target is string => typeof target === 'string')
        : projectTargets,
    );
    const available = expandedTargets(projectTargets);
    const diagnostics: LifecycleDiagnostic[] = [];
    const targets: LifecycleTarget[] = [];
    for (const target of available) {
      if (!selected.includes(target)) {
        diagnostics.push(targetDiagnostic(
          'lifecycle.target.excluded',
          `Lifecycle replay route ${JSON.stringify(route.id)} excludes target ${JSON.stringify(target)}.`,
          target,
          'warning',
        ));
        continue;
      }
      const projected = targetFor(this.#registry, target, route.event!);
      if ('severity' in projected) diagnostics.push(projected);
      else targets.push(projected);
    }
    return deepFreeze({ diagnostics, targets });
  }

  #log(
    kind: DevLogKindFor<'hook'>,
    level: 'error' | 'info',
    summary: string,
    binding: LifecycleBinding,
    details: unknown,
  ): void {
    try {
      this.#logger?.log({
        context: { routeId: binding.routeId, target: binding.target },
        details,
        kind,
        level,
        producer: 'hook',
        summary,
      });
    } catch { /* Diagnostics cannot affect lifecycle replay. */ }
  }
}
