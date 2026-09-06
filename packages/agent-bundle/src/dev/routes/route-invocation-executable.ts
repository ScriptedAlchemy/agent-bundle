import { join } from 'node:path';

import { hooksFlightWorkerPath } from '../../adapters/composite-layout.ts';
import type { ArtifactManifest, ArtifactManifestEventExecution, ArtifactManifestRoute } from '../../build/manifest.ts';
import {
  ProductionRouteInvocationError,
  ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE,
  ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
} from './route-invocation-production-error.ts';
import type { RouteInvocationSurface } from './route-invocation.ts';

/**
 * The compiled executables one production invocation runs, bound from the
 * artifact manifest (`agent-bundle.manifest.json`, #604) before anything is
 * imported or spawned. Every path is absolute under the artifact root and
 * names a `files[]` row the manifest parser already proved; nothing here is
 * discovered by listing a directory or by trying a worker and reading its
 * error.
 */
export interface RouteExecutableBinding {
  /** CLI surface only: the generated bin (`executables.bins[]`) that prepares argv and decides the exit code. */
  readonly bin?: string;
  /** The one compiled Flight worker that owns the route. */
  readonly worker: string;
  /** Hosted event surface only: the compiled wrapper (`executables.hooks[]`) whose preflight gates execution. */
  readonly wrapper?: string;
}

export interface ResolveRouteExecutableInput {
  readonly artifactRoot: string;
  readonly manifest: ArtifactManifest;
  readonly routeId: string;
  readonly surface: RouteInvocationSurface;
}

const unavailable = (message: string): ProductionRouteInvocationError =>
  new ProductionRouteInvocationError(ROUTE_INVOCATION_COMPILED_ROUTE_UNAVAILABLE_CODE, message);

const manifestRoute = (manifest: ArtifactManifest, routeId: string): ArtifactManifestRoute | undefined =>
  manifest.routes.servers.flatMap((server) => server.routes).find((route) => route.id === routeId)
  ?? manifest.routes.cli?.routes.find((route) => route.id === routeId)
  ?? manifest.routes.events.find((route) => route.id === routeId)
  ?? manifest.routes.scripts.find((route) => route.id === routeId);

const bindCliBin = (input: ResolveRouteExecutableInput): RouteExecutableBinding => {
  const { manifest, routeId } = input;
  if (manifest.routes.cli?.routes.some((route) => route.id === routeId) !== true) {
    throw unavailable(`Route ${JSON.stringify(routeId)} is not compiled into the routed CLI of the published artifact.`);
  }
  // The routed CLI is the one generated bin named after the plugin
  // (`normalizeBinEntries`); `executables.bins[]` lists no other kind.
  const bin = manifest.executables.bins.find((candidate) => candidate.name === manifest.application.name);
  if (bin === undefined) {
    throw unavailable(`The published artifact has no routed CLI bin ${JSON.stringify(manifest.application.name)} for route ${JSON.stringify(routeId)}.`);
  }
  if (bin.worker === undefined) {
    throw unavailable(`Routed CLI bin ${JSON.stringify(bin.path)} renders no route, so route ${JSON.stringify(routeId)} has no compiled worker.`);
  }
  return Object.freeze({ bin: join(input.artifactRoot, bin.path), worker: join(input.artifactRoot, bin.worker) });
};

const bindScriptWorker = (input: ResolveRouteExecutableInput): RouteExecutableBinding => {
  const script = input.manifest.executables.scripts.find((candidate) => candidate.rendered?.routeId === input.routeId);
  if (script?.worker === undefined) {
    throw unavailable(`Rendered script route ${JSON.stringify(input.routeId)} has no compiled worker in the published artifact.`);
  }
  return Object.freeze({ worker: join(input.artifactRoot, script.worker) });
};

const bindMcpWorker = (input: ResolveRouteExecutableInput, route: ArtifactManifestRoute): RouteExecutableBinding => {
  const server = input.manifest.executables.mcpServers.find((candidate) => candidate.id === route.serverId);
  if (server?.kind !== 'compiled' || server.launch?.worker === undefined) {
    throw unavailable(`MCP route ${JSON.stringify(input.routeId)} has no compiled server worker in the published artifact.`);
  }
  return Object.freeze({ worker: join(input.artifactRoot, server.launch.worker) });
};

/**
 * The compiled server whose Flight worker registers the composite root's
 * event routes for `host`. `eventRuntimeHosting` (`build/entries.ts`) gives
 * the runtime to the first generated server in model order that targets the
 * host; `normalizeMcpServers` orders the model by server name and
 * `executables.mcpServers[]` is sorted by `id` (`mcp:<name>`), so the first
 * compiled row with a Flight worker reaching the host is that server. A
 * canonical (host-less) run takes the first such row of any host: being
 * first by name, it hosts the runtime for every host it reaches, and every
 * hosting worker registers every event route.
 */
const sharedRuntimeWorker = (
  input: ResolveRouteExecutableInput,
  host: string | undefined,
): string | undefined => {
  const owner = input.manifest.executables.mcpServers.find((server) =>
    server.kind === 'compiled' && server.launch?.worker !== undefined && (host === undefined || server.hosts.includes(host)));
  return owner?.launch?.worker === undefined ? undefined : join(input.artifactRoot, owner.launch.worker);
};

/**
 * The host's wrapper row: the only module that can run the route's compiled
 * preflight. A canonical (host-less) submission has no wrapper, so a route
 * with preflight cannot be prepared and must not reach its handler.
 */
const eventWrapper = (
  input: ResolveRouteExecutableInput,
  execution: ArtifactManifestEventExecution,
  host: string | undefined,
): string | undefined => {
  if (host === undefined) {
    if (execution.preflight === undefined) return undefined;
    throw new ProductionRouteInvocationError(
      ROUTE_INVOCATION_PREPARATION_FAILURE_CODE,
      `Event route ${JSON.stringify(input.routeId)} has compiled preflight ${JSON.stringify(execution.preflight)}; canonical execution cannot select a host wrapper to run it, so the handler is not reached.`,
    );
  }
  const hook = input.manifest.executables.hooks.find((candidate) =>
    candidate.kind === 'event-route' && candidate.routeId === input.routeId && candidate.host === host);
  if (hook === undefined) {
    throw unavailable(`The published artifact compiles no ${host} wrapper for event route ${JSON.stringify(input.routeId)}.`);
  }
  return join(input.artifactRoot, hook.path);
};

const bindEventExecutable = (input: ResolveRouteExecutableInput, route: ArtifactManifestRoute): RouteExecutableBinding => {
  const execution = route.execution;
  if (execution === undefined) {
    throw unavailable(`Event route ${JSON.stringify(input.routeId)} carries no execution record in the published artifact.`);
  }
  const host = input.surface.kind === 'event' ? input.surface.host : undefined;
  const wrapper = eventWrapper(input, execution, host);
  const standaloneWorker = input.manifest.files.some((file) => file.path === hooksFlightWorkerPath)
    ? join(input.artifactRoot, hooksFlightWorkerPath)
    : undefined;
  const worker = execution.runtime === 'standalone'
    ? standaloneWorker
    : sharedRuntimeWorker(input, host) ?? (execution.fallback === 'standalone' ? standaloneWorker : undefined);
  if (worker === undefined) {
    throw unavailable(
      `Event route ${JSON.stringify(input.routeId)} runs ${execution.runtime}${execution.fallback === 'standalone' ? ' with standalone fallback' : ''}, but the published artifact has no compiled worker hosting it${host === undefined ? '' : ` for ${host}`}.`,
    );
  }
  return Object.freeze({ worker, ...(wrapper === undefined ? {} : { wrapper }) });
};

/**
 * Binds the route's executables from the manifest rows the compiler wrote
 * (#604): the routed CLI bin and its worker for a CLI surface, the rendered
 * script's worker, the owning compiled MCP server's worker, or — for an
 * event route — the host's wrapper row plus the worker its execution record
 * selects: `hooks/hooks-flight.mjs` for a standalone runtime, the host's
 * shared runtime owner otherwise, the standalone worker again when the
 * route declares that fallback and no compiled server hosts the runtime.
 * Fails closed (`AB8251`, `AB8252`) instead of guessing: a route the
 * artifact does not compile, a hosted event with no wrapper row, and a
 * canonical submission of a route whose preflight only a wrapper can run
 * all stop here, before any module is imported.
 */
export const resolveRouteExecutable = (input: ResolveRouteExecutableInput): RouteExecutableBinding => {
  const route = manifestRoute(input.manifest, input.routeId);
  if (route === undefined) {
    throw unavailable(`Route ${JSON.stringify(input.routeId)} is absent from the published artifact manifest.`);
  }
  if (input.surface.kind === 'cli') return bindCliBin(input);
  switch (route.kind) {
    case 'cli':
      return bindCliBin(input);
    case 'script':
      return bindScriptWorker(input);
    case 'event-route':
      return bindEventExecutable(input, route);
    case 'prompt':
    case 'resource':
    case 'tool':
      return bindMcpWorker(input, route);
    case 'app':
      throw unavailable('MCP App routes are not invocable through the route execution boundary.');
    default: {
      const exhaustive: never = route.kind;
      throw new Error(`Unsupported route kind ${String(exhaustive)}.`);
    }
  }
};
