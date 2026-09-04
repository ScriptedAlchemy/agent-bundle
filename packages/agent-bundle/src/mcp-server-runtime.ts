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

import { McpServer, ProtocolError, ProtocolErrorCode, isJSONRPCRequest, type Transport } from '@modelcontextprotocol/server';
import {
  AgentRuntimeError,
  agent,
  attachMcpStructuredContent,
  available,
  createAgentRenderDispatcher,
  createWarmFlightHost,
  lineageHostFromClient,
  projectMcpRenderStream,
  runAgentRequest,
  unavailable,
} from '@agent-bundle/runtime';
import type { createEventRuntimeServer } from './events/ipc.ts';
import type { createCanonicalEventProps, projectEventDocument } from './events/project.ts';
import { canonicalAgentEvents, type CanonicalAgentEvent } from './routes/public.ts';
import type {
  AgentActorIdentity,
  AgentDocument,
  AgentHostIdentity,
  AgentLineage,
  AgentProgressReporter,
  AgentRenderDispatch,
  AgentRenderDispatcher,
  AgentSessionIdentity,
  AgentWorkspaceIdentity,
  LineageHost,
  McpProgressNotificationParams,
  McpProgressToken,
  Observed,
  WarmFlightHost,
} from '@agent-bundle/runtime';
import type { AgentNoticeInboxSignaller, AgentNoticeInboxSignalOutcome } from '@agent-bundle/runtime/notices';
import type { AgentLineageRegistry } from '@agent-bundle/runtime/lineage';

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
    /** Request `_meta`: the progress token plus host-specific correlation keys (`claudecode/toolUseId`, `x-codex-turn-metadata`). */
    readonly _meta?: { readonly progressToken?: McpProgressToken } & Readonly<Record<string, unknown>>;
    /** The JSON-RPC request id, the key the raw `tools/call` arguments were captured under. */
    readonly id?: number | string;
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
  readonly lineage: Observed<AgentLineage>;
  readonly session?: Observed<AgentSessionIdentity>;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
}

/** A captured `tools/call` `params.arguments` value; `value` is `undefined` when the call carried none. */
export interface RawToolArguments {
  readonly value: unknown;
}

/** Raw `tools/call` arguments by request, consumed once by the tool callback that serves the request. */
export interface RawToolArgumentsCapture {
  take(requestId: number | string | undefined): RawToolArguments | undefined;
}

const requestKey = (requestId: number | string): string => `${typeof requestId}:${String(requestId)}`;
/** Calls that never reach a registered tool (unknown tool, rejected params) are forgotten past this many. */
const RAW_ARGUMENTS_RETENTION = 1024;

/**
 * Captures every `tools/call`'s arguments off the wire, before the SDK parses
 * them against the route's input schema. Lineage correlates a Cursor call with
 * its pre-tool hook by those raw arguments (the hook's `tool_input`); schema
 * defaults would make two different calls look alike, so the parsed input is
 * never what is compared. The capture wraps the transport's `onmessage` the
 * moment the server connects and keeps one entry per request id until the
 * tool callback takes it.
 */
const captureRawToolArguments = (server: McpServer): RawToolArgumentsCapture => {
  const captured = new Map<string, RawToolArguments>();
  const connect = server.connect.bind(server);
  server.connect = async (transport: Transport): Promise<void> => {
    await connect(transport);
    const inner = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && message.method === 'tools/call') {
        const params = message.params;
        const value = params !== undefined && typeof params === 'object' && params !== null && !Array.isArray(params)
          ? (params as { readonly arguments?: unknown }).arguments
          : undefined;
        captured.set(requestKey(message.id), Object.freeze({ value }));
        if (captured.size > RAW_ARGUMENTS_RETENTION) captured.delete(captured.keys().next().value!);
      }
      inner?.(message, extra);
    };
  };
  return Object.freeze({
    take(requestId: number | string | undefined): RawToolArguments | undefined {
      if (requestId === undefined) return undefined;
      const key = requestKey(requestId);
      const raw = captured.get(key);
      captured.delete(key);
      return raw;
    },
  });
};

/**
 * Lineage for one MCP tool call: Codex names it in `_meta`, Claude names the
 * pre-tool hook's `tool_use_id` in `_meta`, Cursor names nothing — so the
 * registry falls back to the open `MCP:<tool>` pre-tool hook, told apart from
 * a concurrent call in another conversation by the raw arguments the hook
 * recorded. A call whose raw arguments were not captured (a transport the
 * server did not connect itself) is correlated by tool name alone, never by
 * its schema-parsed input. Without a registry (a project with no event
 * routes, or the in-memory proof level) the axis is honestly absent.
 */
const toolCallLineage = async (
  registry: AgentLineageRegistry | undefined,
  context: GeneratedRouteRequestContext,
  toolName: string,
  rawArguments: RawToolArguments | undefined,
  clientName: string | undefined,
  fallbackHost: LineageHost | undefined,
): Promise<Observed<AgentLineage>> => {
  if (registry === undefined) return unavailable<AgentLineage>('not-provided');
  return registry.resolveToolCall({
    ...(rawArguments === undefined ? {} : { arguments: rawArguments.value }),
    host: lineageHostFromClient(clientName) ?? fallbackHost,
    meta: context.mcpReq._meta,
    toolName,
  });
};

/** Identity the server derives from the transport's own request context. */
const requestIdentity = (
  context: GeneratedRouteRequestContext,
  clientName: string | undefined,
  lineage: Observed<AgentLineage>,
): GeneratedRouteIdentity => ({
  lineage,
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
  identity?: { readonly clientName?: string; readonly lineage?: Observed<AgentLineage> },
): Promise<RenderedGeneratedRoute> => runAgentRequest({
  ...requestIdentity(context, identity?.clientName, identity?.lineage ?? unavailable<AgentLineage>('not-provided')),
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

/**
 * Runs after every render the server completes, successful or not: a route
 * that published a notice and then failed still advanced the ledger. The hook
 * never throws into the request path and resolves as soon as the follow-up
 * work is scheduled, never waiting on another connection's wire.
 */
export type GeneratedRenderSettled = () => Promise<void>;

const settled = async <T>(operation: () => Promise<T>, afterRender: GeneratedRenderSettled | undefined): Promise<T> => {
  try {
    return await operation();
  } finally {
    await afterRender?.();
  }
};

export interface RegisterGeneratedRoutesOptions {
  /** Runs after every render the server completes (notice delivery follow-up). */
  readonly afterRender?: GeneratedRenderSettled;
  /** The warm runtime's lineage registry; tool calls resolve their conversation through it. */
  readonly lineage?: AgentLineageRegistry;
  /** The artifact's host, used when the negotiated client name maps to none. */
  readonly lineageHost?: LineageHost;
  /** Raw `tools/call` arguments captured off the wire, for lineage correlation. */
  readonly rawArguments?: RawToolArgumentsCapture;
}

/** Registers the compiled MCP routes on a server, keyed by route kind. */
export const registerGeneratedRoutes = (
  server: McpServer,
  routes: Readonly<Record<string, GeneratedRouteRecord>>,
  dispatcher: AgentRenderDispatcher,
  artifactEpoch: string,
  options: RegisterGeneratedRoutesOptions = {},
): void => {
  for (const route of Object.values(routes)) {
    switch (route.kind) {
      case 'tool': {
        const outputSchema = advertisedOutputSchema(route.module.resultSchema);
        server.registerTool(route.name, {
          ...selectedConfig(route.config, ['_meta', 'annotations', 'description', 'icons', 'title']),
          inputSchema: route.module.inputSchema,
          ...(outputSchema === undefined ? {} : { outputSchema }),
        } as never, (async (input: unknown, context: GeneratedRouteRequestContext) => settled(async () => {
          const clientName = server.server.getClientVersion()?.name;
          const rawArguments = options.rawArguments?.take(context.mcpReq.id);
          const rendered = await renderGeneratedRoute(
            dispatcher,
            artifactEpoch,
            route,
            input,
            context,
            { clientName, lineage: await toolCallLineage(options.lineage, context, route.name, rawArguments, clientName, options.lineageHost) },
          );
          return attachMcpStructuredContent(rendered.toolResult, rendered.result);
        }, options.afterRender)) as never);
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
          (async (resourceUri: URL, context: GeneratedRouteRequestContext) => settled(async () => {
            const clientName = server.server.getClientVersion()?.name;
            return (await renderGeneratedRoute(
              dispatcher,
              artifactEpoch,
              route,
              { uri: resourceUri.href },
              context,
              { clientName },
            )).result;
          }, options.afterRender)) as never,
        );
        break;
      }
      case 'prompt':
        server.registerPrompt(route.name, {
          ...selectedConfig(route.config, ['_meta', 'description', 'icons', 'title']),
          argsSchema: route.module.inputSchema,
        } as never, (async (input: unknown, context: GeneratedRouteRequestContext) => settled(async () => {
          const clientName = server.server.getClientVersion()?.name;
          return (await renderGeneratedRoute(
            dispatcher,
            artifactEpoch,
            route,
            input,
            context,
            { clientName },
          )).result;
        }, options.afterRender)) as never);
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
            lineage: context.lineage,
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

/**
 * The `mcp-resource-updated` delivery route for the notice inbox (#99 stage
 * 4): the server process's own handle on the durable notice store its Flight
 * worker mounts, wrapped by the runtime's inbox signaller. Present only when
 * the artifact's state is workspace-durable — that is the only lifetime two
 * processes can share — so `resources.subscribe` is advertised exactly when a
 * subscription can be honoured. Closed when the server closes.
 */
export type GeneratedNoticeDeliveryBinding = AgentNoticeInboxSignaller;

export interface CreateGeneratedRouteMcpServerOptions {
  readonly apps?: readonly GeneratedMcpAppRecord[];
  /** Identity every request carries, so a stale worker fails loudly. */
  readonly artifactEpoch: string;
  /** Releases the lineage registry's durable store when the server closes. */
  readonly disposeLineage?: () => Promise<void>;
  readonly events?: GeneratedEventRuntimeBinding;
  /** Renders one invocation to Flight bytes. Closed when the server closes. */
  readonly host: GeneratedRouteExecutionHost;
  /**
   * The runtime-held conversation registry (#host-lineage): subagent
   * start/stop and pre-tool events feed it, and every event route and tool
   * call reads `request.lineage` from it. Absent registries leave the axis
   * `unavailable('not-provided')`.
   */
  readonly lineage?: AgentLineageRegistry;
  readonly notices?: GeneratedNoticeDeliveryBinding;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly routes: Readonly<Record<string, GeneratedRouteRecord>>;
}

interface ResourceSubscriptionRequest {
  readonly params: { readonly uri: string };
}

const noticeDiagnostic = (line: string): void => {
  process.stderr.write(`[agent-bundle] notice inbox ${line}\n`);
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Installs `resources/subscribe` / `resources/unsubscribe` for the notice
 * inbox URI and returns the post-render observation that emits
 * `notifications/resources/updated` to the subscribed connection. Only the
 * inbox is subscribable: every other generated resource is static per
 * request, so accepting a subscription for it would be a promise the server
 * never keeps. Subscribing fails closed when the durable store is unreadable.
 */
const installNoticeInboxSubscriptions = (
  server: McpServer,
  notices: GeneratedNoticeDeliveryBinding,
): GeneratedRenderSettled => {
  const protocol = server.server;
  protocol.assertCanSetRequestHandler('resources/subscribe');
  protocol.assertCanSetRequestHandler('resources/unsubscribe');
  protocol.registerCapabilities({ resources: { subscribe: true } });
  const assertInboxUri = (uri: unknown): void => {
    if (uri === notices.inboxUri) return;
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Resource ${String(uri)} does not support subscriptions; only ${notices.inboxUri} emits notifications/resources/updated.`,
      { uri },
    );
  };
  protocol.setRequestHandler('resources/subscribe', (async (
    request: ResourceSubscriptionRequest,
    context: GeneratedRouteRequestContext,
  ) => {
    assertInboxUri(request.params.uri);
    // Subscriptions are not tool calls: no pre-tool hook precedes them, so
    // there is no correlation window to resolve lineage through.
    const identity = requestIdentity(context, protocol.getClientVersion()?.name, unavailable<AgentLineage>('not-provided'));
    try {
      await notices.subscribe({
        actor: identity.actor ?? unavailable(),
        host: identity.host ?? unavailable(),
        session: identity.session ?? unavailable(),
        workspace: identity.workspace,
      });
    } catch (error) {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Notice inbox subscriptions are unavailable: ${describeError(error)}`,
      );
    }
    return {};
  }) as never);
  protocol.setRequestHandler('resources/unsubscribe', (async (request: ResourceSubscriptionRequest) => {
    assertInboxUri(request.params.uri);
    // Acknowledged only once in-flight observations have settled, so the
    // client never receives a signal after its unsubscribe succeeded.
    await notices.unsubscribe();
    return {};
  }) as never);
  const send = async (): Promise<void> => {
    await protocol.sendResourceUpdated({ uri: notices.inboxUri });
  };
  const report = (outcome: AgentNoticeInboxSignalOutcome): void => {
    switch (outcome.kind) {
      case 'idle':
      case 'signalled':
        return;
      case 'failed':
        noticeDiagnostic(`resources/updated ${outcome.stage} failed: ${describeError(outcome.error)}`);
        return;
      default: {
        const unreachable: never = outcome;
        throw new TypeError(`Unhandled notice inbox signal outcome ${String(unreachable)}.`);
      }
    }
  };
  // Detached from the render that triggered it. The signaller serializes its
  // observations and never rejects, and a notification write to a slow or
  // wedged connection — renewed for as long as it takes — must not hold the
  // completed render's response, or unrelated event handling, hostage.
  // Observations coalesce: one is in flight and at most one more is owed,
  // because an observation reads the whole ledger, so every render completing
  // behind a pending write is covered by the single follow-up and a client
  // that stops reading cannot grow a queue of closures per render.
  let observing: Promise<void> | undefined;
  let owed = false;
  const observe = (): void => {
    observing = notices.observe(send).then(report, (error: unknown) => {
      noticeDiagnostic(`resources/updated observation failed: ${describeError(error)}`);
    }).then(() => {
      observing = undefined;
      if (!owed) return;
      owed = false;
      observe();
    });
  };
  return (): Promise<void> => {
    if (observing === undefined) observe();
    else owed = true;
    return Promise.resolve();
  };
};

const lineageHostFor = (target: string): LineageHost | undefined =>
  target === 'claude' || target === 'codex' || target === 'cursor' ? target : undefined;

/**
 * Lineage for one hook event. Cloud Cursor agents run no user hooks at all, so
 * a `sessionEnd`-less cloud payload can never feed the registry; the portable
 * target has no subagent events by contract.
 */
const eventLineage = async (
  registry: AgentLineageRegistry | undefined,
  target: string,
  event: CanonicalAgentEvent,
  native: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
  observedAt: string,
): Promise<Observed<AgentLineage>> => {
  const host = lineageHostFor(target);
  if (host === undefined) return unavailable<AgentLineage>('no-subagent-events');
  if (host === 'cursor' && native['is_background_agent'] === true) {
    return unavailable<AgentLineage>('cloud-agent-no-user-hooks');
  }
  if (registry === undefined) return unavailable<AgentLineage>('not-provided');
  return registry.observe({ event, host, idempotencyKey, native, observedAt });
};

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
  afterRender: GeneratedRenderSettled | undefined,
  registry: AgentLineageRegistry | undefined,
): Promise<{ readonly close: () => Promise<void> }> => {
  const startedAt = new Date().toISOString();
  return events.createEventRuntimeServer({
    artifactEpoch: events.artifactEpoch,
    endpointId: events.endpointId,
    handle: async (request, signal) => settled(async () => {
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
    // The registry sees the event before the route renders, so the route
    // observes its own subagent start/stop already applied.
    const lineage = await eventLineage(
      registry,
      target,
      event,
      request.native,
      props.canonical.idempotencyKey,
      props.canonical.observedAt,
    );
    return runAgentRequest({
      host: available({ name: target }, 'native'),
      invocation: {
        artifactEpoch: events.artifactEpoch,
        hostContractRevision: request.hostContractRevision,
        kind: 'event',
        operationId: `event:${event}`,
        surface: event,
      },
      lineage,
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
    }, afterRender),
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
  // The subscribe bit registers before any transport connects; the SDK merges
  // its own resources.listChanged into the same capability object when the
  // inbox resource route registers below.
  const afterRender = options.notices === undefined
    ? undefined
    : installNoticeInboxSubscriptions(server, options.notices);
  const events = options.events === undefined
    ? undefined
    : await startEventRuntime(options.events, dispatcher, options.host, afterRender, options.lineage);
  registerGeneratedRoutes(server, options.routes, dispatcher, options.artifactEpoch, {
    ...(afterRender === undefined ? {} : { afterRender }),
    ...(options.lineage === undefined ? {} : { lineage: options.lineage, rawArguments: captureRawToolArguments(server) }),
    ...(options.events === undefined || lineageHostFor(options.events.target) === undefined
      ? {}
      : { lineageHost: lineageHostFor(options.events.target) }),
  });
  registerGeneratedMcpApps(server, options.apps ?? []);
  const close = server.close.bind(server);
  server.close = async (): Promise<void> => {
    // The signaller drains any receipt still owed for a send that reached the
    // wire, so it must close while the ledger it commits to is still open:
    // the host owns (or shares) that store and closes after it. Its close
    // abandons a notification write still pending rather than waiting on the
    // client's wire, so a subscriber that stopped reading cannot wedge this
    // teardown. Whatever fails on the way, the protocol and its transport are
    // always closed; the teardown error surfaces once they are. The lineage
    // journal closes after the host, once no render can observe into it.
    try {
      try {
        await events?.close();
      } finally {
        try {
          await options.notices?.close();
        } finally {
          try {
            await options.host.close();
          } finally {
            await options.disposeLineage?.();
          }
        }
      }
    } finally {
      await close();
    }
  };
  return server;
};
