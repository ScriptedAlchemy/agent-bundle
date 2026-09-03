/**
 * The runtime half of a generated MCP server: the warm Flight worker host,
 * route registration, request identity, the projected render, and the
 * Agent Document → MCP result projection.
 *
 * The generated stdio entry (`src/build/entry-shell.ts`) used to inline all of
 * this as template text, which made it unreachable outside a built artifact.
 * It lives here so exactly one implementation serves both the packed server a
 * host spawns and the in-memory server the projection proof level connects a
 * client to — a test that renders through a second registration or projection
 * path proves nothing about the artifact.
 *
 * The generated entry reaches this module through the `agent-bundle/mcp-server-runtime`
 * bundler alias, so artifacts stay self-contained; `agent-bundle/test` imports
 * it directly.
 */
import { Worker } from 'node:worker_threads';

import { McpServer } from '@modelcontextprotocol/server';
import {
  AgentRuntimeError,
  agent,
  attachMcpStructuredContent,
  available,
  createAgentRenderDispatcher,
  createWarmFlightHost,
  projectMcpRenderStream,
  runAgentRequest,
} from '@agent-bundle/runtime';
import type { createEventRuntimeServer } from './events/ipc.ts';
import type { createCanonicalEventProps, projectEventDocument } from './events/project.ts';
import { canonicalAgentEvents, type CanonicalAgentEvent } from './routes/public.ts';
import type {
  AgentActorIdentity,
  AgentDocument,
  AgentHostIdentity,
  AgentProgressReporter,
  AgentRenderDispatch,
  AgentRenderDispatcher,
  AgentSessionIdentity,
  AgentWorkspaceIdentity,
  McpProgressNotificationParams,
  McpProgressToken,
  Observed,
  WarmFlightHost,
} from '@agent-bundle/runtime';

/** One route the generated server hosts, as the generated module records it. */
export interface GeneratedRouteRecord {
  /** The route module's statically extracted `config` export. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: 'tool' | 'resource' | 'prompt';
  readonly module: {
    readonly default: (props: never) => unknown;
    readonly inputSchema?: unknown;
    readonly resultSchema: { readonly parse: (value: unknown) => unknown };
  };
  /** The protocol name the server registers — the route id's last segment. */
  readonly name: string;
}

/** One compiled MCP App the generated server serves as a resource. */
export interface GeneratedMcpAppRecord {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly html: string;
  readonly mimeType: string;
  readonly name: string;
  readonly resourceUri: string;
}

/**
 * The subset of the MCP SDK's request context the generated server reads.
 * Structural so the harness can build one without importing SDK internals.
 */
export interface GeneratedRouteRequestContext {
  readonly http?: { readonly authInfo?: { readonly clientId?: string } };
  readonly mcpReq: {
    readonly _meta?: { readonly progressToken?: McpProgressToken };
    readonly notify?: (notification: {
      readonly method: 'notifications/progress';
      readonly params: McpProgressNotificationParams;
    }) => Promise<void>;
    readonly signal: AbortSignal;
  };
  readonly sessionId?: string;
}

export interface RenderedGeneratedRoute {
  readonly document: AgentDocument;
  /** The document value parsed by the route's own `resultSchema`. */
  readonly result: unknown;
  /** The projected `CallToolResult`, before structured content is attached. */
  readonly toolResult: Awaited<ReturnType<typeof projectMcpRenderStream>>['result'];
}

interface GeneratedRouteIdentity {
  readonly actor?: Observed<AgentActorIdentity>;
  readonly host?: Observed<AgentHostIdentity>;
  readonly session?: Observed<AgentSessionIdentity>;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
}

/** Identity the server derives from the transport's own request context. */
const requestIdentity = (
  context: GeneratedRouteRequestContext,
  clientName: string | undefined,
): GeneratedRouteIdentity => ({
  ...(context.http?.authInfo?.clientId === undefined
    ? {}
    : { actor: available({ id: context.http.authInfo.clientId }, 'native') }),
  ...(typeof clientName === 'string' && clientName.trim() !== ''
    ? { host: available({ name: clientName }, 'native') }
    : {}),
  ...(typeof context.sessionId === 'string' && context.sessionId.trim() !== ''
    ? { session: available({ sessionId: context.sessionId }, 'native') }
    : {}),
  workspace: available({ root: process.cwd() }, 'derived'),
});

/**
 * Progress forwarding for one request: the client's own `progressToken` is
 * what turns render progress into `notifications/progress`, so a request that
 * did not ask for progress gets none.
 */
const projectorOptions = (context: GeneratedRouteRequestContext): {
  readonly progressToken?: McpProgressToken;
  readonly sendProgress?: (params: McpProgressNotificationParams) => Promise<void>;
  readonly signal: AbortSignal;
} => {
  const progressToken = context.mcpReq._meta?.progressToken;
  const notify = context.mcpReq.notify;
  return {
    signal: context.mcpReq.signal,
    ...(progressToken === undefined || notify === undefined
      ? {}
      : {
        progressToken,
        sendProgress: async (params: McpProgressNotificationParams) =>
          notify({ method: 'notifications/progress', params }),
      }),
  };
};

/**
 * Renders one route inside a request scope, projects its render-event stream
 * into an MCP result, and validates the document value against the route's
 * own `resultSchema` — exactly what the generated server does per request.
 * The host scope establishes the full transport-observed identity and the
 * warm host's `agent()` probe forwards it into the Flight worker.
 */
export const renderGeneratedRoute = async (
  dispatcher: AgentRenderDispatcher,
  artifactEpoch: string,
  route: GeneratedRouteRecord,
  input: unknown,
  context: GeneratedRouteRequestContext,
  identity?: { readonly clientName?: string },
): Promise<RenderedGeneratedRoute> => runAgentRequest({
  ...requestIdentity(context, identity?.clientName),
  invocation: { artifactEpoch, kind: 'tool', operationId: route.id, surface: route.name },
  signal: context.mcpReq.signal,
}, async () => {
  // State and notice admission live only in the render scope. This host scope
  // establishes identity and forwards it so one invocation is admitted once.
  const projected = await projectMcpRenderStream(dispatcher.stream({
    artifactEpoch,
    invocation: { kind: 'tool', props: { input: input as never, operationId: route.id } },
    signal: context.mcpReq.signal,
  }), projectorOptions(context));
  return {
    document: projected.document,
    result: route.module.resultSchema.parse(projected.document.value),
    toolResult: projected.result,
  };
});

const selectedConfig = (
  config: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> => Object.fromEntries(
  keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]),
);

/** The JSON Schema draft the MCP SDK targets when it advertises a Standard Schema. */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

interface StandardJsonSchemaSource {
  readonly '~standard'?: {
    readonly jsonSchema?: {
      readonly output?: (options: { readonly target: string }) => unknown;
    };
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A typeless JSON Schema root is object-shaped when it carries object keywords
 * or every member of its `oneOf`/`anyOf`/`allOf` composition is — the same
 * judgment the MCP SDK applies before stamping `type: "object"`.
 */
const objectRootedJsonSchema = (schema: unknown): boolean => {
  if (!isRecord(schema)) return false;
  if (schema['type'] !== undefined) return schema['type'] === 'object';
  if (['properties', 'patternProperties', 'additionalProperties', 'required'].some((key) => key in schema)) return true;
  return ['oneOf', 'anyOf', 'allOf'].some((key) => {
    const members = schema[key];
    return Array.isArray(members) && members.length > 0 && members.every(objectRootedJsonSchema);
  });
};

/**
 * Advertises a tool `outputSchema` only when the route's `resultSchema`
 * describes an object: the MCP specification requires every result of a tool
 * that declares `outputSchema` to carry `structuredContent`, and the
 * projection emits `structuredContent` only for object-valued documents. A
 * text-only route (`z.undefined()`, `z.string()`, an array schema) therefore
 * advertises none, while an object schema keeps the SDK's fail-closed output
 * validation. A schema that cannot describe itself as JSON Schema is handed
 * to the SDK unchanged so its own conversion decides.
 */
export const advertisedOutputSchema = (schema: unknown): unknown => {
  const toJsonSchema = (schema as StandardJsonSchemaSource | null | undefined)?.['~standard']?.jsonSchema?.output;
  if (typeof toJsonSchema !== 'function') return schema;
  let jsonSchema: unknown;
  try {
    jsonSchema = toJsonSchema({ target: JSON_SCHEMA_TARGET });
  } catch {
    return undefined;
  }
  return objectRootedJsonSchema(jsonSchema) ? schema : undefined;
};

/** Registers the compiled MCP routes on a server, keyed by route kind. */
export const registerGeneratedRoutes = (
  server: McpServer,
  routes: Readonly<Record<string, GeneratedRouteRecord>>,
  dispatcher: AgentRenderDispatcher,
  artifactEpoch: string,
): void => {
  for (const route of Object.values(routes)) {
    switch (route.kind) {
      case 'tool': {
        const outputSchema = advertisedOutputSchema(route.module.resultSchema);
        server.registerTool(route.name, {
          ...selectedConfig(route.config, ['_meta', 'annotations', 'description', 'icons', 'title']),
          inputSchema: route.module.inputSchema,
          ...(outputSchema === undefined ? {} : { outputSchema }),
        } as never, (async (input: unknown, context: GeneratedRouteRequestContext) => {
          const clientName = server.server.getClientVersion()?.name;
          const rendered = await renderGeneratedRoute(
            dispatcher,
            artifactEpoch,
            route,
            input,
            context,
            { clientName },
          );
          return attachMcpStructuredContent(rendered.toolResult, rendered.result);
        }) as never);
        break;
      }
      case 'resource': {
        const uri = route.config['uri'];
        if (typeof uri !== 'string' || uri.trim() === '') {
          throw new Error(`Generated resource route ${JSON.stringify(route.id)} requires a non-empty static config.uri.`);
        }
        server.registerResource(
          route.name,
          uri,
          selectedConfig(route.config, ['_meta', 'description', 'icons', 'mimeType', 'title']) as never,
          (async (resourceUri: URL, context: GeneratedRouteRequestContext) => {
            const clientName = server.server.getClientVersion()?.name;
            return (await renderGeneratedRoute(
              dispatcher,
              artifactEpoch,
              route,
              { uri: resourceUri.href },
              context,
              { clientName },
            )).result;
          }) as never,
        );
        break;
      }
      case 'prompt':
        server.registerPrompt(route.name, {
          ...selectedConfig(route.config, ['_meta', 'description', 'icons', 'title']),
          argsSchema: route.module.inputSchema,
        } as never, (async (input: unknown, context: GeneratedRouteRequestContext) => {
          const clientName = server.server.getClientVersion()?.name;
          return (await renderGeneratedRoute(
            dispatcher,
            artifactEpoch,
            route,
            input,
            context,
            { clientName },
          )).result;
        }) as never);
        break;
      default: {
        const unreachable: never = route.kind;
        throw new TypeError(`Unsupported generated MCP route kind ${String(unreachable)}.`);
      }
    }
  }
};

/** Registers compiled MCP App surfaces as inline HTML resources. */
export const registerGeneratedMcpApps = (
  server: McpServer,
  apps: readonly GeneratedMcpAppRecord[],
): void => {
  for (const app of apps) {
    server.registerResource(
      app.name,
      app.resourceUri,
      { ...(app._meta === undefined ? {} : { _meta: app._meta }), mimeType: app.mimeType } as never,
      (async (uri: URL) => ({
        contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],
      })) as never,
    );
  }
};

interface FlightWorkerMessage {
  readonly bytes?: Uint8Array;
  readonly code?: string;
  readonly id: number;
  readonly message?: string;
  readonly receivedEpoch?: string;
  readonly type: string;
  readonly update?: never;
}

/**
 * The long-lived react-server worker one generated MCP process renders
 * through. The worker exists only to satisfy React's `react-server`
 * condition; it is reused for every request until the server closes, and the
 * warm host is what turns a dead worker or a stale artifact epoch into a
 * typed `AgentRuntimeError` instead of a hung request.
 */
export const createFlightWorkerHost = (
  workerUrl: URL,
  artifactEpoch: string,
): WarmFlightHost => {
  interface PendingRender {
    readonly abort: () => void;
    readonly progress?: AgentProgressReporter;
    readonly reject: (error: Error) => void;
    readonly resolve: (stream: ReadableStream<Uint8Array>) => void;
    readonly signal: AbortSignal;
  }
  // Generated route modules may write to stdout; stdout is the stdio
  // transport's protocol channel, so the worker's own output is rerouted.
  const worker = new Worker(workerUrl, { stderr: true, stdout: true });
  worker.stdout.on('data', (chunk: unknown) => process.stderr.write(chunk as Uint8Array));
  worker.stderr.on('data', (chunk: unknown) => process.stderr.write(chunk as Uint8Array));
  const pending = new Map<number, PendingRender>();
  let sequence = 0;
  let exited = false;
  const failPending = (error: Error): void => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const workerError = (message: FlightWorkerMessage): Error => {
    switch (message.code) {
      case 'artifact-epoch-mismatch':
        return new AgentRuntimeError('artifact-epoch-mismatch', message.message ?? 'Artifact epoch mismatch', {
          expectedEpoch: artifactEpoch,
          ...(message.receivedEpoch === undefined ? {} : { receivedEpoch: message.receivedEpoch }),
        });
      case 'runtime-unavailable':
      case 'runtime-restarted':
        return new AgentRuntimeError(message.code, message.message ?? 'The MCP render runtime is unavailable');
      default:
        return new Error(message.message);
    }
  };
  worker.on('error', (error: Error) => {
    exited = true;
    failPending(error);
  });
  worker.on('exit', (code: number) => {
    exited = true;
    warmHost.markUnavailable(code === 0 ? 'runtime-unavailable' : 'runtime-restarted');
    failPending(new AgentRuntimeError(
      code === 0 ? 'runtime-unavailable' : 'runtime-restarted',
      code === 0
        ? 'The MCP render runtime is unavailable'
        : `The MCP render runtime restarted; worker exited with code ${String(code)}.`,
    ));
  });
  worker.on('message', (message: FlightWorkerMessage) => {
    const request = pending.get(message.id);
    if (request === undefined) return;
    if (message.type === 'progress') {
      void request.progress?.report(message.update as never);
      return;
    }
    pending.delete(message.id);
    request.signal.removeEventListener('abort', request.abort);
    if (message.type === 'error') {
      request.reject(workerError(message));
      return;
    }
    request.resolve(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(message.bytes!);
        controller.close();
      },
    }));
  });
  const warmHost = createWarmFlightHost({
    artifactEpoch,
    close: async (): Promise<void> => {
      await worker.terminate();
    },
    host: {
      execute: async ({
        artifactEpoch: requestEpoch,
        invocation,
        progress,
        signal,
      }: AgentRenderDispatch): Promise<ReadableStream<Uint8Array>> => {
        if (exited) {
          throw new AgentRuntimeError('runtime-unavailable', 'The MCP render runtime is unavailable');
        }
        const context = await agent();
        const id = ++sequence;
        return new Promise<ReadableStream<Uint8Array>>((resolve, reject) => {
          const abort = (): void => {
            worker.postMessage({ id, type: 'cancel' });
            pending.delete(id);
            reject(new DOMException('Agent render was aborted', 'AbortError'));
          };
          pending.set(id, { abort, ...(progress === undefined ? {} : { progress }), reject, resolve, signal });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) {
            abort();
            return;
          }
          worker.postMessage({
            actor: context.actor,
            artifactEpoch: requestEpoch ?? artifactEpoch,
            host: context.host,
            id,
            invocation,
            requestInvocation: context.invocation,
            session: context.session,
            type: 'render',
            workspace: context.workspace,
          });
        });
      },
    },
  });
  return warmHost;
};

/** The render host a generated server closes over, plus its teardown. */
export type GeneratedRouteExecutionHost = WarmFlightHost;

/**
 * The shared event runtime an artifact's event routes are served through
 * (#97/#180), injected rather than imported: the generated entry reaches the
 * IPC and projection modules through bundler aliases that only exist inside a
 * built artifact, while this module is also imported directly by the test
 * harness. An artifact with no event routes passes nothing.
 */
export interface GeneratedEventRuntimeBinding {
  readonly allowedTargets: readonly string[];
  readonly artifactEpoch: string;
  readonly createCanonicalEventProps: typeof createCanonicalEventProps;
  readonly createEventRuntimeServer: typeof createEventRuntimeServer;
  /** Identifies this artifact's socket, so two installs never share a runtime. */
  readonly endpointId: string;
  readonly projectEventDocument: typeof projectEventDocument;
  readonly target: string;
}

export interface CreateGeneratedRouteMcpServerOptions {
  readonly apps?: readonly GeneratedMcpAppRecord[];
  /** Identity every request carries, so a stale worker fails loudly. */
  readonly artifactEpoch: string;
  readonly events?: GeneratedEventRuntimeBinding;
  /** Renders one invocation to Flight bytes. Closed when the server closes. */
  readonly host: GeneratedRouteExecutionHost;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly routes: Readonly<Record<string, GeneratedRouteRecord>>;
}

const nativeString = (
  native: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => (typeof native[key] === 'string' ? native[key] : undefined);

/**
 * The IPC request carries the event name as a plain string, so it is narrowed
 * here rather than asserted: an envelope naming an event this contract does
 * not define is a transport failure, not a route render.
 */
const canonicalEvent = (event: string): CanonicalAgentEvent => {
  const canonical = canonicalAgentEvents.find((candidate) => candidate === event);
  if (canonical === undefined) {
    throw new TypeError(`Event runtime received the unknown canonical event ${JSON.stringify(event)}.`);
  }
  return canonical;
};

/**
 * The shared event runtime for one artifact: native envelopes arrive over the
 * IPC socket, render through the same dispatcher every route uses, and project
 * back into the host's own hook response shape.
 */
const startEventRuntime = async (
  events: GeneratedEventRuntimeBinding,
  dispatcher: AgentRenderDispatcher,
  host: WarmFlightHost,
): Promise<{ readonly close: () => Promise<void> }> => {
  const startedAt = new Date().toISOString();
  return events.createEventRuntimeServer({
    artifactEpoch: events.artifactEpoch,
    endpointId: events.endpointId,
    handle: async (request, signal) => {
    const event = canonicalEvent(request.event);
    const target = events.allowedTargets.find((candidate) => candidate === request.target);
    if (target === undefined) {
      throw new TypeError(
        `Event runtime target ${JSON.stringify(request.target)} is not allowed by this artifact (${events.allowedTargets.map((candidate) => JSON.stringify(candidate)).join(', ')}).`,
      );
    }
    const nativeEvent = nativeString(request.native, 'hook_event_name') ?? event;
    const props = events.createCanonicalEventProps(
      event,
      request.native,
      target,
      nativeEvent,
      request.hostContractRevision,
      signal,
    );
    const sessionId = nativeString(request.native, 'session_id')
      ?? nativeString(request.native, 'conversation_id');
    const workspaceRoots = request.native['workspace_roots'];
    const workspaceRoot = nativeString(request.native, 'cwd')
      ?? (Array.isArray(workspaceRoots) && typeof workspaceRoots[0] === 'string'
        ? workspaceRoots[0]
        : undefined);
    return runAgentRequest({
      host: available({ name: target }, 'native'),
      invocation: {
        artifactEpoch: events.artifactEpoch,
        hostContractRevision: request.hostContractRevision,
        kind: 'event',
        operationId: `event:${event}`,
        surface: event,
      },
      ...(sessionId === undefined ? {} : { session: available({ sessionId }, 'native') }),
      signal,
      ...(workspaceRoot === undefined ? {} : { workspace: available({ root: workspaceRoot }, 'native') }),
    }, async () => events.projectEventDocument(
      // The host scope remains ledger-free: the Flight worker owns the one
      // notice admission where route components read the request handle.
      await dispatcher.dispatch({
        invocation: {
          kind: 'event',
          // The event payload crosses the render boundary as data; the route
          // props type is what gives it shape on the other side.
          props: { event, payload: { canonical: props.canonical, native: props.native } as never },
        },
        signal,
      }),
      event,
      target,
      nativeEvent,
      props.native,
    ));
    },
    status: () => ({
      artifactEpoch: host.identity.artifactEpoch,
      availability: host.availability(),
      instanceId: host.identity.instanceId,
      pid: process.pid,
      startedAt,
    }),
  });
};

/**
 * Builds the MCP server a generated artifact serves: the dispatcher over the
 * supplied warm render host, every compiled route registered by kind, the
 * compiled MCP Apps as inline resources, and — when the artifact has event
 * routes — the shared event runtime over that same dispatcher. Closing the
 * server closes both.
 */
export const createGeneratedRouteMcpServer = async (
  options: CreateGeneratedRouteMcpServerOptions,
): Promise<McpServer> => {
  const server = new McpServer(options.plugin);
  const dispatcher = createAgentRenderDispatcher(options.host);
  const events = options.events === undefined
    ? undefined
    : await startEventRuntime(options.events, dispatcher, options.host);
  registerGeneratedRoutes(server, options.routes, dispatcher, options.artifactEpoch);
  registerGeneratedMcpApps(server, options.apps ?? []);
  const close = server.close.bind(server);
  server.close = async (): Promise<void> => {
    await events?.close();
    await options.host.close();
    await close();
  };
  return server;
};
