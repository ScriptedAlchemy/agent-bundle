import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as AgentFlightServer from '@agent-bundle/runtime/flight/server';
import type * as AgentRuntime from '@agent-bundle/runtime';
import type * as AgentMount from '@agent-bundle/runtime/mount';
import type * as AgentState from '@agent-bundle/runtime/state';
import type {
  AgentDocument,
  AgentInvocationInput,
  AgentProgressReporter,
  AgentProgressUpdate,
  AgentProviderValues,
  AgentRenderDispatch,
  AgentRenderEvent,
  AgentRenderInvocation,
  AgentRenderLimits,
  AgentRequestInit,
} from '@agent-bundle/runtime';
import type * as React from 'react';

import { CliInputError } from '../cli-entry.ts';
import type {
  CliRenderedEvent,
  GeneratedCliRenderContext,
  GeneratedCliRenderSession,
} from '../cli-entry.ts';
import type { CompiledCliCommand } from '../routes/types.ts';
import { AgentTestError, captured } from './errors.ts';
import { ROUTE_UNIT_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { mountProviders } from './providers.ts';
import {
  registeredManifestIdentity,
  registeredRouteLoader,
  registeredStateLoader,
  testManifest,
} from './registry.ts';
import type {
  AgentRouteModule,
  RenderableRouteKind,
  RenderedRouteProvenance,
  TestableRouteDescriptor,
} from './types.ts';

/**
 * Request-scoped overrides for one rendered route, over the runtime's own
 * request contract. `host`, `session`, `actor`, `workspace`, and
 * `capabilities` are the identity-injection seam for context-dependent route
 * tests; construct observed values with `available` or `unavailable` from
 * `@agent-bundle/runtime`. `providers` is the opt-out for conventional
 * provider discovery: when present it is mounted verbatim; when absent the
 * harness executes the project's `src/providers/*` exactly as the generated
 * request scopes do.
 */
export type RenderRouteContext = Omit<AgentRequestInit, 'invocation' | 'progress' | 'signal'> & {
  readonly invocation?: Omit<AgentInvocationInput, 'kind'>;
  readonly progress?: AgentProgressReporter;
};

/**
 * The `context` member of every harness call. The harness installs fixture
 * values instead of executing `src/providers/*`, so once the project's
 * generated `.agent-bundle/routes.d.ts` augmentation declares required provider
 * keys, `context` (and its `providers`) becomes mandatory: a test cannot omit
 * the fixtures while the route's types promise them. Provider-free projects
 * keep `context` optional.
 */
export type RenderRouteContextInit = Record<never, never> extends AgentProviderValues
  ? { readonly context?: RenderRouteContext }
  : { readonly context: RenderRouteContext };

export interface RenderRouteOptionsBase {
  /** CLI route arguments; `cli` routes only. */
  readonly args?: readonly string[];
  /** The route's input: tool input, event payload, or script input. */
  readonly input?: unknown;
  /** Overrides the route kind when a module is rendered directly; ignored for manifest routes. */
  readonly kind?: RenderableRouteKind;
  readonly limits?: Partial<AgentRenderLimits>;
  /** Renders against an explicit manifest instead of the one the generated configuration registered. */
  readonly manifest?: AgentBundleTestManifest;
  /** Names a module rendered directly, so failure diagnostics carry a route identity. */
  readonly routeId?: string;
  readonly signal?: AbortSignal;
}

export type RenderRouteOptions = RenderRouteOptionsBase & RenderRouteContextInit;

/**
 * The trailing options parameter of every harness entry point. Provider-free
 * projects may omit it; once the generated augmentation declares provider
 * keys it is mandatory, so no harness call can silently skip the fixtures.
 */
export type HarnessOptionsArguments<Options> = Record<never, never> extends AgentProviderValues
  ? readonly [options?: Options]
  : readonly [options: Options];

export interface RenderedRoute {
  /** The final Agent Document the real renderer produced. */
  readonly document: AgentDocument;
  readonly invocation: AgentRenderInvocation;
  /** The document value parsed by the route's own `resultSchema`; absent when the module exports none. */
  readonly result?: unknown;
  /** Request-scoped progress the route reported. These are not render events; the final-only dispatcher emits no event stream. */
  readonly progress: readonly AgentProgressUpdate[];
  readonly provenance: RenderedRouteProvenance;
}

export type RenderRouteTarget = AgentRouteModule | string;

interface Renderer {
  readonly available: typeof AgentRuntime.available;
  readonly createAgentRenderDispatcher: typeof AgentRuntime.createAgentRenderDispatcher;
  readonly createElement: typeof React.createElement;
  readonly createGeneratedRuntimeState: typeof AgentMount.createGeneratedRuntimeState;
  readonly createMemoryStateDriver: typeof AgentState.createMemoryStateDriver;
  readonly renderAgentFlight: typeof AgentFlightServer.renderAgentFlight;
  readonly runAgentRequest: typeof AgentRuntime.runAgentRequest;
  readonly unavailable: typeof AgentRuntime.unavailable;
}

let rendererPromise: Promise<Renderer> | undefined;

/**
 * Loads the real renderer on first render. The imports are deliberately not at
 * module scope: `@agent-bundle/runtime` and `react` are optional peers of this
 * package, and the Flight server entry throws on import unless the process
 * enabled the `react-server` condition — so a manifest-only test must be able
 * to import these helpers without either installed, and a missing condition
 * must fail with the wiring step rather than an opaque React message.
 */
const loadRenderer = async (): Promise<Renderer> => {
  rendererPromise ??= (async (): Promise<Renderer> => {
    const [runtime, mount, state, flight, react] = await Promise.all([
      import('@agent-bundle/runtime'),
      import('@agent-bundle/runtime/mount'),
      import('@agent-bundle/runtime/state'),
      import('@agent-bundle/runtime/flight/server'),
      import('react'),
    ]);
    return {
      available: runtime.available,
      createAgentRenderDispatcher: runtime.createAgentRenderDispatcher,
      createElement: react.createElement,
      createGeneratedRuntimeState: mount.createGeneratedRuntimeState,
      createMemoryStateDriver: state.createMemoryStateDriver,
      renderAgentFlight: flight.renderAgentFlight,
      runAgentRequest: runtime.runAgentRequest,
      unavailable: runtime.unavailable,
    };
  })().catch((error: unknown) => {
    rendererPromise = undefined;
    throw new AgentTestError(
      'render-failed',
      'Unable to load the Agent renderer for an in-process test render.',
      {
        cause: error,
        details: [`cause:        ${error instanceof Error ? error.message : String(error)}`],
        recovery: 'Install react and @agent-bundle/runtime, and run the cli-dispatch or route-unit pool with the react-server condition — agentBundleRstest() from agent-bundle/rstest configures both.',
      },
    );
  });
  return rendererPromise;
};

const renderableKind = (
  descriptor: TestableRouteDescriptor,
  provenance: RenderedRouteProvenance,
): RenderableRouteKind => {
  switch (descriptor.kind) {
    case 'cli':
    case 'event-route':
    case 'prompt':
    case 'resource':
    case 'script':
    case 'tool':
      return descriptor.kind;
    case 'app':
      throw new AgentTestError(
        'unsupported-route-kind',
        `Route ${descriptor.id} is a browser App surface, which the route-unit level does not render.`,
        {
          provenance,
          recovery: 'Assert App surfaces at the browser proof level; it compiles the App through its production Rsbuild profile.',
        },
      );
    default: {
      const exhaustive: never = descriptor.kind;
      throw new AgentTestError(
        'unsupported-route-kind',
        `Unsupported compiled route kind ${String(exhaustive)}.`,
        { provenance },
      );
    }
  }
};

const cliArguments = (
  options: RenderRouteOptions,
  provenance: RenderedRouteProvenance,
): readonly string[] => {
  const candidate = options.args ?? [];
  if (Array.isArray(candidate) && candidate.every((value) => typeof value === 'string')) {
    return candidate as readonly string[];
  }
  throw new AgentTestError(
    'invalid-input',
    'A cli route invocation carries string arguments.',
    {
      details: [`received:     ${captured(candidate)}`],
      provenance,
      recovery: 'Pass args: ["--flag", "value"] to renderRoute().',
    },
  );
};

/**
 * The executable surface name the generated entry records and hands to
 * providers, derived like the artifact derives it: a routed CLI command is
 * its space-joined command path (`tooling report`), a script is its
 * path-derived name (`script:tooling-summary` -> `tooling-summary`), and an
 * event route is its canonical event. The compiled command graph is the
 * authority for command paths; without a manifest (module-direct renders)
 * the harness falls back to the route id's own path segments.
 */
const executableSurface = (
  kind: RenderableRouteKind,
  routeId: string,
  manifest: AgentBundleTestManifest | undefined,
): string => {
  switch (kind) {
    case 'prompt':
    case 'resource':
    case 'tool':
      return protocolName(routeId);
    case 'event-route':
      return routeId.startsWith('event:') ? routeId.slice('event:'.length) : routeId;
    case 'cli': {
      const command = manifest?.cliCommands.find((candidate) => candidate.routeId === routeId);
      if (command !== undefined) return command.path.join(' ');
      return (routeId.startsWith('cli:') ? routeId.slice('cli:'.length) : routeId).replaceAll('/', ' ');
    }
    case 'script':
      return routeId.startsWith('script:') ? routeId.slice('script:'.length) : routeId;
    default: {
      const exhaustive: never = kind;
      throw new AgentTestError('unsupported-route-kind', `Unsupported renderable route kind ${String(exhaustive)}.`);
    }
  }
};

const invocationFor = (
  kind: RenderableRouteKind,
  routeId: string,
  surface: string,
  options: RenderRouteOptions,
  provenance: RenderedRouteProvenance,
): AgentRenderInvocation => {
  switch (kind) {
    // The generated MCP server dispatches tools, resources, and prompts
    // through one tool invocation; the harness renders them the same way
    // rather than inventing a second invocation shape.
    case 'prompt':
    case 'resource':
    case 'tool':
      return { kind: 'tool', props: { input: (options.input ?? {}) as never, operationId: routeId } };
    case 'event-route':
      // The generated server names the canonical event, not the route id, and
      // carries the host envelope as `payload`; the harness matches both so a
      // route sees the props the artifact would hand it.
      return { kind: 'event', props: { event: surface, payload: (options.input ?? {}) as never } };
    case 'cli':
      // The generated executable passes `command.path.join(' ')`, never the
      // route id, so providers branching on `command` see the artifact's value.
      return { kind: 'cli', props: { args: cliArguments(options, provenance), command: surface } };
    case 'script':
      // The generated script passes its path-derived name (`tooling-summary`).
      return { kind: 'script', props: { input: cliArguments(options, provenance) as never, name: surface } };
    default: {
      const exhaustive: never = kind;
      throw new AgentTestError(
        'unsupported-route-kind',
        `Unsupported renderable route kind ${String(exhaustive)}.`,
        { provenance },
      );
    }
  }
};

const knownRouteIds = (manifest: AgentBundleTestManifest): string =>
  Object.keys(manifest.routes).length === 0
    ? 'this project compiled no route modules'
    : Object.keys(manifest.routes).sort().join(', ');

interface ResolvedTarget {
  readonly component: (props: never) => unknown;
  readonly kind: RenderableRouteKind;
  readonly manifest?: AgentBundleTestManifest;
  readonly module: AgentRouteModule;
  readonly provenance: RenderedRouteProvenance;
}

/** The protocol name a generated server registers, and the request surface it records. */
const protocolName = (routeId: string): string => routeId.slice(routeId.lastIndexOf('/') + 1);

/**
 * Props the route component receives. MCP route kinds get exactly the public
 * route contract's `{ input, signal }` — the same props the generated server's
 * Flight worker passes. Rendered CLI commands get the routed command
 * contract's `{ input, signal }` (parsed input); rendered scripts get
 * `{ argv, signal }` — both exactly what the generated executables pass
 * (#102 stage 3). Event routes receive their invocation props beside the
 * signal until their public surface hardens.
 */
const componentProps = (
  invocation: AgentRenderInvocation,
  kind: RenderableRouteKind,
  options: RenderRouteOptions,
  signal: AbortSignal,
): Readonly<Record<string, unknown>> => {
  switch (kind) {
    case 'prompt':
    case 'resource':
    case 'tool':
      return { input: (invocation.props as { readonly input?: unknown }).input, signal };
    case 'event-route': {
      // The public event-route contract is `{ canonical, native, signal }`,
      // and the generated Flight worker unwraps the payload into exactly that.
      const payload = (invocation.props as {
        readonly payload?: { readonly canonical?: unknown; readonly native?: unknown };
      }).payload ?? {};
      return { canonical: payload.canonical, native: payload.native, signal };
    }
    case 'cli':
      return { input: options.input ?? {}, signal };
    case 'script':
      return { argv: (invocation.props as { readonly input?: unknown }).input ?? [], signal };
    default: {
      const exhaustive: never = kind;
      throw new AgentTestError('unsupported-route-kind', `Unsupported renderable route kind ${String(exhaustive)}.`);
    }
  }
};

/**
 * The request-scope invocation the generated entry opens for one route:
 * `operationId` is the route id and `surface` the executable surface name on
 * every kind, exactly as the generated MCP server, CLI, and script shells
 * record them.
 */
const requestInvocation = (
  invocation: AgentRenderInvocation,
  routeId: string,
  surface: string,
): AgentInvocationInput => ({
  kind: invocation.kind,
  operationId: routeId,
  surface,
});

const componentOf = (
  module: AgentRouteModule,
  provenance: RenderedRouteProvenance,
): ((props: never) => unknown) => {
  const component = (module as { default?: unknown }).default;
  if (typeof component !== 'function') {
    throw new AgentTestError(
      'invalid-route-module',
      'A route module default-exports its route component.',
      {
        details: [`received:     default export of type ${typeof component}`],
        provenance,
        recovery: 'Export the route component as the module default.',
      },
    );
  }
  return component as (props: never) => unknown;
};

const resolveTarget = async (
  target: RenderRouteTarget,
  options: RenderRouteOptions,
): Promise<ResolvedTarget> => {
  if (typeof target !== 'string') {
    const kind = options.kind ?? 'tool';
    const provenance: RenderedRouteProvenance = Object.freeze({
      kind,
      proofLevel: ROUTE_UNIT_PROOF_LEVEL,
      routeId: options.routeId ?? '(module passed to renderRoute)',
      source: 'module',
      targets: [],
    });
    return { component: componentOf(target, provenance), kind, module: target, provenance };
  }
  const manifest = options.manifest ?? testManifest();
  const descriptor = manifest.routes[target];
  if (descriptor === undefined) {
    throw new AgentTestError('route-not-found', `No compiled route is named ${JSON.stringify(target)}.`, {
      details: [
        `project root: ${manifest.projectRoot}`,
        `compiled:     ${knownRouteIds(manifest)}`,
        ...(manifest.diagnostics.length === 0
          ? []
          : [`compiler:     ${String(manifest.diagnostics.length)} diagnostic(s), first ${manifest.diagnostics[0]!.code}: ${manifest.diagnostics[0]!.message}`]),
      ],
      recovery: 'Render one of the compiled route ids, or pass the route module to renderRoute() directly.',
    });
  }
  const provenance: RenderedRouteProvenance = Object.freeze({
    kind: 'tool',
    manifestDigest: manifest.digest,
    modulePath: descriptor.source,
    projectRoot: manifest.projectRoot,
    proofLevel: ROUTE_UNIT_PROOF_LEVEL,
    relativePath: descriptor.relativePath,
    routeId: descriptor.id,
    ...(descriptor.serverId === undefined ? {} : { serverId: descriptor.serverId }),
    source: 'manifest',
    targets: manifest.targets,
  });
  const kind = renderableKind(descriptor, provenance);
  const loader = registeredRouteLoader(manifest, descriptor.id);
  if (loader === undefined) {
    const identity = registeredManifestIdentity();
    // A registered manifest that is not this one means the loaders in this
    // worker belong to a different compilation. Loading one of them would run
    // another project's module under this manifest's provenance, so the miss is
    // reported as the mismatch it is rather than as missing wiring.
    const mismatched = identity !== undefined && identity.digest !== manifest.digest;
    throw new AgentTestError(
      'manifest-unavailable',
      mismatched
        ? `Route ${descriptor.id} belongs to a manifest whose route loaders are not the ones registered in this test process.`
        : `Route ${descriptor.id} is compiled but no test-time module loader is registered for it.`,
      {
        ...(mismatched
          ? {
              details: [
                `manifest:     ${manifest.digest} (${manifest.projectRoot})`,
                `registered:   ${identity.digest} (${identity.projectRoot})`,
              ],
            }
          : {}),
        provenance: { ...provenance, kind },
        recovery: mismatched
          ? 'Render this route through the manifest the generated setup registered, or pass the route module to renderRoute() directly — route loaders are bound to the manifest that produced them.'
          : 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers route loaders, or pass the route module to renderRoute() directly.',
      },
    );
  }
  const module = await loader();
  return {
    component: componentOf(module, { ...provenance, kind }),
    kind,
    manifest,
    module,
    provenance: { ...provenance, kind },
  };
};

/**
 * The structured result a generated server would return: the document value
 * validated by the route's own `resultSchema`. A document that renders but
 * whose value the route's schema rejects is a route defect, not a pass.
 */
const parsedResult = (
  schema: { readonly parse: (value: unknown) => unknown },
  document: AgentDocument,
  provenance: RenderedRouteProvenance,
): unknown => {
  try {
    return schema.parse(document.value);
  } catch (error) {
    throw new AgentTestError('result-rejected', "The route's own resultSchema rejected the rendered document value.", {
      cause: error,
      details: [
        `cause:        ${error instanceof Error ? error.message : String(error)}`,
        `received:     ${document.value === undefined ? 'no document value' : captured(document.value)}`,
      ],
      provenance,
    });
  }
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<readonly Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
};

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
});

interface AutoMountedState {
  readonly context: Pick<AgentRequestInit, 'noticeLedger' | 'state'>;
  close(): Promise<void>;
}

const noMountedState: AutoMountedState = Object.freeze({
  context: {},
  close: async () => undefined,
});

/**
 * Mounts one fresh state owner for a manifest render. Durable definitions use
 * a disposable sqlite root so repeated route-unit renders are deterministic.
 */
const mountManifestState = async (
  manifest: AgentBundleTestManifest | undefined,
  provenance: RenderedRouteProvenance,
  context: RenderRouteContext,
  renderer: Renderer,
  signal: AbortSignal,
): Promise<AutoMountedState> => {
  const descriptor = manifest?.state;
  if (
    manifest === undefined
    || descriptor === undefined
    || (context.state !== undefined && context.noticeLedger !== undefined)
  ) return noMountedState;
  const loader = registeredStateLoader(manifest);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `State ${descriptor.id} is declared but no test-time state module loader is registered for it.`,
      {
        provenance,
        recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers the state loader.',
      },
    );
  }
  const definition = (await loader()).default;
  let root: string | undefined;
  let driver: AgentState.AgentStateDriver;
  try {
    if (descriptor.lifetime === 'workspace-durable') {
      root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-state-'));
      driver = (await import('@agent-bundle/runtime/state/sqlite')).createSqliteStateDriver({ root });
    } else {
      driver = renderer.createMemoryStateDriver({ lifetime: descriptor.lifetime });
    }
  } catch (error) {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
    throw error;
  }
  const owner = renderer.createGeneratedRuntimeState({ definition, driver });
  try {
    const bindings = await owner.requestBindings({ signal });
    let closed = false;
    return Object.freeze({
      context: {
        ...(context.noticeLedger === undefined ? { noticeLedger: bindings.noticeLedger } : {}),
        ...(context.state === undefined ? { state: bindings.state } : {}),
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await bindings.close();
        } finally {
          try {
            await owner.close();
          } finally {
            if (root !== undefined) await rm(root, { force: true, recursive: true });
          }
        }
      },
    });
  } catch (error) {
    try {
      await owner.close();
    } finally {
      if (root !== undefined) await rm(root, { force: true, recursive: true });
    }
    throw error;
  }
};

const progressFor = (
  collected: AgentProgressUpdate[],
  delegated: AgentProgressReporter | undefined,
  dispatcher: AgentProgressReporter | undefined,
): AgentProgressReporter => ({
  report: async (update) => {
    collected.push(update);
    await delegated?.report(update);
    await dispatcher?.report(update);
  },
});

interface FlightDispatcherOptions {
  readonly collected: AgentProgressUpdate[];
  readonly component: (props: never) => unknown;
  readonly componentProps: (request: AgentRenderDispatch) => Readonly<Record<string, unknown>>;
  readonly contextProgress?: AgentProgressReporter;
  readonly limits?: Partial<AgentRenderLimits>;
  readonly renderer: Renderer;
  /** Async so conventional providers execute inside the request, before the scope opens, as generated scopes do. */
  readonly requestInit: (request: AgentRenderDispatch) => Promise<AgentRequestInit>;
}

const createFlightDispatcher = (options: FlightDispatcherOptions): AgentRuntime.AgentRenderDispatcher =>
  options.renderer.createAgentRenderDispatcher({
    execute: async (request) => streamOf(await options.renderer.runAgentRequest({
      ...(await options.requestInit(request)),
      progress: progressFor(options.collected, options.contextProgress, request.progress),
      signal: request.signal,
    }, async () => drain(options.renderer.renderAgentFlight(
      options.renderer.createElement(
        options.component as never,
        options.componentProps(request) as never,
      ),
      { signal: request.signal },
    )))),
  }, options.limits === undefined ? {} : { limits: options.limits });

export interface PrepareCliRenderHostOptions {
  readonly context?: RenderRouteContext;
  readonly manifest: AgentBundleTestManifest;
  readonly modules: ReadonlyMap<string, AgentRouteModule>;
  readonly onValidated: (value: unknown) => void;
  readonly provenance: RenderedRouteProvenance;
  readonly signal: AbortSignal;
}

export interface PreparedCliRenderHost {
  readonly close: () => Promise<void>;
  readonly render: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliRenderContext,
  ) => GeneratedCliRenderSession;
}

/**
 * Accepts preloaded route modules and prepares the renderer and manifest
 * state before the synchronous generated-shell render factory is installed.
 */
export const prepareCliRenderHost = async (
  options: PrepareCliRenderHostOptions,
): Promise<PreparedCliRenderHost> => {
  const renderer = await loadRenderer();
  const context = options.context ?? {};
  const mounted = await mountManifestState(
    options.manifest,
    options.provenance,
    context,
    renderer,
    options.signal,
  );
  return Object.freeze({
    close: mounted.close,
    render: (
      command: CompiledCliCommand,
      input: Readonly<Record<string, unknown>>,
      execution: GeneratedCliRenderContext,
    ): GeneratedCliRenderSession => {
      const module = options.modules.get(command.routeId);
      if (module === undefined) {
        throw new AgentTestError(
          'manifest-unavailable',
          `Rendered command route ${command.routeId} was not preloaded for CLI dispatch.`,
          {
            provenance: { ...options.provenance, routeId: command.routeId },
            recovery: 'Build the Rstest configuration with agentBundleRstest() so every rendered command loader is registered.',
          },
        );
      }
      if (module.inputSchema === undefined || module.resultSchema === undefined) {
        throw new AgentTestError(
          'invalid-route-module',
          `Rendered command route ${command.routeId} must export inputSchema and resultSchema.`,
          {
            provenance: { ...options.provenance, routeId: command.routeId },
            recovery: 'Export both zod schemas from the rendered command module.',
          },
        );
      }
      let parsed: unknown;
      try {
        parsed = module.inputSchema.parse(input);
      } catch (error) {
        throw new CliInputError(error instanceof Error ? error.message : String(error));
      }
      const commandName = command.path.join(' ');
      const invocation: AgentRenderInvocation = command.mcp === undefined
        ? {
            kind: 'cli',
            props: { args: execution.args, command: commandName },
          }
        : {
            kind: 'tool',
            props: { input: parsed as never, operationId: command.routeId },
          };
      const collected: AgentProgressUpdate[] = [];
      const dispatcher = createFlightDispatcher({
        collected,
        component: componentOf(module, { ...options.provenance, routeId: command.routeId }),
        componentProps: (request) => ({ input: parsed, signal: request.signal }),
        contextProgress: context.progress,
        renderer,
        requestInit: async (request) => {
          const root = process.cwd();
          const providers = await mountProviders({
            explicit: context.providers,
            invocation,
            manifest: options.manifest,
            provenance: { ...options.provenance, routeId: command.routeId },
            signal: request.signal,
          });
          return {
            capabilities: {
              command: renderer.unavailable(),
              filesystem: renderer.unavailable(),
              network: renderer.unavailable(),
              projectRoot: renderer.available({ root }, 'derived'),
            },
            host: renderer.unavailable('unsupported-surface'),
            workspace: renderer.available({ root }, 'derived'),
            ...context,
            ...mounted.context,
            providers,
            invocation: command.mcp === undefined
              ? {
                  kind: 'cli',
                  operationId: command.routeId,
                  surface: commandName,
                  ...context.invocation,
                }
              : {
                  artifactEpoch: `${options.manifest.plugin.name}@${options.manifest.plugin.version}`,
                  kind: 'tool',
                  operationId: command.routeId,
                  surface: command.mcp.tool,
                  ...context.invocation,
                },
            signal: request.signal,
          };
        },
      });
      return Object.freeze({
        close: mounted.close,
        events: (): ReadableStream<CliRenderedEvent> => dispatcher.stream({
          invocation,
          signal: execution.signal,
        }),
        validate: (value: unknown) => {
          const validated = module.resultSchema!.parse(value);
          options.onValidated(validated);
          return validated;
        },
      });
    },
  });
};

interface PreparedRender {
  readonly close: () => Promise<void>;
  readonly collected: readonly AgentProgressUpdate[];
  readonly dispatcher: AgentRuntime.AgentRenderDispatcher;
  readonly invocation: AgentRenderInvocation;
  readonly resolved: ResolvedTarget;
  readonly signal: AbortSignal;
}

/**
 * Resolves the route, loads the real renderer, and wires one dispatcher over
 * a request-scoped Flight render of the route component. Both the final-only
 * and the event-stream entry points run through this, so neither owns a
 * second rendering path.
 */
const prepareRender = async (
  target: RenderRouteTarget,
  options: RenderRouteOptions,
): Promise<PreparedRender> => {
  const resolved = await resolveTarget(target, options);
  const renderer = await loadRenderer();
  const surface = executableSurface(resolved.kind, resolved.provenance.routeId, resolved.manifest);
  const invocation = invocationFor(resolved.kind, resolved.provenance.routeId, surface, options, resolved.provenance);
  const collected: AgentProgressUpdate[] = [];
  const context = options.context ?? {};
  const signal = options.signal ?? new AbortController().signal;
  const mounted = await mountManifestState(resolved.manifest, resolved.provenance, context, renderer, signal);
  const dispatcher = createFlightDispatcher({
    collected,
    component: resolved.component,
    componentProps: (request) => componentProps(request.invocation, resolved.kind, options, request.signal),
    contextProgress: context.progress,
    limits: options.limits,
    renderer,
    requestInit: async (request) => ({
      ...context,
      ...mounted.context,
      // The render invocation is exactly what the generated Flight worker
      // receives as `message.invocation`, so providers see the same shape.
      providers: await mountProviders({
        explicit: context.providers,
        invocation: request.invocation,
        manifest: resolved.manifest,
        provenance: resolved.provenance,
        signal: request.signal,
      }),
      invocation: {
        ...requestInvocation(request.invocation, resolved.provenance.routeId, surface),
        ...context.invocation,
        kind: request.invocation.kind,
      },
      signal: request.signal,
    }),
  });
  return {
    close: mounted.close,
    collected,
    dispatcher,
    invocation,
    resolved,
    signal,
  };
};

const renderFailure = (
  error: unknown,
  invocation: AgentRenderInvocation,
  provenance: RenderedRouteProvenance,
): AgentTestError => new AgentTestError('render-failed', 'The route render failed.', {
  cause: error,
  details: [
    `cause:        ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    `invocation:   ${invocation.kind}`,
  ],
  provenance,
});

/**
 * Renders one route through the real Agent renderer and returns its final
 * Agent Document. The route component executes inside a real request scope,
 * its output is encoded as React Flight, and the runtime's own final-only
 * dispatcher decodes it — the harness owns no second rendering path.
 *
 * This is the route-unit proof level: no transport is opened, no browser
 * surface is compiled, and no host artifact is built.
 */
export const renderRoute = async (
  target: RenderRouteTarget,
  ...[options = {}]: HarnessOptionsArguments<RenderRouteOptions>
): Promise<RenderedRoute> => {
  const { close, collected, dispatcher, invocation, resolved, signal } = await prepareRender(target, options);
  try {
    const document = await dispatcher.dispatch({ invocation, signal });
    return Object.freeze({
      document,
      invocation,
      progress: Object.freeze([...collected]),
      provenance: resolved.provenance,
      ...(resolved.module.resultSchema === undefined
        ? {}
        : { result: parsedResult(resolved.module.resultSchema, document, resolved.provenance) }),
    });
  } catch (error) {
    throw renderFailure(error, invocation, resolved.provenance);
  } finally {
    await close();
  }
};

export interface RenderedRouteEvents extends RenderedRoute {
  /** Every render event the runtime emitted, in the order it emitted them. */
  readonly events: readonly AgentRenderEvent[];
}

/**
 * Renders one route and collects the ordered render-event stream (#140)
 * alongside the final document, for the event matchers in
 * `agent-bundle/test`. Same proof level and same renderer as
 * {@link renderRoute}: this drains the dispatcher's public event stream
 * rather than its final-only entry point.
 */
export const renderRouteEvents = async (
  target: RenderRouteTarget,
  ...[options = {}]: HarnessOptionsArguments<RenderRouteOptions>
): Promise<RenderedRouteEvents> => {
  const { close, collected, dispatcher, invocation, resolved, signal } = await prepareRender(target, options);
  const events: AgentRenderEvent[] = [];
  const reader = dispatcher.stream({ invocation, signal }).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      events.push(next.value);
    }
  } catch (error) {
    throw renderFailure(error, invocation, resolved.provenance);
  } finally {
    await close();
  }
  const complete = events.findLast((event) => event.type === 'complete');
  if (complete === undefined) {
    throw new AgentTestError('render-failed', 'The route render ended without a complete event.', {
      details: [
        `invocation:   ${invocation.kind}`,
        `events:       ${events.length === 0 ? 'none' : events.map((event) => `${String(event.sequence)}:${event.type}`).join(' ')}`,
      ],
      provenance: resolved.provenance,
    });
  }
  return Object.freeze({
    document: complete.document,
    events: Object.freeze([...events]),
    invocation,
    progress: Object.freeze([...collected]),
    provenance: resolved.provenance,
    ...(resolved.module.resultSchema === undefined
      ? {}
      : { result: parsedResult(resolved.module.resultSchema, complete.document, resolved.provenance) }),
  });
};
