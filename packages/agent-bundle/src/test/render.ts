import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type * as AgentFlightServer from '@agent-bundle/runtime/flight/server';
import type * as AgentRuntime from '@agent-bundle/runtime';
import type * as AgentMount from '@agent-bundle/runtime/mount';
import type * as AgentNotices from '@agent-bundle/runtime/notices';
import type * as AgentState from '@agent-bundle/runtime/state';
import type {
  AgentDocument,
  AgentInvocationInput,
  AgentNoticeLedger,
  AgentProgressReporter,
  AgentProgressUpdate,
  AgentProviderValues,
  AgentRenderDispatch,
  AgentRenderEvent,
  AgentRenderInvocation,
  AgentRenderLimits,
  AgentRequestInit,
  RegisteredRouteId,
  RegisteredRouteInput,
  RegisteredRouteResult,
} from '@agent-bundle/runtime';
import type * as React from 'react';

import {
  CliInputError,
  CliUsageError,
  cliInputError,
  confirmationRequiredMessage,
} from '../cli-entry.ts';
import type {
  CliRenderedEvent,
  GeneratedCliRenderContext,
  GeneratedCliRenderSession,
} from '../cli-entry.ts';
import { createProviderProcessLifetime, type ProviderProcessLifetime } from '../routes/provider-execution.ts';
import { routeRenderLimits, type RouteRenderBudget } from '../routes/render-budget.ts';
import type { CompiledCliCommand } from '../routes/types.ts';
import type { AgentTerminal } from '../terminal-capability.ts';
import { AgentTestError, captured } from './errors.ts';
import { composeLayouts, loadLayoutChain, type LayoutChainTarget, type LoadedLayout } from './layouts.ts';
import { ROUTE_UNIT_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { claimProcessHit, harnessPluginRoot, mountProviders } from './providers.ts';
import { routeKindTerminal } from './terminal.ts';
import {
  registeredManifestIdentity,
  registeredProjectionLoader,
  registeredRouteLoader,
  registeredStateLoader,
  testManifest,
  type AgentStateModuleLoader,
} from './registry.ts';
import type {
  AgentRouteModule,
  AgentRouteSchema,
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
 * request scopes do. It stays optional even once the generated
 * `.agent-bundle/routes.d.ts` augmentation declares provider keys — omitting
 * it runs the real providers, which is the artifact's behavior — while an
 * explicit map must still carry every declared key, so a fixture cannot leave
 * a promised value `undefined`.
 */
export type RenderRouteContext = Omit<AgentRequestInit, 'invocation' | 'progress' | 'providers' | 'signal'> & {
  readonly invocation?: Omit<AgentInvocationInput, 'kind'>;
  readonly progress?: AgentProgressReporter;
  readonly providers?: AgentProviderValues;
};

/**
 * The `context` member of every harness call. Unlike a direct
 * `runAgentRequest`, where `providers` becomes mandatory once the augmentation
 * declares keys because nothing else would supply them, a harness call
 * mounts the project's conventional providers itself, so `context` is always
 * optional: omitting it observes what the artifact mounts, and passing
 * `context.providers` substitutes a complete fixture map.
 */
export type RenderRouteContextInit = { readonly context?: RenderRouteContext };

/** What `renderRoute` accepts: a route module rendered directly, or a route id. */
export type RenderRouteTarget = AgentRouteModule | string;

/**
 * The constraint one target must satisfy. Once the generated
 * `.agent-bundle/routes.d.ts` registers the project's routes on
 * `@agent-bundle/runtime`'s `Register`, a string literal must be one of the
 * registered ids (the editor completes them and a typo is rejected naming the
 * alternatives), while a value typed `string` stays legal for dynamic lookups
 * and a module target is unaffected. Without a registration `RegisteredRouteId`
 * is `string`, so every string is legal, exactly as before.
 *
 * `renderRoute` infers `Target` from a literal while checking it against this
 * constraint through TanStack Router's `ConstrainLiteral` shape,
 * `(Target & Constraint) | Constraint`, spelled inline in each signature so the
 * rejection message lists the registered ids rather than an alias name.
 */
export type RouteTargetConstraint<Target> = Target extends AgentRouteModule
  ? AgentRouteModule
  : string extends Target ? string : RegisteredRouteId;


/** The registered input type of a route target; `unknown` for a module target, a dynamic string, or an unregistered project. */
export type RouteTargetInput<Target> = Target extends RegisteredRouteId ? RegisteredRouteInput<Target> : unknown;

/** The registered result type of a route target; `unknown` for a module target, a dynamic string, or an unregistered project. */
export type RouteTargetResult<Target> = Target extends RegisteredRouteId ? RegisteredRouteResult<Target> : unknown;

export interface RenderRouteOptionsBase<Target = RenderRouteTarget> {
  /** CLI route arguments; `cli` routes only. */
  readonly args?: readonly string[];
  /** The route's input: tool input, event payload, or script input — typed from the route's own schema once the id is registered. */
  readonly input?: RouteTargetInput<Target>;
  /** Overrides the route kind when a module is rendered directly; ignored for manifest routes. */
  readonly kind?: RenderableRouteKind;
  /**
   * The dispatcher's base render limits, as the generated executable's
   * dispatcher has them. A manifest route's compiled `config.render` budget
   * layers over them exactly as in the generated MCP server and routed CLI;
   * a module rendered directly has no compiled config, so these apply alone.
   */
  readonly limits?: Partial<AgentRenderLimits>;
  /** Renders against an explicit manifest instead of the one the generated configuration registered. */
  readonly manifest?: AgentBundleTestManifest;
  /** Names a module rendered directly, so failure diagnostics carry a route identity. */
  readonly routeId?: string;
  readonly signal?: AbortSignal;
}

export type RenderRouteOptions<Target = RenderRouteTarget> = RenderRouteOptionsBase<Target> & RenderRouteContextInit;

/**
 * The trailing options parameter of every harness entry point. It is always
 * optional: a call that omits it mounts the project's conventional providers
 * exactly as the generated request scopes do (see {@link RenderRouteContextInit}).
 */
export type HarnessOptionsArguments<Options> = readonly [options?: Options];

export interface RenderedRoute<Target = RenderRouteTarget> {
  /** The final Agent Document the real renderer produced. */
  readonly document: AgentDocument;
  readonly invocation: AgentRenderInvocation;
  /** The document value parsed by the route's own `resultSchema`, typed from that schema once the id is registered; absent when the module exports none. */
  readonly result?: RouteTargetResult<Target>;
  /** Request-scoped progress the route reported. These are not render events; the final-only dispatcher emits no event stream. */
  readonly progress: readonly AgentProgressUpdate[];
  readonly provenance: RenderedRouteProvenance;
}

interface Renderer {
  readonly available: typeof AgentRuntime.available;
  readonly createAgentRenderDispatcher: typeof AgentRuntime.createAgentRenderDispatcher;
  readonly createElement: typeof React.createElement;
  readonly createGeneratedRuntimeState: typeof AgentMount.createGeneratedRuntimeState;
  readonly createMemoryStateDriver: typeof AgentState.createMemoryStateDriver;
  readonly renderAgentFlight: typeof AgentFlightServer.renderAgentFlight;
  readonly resolvePluginRoot: typeof AgentRuntime.resolvePluginRoot;
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
      resolvePluginRoot: runtime.resolvePluginRoot,
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
      // Only authored `src/cli/**` commands have a `cli` route kind. Projected
      // MCP commands (`command.mcp`) carry their tool's route id, so a request
      // for one resolves as that `tool` route above, exactly like the generated
      // entry's `command.mcp !== undefined` branch.
      const command = manifest?.cliCommands.find((candidate) =>
        candidate.mcp === undefined && candidate.routeId === routeId);
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
  /** The manifest layout chain, outermost first; empty for a module rendered directly. */
  readonly layouts: readonly LoadedLayout[];
  readonly manifest?: AgentBundleTestManifest;
  readonly module: AgentRouteModule;
  readonly provenance: RenderedRouteProvenance;
  /** The route's compiled `config.render` budget; absent for a module rendered directly or a route without one. */
  readonly render?: RouteRenderBudget;
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
    return { component: componentOf(target, provenance), kind, layouts: [], module: target, provenance };
  }
  const manifest = options.manifest ?? testManifest();
  const loaded = await loadManifestRouteModule(manifest, target);
  const layouts = await loadLayoutChain(manifest, loaded.descriptor, loaded.provenance);
  const render = routeRenderLimits(loaded.descriptor.config);
  return {
    component: componentOf(loaded.module, loaded.provenance),
    kind: loaded.kind,
    layouts,
    manifest,
    module: loaded.module,
    provenance: loaded.provenance,
    ...(render === undefined ? {} : { render }),
  };
};

interface LoadedManifestRoute {
  readonly descriptor: TestableRouteDescriptor;
  readonly kind: RenderableRouteKind;
  readonly module: AgentRouteModule;
  readonly provenance: RenderedRouteProvenance;
}

/**
 * Resolves one compiled route id of `manifest` to its evaluated module through
 * the loader the generated setup registered — the one path every manifest
 * render takes, and the one `loadRouteModule` exposes on its own.
 */
const loadManifestRouteModule = async (
  manifest: AgentBundleTestManifest,
  routeId: string,
): Promise<LoadedManifestRoute> => {
  const descriptor = manifest.routes[routeId];
  if (descriptor === undefined) {
    throw new AgentTestError('route-not-found', `No compiled route is named ${JSON.stringify(routeId)}.`, {
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
  return { descriptor, kind, module, provenance: { ...provenance, kind } };
};

/** A route schema whose parsed value is typed from the route's registration once the id is registered. */
export interface RouteModuleSchema<Value> extends AgentRouteSchema {
  readonly parse: (value: unknown) => Value;
}

/**
 * The evaluated module `loadRouteModule` returns: the same object the generated
 * server, the routed CLI, and `renderRoute` execute, so `inputSchema` and
 * `resultSchema` are the route's own schema instances by reference (not copies
 * or JSON), `config` is the module's static config export, and `default` its
 * component — absent for a plain `src/scripts/*.ts` module, whose contract is
 * `main`. Any other named export is reachable through the index signature.
 */
export interface LoadedRouteModule<Target extends string = string> {
  readonly [exportName: string]: unknown;
  readonly config?: unknown;
  readonly default?: (props: never) => unknown;
  readonly inputSchema?: RouteModuleSchema<RouteTargetInput<Target>>;
  readonly resultSchema?: RouteModuleSchema<RouteTargetResult<Target>>;
}

export interface LoadRouteModuleOptions {
  /** Loads against an explicit manifest instead of the one the generated configuration registered. */
  readonly manifest?: AgentBundleTestManifest;
}

/**
 * The constraint one `loadRouteModule` id must satisfy. Conventional scripts
 * are loadable but are not part of the generated route registration
 * (`.agent-bundle/routes.d.ts` registers tool, resource, prompt, CLI, and
 * event routes), so a `script:` literal is admitted unchecked while every
 * other literal is checked against the registered ids exactly as `renderRoute`
 * checks its target; a value typed `string` stays legal for dynamic lookups,
 * and without a registration every string is legal. The union is spelled
 * inline so a rejection lists the registered ids rather than an alias name.
 */
export type LoadRouteModuleConstraint<Target> = string extends Target ? string : RegisteredRouteId | `script:${string}`;

/**
 * Loads the evaluated module of one compiled route by its id, through the
 * lazy loader the generated Rstest setup registered for it — the loader
 * `renderRoute` uses. This is the supported replacement for a hand-maintained
 * list of static `import * as m from '../../src/mcp/<server>/tools/<tool>'`
 * statements in a schema-identity suite: iterate `testManifest().routes` and
 * load each id instead (#493).
 *
 * The id is checked against the registered route ids exactly as `renderRoute`
 * checks its target, so a removed placement is a type error (`script:` ids are
 * not registered and pass unchecked; see {@link LoadRouteModuleConstraint}). Outside a pool
 * built with `agentBundleRstest()` it throws `manifest-unavailable`, and a
 * manifest describing another project rejects with the same mismatch report
 * `renderRoute` gives: route loaders are bound to the compilation that
 * produced them. Every renderable kind loads — tools, resources, prompts,
 * event routes, CLI commands, and scripts; App routes are browser builds and
 * are not loadable here (`unsupported-route-kind`).
 */
export const loadRouteModule = async <Target extends string>(
  routeId: (Target & LoadRouteModuleConstraint<Target>) | LoadRouteModuleConstraint<Target>,
  ...[options = {}]: HarnessOptionsArguments<LoadRouteModuleOptions>
): Promise<LoadedRouteModule<Target>> => {
  const manifest = options.manifest ?? testManifest();
  // The loader returns the module namespace object itself. Its shape is not
  // checked here: a plain script legitimately has no default export, and the
  // render and dispatch levels already report a module that breaks their own
  // contract with the route's provenance.
  const loaded = await loadManifestRouteModule(manifest, routeId as string);
  return loaded.module as LoadedRouteModule<Target>;
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

type StateMount = (renderer: Renderer, signal: AbortSignal) => Promise<AutoMountedState>;

/**
 * Marks the `state` handle a {@link mountTestState} mount hands out. A render
 * that receives one rebinds the shared owner to its own request signal — the
 * same `requestBindings({ signal })` a generated request scope performs — so
 * aborting that render stops its in-flight state operations without
 * disturbing the owner the other renders share.
 */
const MOUNTED_TEST_STATE: unique symbol = Symbol.for('agent-bundle/test-mounted-state');

type RebindMountedState = (signal: AbortSignal) => Promise<AutoMountedState>;

type RebindableStateHandle<
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
> = AgentState.AgentStateHandle<TState, TEvents> & { readonly [MOUNTED_TEST_STATE]?: RebindMountedState };

const mountedStateRebind = (context: RenderRouteContext): RebindMountedState | undefined =>
  (context.state as RebindableStateHandle | undefined)?.[MOUNTED_TEST_STATE];

/**
 * Resolves how a manifest render mounts its state, without mounting it: the
 * loader lookup is harness wiring and fails here, while loading the state
 * module and opening its driver — user code and a filesystem root — wait for
 * the returned mount to be called.
 */
const manifestStateMount = (
  manifest: AgentBundleTestManifest | undefined,
  provenance: RenderedRouteProvenance,
  context: RenderRouteContext,
): StateMount => {
  const rebind = mountedStateRebind(context);
  if (rebind !== undefined) return (_renderer, signal) => rebind(signal);
  const descriptor = manifest?.state;
  if (
    manifest === undefined
    || descriptor === undefined
    || (context.state !== undefined && context.noticeLedger !== undefined)
  ) return async () => noMountedState;
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
  return (renderer, signal) => mountState(descriptor, loader, context, renderer, signal);
};

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
): Promise<AutoMountedState> => manifestStateMount(manifest, provenance, context)(renderer, signal);

interface OpenedStateOwner<TState, TEvents extends AgentState.AgentStateEventSchemas> {
  readonly owner: AgentMount.GeneratedRuntimeState<TState, TEvents>;
  /** Closes the owner (and its driver), then removes the disposable sqlite root when one was created. */
  dispose(): Promise<void>;
}

/**
 * Opens one generated state owner — the project state plus its notice ledger
 * — over the driver the route-unit level uses: a disposable sqlite root for a
 * `workspace-durable` definition, so repeated renders are deterministic, and
 * the memory driver for every other lifetime. A caller-supplied driver
 * replaces that choice and is closed with the owner.
 */
const openStateOwner = async <TState, TEvents extends AgentState.AgentStateEventSchemas>(
  definition: AgentState.AgentStateDefinition<TState, TEvents>,
  lifetime: AgentState.AgentStateLifetime,
  renderer: Renderer,
  explicitDriver?: AgentState.AgentStateDriver,
): Promise<OpenedStateOwner<TState, TEvents>> => {
  let root: string | undefined;
  let driver: AgentState.AgentStateDriver;
  try {
    if (explicitDriver !== undefined) {
      driver = explicitDriver;
    } else if (lifetime === 'external') {
      // The compiler admits no `external` state definition, so only an
      // explicit `options.definition` reaches here; its storage is the caller's.
      throw new AgentTestError(
        'invalid-input',
        `State ${definition.id} has the external lifetime, which names no storage the harness could open.`,
        { recovery: 'Pass the driver that owns its storage as options.driver.' },
      );
    } else if (lifetime === 'workspace-durable') {
      root = await mkdtemp(join(tmpdir(), 'agent-bundle-route-state-'));
      driver = (await import('@agent-bundle/runtime/state/sqlite')).createSqliteStateDriver({ root });
    } else {
      driver = renderer.createMemoryStateDriver({ lifetime });
    }
  } catch (error) {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
    throw error;
  }
  const owner = renderer.createGeneratedRuntimeState({ definition, driver });
  return {
    owner,
    dispose: async () => {
      try {
        await owner.close();
      } finally {
        if (root !== undefined) await rm(root, { force: true, recursive: true });
      }
    },
  };
};

const mountState = async (
  descriptor: NonNullable<AgentBundleTestManifest['state']>,
  loader: AgentStateModuleLoader,
  context: RenderRouteContext,
  renderer: Renderer,
  signal: AbortSignal,
): Promise<AutoMountedState> => {
  const definition = (await loader()).default;
  const opened = await openStateOwner(definition, descriptor.lifetime, renderer);
  try {
    const bindings = await opened.owner.requestBindings({ signal });
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
          await opened.dispose();
        }
      },
    });
  } catch (error) {
    await opened.dispose();
    throw error;
  }
};

export interface MountTestStateOptions<
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
> {
  /**
   * The state definition to mount instead of the manifest's registered state
   * module. It also types `state` and `read()`; without it, pass the
   * definition's types as type arguments (`mountTestState<State, Events>()`).
   */
  readonly definition?: AgentState.AgentStateDefinition<TState, TEvents>;
  /** A driver of your own, closed with the mount; replaces the disposable-sqlite / memory choice. */
  readonly driver?: AgentState.AgentStateDriver;
  /** Mounts the state declared by an explicit manifest instead of the one the generated configuration registered. */
  readonly manifest?: AgentBundleTestManifest;
  readonly signal?: AbortSignal;
}

/** The `state` and `noticeLedger` context members one mounted test state hands every render. */
export interface MountedTestStateContext<
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
> {
  readonly noticeLedger: AgentNoticeLedger;
  readonly state: AgentState.AgentStateHandle<TState, TEvents>;
}

/**
 * One state owner mounted for a whole test rather than one render: the same
 * `state` handle and `noticeLedger` for every `renderRoute` /
 * `renderRouteEvents` call that spreads {@link MountedTestState.context} into
 * its `context`, a typed snapshot read, the ledger's snapshot, and one
 * `close()`.
 */
export interface MountedTestState<
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
> extends MountedTestStateContext<TState, TEvents> {
  /** Releases the bindings, closes the owner and its driver, and removes the disposable sqlite root. Idempotent. */
  close(): Promise<void>;
  /** `{ noticeLedger, state }`, to spread into the `context` of any number of renders. */
  context(): MountedTestStateContext<TState, TEvents>;
  /** The notice ledger's current snapshot: every notice with its delivery state. */
  notices(): Promise<AgentNotices.AgentNoticeLedgerSnapshot>;
  /** The project state's current snapshot, typed by the mounted definition. */
  read(): Promise<AgentState.AgentStateSnapshot<TState>>;
}

const manifestStateDefinition = async (
  manifest: AgentBundleTestManifest,
): Promise<AgentState.AgentStateDefinition<unknown, AgentState.AgentStateEventSchemas>> => {
  if (manifest.state === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      'The project declares no state, so there is no state definition to mount.',
      { recovery: 'Declare src/state.ts in the project, or pass the definition to mount as options.definition.' },
    );
  }
  const loader = registeredStateLoader(manifest);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `State ${manifest.state.id} is declared but no test-time state module loader is registered for it.`,
      { recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers the state loader, or pass the definition as options.definition.' },
    );
  }
  return (await loader()).default;
};

/**
 * Mounts the project's state definition and notice ledger once, for a journey
 * that spans several renders — record on one event, read on the next — where
 * the fresh per-render owner `renderRoute` mounts by default would forget
 * everything between calls. The same driver rules apply: a
 * `workspace-durable` definition opens a disposable sqlite root that `close()`
 * removes; every other lifetime uses the memory driver. `renderRoute` and
 * `renderRouteEvents` honour a caller-supplied `state` and `noticeLedger`, so
 * spreading `context()` into each render's `context` is the whole wiring; a
 * render that omits them still mounts its own isolated owner. Each render
 * that receives the handles binds the shared owner to its own request
 * signal, exactly as a generated request scope does, so a render's `signal`
 * still cancels its state operations; `read()`, `notices()`, and the handles
 * themselves are bound to `options.signal`. The owner is held as one request's
 * bindings, so a `request`-lifetime definition behaves as one long request.
 * Always `close()` it (or use {@link withTestState}).
 */
export const mountTestState = async <
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
>(
  ...[options = {}]: HarnessOptionsArguments<MountTestStateOptions<TState, TEvents>>
): Promise<MountedTestState<TState, TEvents>> => {
  const renderer = await loadRenderer();
  // Without an explicit definition the registered module is the project's own
  // `src/state.ts`; its types are whatever the caller named as type arguments.
  const definition = options.definition
    ?? (await manifestStateDefinition(options.manifest ?? testManifest()) as unknown as AgentState.AgentStateDefinition<TState, TEvents>);
  const opened = await openStateOwner(definition, definition.lifetime, renderer, options.driver);
  let bindings: AgentMount.GeneratedRuntimeRequestBindings<TState, TEvents>;
  try {
    bindings = await opened.owner.requestBindings(options.signal === undefined ? {} : { signal: options.signal });
  } catch (error) {
    await opened.dispose();
    throw error;
  }
  let closed = false;
  // A render that receives these handles rebinds the shared owner to its own
  // request signal (see MOUNTED_TEST_STATE). A `request`-lifetime owner opens
  // fresh stores per binding, so it is not rebound: the mount's one binding
  // is the request every render shares.
  const rebind: RebindMountedState = async (signal) => {
    if (closed || definition.lifetime === 'request') return noMountedState;
    const request = await opened.owner.requestBindings({ signal });
    return Object.freeze({
      context: { noticeLedger: request.noticeLedger, state: request.state },
      close: request.close,
    });
  };
  const state: RebindableStateHandle<TState, TEvents> = Object.freeze({
    lifetime: bindings.state.lifetime,
    changes: bindings.state.changes,
    dispatch: bindings.state.dispatch,
    read: bindings.state.read,
    [MOUNTED_TEST_STATE]: rebind,
  });
  const context: MountedTestStateContext<TState, TEvents> = Object.freeze({
    noticeLedger: bindings.noticeLedger,
    state,
  });
  return Object.freeze({
    ...context,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await bindings.close();
      } finally {
        await opened.dispose();
      }
    },
    context: () => context,
    notices: () => context.noticeLedger.read(),
    read: () => context.state.read(),
  });
};

/**
 * {@link mountTestState} scoped to one callback: the mounted state is closed
 * — and its disposable root removed — when `run` settles, whether it resolved
 * or threw.
 */
export const withTestState = async <
  TState = unknown,
  TEvents extends AgentState.AgentStateEventSchemas = AgentState.AgentStateEventSchemas,
  T = void,
>(
  run: (state: MountedTestState<TState, TEvents>) => Promise<T>,
  ...[options = {}]: HarnessOptionsArguments<MountTestStateOptions<TState, TEvents>>
): Promise<T> => {
  const mounted = await mountTestState<TState, TEvents>(options);
  try {
    return await run(mounted);
  } finally {
    await mounted.close();
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
  /** The manifest layout chain composed around the route element, exactly as the generated worker composes it. */
  readonly layouts: readonly LoadedLayout[];
  readonly layoutRoute: LayoutChainTarget;
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
      composeLayouts(
        options.renderer.createElement,
        options.layouts,
        options.layoutRoute,
        options.component,
        options.componentProps(request),
        request.signal,
      ) as React.ReactNode,
      { signal: request.signal },
    )))),
  }, options.limits === undefined ? {} : { limits: options.limits });

export interface PrepareCliRenderHostOptions {
  readonly context?: RenderRouteContext;
  readonly manifest: AgentBundleTestManifest;
  readonly modules: ReadonlyMap<string, AgentRouteModule>;
  readonly onValidated: (value: unknown) => void;
  /** The invoking CLI's process identity; the rendered command runs inside that same simulated executable. */
  readonly processLifetime: ProviderProcessLifetime;
  readonly provenance: RenderedRouteProvenance;
  readonly signal: AbortSignal;
}

export interface PreparedCliRenderHost {
  readonly close: () => Promise<void>;
  readonly render: (
    command: CompiledCliCommand,
    input: Readonly<Record<string, unknown>>,
    context: GeneratedCliRenderContext,
    projectionModule?: Readonly<Record<string, unknown>>,
  ) => GeneratedCliRenderSession;
}

/** Loads the dispatched command's explicit CLI projection through the generated registry. */
export const loadCliProjectionModule = async (
  manifest: AgentBundleTestManifest,
  command: CompiledCliCommand,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  if (command.projection === undefined) return undefined;
  const modulePath = join(manifest.projectRoot, command.projection.module);
  try {
    const loader = registeredProjectionLoader(manifest, command.routeId);
    if (loader !== undefined) return await loader();
    if (registeredManifestIdentity() !== undefined) {
      throw new Error('The registered projection loaders belong to a different manifest.');
    }
    return await import(pathToFileURL(modulePath).href) as Readonly<Record<string, unknown>>;
  } catch (cause) {
    throw new AgentTestError(
      'invalid-route-module',
      `Unable to load CLI projection ${command.projection.module} for ${command.routeId}.`,
      {
        cause,
        details: [`module path:   ${modulePath}`],
        recovery: 'Build the Rstest configuration with agentBundleRstest() so the projection is transformed with the project modules.',
      },
    );
  }
};

/** Mirrors the generated bin's confirmation, explicit defaults, mapping, and canonical validation boundary. */
export const parseCliCommandInput = (
  command: CompiledCliCommand,
  module: AgentRouteModule,
  projectionModule: Readonly<Record<string, unknown>> | undefined,
  input: Readonly<Record<string, unknown>>,
): unknown => {
  let mapped: Readonly<Record<string, unknown>> = { ...input };
  if (command.projection !== undefined && command.mcp?.confirm === true) {
    if (mapped['yes'] !== true) {
      throw new CliUsageError(confirmationRequiredMessage(command.mcp.server, command.mcp.tool));
    }
    const withoutConfirmation = { ...mapped };
    delete withoutConfirmation['yes'];
    mapped = withoutConfirmation;
  }
  if (command.projection?.defaults !== undefined) {
    const withDefaults: Record<string, unknown> = { ...mapped };
    for (const [key, value] of Object.entries(command.projection.defaults)) {
      if (!Object.hasOwn(withDefaults, key)) withDefaults[key] = value;
    }
    mapped = withDefaults;
  }
  if (command.projection?.mapInput === true) {
    const mapInput = projectionModule?.['mapInput'];
    if (typeof mapInput !== 'function') {
      throw new TypeError(`CLI projection ${command.projection.module} for ${command.routeId} must export a mapInput function.`);
    }
    try {
      mapped = mapInput(mapped) as Readonly<Record<string, unknown>>;
    } catch (error) {
      throw new CliInputError(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    return module.inputSchema!.parse(mapped);
  } catch (error) {
    throw cliInputError(command, mapped, error);
  }
};

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
  // Rendered commands compose the manifest layout chain of their backing
  // route (a projected MCP command keeps its tool route's server layout),
  // resolved up front because the generated shell's render factory is sync.
  const layoutsByRoute = new Map<string, readonly LoadedLayout[]>();
  for (const routeId of options.modules.keys()) {
    const descriptor = options.manifest.routes[routeId];
    if (descriptor === undefined) continue;
    layoutsByRoute.set(routeId, await loadLayoutChain(options.manifest, descriptor, { ...options.provenance, routeId }));
  }
  return Object.freeze({
    close: mounted.close,
    render: (
      command: CompiledCliCommand,
      input: Readonly<Record<string, unknown>>,
      execution: GeneratedCliRenderContext,
      projectionModule?: Readonly<Record<string, unknown>>,
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
      const parsed = parseCliCommandInput(
        command,
        module,
        projectionModule,
        input,
      );
      const commandName = command.path.join(' ');
      const invocation: AgentRenderInvocation = command.mcp === undefined || command.projection !== undefined
        ? {
            kind: 'cli',
            props: { args: execution.args, command: commandName },
          }
        : {
            kind: 'tool',
            props: { input: parsed as never, operationId: command.routeId },
          };
      const collected: AgentProgressUpdate[] = [];
      const descriptor = options.manifest.routes[command.routeId];
      const dispatcher = createFlightDispatcher({
        collected,
        component: componentOf(module, { ...options.provenance, routeId: command.routeId }),
        componentProps: (request) => ({ input: parsed, signal: request.signal }),
        contextProgress: context.progress,
        layoutRoute: descriptor ?? { id: command.routeId, kind: command.mcp === undefined ? 'cli' : 'tool' },
        layouts: layoutsByRoute.get(command.routeId) ?? [],
        // The compiled command carries its route's render budget (#454), as
        // the generated executable's command table does.
        ...(command.render === undefined ? {} : { limits: command.render }),
        renderer,
        requestInit: async (request) => {
          const root = process.cwd();
          const plugin = harnessPluginRoot({ context, manifest: options.manifest, resolvePluginRoot: renderer.resolvePluginRoot });
          const providers = mountProviders({
            explicit: context.providers,
            invocation,
            manifest: options.manifest,
            processHit: claimProcessHit(options.processLifetime),
            provenance: { ...options.provenance, routeId: command.routeId },
          });
          return {
            capabilities: {
              command: renderer.unavailable(),
              filesystem: renderer.unavailable(),
              network: renderer.unavailable(),
              projectRoot: renderer.available({ root }, 'derived'),
            },
            host: renderer.unavailable('unsupported-surface'),
            plugin,
            terminal: renderer.available(execution.terminal, 'native'),
            workspace: renderer.available({ root }, 'derived'),
            ...context,
            ...mounted.context,
            providers,
            invocation: command.mcp === undefined || command.projection !== undefined
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

export interface PrepareScriptRenderHostOptions {
  readonly context?: RenderRouteContext;
  /**
   * Loads the script module. It is called only when the shell opens a
   * session — after its own argv checks — and its failure, like a module
   * without a default component, reaches the shell through the event stream,
   * exactly as the generated executable's render worker reports it.
   */
  readonly loadModule: () => Promise<AgentRouteModule>;
  readonly manifest: AgentBundleTestManifest;
  /** The path-derived script name the generated executable reports as its surface. */
  readonly name: string;
  /** Receives the completed document's value, exactly what the rendered-script shell validated. */
  readonly onComplete: (value: unknown) => void;
  /** The script executable's process identity; a generated `scripts/<name>.mjs` is a fresh process per run. */
  readonly processLifetime: ProviderProcessLifetime;
  readonly provenance: RenderedRouteProvenance;
  readonly signal: AbortSignal;
}

export interface PreparedScriptRenderHost {
  readonly close: () => Promise<void>;
  readonly createSession: (
    argv: readonly string[],
    context: { readonly signal: AbortSignal; readonly terminal: AgentTerminal },
  ) => GeneratedCliRenderSession;
  /**
   * Ends the render the way the generated executable's render worker ending
   * does: every session's event stream fails with `reason`, nothing further
   * starts, and the shell reports the failure. The harness calls this when
   * rendered user code calls `process.exit`, which in that worker ends the
   * worker — never the executable's own shell.
   */
  readonly terminate: (reason: Error) => void;
}

/**
 * Settles with `pending`, or rejects with the signal's reason as soon as it
 * aborts: the pending work is abandoned, the way the generated executable
 * abandons its render worker.
 */
const settledBeforeAbort = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason); };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort); });
  });

/**
 * The render host behind the script-dispatch level for rendered scripts. It
 * mirrors the generated `scripts/<name>.mjs` executable exactly: the
 * component receives `{ argv, signal }`, the request scope opens with the
 * `script` invocation naming the route and the script surface, and — like
 * that executable — the completed value passes through unvalidated; rendered
 * scripts carry no `resultSchema` contract.
 */
export const prepareScriptRenderHost = async (
  options: PrepareScriptRenderHostOptions,
): Promise<PreparedScriptRenderHost> => {
  const context = options.context ?? {};
  // Resolving the state loader is harness wiring and happens now. Loading the
  // renderer (React, the runtime, the Flight server) and mounting the state —
  // loading its module, opening a driver root — is the render worker's work:
  // the generated executable starts that worker only once the shell has
  // accepted argv, so both wait, like the module, for the shell to open a
  // session.
  const mount = manifestStateMount(options.manifest, options.provenance, context);
  // The render worker's lifetime: `terminate` ends it, as `process.exit` in
  // worker code ends the generated executable's worker, and every step and
  // stream of the host observes that end alongside the caller's own signal.
  const termination = new AbortController();
  const terminate = (reason: Error): void => { termination.abort(reason); };
  const ended = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, termination.signal]);
  let rendering: Promise<Renderer> | undefined;
  let mounting: Promise<AutoMountedState> | undefined;
  let mounted: AutoMountedState | undefined;
  const close = async (): Promise<void> => {
    if (mounting === undefined) return;
    if (mounted === undefined && ended(options.signal).aborted) {
      // The executable terminates its render worker on abort; here a mount
      // still pending may never settle, so closing waits for nothing and
      // whatever the mount does produce later is closed on arrival.
      void mounting.then((state) => state.close(), () => undefined);
      return;
    }
    const state = await mounting.catch(() => undefined);
    await state?.close();
  };
  return Object.freeze({
    close,
    createSession: (
      argv: readonly string[],
      execution: { readonly signal: AbortSignal; readonly terminal: AgentTerminal },
    ): GeneratedCliRenderSession => {
      const invocation: AgentRenderInvocation = {
        kind: 'script',
        props: { input: argv as never, name: options.name },
      };
      const collected: AgentProgressUpdate[] = [];
      // State and module are user code: they load when the shell asks for
      // events, and a load or shape failure is the stream's failure, never
      // the harness's.
      // Once the signal aborts, the executable's render worker is gone: no
      // state is mounted and no module is loaded after it. A load already in
      // flight cannot be recalled, but each step that has not begun checks
      // the signal before it starts rather than running on behind a run that
      // has already reported its cancellation.
      const hostSignal = ended(options.signal);
      const signal = ended(execution.signal);
      rendering ??= loadRenderer();
      mounting ??= rendering
        .then((renderer) => {
          hostSignal.throwIfAborted();
          return mount(renderer, hostSignal);
        })
        .then((state) => { mounted = state; return state; });
      // The generated worker composes the project's root layout around a
      // rendered script (a script belongs to no server, so no server layout
      // applies); the layout modules are user code and load with the script's.
      const layoutRoute: LayoutChainTarget = { id: options.provenance.routeId, kind: 'script' };
      const pending = Promise.all([rendering, mounting]).then(async ([renderer, state]) => {
        signal.throwIfAborted();
        const [module, layouts] = await Promise.all([
          options.loadModule(),
          loadLayoutChain(options.manifest, layoutRoute, options.provenance),
        ]);
        signal.throwIfAborted();
        return createFlightDispatcher({
          collected,
          component: componentOf(module, options.provenance),
          componentProps: (request) => ({ argv, signal: request.signal }),
          contextProgress: context.progress,
          layoutRoute,
          layouts,
          renderer,
          requestInit: async (request) => {
            const root = process.cwd();
            // The generated script's render worker hands its providers the
            // `script` invocation with the path-derived name, never the route id.
            const plugin = harnessPluginRoot({ context, manifest: options.manifest, resolvePluginRoot: renderer.resolvePluginRoot });
            const providers = mountProviders({
              explicit: context.providers,
              invocation,
              manifest: options.manifest,
              processHit: claimProcessHit(options.processLifetime),
              provenance: options.provenance,
            });
            return {
              capabilities: {
                command: renderer.unavailable(),
                filesystem: renderer.unavailable(),
                network: renderer.unavailable(),
                projectRoot: renderer.available({ root }, 'derived'),
              },
              host: renderer.unavailable('unsupported-surface'),
              plugin,
              terminal: renderer.available(execution.terminal, 'native'),
              workspace: renderer.available({ root }, 'derived'),
              ...context,
              ...state.context,
              providers,
              invocation: {
                kind: 'script',
                operationId: options.provenance.routeId,
                surface: options.name,
                ...context.invocation,
              },
              signal: request.signal,
            };
          },
        });
      });
      void pending.catch(() => undefined);
      let inner: ReadableStreamDefaultReader<CliRenderedEvent> | undefined;
      return Object.freeze({
        close,
        events: (): ReadableStream<CliRenderedEvent> => new ReadableStream<CliRenderedEvent>({
          cancel: async (reason) => { await inner?.cancel(reason); },
          start: async (controller) => {
            try {
              // The executable fails its parent stream the moment the signal
              // aborts and terminates the worker, however far along the
              // module or state load is; the stream here fails the same way
              // rather than waiting for a load that may never settle.
              const dispatcher = await settledBeforeAbort(pending, signal);
              inner = dispatcher.stream({ invocation, signal }).getReader();
              for (;;) {
                const next = await inner.read();
                if (next.done) break;
                termination.signal.throwIfAborted();
                controller.enqueue(next.value);
              }
              termination.signal.throwIfAborted();
              controller.close();
            } catch (error) {
              // A worker that exited fails the executable's pending render
              // with the exit, whatever the render itself was doing.
              controller.error(termination.signal.aborted ? termination.signal.reason : error);
            }
          },
        }),
        validate: (value: unknown) => {
          options.onComplete(value);
          return value;
        },
      });
    },
    terminate,
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
  // A route-unit render stands in for one fresh executable serving one
  // request; nothing is warm across renders, so each starts at hit 1.
  const processLifetime = createProviderProcessLifetime();
  const mounted = await mountManifestState(resolved.manifest, resolved.provenance, context, renderer, signal);
  const plugin = harnessPluginRoot({ context, manifest: resolved.manifest, resolvePluginRoot: renderer.resolvePluginRoot });
  const dispatcher = createFlightDispatcher({
    collected,
    component: resolved.component,
    componentProps: (request) => componentProps(request.invocation, resolved.kind, options, request.signal),
    contextProgress: context.progress,
    layoutRoute: {
      id: resolved.provenance.routeId,
      kind: resolved.kind,
      ...(resolved.provenance.serverId === undefined ? {} : { serverId: resolved.provenance.serverId }),
    },
    layouts: resolved.layouts,
    // The route's compiled budget layers over the base limits, as it does on
    // the generated dispatchers.
    ...(options.limits === undefined && resolved.render === undefined
      ? {}
      : { limits: { ...options.limits, ...resolved.render } }),
    renderer,
    requestInit: async (request) => ({
      plugin,
      // What the artifact's scope for this route kind mounts (#511): no
      // terminal under MCP or a hook, the harness's piped shape otherwise.
      terminal: renderer.available(routeKindTerminal(resolved.kind), 'derived'),
      ...context,
      ...mounted.context,
      // The render invocation is exactly what the generated Flight worker
      // receives as `message.invocation`, so providers see the same shape.
      providers: mountProviders({
        explicit: context.providers,
        invocation: request.invocation,
        manifest: resolved.manifest,
        processHit: claimProcessHit(processLifetime),
        provenance: resolved.provenance,
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
export const renderRoute = async <Target extends RenderRouteTarget>(
  target: (Target & RouteTargetConstraint<Target>) | RouteTargetConstraint<Target>,
  ...[options = {}]: HarnessOptionsArguments<RenderRouteOptions<Target>>
): Promise<RenderedRoute<Target>> => {
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
        // The value was parsed by the same `resultSchema` the registration types it from.
        : { result: parsedResult(resolved.module.resultSchema, document, resolved.provenance) as RouteTargetResult<Target> }),
    });
  } catch (error) {
    throw renderFailure(error, invocation, resolved.provenance);
  } finally {
    await close();
  }
};

export interface RenderedRouteEvents<Target = RenderRouteTarget> extends RenderedRoute<Target> {
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
export const renderRouteEvents = async <Target extends RenderRouteTarget>(
  target: (Target & RouteTargetConstraint<Target>) | RouteTargetConstraint<Target>,
  ...[options = {}]: HarnessOptionsArguments<RenderRouteOptions<Target>>
): Promise<RenderedRouteEvents<Target>> => {
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
      : { result: parsedResult(resolved.module.resultSchema, complete.document, resolved.provenance) as RouteTargetResult<Target> }),
  });
};
