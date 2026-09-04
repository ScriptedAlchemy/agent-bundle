import { Client, type Resource, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Context, Effect, Layer, type Scope } from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Stream } from 'node:stream';

import type { TargetRegistry } from '../adapters/registry.ts';
import { isRecord } from '../core/strict-json.ts';
import type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';
import {
  McpAppBindingService,
  selectMcpAppResourceUri,
  type McpAppBridgeResource,
  type McpAppBridgeSession,
  type McpAppBridgeTool,
  type McpAppJsonValue,
  type McpAppSessionAuthority,
  type McpAppSessionLease,
  type McpAppToolDefinition,
} from '../dev/mcp-apps/mcp-app-binding-service.ts';
import { MCP_APP_MIME_TYPE } from '../dev/mcp-apps/mcp-app-bridge.ts';
import type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
import {
  mcpAppPreviewHost,
  mcpAppPreviewHostInfo,
  openInBrowser,
  type OpenBrowser,
} from '../dev/mcp-apps/mcp-app-preview-host.ts';
import { McpAppPreviewService } from '../dev/mcp-apps/mcp-app-preview-service.ts';
import { McpAppRoutes } from '../dev/mcp-apps/mcp-app-routes.ts';
import { createMcpAppSandboxProxy, type McpAppSandboxProxy } from '../dev/mcp-apps/mcp-app-sandbox.ts';
import {
  canonicalMcpAppJson,
  canonicalMcpAppResource,
  canonicalMcpAppTool,
  mcpAppClientCapabilities,
} from '../dev/mcp-session/mcp-session-apps.ts';
import { diagnostic, isRequestDiagnostic, requestError, responseDiagnostic, singleHeader } from '../dev/http.ts';
import { makeScopedEffectRuntime } from '../effect/boundary.ts';
import { liftPromise, liftTry } from '../effect/lift.ts';
import { resolveMcpLaunchEnvironment, type McpLaunchEnvironmentOptions, type ResolvedMcpStdioLaunch } from '../services/mcp-run.ts';
import { renderServeAppPage, SERVE_APP_TOKEN_HEADER } from './serve-app-page.ts';

/**
 * `agent-bundle serve-app`: one built MCP App, served standalone in a browser
 * over a bound session to the plugin's own packed MCP server.
 *
 * This is the Workbench's MCP App preview stack without the Workbench:
 * the same `McpAppBindingService` → `McpAppPreviewService` → `McpAppRoutes`
 * chain hosts the App over `/api/mcp/...`, the same loopback sandbox proxy
 * (`createMcpAppSandboxProxy`) isolates the App document on its own origin,
 * and the same `McpAppBridge` enforces the MCP Apps protocol, consent, and
 * resource policy. Only two things are specific to this module: the session
 * authority is one stdio connection to the packed server (launched exactly
 * as `mcp run` launches it), and the host document is a small page whose
 * inline relay mirrors the Workbench's `McpAppFrameRelay` over those routes.
 *
 * Every resource is `acquireRelease`d into one Effect scope owned by a
 * `makeScopedEffectRuntime`; `close()` finalizes that scope once, newest
 * resource first: routes, preview bindings, sandbox proxy, HTTP server, MCP
 * session.
 */

export type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';

export interface ServeMcpAppOptions extends Omit<McpLaunchEnvironmentOptions, 'artifact' | 'registry' | 'server'> {
  /** The MCP App to serve: `<server>/<app>`, or a full `ui://` resource URI. */
  readonly app: string;
  /**
   * A built artifact root, or an Effect that acquires one into the served
   * App's scope (a throwaway build removed on `close()`).
   */
  readonly artifact: string | Effect.Effect<string, unknown, Scope.Scope>;
  /**
   * Consent capabilities approved on the operator's behalf as the App
   * requests them; everything else waits for a decision in the host page,
   * exactly as in the Workbench.
   */
  readonly autoApprove?: readonly McpAppConsentCapability[];
  /** Arguments for the opening tool call; defaults to `{}`. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Open the default browser on the served URL once the host is listening. */
  readonly open?: boolean;
  /** Injectable only to keep browser launching deterministic in tests. */
  readonly openBrowser?: OpenBrowser;
  /** Loopback TCP port for the host document; `0` (default) picks an ephemeral one. */
  readonly port?: number;
  /** The simulated MCP Apps host profile; defaults to `portable`. */
  readonly profile?: McpAppProfileId;
  readonly registry?: TargetRegistry;
  /** Per-request timeout for the bound session, in milliseconds. */
  readonly timeoutMs?: number;
  /**
   * The tool whose result the App opens with. Defaults to the only tool that
   * declares the App's `_meta.ui.resourceUri`; required when several do.
   */
  readonly tool?: string;
}

export interface ServedMcpApp {
  /** The App's canonical `ui://` resource URI. */
  readonly resourceUri: string;
  /** Loopback origin of the sandbox proxy the App document runs on. */
  readonly sandboxOrigin: string;
  /** The generated MCP server the App is bound to. */
  readonly server: string;
  /** The tool whose call opened the App. */
  readonly tool: string;
  /** The host document URL. */
  readonly url: string;
  /** Settles once the bound MCP server connection has ended, whether by `close()` or on its own. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const defaultTimeoutMs = 30_000;
const maxStderrBytes = 64 * 1024;
const closeTimeoutMs = 1_000;

interface StandaloneSession {
  readonly bridge: McpAppBridgeSession;
  readonly client: Client;
  readonly closed: Promise<void>;
  readonly sessionId: string;
  readonly stderr: () => string;
  close(): Promise<void>;
  listResources(): Promise<readonly Resource[]>;
  listTools(): Promise<readonly Tool[]>;
  watchClosed(listener: () => void): () => void;
}

interface AppSelection {
  readonly input: Readonly<Record<string, McpAppJsonValue>>;
  readonly result: McpAppJsonValue;
  readonly resourceUri: string;
  readonly server: string;
  readonly tool: McpAppToolDefinition;
}

interface ServedMcpAppShape {
  readonly closed: Promise<void>;
  readonly resourceUri: string;
  readonly sandboxOrigin: string;
  readonly server: string;
  readonly tool: string;
  readonly url: string;
}

class ServedMcpAppService extends Context.Service<ServedMcpAppService, ServedMcpAppShape>()(
  'agent-bundle/serve-app/ServedMcpAppService',
) {}

const loopbackHosts: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

const requireJsonObject = (value: unknown, label: string): Readonly<Record<string, McpAppJsonValue>> => {
  const snapshot = canonicalMcpAppJson(value, label);
  if (!isRecord(snapshot)) throw new TypeError(`${label} must be a JSON object.`);
  return snapshot as Readonly<Record<string, McpAppJsonValue>>;
};

export interface ServeAppSelector {
  readonly name?: string;
  readonly resourceUri?: string;
  readonly server: string;
}

/** Splits `<server>/<app>` or `<server>/ui://...` into its server and App parts, rejecting anything else. */
export const parseServeAppSelector = (value: string): ServeAppSelector => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error('MCP App must be named as <server>/<app> or a ui:// resource URI.');
  const separator = trimmed.indexOf('/');
  if (separator < 1 || separator === trimmed.length - 1) {
    throw new Error(`MCP App ${JSON.stringify(value)} must be named as <server>/<app> or <server>/ui://... .`);
  }
  const server = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);
  if (rest.startsWith('ui://')) return Object.freeze({ resourceUri: rest, server });
  if (rest.includes('/')) throw new Error(`MCP App name ${JSON.stringify(rest)} must not contain a slash.`);
  return Object.freeze({ name: rest, server });
};

const appNameOf = (resourceUri: string): string | undefined => {
  try {
    const parsed = new URL(resourceUri);
    if (parsed.protocol !== 'ui:') return undefined;
    const segment = parsed.pathname.split('/').filter((part) => part.length > 0).at(-1);
    return segment === undefined ? undefined : segment.replace(/\.html?$/iu, '');
  } catch {
    return undefined;
  }
};

const captureStderr = (stream: Stream | null): (() => string) => {
  if (stream === null) return () => '';
  let captured = '';
  stream.on('data', (chunk: unknown) => {
    if (captured.length >= maxStderrBytes) return;
    captured = `${captured}${String(chunk)}`.slice(0, maxStderrBytes);
  });
  return () => captured;
};

const openSession = async (
  launch: ResolvedMcpStdioLaunch,
  identity: Readonly<{ readonly serverName: string; readonly target: string }>,
  timeoutMs: number,
): Promise<StandaloneSession> => {
  const client = new Client({ name: mcpAppPreviewHostInfo.name, version: mcpAppPreviewHostInfo.version }, {
    capabilities: mcpAppClientCapabilities,
  });
  const transport = new StdioClientTransport({
    args: [...launch.args],
    command: launch.command,
    cwd: launch.cwd,
    env: { ...launch.env },
    stderr: 'pipe',
  });
  const stderr = captureStderr(transport.stderr);
  const closedGate = Promise.withResolvers<void>();
  const listeners = new Set<() => void>();
  let closed = false;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    closedGate.resolve();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A close watcher must never disrupt teardown.
      }
    }
    listeners.clear();
  };
  transport.onclose = markClosed;
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    markClosed();
    const output = stderr();
    throw new Error(
      `The packed MCP server did not start: ${error instanceof Error ? error.message : String(error)}` +
      `${output.length === 0 ? '' : `\nserver stderr:\n${output}`}`,
      { cause: error },
    );
  }
  // The transport's own onclose is installed by the SDK client on connect;
  // chain ours behind it so an unexpected server exit still settles `closed`.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    try {
      sdkOnClose?.();
    } finally {
      markClosed();
    }
  };
  const assertActive = (): void => {
    if (closed) throw new Error('The bound MCP server connection is closed.');
  };
  const requestOptions = Object.freeze({ timeout: timeoutMs });
  let bridgeTools: Promise<readonly McpAppBridgeTool[]> | undefined;
  let bridgeResources: Promise<readonly McpAppBridgeResource[]> | undefined;
  const listTools = async (): Promise<readonly Tool[]> => Object.freeze([...(await client.listTools(undefined, requestOptions)).tools]);
  const listResources = async (): Promise<readonly Resource[]> => Object.freeze([...(await client.listResources(undefined, requestOptions)).resources]);
  const sessionId = randomUUID();
  const bridge: McpAppBridgeSession = Object.freeze({
    callTool: async ({ arguments: toolArguments, name }: { readonly arguments: McpAppJsonValue | undefined; readonly name: string }) => {
      assertActive();
      const argumentsSnapshot = requireJsonObject(toolArguments ?? {}, 'MCP App tool arguments');
      const result = await client.callTool({ arguments: { ...argumentsSnapshot }, name }, requestOptions);
      assertActive();
      return canonicalMcpAppJson(result, 'MCP App tool result');
    },
    identity: Object.freeze({ epochId: `serve-app:${sessionId}`, serverName: identity.serverName, sessionId, target: identity.target }),
    listBridgeResources: async () => {
      assertActive();
      bridgeResources ??= listResources().then((resources) => Object.freeze(resources.map(canonicalMcpAppResource)));
      const resources = await bridgeResources;
      assertActive();
      return resources;
    },
    listBridgeTools: async () => {
      assertActive();
      bridgeTools ??= listTools().then((tools) => Object.freeze(tools.map(canonicalMcpAppTool)));
      const tools = await bridgeTools;
      assertActive();
      return tools;
    },
    readResource: async ({ uri }: { readonly uri: string }) => {
      assertActive();
      const result = await client.readResource({ uri }, requestOptions);
      assertActive();
      return canonicalMcpAppJson(result, 'MCP App resource result');
    },
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    bridge,
    client,
    close: () => {
      closing ??= client.close().catch(() => undefined).then(markClosed);
      return closing;
    },
    closed: closedGate.promise,
    listResources,
    listTools,
    sessionId,
    stderr,
    watchClosed: (listener: () => void) => {
      if (closed) {
        listener();
        return () => undefined;
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
};

/**
 * Resolves the App and its opening tool against the live server, then calls
 * the tool once so the App opens populated — the same input/result pair the
 * Workbench binds when it previews a tool run.
 */
const selectApp = async (session: StandaloneSession, options: ServeMcpAppOptions): Promise<AppSelection> => {
  const requested = parseServeAppSelector(options.app);
  const [tools, resources] = await Promise.all([session.listTools(), session.listResources()]);
  const appResources = resources.filter((resource) => resource.mimeType === MCP_APP_MIME_TYPE);
  const matching = appResources.filter((resource) => requested.resourceUri === undefined
    ? appNameOf(resource.uri) === requested.name
    : resource.uri === requested.resourceUri);
  const available = appResources.map((resource) => `${requested.server}/${appNameOf(resource.uri) ?? resource.uri}`);
  if (matching.length === 0) {
    throw new Error(
      `MCP server ${JSON.stringify(requested.server)} serves no MCP App ${JSON.stringify(requested.name ?? requested.resourceUri)}` +
      `${available.length === 0 ? ' (it serves no MCP App resources).' : `; available: ${available.join(', ')}.`}`,
    );
  }
  if (matching.length > 1) {
    throw new Error(
      `MCP App ${JSON.stringify(requested.name)} names ${String(matching.length)} resources on server ${JSON.stringify(requested.server)}; ` +
      `use ${requested.server}/<ui://...> to select one of: ${matching.map((resource) => resource.uri).join(', ')}.`,
    );
  }
  const resourceUri = matching[0]!.uri;
  const appTools = tools.filter((tool) => {
    const definition = canonicalMcpAppTool(tool).definition;
    return selectMcpAppResourceUri(definition) === resourceUri;
  });
  const selectedTool = options.tool === undefined
    ? appTools.length === 1 ? appTools[0] : undefined
    : appTools.find((tool) => tool.name === options.tool);
  if (selectedTool === undefined) {
    if (options.tool !== undefined) {
      throw new Error(
        `Tool ${JSON.stringify(options.tool)} does not open MCP App ${resourceUri}` +
        `${appTools.length === 0 ? '.' : `; tools that do: ${appTools.map((tool) => tool.name).join(', ')}.`}`,
      );
    }
    throw new Error(appTools.length === 0
      ? `No tool on server ${JSON.stringify(requested.server)} declares _meta.ui.resourceUri ${resourceUri}.`
      : `Several tools open MCP App ${resourceUri} (${appTools.map((tool) => tool.name).join(', ')}); choose one with --tool.`);
  }
  const definition = canonicalMcpAppTool(selectedTool).definition;
  const input = requireJsonObject(options.input ?? {}, 'MCP App tool input');
  const result = await session.bridge.callTool({ arguments: input, name: definition.name });
  return Object.freeze({ input, resourceUri, result, server: requested.server, tool: definition });
};

/** The one bound session, leased to every App binding the host page creates. */
const sessionAuthorityFor = (session: StandaloneSession): McpAppSessionAuthority => Object.freeze({
  acquireAppLease: async (sessionId: string): Promise<McpAppSessionLease> => {
    if (sessionId !== session.sessionId) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
    return Object.freeze({
      release: async () => undefined,
      session: session.bridge,
      watchSessionClosed: (listener: (reason?: unknown) => Promise<void> | void) => {
        let closedNow = false;
        const unsubscribe = session.watchClosed(() => {
          closedNow = true;
          void listener();
        });
        return Object.freeze({ closed: closedNow, unsubscribe });
      },
    });
  },
});

const listen = async (server: Server, port: number): Promise<number> => new Promise((resolvePort, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port }, () => {
    server.off('error', reject);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('The MCP App host did not receive a TCP address.'));
      return;
    }
    resolvePort(address.port);
  });
});

const closeServer = async (server: Server, sockets: ReadonlySet<Socket>): Promise<void> => new Promise((resolveClose, reject) => {
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, closeTimeoutMs);
  server.close((error) => {
    clearTimeout(deadline);
    if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolveClose();
  });
  for (const socket of sockets) socket.destroy();
});

const validPort = (value: number | undefined): number => {
  const port = value ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new RangeError('MCP App host port must be a TCP port number.');
  return port;
};

const validProfile = (value: McpAppProfileId | undefined): McpAppProfileId => {
  const profile = value ?? 'portable';
  if (profile !== 'portable' && profile !== 'claude' && profile !== 'chatgpt') {
    throw new RangeError(`Unsupported MCP App profile ${JSON.stringify(String(profile))}.`);
  }
  return profile;
};

const requestOriginIsHost = (request: IncomingMessage, url: string): boolean => {
  const origin = singleHeader(request.headers.origin);
  if (origin !== undefined) return origin === url;
  return singleHeader(request.headers['sec-fetch-site']) === 'same-origin';
};

const hostHeaderIsLoopback = (request: IncomingMessage, port: number): boolean => {
  const host = singleHeader(request.headers.host);
  if (host === undefined) return false;
  const separator = host.lastIndexOf(':');
  if (separator === -1) return false;
  return loopbackHosts.has(host.slice(0, separator)) && host.slice(separator + 1) === String(port);
};

const serveProgram = (options: ServeMcpAppOptions): Effect.Effect<ServedMcpAppShape, unknown, Scope.Scope> => Effect.gen(function* () {
  const port = yield* liftTry(() => validPort(options.port));
  const profile = yield* liftTry(() => validProfile(options.profile));
  const autoApprove = Object.freeze([...(options.autoApprove ?? [])]);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const requestedApp = yield* liftTry(() => parseServeAppSelector(options.app));
  const artifact = typeof options.artifact === 'string' ? options.artifact : yield* options.artifact;
  const launch = yield* liftPromise(() => resolveMcpLaunchEnvironment({
    artifact,
    ...(options.envFiles === undefined ? {} : { envFiles: options.envFiles }),
    ...(options.envPluginRoot === undefined ? {} : { envPluginRoot: options.envPluginRoot }),
    ...(options.loadEnvFiles === undefined ? {} : { loadEnvFiles: options.loadEnvFiles }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    pluginDataRoot: options.pluginDataRoot,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    server: requestedApp.server,
    target: options.target,
    workspaceRoot: options.workspaceRoot,
  }));
  const session = yield* Effect.acquireRelease(
    liftPromise(() => openSession(launch, { serverName: requestedApp.server, target: options.target }, timeoutMs)),
    (opened) => Effect.promise(() => opened.close()),
  );
  const selection = yield* liftPromise(() => selectApp(session, options));

  const token = randomBytes(32).toString('base64url');
  const sockets = new Set<Socket>();
  // The listener is installed after the routes exist; a request racing the
  // wiring is refused rather than served without authorization.
  const dispatch: { current?: (request: IncomingMessage, response: ServerResponse) => Promise<void> } = {};
  const server = createServer((request, response) => {
    const handler = dispatch.current;
    if (handler === undefined) {
      responseDiagnostic(response, diagnostic('AB8022', 'MCP App host is not ready.', 503));
      return;
    }
    void handler(request, response).catch((error: unknown) => {
      if (isRequestDiagnostic(error)) {
        responseDiagnostic(response, error);
        return;
      }
      responseDiagnostic(response, diagnostic('AB8023', 'MCP App operation could not be completed.', 502));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const boundPort = yield* Effect.acquireRelease(
    liftPromise(() => listen(server, port)),
    () => Effect.promise(() => closeServer(server, sockets).catch(() => undefined)),
  );
  const url = `http://127.0.0.1:${String(boundPort)}`;
  const sandbox: McpAppSandboxProxy = yield* Effect.acquireRelease(
    liftPromise(() => createMcpAppSandboxProxy({ hostOrigin: url })),
    (proxy) => Effect.promise(() => proxy.close().catch(() => undefined)),
  );
  const openBrowser = options.openBrowser ?? openInBrowser;
  const bindings = new McpAppBindingService({ sessionAuthority: sessionAuthorityFor(session) });
  const previews = yield* Effect.acquireRelease(
    Effect.sync(() => new McpAppPreviewService({
      bindingAuthority: bindings,
      host: mcpAppPreviewHost(openBrowser),
      hostInfo: mcpAppPreviewHostInfo,
      hostOrigin: url,
      sandboxProxy: sandbox,
      toolAuthority: {
        resolveTool: async (sessionId, toolName): Promise<McpAppToolDefinition> => {
          if (sessionId !== session.sessionId || toolName !== selection.tool.name) {
            throw new Error(`Unknown MCP App tool ${JSON.stringify(toolName)}.`);
          }
          return selection.tool;
        },
      },
    })),
    (service) => Effect.promise(() => service.closeAll().catch(() => undefined)),
  );
  const authorize = (request: IncomingMessage): void => {
    if (!hostHeaderIsLoopback(request, boundPort) || !requestOriginIsHost(request, url)) {
      throw requestError(diagnostic('AB8003', 'Request origin is not this MCP App host.', 403));
    }
    if (singleHeader(request.headers[SERVE_APP_TOKEN_HEADER]) !== token) {
      throw requestError(diagnostic('AB8004', 'A valid MCP App host token is required.', 403));
    }
  };
  const routes = yield* Effect.acquireRelease(
    Effect.sync(() => new McpAppRoutes({ authorize, service: previews })),
    (created) => Effect.sync(() => { created.close(); }),
  );
  const page = renderServeAppPage({
    autoApprove,
    input: selection.input,
    previewProfile: profile,
    result: selection.result,
    sessionId: session.sessionId,
    title: `${selection.server}/${appNameOf(selection.resourceUri) ?? selection.resourceUri}`,
    token,
    toolName: selection.tool.name,
  });
  // `frame-ancestors` does not inherit from `default-src`: without it, a page
  // on another origin could frame this consent-bearing document on a fixed
  // `--port` and clickjack its Allow/Deny controls.
  const contentSecurityPolicy = [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `frame-src ${sandbox.origin}`,
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
  ].join('; ');
  dispatch.current = async (request, response) => {
    if (!hostHeaderIsLoopback(request, boundPort)) {
      throw requestError(diagnostic('AB8003', 'Request origin is not this MCP App host.', 403));
    }
    if (await routes.handle(request, response)) return;
    const pathname = new URL(request.url ?? '/', url).pathname;
    if (pathname !== '/' && pathname !== '/index.html') {
      responseDiagnostic(response, diagnostic('AB8020', 'Not found.', 404));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': contentSecurityPolicy,
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : page);
  };
  if (options.open === true) yield* liftPromise(() => Promise.resolve(openBrowser(`${url}/`)));
  return Object.freeze({
    closed: session.closed,
    resourceUri: selection.resourceUri,
    sandboxOrigin: sandbox.origin,
    server: selection.server,
    tool: selection.tool.name,
    url: `${url}/`,
  });
});

/**
 * Serves one built MCP App standalone: launches the plugin's packed MCP
 * server exactly as `agent-bundle mcp run` would, binds the App to it
 * through the Workbench's MCP App host stack, and returns the loopback URL of
 * a page that renders the App. `close()` tears everything down, the server
 * process included.
 */
export const serveMcpApp = async (options: ServeMcpAppOptions): Promise<ServedMcpApp> => {
  const runtime = makeScopedEffectRuntime(Layer.effect(ServedMcpAppService, serveProgram(options)));
  let service: ServedMcpAppShape;
  try {
    service = await runtime.run(ServedMcpAppService);
  } catch (error) {
    await runtime.close().catch(() => undefined);
    throw error;
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    close: () => {
      closing ??= runtime.close();
      return closing;
    },
    closed: service.closed,
    resourceUri: service.resourceUri,
    sandboxOrigin: service.sandboxOrigin,
    server: service.server,
    tool: service.tool,
    url: service.url,
  });
};
