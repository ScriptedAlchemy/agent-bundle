/**
 * The in-memory MCP projection proof level.
 *
 * A test at this level talks to the **real generated MCP server** — the same
 * `agent-bundle/mcp-server-runtime` registration and Agent Document
 * projection a built artifact runs — through a **real MCP SDK client** over
 * the SDK's in-memory linked transport pair. What differs from a shipped
 * server is the transport and the render host: there is no process, no stdio
 * framing, and routes render in this process instead of in a spawned Flight
 * worker.
 *
 * That makes this fast protocol-contract proof and nothing else. It is
 * labeled `mcp-in-memory` in every result, every provenance record, and every
 * failure message, and `invokePackedMcpTool` (`agent-bundle/test`, the
 * `packed-stdio` level) is the helper that carries process evidence.
 */
import type { Client } from '@modelcontextprotocol/client';
import type {
  AgentStateDefinition,
  AgentStateDriver,
  AgentStateEventSchemas,
} from '@agent-bundle/runtime/state';
import type {
  AgentRenderLimits,
  LineageHost,
  RegisteredMcpRouteId,
  RegisteredMcpRouteKind,
  RegisteredMcpRouteName,
  RegisteredMcpServerName,
  RegisteredRouteInput,
} from '@agent-bundle/runtime';
import type { AgentLineageRegistry } from '@agent-bundle/runtime/lineage';
import type { createGeneratedRuntimeState } from '@agent-bundle/runtime/mount';
import type { ReactNode } from 'react';

import type { NoticeDeliveryAdvertisement } from '../adapters/notice-delivery.ts';
import type { NormalizedNoticeRetentionPolicy } from '../core/types.ts';
import type { GeneratedNoticeDeliveryBinding, GeneratedNoticePrincipal } from '../mcp-server-runtime.ts';
import { createProviderProcessLifetime } from '../routes/provider-execution.ts';
import { AgentTestError, captured } from './errors.ts';
import { composeLayouts, loadLayoutChain, type LoadedLayout } from './layouts.ts';
import { MCP_IN_MEMORY_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { claimProcessHit, harnessPluginRoot, mountProviders } from './providers.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import type { HarnessOptionsArguments, RenderRouteContext, RenderRouteContextInit } from './render.ts';
import type { RenderedRouteProvenance, TestableRouteDescriptor } from './types.ts';

/** Where an in-memory projection result came from and what it proves. */
export interface McpProjectionProvenance {
  readonly manifestDigest: string;
  readonly projectRoot: string;
  readonly proofLevel: typeof MCP_IN_MEMORY_PROOF_LEVEL;
  /** The MCP server name as the protocol sees it, e.g. `curator`. */
  readonly serverName: string;
  /** Compiled route ids this server registered. */
  readonly routeIds: readonly string[];
}

export interface McpContentBlock {
  readonly data?: string;
  readonly mimeType?: string;
  readonly name?: string;
  readonly text?: string;
  readonly type: string;
  readonly uri?: string;
}

export interface McpToolInvocation {
  /** Result-level `CallToolResult._meta`, projected from `Agent.Result metadata`. */
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly content: readonly McpContentBlock[];
  readonly isError: boolean;
  readonly provenance: McpProjectionProvenance;
  readonly structuredContent?: unknown;
}

export interface InMemoryMcpSessionOptionsBase<
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
> {
  /**
   * A lineage registry the generated server resolves tool calls through,
   * exactly as the artifact does; omitted sessions observe `request.lineage`
   * as `unavailable('not-provided')`.
   */
  /**
   * The server dispatcher's base render limits, as the generated entry's
   * dispatcher has them (the runtime defaults when omitted). A route's compiled
   * `config.render` budget layers over them per call exactly as in the
   * artifact, so a low `maxElapsedMs` here observes a route's raised budget
   * without waiting out the 60-second default.
   */
  readonly limits?: Partial<AgentRenderLimits>;
  readonly lineage?: AgentLineageRegistry;
  /** The host vocabulary the registry applies when the in-memory client name maps to none. */
  readonly lineageHost?: LineageHost;
  readonly manifest?: AgentBundleTestManifest;
  /** MCP server name. Optional when the project compiled exactly one server. */
  readonly server?: string;
  /** Optional state owner input for parity with a generated Flight worker. */
  readonly state?: {
    readonly definition: AgentStateDefinition<TState, TEvents>;
    readonly driver: AgentStateDriver;
    /**
     * The host advertisement the generated runtime would mount (a
     * `TargetAdapter.noticeDelivery` value): its per-route sensitivity
     * ceilings decide what the inbox discloses. Absent means every route
     * admits `internal`, exactly as a generated artifact without one.
     */
    readonly noticeDelivery?: NoticeDeliveryAdvertisement;
    /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
    readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  };
}

/**
 * Session options; `context` holds the request-scoped overrides applied to
 * every route render in this session; omitting it (or its `providers`) mounts
 * the project's conventional providers exactly as the generated server does
 * (see {@link RenderRouteContextInit}).
 */
export type InMemoryMcpSessionOptions<
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
> = InMemoryMcpSessionOptionsBase<TState, TEvents> & RenderRouteContextInit;

export interface InMemoryMcpSession extends AsyncDisposable {
  /** The real MCP SDK client, for protocol calls this module does not wrap. */
  readonly client: Client;
  readonly close: () => Promise<void>;
  readonly provenance: McpProjectionProvenance;
}

/**
 * The constraint a `server` option must satisfy: once the project's routes
 * are registered, a literal must name a compiled server (`curator` for
 * `tool:curator/find`; a typo is rejected naming the alternatives), while a
 * value typed `string` stays legal. `string` for an unregistered project.
 */
export type McpServerConstraint<Server> = string extends Server ? string : RegisteredMcpServerName & string;

/**
 * The server the wire helpers look a name up on: a registered literal narrows
 * the lookup to that server's routes; `string` (omitted or dynamic) and an
 * unregistered literal — already rejected by {@link McpServerConstraint} —
 * match every compiled server, so the one error lands on `server`.
 */
export type McpRouteServer<Server extends string> = Server extends RegisteredMcpServerName ? Server : string;

/**
 * Options of one wire invocation. `Input` is the payload the generated server
 * hands the route: `invokeMcpTool` and `getMcpPrompt` bind it to the route's
 * registered input ({@link McpRouteInput}) when the name is a literal, and
 * it stays `unknown` — the previous shape — for a dynamic name or an
 * unregistered project. `Server` is the literal `server` option, when given;
 * it selects which server's route the name resolves to.
 */
export type McpInvocationOptions<Input = unknown, Server extends string = string> = InMemoryMcpSessionOptions & {
  readonly input?: Input;
  readonly server?: (Server & McpServerConstraint<Server>) | McpServerConstraint<Server>;
};

/**
 * The constraint one protocol name must satisfy — `RouteTargetConstraint` for
 * the wire helpers. Once the generated `.agent-bundle/routes.d.ts` registers
 * the project's routes, a string literal must be the protocol name of a
 * registered `Kind` route on `Server` (`find` for `tool:curator/find`; the
 * editor completes them and a typo is rejected naming the alternatives) —
 * on any compiled server when `server` is omitted or dynamic — while a value
 * typed `string` stays legal for dynamic lookups. Without a registration
 * `RegisteredMcpRouteName` is `string`, so every name is legal, as before.
 *
 * The `& string` is not a widening: it makes the compiler reduce the alias
 * instantiation to a fresh literal union, so a rejection lists the registered
 * names rather than printing `RegisteredMcpRouteName<"tool">`.
 */
export type McpRouteNameConstraint<Name, Kind extends RegisteredMcpRouteKind, Server extends string = string> =
  string extends Name ? string : RegisteredMcpRouteName<Kind, McpRouteServer<Server>> & string;

/**
 * The registered input of the `Kind` route named `Name` on `Server` — on any
 * compiled server when `Server` is `string`, a union when two of them register
 * the same name; `unknown` for a dynamic name or an unregistered project.
 */
export type McpRouteInput<
  Name extends string,
  Kind extends RegisteredMcpRouteKind,
  Server extends string = string,
> = Name extends RegisteredMcpRouteName<Kind, McpRouteServer<Server>>
  ? RegisteredRouteInput<RegisteredMcpRouteId<Kind, McpRouteServer<Server>, Name>>
  : unknown;

const serverRoutes = (
  manifest: AgentBundleTestManifest,
  serverName: string,
): readonly TestableRouteDescriptor[] => Object.values(manifest.routes)
  .filter((route) => route.serverId === `mcp:${serverName}` && route.kind !== 'app')
  .sort((left, right) => left.id.localeCompare(right.id));

const compiledServerNames = (manifest: AgentBundleTestManifest): readonly string[] => [
  ...new Set(Object.values(manifest.routes).flatMap((route) =>
    (route.serverId === undefined ? [] : [route.serverId.replace(/^mcp:/u, '')]))),
].sort((left, right) => left.localeCompare(right));

const resolveServerName = (
  manifest: AgentBundleTestManifest,
  requested: string | undefined,
): string => {
  const names = compiledServerNames(manifest);
  if (requested !== undefined) {
    if (!names.includes(requested)) {
      throw new AgentTestError('server-not-found', `No compiled MCP server is named ${JSON.stringify(requested)}.`, {
        details: [
          `project root: ${manifest.projectRoot}`,
          `compiled:     ${names.length === 0 ? 'this project compiled no MCP servers' : names.join(', ')}`,
        ],
        recovery: 'Name one of the compiled servers, or add route modules under src/mcp/<server>/.',
      });
    }
    return requested;
  }
  if (names.length === 1) return names[0]!;
  throw new AgentTestError(
    'server-not-found',
    names.length === 0
      ? 'This project compiled no MCP servers.'
      : 'This project compiled more than one MCP server, so the helper cannot pick one.',
    {
      details: [
        `project root: ${manifest.projectRoot}`,
        `compiled:     ${names.length === 0 ? 'none' : names.join(', ')}`,
      ],
      recovery: 'Pass { server: "<name>" }.',
    },
  );
};

const routeProvenance = (
  descriptor: TestableRouteDescriptor,
  manifest: AgentBundleTestManifest,
): RenderedRouteProvenance => Object.freeze({
  kind: descriptor.kind as 'prompt' | 'resource' | 'tool',
  manifestDigest: manifest.digest,
  modulePath: descriptor.source,
  projectRoot: manifest.projectRoot,
  proofLevel: MCP_IN_MEMORY_PROOF_LEVEL,
  relativePath: descriptor.relativePath,
  routeId: descriptor.id,
  ...(descriptor.serverId === undefined ? {} : { serverId: descriptor.serverId }),
  source: 'manifest' as const,
  targets: manifest.targets,
});

interface ServerRuntime {
  readonly createGeneratedRouteMcpServer: typeof import('../mcp-server-runtime.ts').createGeneratedRouteMcpServer;
}

interface Renderer {
  readonly agent: typeof import('@agent-bundle/runtime').agent;
  readonly createElement: typeof import('react').createElement;
  readonly createGeneratedRuntimeState: typeof createGeneratedRuntimeState;
  readonly createNoticeInboxSignaller: typeof import('@agent-bundle/runtime/notices').createNoticeInboxSignaller;
  readonly createWarmFlightHost: typeof import('@agent-bundle/runtime').createWarmFlightHost;
  readonly noticeInboxRoute: typeof import('@agent-bundle/runtime/notices/inbox-route');
  readonly renderAgentFlight: typeof import('@agent-bundle/runtime/flight/server').renderAgentFlight;
  readonly resolvePluginRoot: typeof import('@agent-bundle/runtime').resolvePluginRoot;
  readonly runAgentRequest: typeof import('@agent-bundle/runtime').runAgentRequest;
}

interface Sdk {
  readonly Client: typeof import('@modelcontextprotocol/client').Client;
  readonly InMemoryTransport: typeof import('@modelcontextprotocol/client').InMemoryTransport;
}

let dependenciesPromise: Promise<ServerRuntime & Renderer & Sdk> | undefined;

/**
 * Loads the server runtime, the renderer, and the MCP SDK on first use. These
 * are deliberately not module-scope imports: `@agent-bundle/runtime` and
 * `react` are optional peers of this package, and the Flight server entry
 * throws on import unless the process enabled the `react-server` condition —
 * so importing `agent-bundle/test` for the manifest alone must not require
 * either, and a missing condition must fail with the wiring step.
 */
const loadDependencies = async (): Promise<ServerRuntime & Renderer & Sdk> => {
  dependenciesPromise ??= (async () => {
    const [serverRuntime, runtime, mount, notices, noticeInboxRoute, flight, react, client] = await Promise.all([
      import('../mcp-server-runtime.ts'),
      import('@agent-bundle/runtime'),
      import('@agent-bundle/runtime/mount'),
      import('@agent-bundle/runtime/notices'),
      import('@agent-bundle/runtime/notices/inbox-route'),
      import('@agent-bundle/runtime/flight/server'),
      import('react'),
      import('@modelcontextprotocol/client'),
    ]);
    return {
      Client: client.Client,
      InMemoryTransport: client.InMemoryTransport,
      agent: runtime.agent,
      createElement: react.createElement,
      createGeneratedRuntimeState: mount.createGeneratedRuntimeState,
      createGeneratedRouteMcpServer: serverRuntime.createGeneratedRouteMcpServer,
      createNoticeInboxSignaller: notices.createNoticeInboxSignaller,
      createWarmFlightHost: runtime.createWarmFlightHost,
      noticeInboxRoute,
      renderAgentFlight: flight.renderAgentFlight,
      resolvePluginRoot: runtime.resolvePluginRoot,
      runAgentRequest: runtime.runAgentRequest,
    };
  })().catch((error: unknown) => {
    dependenciesPromise = undefined;
    throw new AgentTestError(
      'projection-failed',
      'Unable to load the generated MCP server runtime for an in-memory projection.',
      {
        cause: error,
        details: [`cause:        ${error instanceof Error ? error.message : String(error)}`],
        recovery: 'Install react and @agent-bundle/runtime, and run the level with the react-server condition — agentBundleRstest() from agent-bundle/rstest configures both.',
      },
    );
  });
  return dependenciesPromise;
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return chunks;
    chunks.push(next.value);
  }
};

const withContextIdentity = (
  signaller: GeneratedNoticeDeliveryBinding,
  context: RenderRouteContext,
): GeneratedNoticeDeliveryBinding => Object.freeze({
  inboxUri: signaller.inboxUri,
  get subscribed(): boolean {
    return signaller.subscribed;
  },
  close: () => signaller.close(),
  observe: (send: () => Promise<void>) => signaller.observe(send),
  subscribe: (principal: GeneratedNoticePrincipal) => {
    const lineage = context.lineage ?? principal.lineage;
    return signaller.subscribe({
      actor: context.actor ?? principal.actor,
      host: context.host ?? principal.host,
      ...(lineage === undefined ? {} : { lineage }),
      session: context.session ?? principal.session,
      workspace: context.workspace ?? principal.workspace,
    });
  },
  unsubscribe: () => signaller.unsubscribe(),
});

const streamOf = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

/**
 * Opens a real MCP client against the real generated server for one compiled
 * MCP surface, over the SDK's in-memory transport pair.
 *
 * Compiled MCP Apps are deliberately not registered: their HTML is a browser
 * build output, and claiming an App resource without it would be exactly the
 * fake this level must not become. App surfaces belong to the browser level.
 */
export const openInMemoryMcpServer = async <
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
>(
  ...[options = {}]: HarnessOptionsArguments<InMemoryMcpSessionOptions<TState, TEvents>>
): Promise<InMemoryMcpSession> => {
  const manifest = options.manifest ?? testManifest();
  const serverName = resolveServerName(manifest, options.server);
  const descriptors = serverRoutes(manifest, serverName);
  const dependencies = await loadDependencies();
  const context = options.context ?? {};

  const routes: Record<string, {
    config: Readonly<Record<string, unknown>>;
    id: string;
    kind: 'prompt' | 'resource' | 'tool';
    module: { default: (props: never) => unknown; inputSchema?: unknown; resultSchema: { parse: (value: unknown) => unknown } };
    name: string;
  }> = {};
  const layoutsByRoute = new Map<string, readonly LoadedLayout[]>();
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'tool' && descriptor.kind !== 'resource' && descriptor.kind !== 'prompt') continue;
    const loader = registeredRouteLoader(manifest, descriptor.id);
    if (loader === undefined) {
      throw new AgentTestError(
        'manifest-unavailable',
        `Route ${descriptor.id} is compiled but no test-time module loader is registered for it.`,
        {
          provenance: routeProvenance(descriptor, manifest),
          recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers route loaders.',
        },
      );
    }
    const module = await loader() as {
      default: (props: never) => unknown;
      inputSchema?: unknown;
      resultSchema?: { parse: (value: unknown) => unknown };
    };
    if (module.resultSchema === undefined) {
      throw new AgentTestError(
        'invalid-route-module',
        `Route ${descriptor.id} exports no resultSchema, which the generated MCP server requires to validate its result.`,
        {
          provenance: routeProvenance(descriptor, manifest),
          recovery: 'Export a resultSchema from the route module; the generated server validates every document value against it.',
        },
      );
    }
    routes[descriptor.id] = {
      config: descriptor.config,
      id: descriptor.id,
      kind: descriptor.kind,
      module: { ...module, resultSchema: module.resultSchema },
      name: descriptor.id.slice(descriptor.id.lastIndexOf('/') + 1),
    };
    layoutsByRoute.set(
      descriptor.id,
      await loadLayoutChain(manifest, descriptor, routeProvenance(descriptor, manifest)),
    );
  }
  if (options.state !== undefined) {
    const record = dependencies.noticeInboxRoute.noticeInboxRouteRecord(dependencies.noticeInboxRoute);
    routes[record.id] = record as never;
  }

  // The in-process stand-in for the artifact's Flight worker: same request
  // scope, same Flight encode, same bytes handed back to the dispatcher, and
  // the same warm host wrapper the artifact uses — it simply renders here
  // instead of in a spawned thread.
  const artifactEpoch = `${manifest.plugin.name}@${manifest.plugin.version}`;
  // One process identity per open server, like the artifact's Flight worker:
  // every request this session handles shares it, and a new server starts fresh.
  const processLifetime = createProviderProcessLifetime();
  const runtimeState = options.state === undefined
    ? undefined
    : dependencies.createGeneratedRuntimeState(options.state);
  // One resolution per open server, as the generated entry does at startup.
  const pluginRoot = harnessPluginRoot({ context, manifest, resolvePluginRoot: dependencies.resolvePluginRoot });
  const host = dependencies.createWarmFlightHost({
    artifactEpoch,
    host: {
      execute: async (request): Promise<ReadableStream<Uint8Array>> => {
        const transport = await dependencies.agent();
        // The generated server dispatches every MCP route kind as a tool
        // invocation, so the operation id is the compiled route id.
        const props = request.invocation.props as { readonly input?: unknown; readonly operationId?: string };
        const route = routes[String(props.operationId)];
        if (route === undefined) {
          throw new AgentTestError('route-not-found', `The in-memory server dispatched an unregistered route ${captured(props.operationId)}.`, {
            details: [`registered:   ${Object.keys(routes).sort().join(', ')}`],
          });
        }
        // The hit is claimed before state bindings are awaited, in the
        // generated worker's order, so a failed or slow binding still consumes
        // this request's hit and concurrent requests keep arrival order.
        const processHit = claimProcessHit(processLifetime);
        const bindings = await runtimeState?.requestBindings({ signal: request.signal });
        try {
          // Conventional providers run as the scope's resolver, over the same
          // tool invocation the generated Flight worker hands them.
          const descriptor = manifest.routes[route.id];
          // The server process's anchor, as the artifact's host scope forwards
          // it into the Flight worker; the context seam overrides it like every
          // other identity axis.
          const plugin = transport.plugin.state === 'available' ? transport.plugin : pluginRoot;
          const providers = mountProviders({
            explicit: context.providers,
            invocation: request.invocation,
            manifest,
            processHit,
            ...(descriptor === undefined ? {} : { provenance: routeProvenance(descriptor, manifest) }),
          });
          return streamOf(await dependencies.runAgentRequest({
            // Mirror the Flight worker boundary while allowing the documented
            // harness context seam to override forwarded transport identity.
            actor: transport.actor,
            host: transport.host,
            lineage: transport.lineage,
            plugin,
            session: transport.session,
            terminal: transport.terminal,
            workspace: transport.workspace,
            ...context,
            providers,
            invocation: {
              kind: 'tool' as const,
              operationId: route.id,
              surface: route.name,
              ...context.invocation,
            },
            ...(bindings === undefined ? {} : {
              noticeLedger: bindings.noticeLedger,
              state: bindings.state,
            }),
            ...(request.progress === undefined ? {} : { progress: request.progress }),
            signal: request.signal,
          }, async () => drain(dependencies.renderAgentFlight(
            composeLayouts(
              dependencies.createElement,
              layoutsByRoute.get(route.id) ?? [],
              { id: route.id, kind: route.kind, serverId: `mcp:${serverName}` },
              route.module.default,
              { input: props.input, signal: request.signal },
              request.signal,
            ) as ReactNode,
            { signal: request.signal },
          ))));
        } finally {
          await bindings?.close();
        }
      },
    },
    ...(runtimeState === undefined ? {} : { runtimeState }),
  });

  // Mirrors the generated entry: only a workspace-durable store can be shared
  // between the render side and the server process, so only that lifetime
  // advertises `resources.subscribe` for the notice inbox. The warm host owns
  // the state's lifetime, so the signaller's store handle does not close it,
  // and the harness context seam overrides the subscriber's transport
  // identity exactly as it overrides every render's.
  const notices = runtimeState === undefined || options.state?.definition.lifetime !== 'workspace-durable'
    ? undefined
    : withContextIdentity(dependencies.createNoticeInboxSignaller({
      ...(options.state.noticeDelivery === undefined ? {} : { delivery: options.state.noticeDelivery }),
      store: { close: async () => undefined, noticeLedger: () => runtimeState.noticeLedger() },
    }), context);
  const server = await dependencies.createGeneratedRouteMcpServer({
    artifactEpoch,
    host,
    ...(notices === undefined ? {} : { notices }),
    ...(options.lineage === undefined ? {} : { lineage: options.lineage }),
    ...(options.lineageHost === undefined
      ? {}
      : {
          events: {
            allowedTargets: [options.lineageHost],
            artifactEpoch,
            createCanonicalEventProps: (() => { throw new Error('in-memory lineage sessions dispatch no events'); }) as never,
            createEventRuntimeServer: (async () => ({ close: async () => undefined })) as never,
            endpointId: `${artifactEpoch}:in-memory`,
            projectEventDocument: (() => undefined) as never,
            target: options.lineageHost,
          },
        }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    plugin: manifest.plugin,
    pluginRoot,
    routes: routes as never,
  });
  const client = new dependencies.Client({ name: 'agent-bundle-in-memory-projection', version: '1.0.0' });
  const [clientTransport, serverTransport] = dependencies.InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport as never), client.connect(clientTransport)]);

  const provenance: McpProjectionProvenance = Object.freeze({
    manifestDigest: manifest.digest,
    projectRoot: manifest.projectRoot,
    proofLevel: MCP_IN_MEMORY_PROOF_LEVEL,
    routeIds: Object.freeze(Object.keys(routes).sort()),
    serverName,
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
    await server.close();
  };
  return Object.freeze({
    client,
    close,
    provenance,
    [Symbol.asyncDispose]: close,
  });
};

/**
 * Runs `body` against a single-use in-memory session. Every wrapper below
 * goes through this so a helper never leaks a connected transport pair.
 */
const withSession = async <T>(
  options: InMemoryMcpSessionOptions,
  body: (session: InMemoryMcpSession) => Promise<T>,
): Promise<T> => {
  const session = await openInMemoryMcpServer(options);
  try {
    return await body(session);
  } finally {
    await session.close();
  }
};

const asContentBlocks = (value: unknown): readonly McpContentBlock[] =>
  Array.isArray(value) ? (value as readonly McpContentBlock[]) : [];

/**
 * Calls one compiled tool through the real protocol and returns the projected
 * result. `mcp-in-memory` level: protocol contract proof, not process proof.
 *
 * `tool` is the wire name (`find` for the route `tool:curator/find`). Once
 * the project's routes are registered, a literal is checked against the
 * compiled tool names — of the literal `server` when one is passed, since
 * the session mounts only that server's routes — and `input` is typed from
 * that route's `inputSchema` (see {@link McpRouteNameConstraint}). The
 * projected `structuredContent` stays `unknown`: the wire carries it only for
 * object-valued documents, so the route's `resultSchema` output is not what
 * every call yields.
 */
export const invokeMcpTool = async <Name extends string, Server extends string = string>(
  tool: (Name & McpRouteNameConstraint<Name, 'tool', Server>) | McpRouteNameConstraint<Name, 'tool', Server>,
  ...[options = {}]: HarnessOptionsArguments<McpInvocationOptions<McpRouteInput<Name, 'tool', Server>, Server>>
): Promise<McpToolInvocation> => withSession(options, async (session) => {
  const result = await session.client.callTool({
    arguments: (options.input ?? {}) as Record<string, unknown>,
    name: tool,
  }) as { _meta?: Readonly<Record<string, unknown>>; content?: unknown; isError?: boolean; structuredContent?: unknown };
  return Object.freeze({
    ...(result._meta === undefined ? {} : { _meta: result._meta }),
    content: asContentBlocks(result.content),
    isError: result.isError === true,
    provenance: session.provenance,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
  });
});

export interface McpResourceRead {
  readonly contents: readonly Readonly<Record<string, unknown>>[];
  readonly provenance: McpProjectionProvenance;
}

/** Reads one compiled resource route by URI through the real protocol. */
export const readMcpResource = async (
  uri: string,
  ...[options = {}]: HarnessOptionsArguments<InMemoryMcpSessionOptions>
): Promise<McpResourceRead> => withSession(options, async (session) => {
  const result = await session.client.readResource({ uri }) as { contents?: unknown };
  return Object.freeze({
    contents: Array.isArray(result.contents) ? (result.contents as readonly Readonly<Record<string, unknown>>[]) : [],
    provenance: session.provenance,
  });
});

export interface McpPromptResult {
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly provenance: McpProjectionProvenance;
}

/**
 * Gets one compiled prompt route through the real protocol. `prompt` is the
 * wire name (`brief` for `prompt:curator/brief`); once registered, a literal
 * is checked against the compiled prompt names (of the literal `server`, when
 * passed) and `input` is typed from that route's `inputSchema`, exactly as
 * {@link invokeMcpTool} types a tool.
 */
export const getMcpPrompt = async <Name extends string, Server extends string = string>(
  prompt: (Name & McpRouteNameConstraint<Name, 'prompt', Server>) | McpRouteNameConstraint<Name, 'prompt', Server>,
  ...[options = {}]: HarnessOptionsArguments<McpInvocationOptions<McpRouteInput<Name, 'prompt', Server>, Server>>
): Promise<McpPromptResult> => withSession(options, async (session) => {
  const result = await session.client.getPrompt({
    arguments: (options.input ?? {}) as Record<string, string>,
    name: prompt,
  }) as { messages?: unknown };
  return Object.freeze({
    messages: Array.isArray(result.messages) ? (result.messages as readonly Readonly<Record<string, unknown>>[]) : [],
    provenance: session.provenance,
  });
});

export interface McpSurfaceListing {
  readonly prompts: readonly string[];
  readonly provenance: McpProjectionProvenance;
  readonly resources: readonly string[];
  readonly tools: readonly string[];
}

/**
 * Lists what the generated server actually registered — the cheapest proof
 * that a compiled route reached the protocol at all.
 */
export const listMcpSurface = async (
  ...[options = {}]: HarnessOptionsArguments<InMemoryMcpSessionOptions>
): Promise<McpSurfaceListing> => withSession(options, async (session) => {
  const [tools, resources, prompts] = await Promise.all([
    session.client.listTools(),
    session.client.listResources(),
    session.client.listPrompts(),
  ]);
  return Object.freeze({
    prompts: Object.freeze(prompts.prompts.map((entry) => entry.name).sort()),
    provenance: session.provenance,
    resources: Object.freeze(resources.resources.map((entry) => entry.uri).sort()),
    tools: Object.freeze(tools.tools.map((entry) => entry.name).sort()),
  });
});
