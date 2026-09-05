import type { Resource, Tool } from '@modelcontextprotocol/client';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import { isRecord } from '../core/strict-json.ts';
import type {
  McpAppJsonValue,
  McpAppSessionLease,
  McpAppToolDefinition,
} from './mcp-apps/mcp-app-binding-service.ts';
import { MCP_APP_MIME_TYPE } from './mcp-apps/mcp-app-bridge.ts';
import type {
  McpAppOpeningCall,
  McpAppRoutePreviewService,
} from './mcp-apps/mcp-app-routes.ts';
import {
  canonicalMcpAppJson,
  canonicalMcpAppTool,
} from './mcp-session/mcp-session-apps.ts';
import type { McpSession } from './mcp-session/mcp-session.ts';
import type { McpSessionService } from './mcp-session/mcp-session-service.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  isRequestDiagnostic,
  rawPathname,
  requestError,
  responseDiagnostic,
} from './http.ts';
import {
  readWebManifest,
  type WebManifestApp,
} from '../web-host/manifest.ts';
import { renderWebHostPage, webHostContentSecurityPolicy } from '../web-host/page.ts';
import { readWebHostPageScript } from '../web-host/page-script.ts';
import {
  openApp,
  type AppSelectionSource,
} from '../web-host/select-app.ts';

const devWebHostTarget = 'portable';
const manifestFileName = 'agent-bundle.manifest.json';

interface WebHostEpochReference {
  close(): Promise<void>;
  readonly epoch: Readonly<{ readonly id: string }>;
  readonly root: string;
}

export interface WebHostEpochSource {
  acquireActiveEpochReference(): Promise<WebHostEpochReference>;
}

interface RegisteredSession {
  readonly dispose: () => Promise<void>;
  readonly session: McpSession;
}

export interface WebHostRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly epochs?: WebHostEpochSource;
  readonly mcpSessions?: McpSessionService;
  readonly previews?: McpAppRoutePreviewService;
  readonly sandboxOrigin: () => string | undefined;
  readonly sessionToken: string;
}

interface WebHostRoute {
  readonly app: string;
  readonly server: string;
}

const routeSegment = (value: string): string =>
  decodedOpaqueSegment(value, {
    code: 'AB8020',
    message: 'Web host route path is not valid.',
    rejectBlank: true,
  });

const route = (requestTarget: string | undefined): WebHostRoute | false | undefined => {
  const pathname = rawPathname(requestTarget);
  if (pathname !== '/web' && !pathname.startsWith('/web/')) return undefined;
  const parts = pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'web') return false;
  return Object.freeze({ app: routeSegment(parts[3]!), server: routeSegment(parts[2]!) });
};

const jsonInput = (
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, McpAppJsonValue>> => {
  const input = canonicalMcpAppJson(value ?? {}, 'MCP App opening input');
  if (!isRecord(input)) throw new TypeError('MCP App opening input must be a JSON object.');
  return input as Readonly<Record<string, McpAppJsonValue>>;
};

const selectionSource = (session: McpSession): AppSelectionSource => Object.freeze({
  callTool: async (
    name: string,
    input: Readonly<Record<string, McpAppJsonValue>>,
  ): Promise<McpAppJsonValue> => canonicalMcpAppJson(
    await session.callTool({ arguments: { ...input }, name }),
    'MCP App tool result',
  ),
  listAppResourceUris: async () => Object.freeze(
    (await session.listResources())
      .filter((resource: Resource) => resource.mimeType === MCP_APP_MIME_TYPE)
      .map((resource: Resource) => resource.uri),
  ),
  listToolDefinitions: async (): Promise<readonly McpAppToolDefinition[]> => Object.freeze(
    (await session.listTools()).map((tool: Tool) => canonicalMcpAppTool(tool).definition),
  ),
});

const writePage = (
  response: ServerResponse,
  method: string,
  sandboxOrigin: string,
  body: string,
): void => {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-security-policy': webHostContentSecurityPolicy(sandboxOrigin),
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : body);
};

/** Same-origin development entry point for Apps explicitly exposed by the active epoch. */
export class WebHostRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #epochs: WebHostEpochSource | undefined;
  readonly #mcpSessions: McpSessionService | undefined;
  readonly #previews: McpAppRoutePreviewService | undefined;
  readonly #sandboxOrigin: () => string | undefined;
  readonly #sessionToken: string;
  readonly #openingCalls = new Map<string, McpAppOpeningCall>();
  readonly #sessions = new Map<string, Promise<RegisteredSession>>();
  #closed = false;

  constructor(options: WebHostRoutesOptions) {
    this.#authorize = options.authorize;
    this.#epochs = options.epochs;
    this.#mcpSessions = options.mcpSessions;
    this.#previews = options.previews;
    this.#sandboxOrigin = options.sandboxOrigin;
    this.#sessionToken = options.sessionToken;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#openingCalls.clear();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      void session.then((registered) => registered.dispose()).catch(() => undefined);
    }
  }

  openingCall(sessionId: string, toolName: string): McpAppOpeningCall | undefined {
    return this.#openingCalls.get(this.#openingCallKey(sessionId, toolName));
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    if (parsed === false) {
      responseDiagnostic(response, diagnostic('AB8020', 'Web host route was not found.', 404));
      return true;
    }
    this.#authorize(request);
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return true;
    }
    if (this.#closed) throw requestError(diagnostic('AB8022', 'Web host routes are not available.', 503));
    const epochs = this.#epochs;
    const mcpSessions = this.#mcpSessions;
    const sandboxOrigin = this.#sandboxOrigin();
    if (epochs === undefined || mcpSessions === undefined || this.#previews === undefined || sandboxOrigin === undefined) {
      throw requestError(diagnostic('AB8022', 'Web host routes are not available.', 404));
    }

    try {
      const exposed = await this.#exposedApp(epochs, parsed);
      if (exposed.app === undefined) {
        const suffix = exposed.names.length === 0
          ? ' No Apps are exposed.'
          : ` Exposed Apps: ${exposed.names.join(', ')}.`;
        responseDiagnostic(
          response,
          diagnostic(
            'AB8020',
            `MCP App ${JSON.stringify(`${parsed.server}/${parsed.app}`)} is not exposed.${suffix}`,
            404,
          ),
        );
        return true;
      }
      const { app, epochId } = exposed;
      if (method === 'HEAD') {
        writePage(response, method, sandboxOrigin, '');
        return true;
      }
      const registered = await this.#session(mcpSessions, epochId, app.server);
      const selection = await openApp(selectionSource(registered.session), {
        input: jsonInput(app.input),
        resourceUri: app.resourceUri,
        server: app.server,
        ...(app.tool === undefined ? {} : { tool: app.tool }),
      });
      this.#openingCalls.set(
        this.#openingCallKey(registered.session.id, selection.tool.name),
        Object.freeze({ input: selection.input, result: selection.result }),
      );
      const body = renderWebHostPage({
        script: await readWebHostPageScript(),
        seed: {
          autoApprove: app.allow,
          input: selection.input,
          previewProfile: 'portable',
          result: selection.result,
          sessionId: registered.session.id,
          title: app.app,
          token: this.#sessionToken,
          tokenHeader: 'x-agent-bundle-session',
          toolName: selection.tool.name,
        },
      });
      writePage(response, method, sandboxOrigin, body);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      throw requestError(diagnostic('AB8023', 'MCP App could not be opened.', 502));
    }
    return true;
  }

  async #exposedApp(
    epochs: WebHostEpochSource,
    requested: WebHostRoute,
  ): Promise<Readonly<{
    readonly app?: WebManifestApp;
    readonly epochId: string;
    readonly names: readonly string[];
  }>> {
    let reference: WebHostEpochReference;
    try {
      reference = await epochs.acquireActiveEpochReference();
    } catch {
      throw requestError(diagnostic('AB8022', 'Web host routes are not available without an active artifact epoch.', 404));
    }
    try {
      const manifest = await readWebManifest(join(reference.root, manifestFileName));
      const apps: readonly WebManifestApp[] = manifest?.apps ?? [];
      const requestedName = `${requested.server}/${requested.app}`;
      const app = apps.find((candidate) => candidate.app === requestedName);
      const names = Object.freeze(apps.map((candidate) => candidate.app).sort((left, right) => left.localeCompare(right)));
      return Object.freeze({
        ...(app === undefined ? {} : { app }),
        epochId: reference.epoch.id,
        names,
      });
    } finally {
      await reference.close();
    }
  }

  async #session(service: McpSessionService, epochId: string, serverName: string): Promise<RegisteredSession> {
    const key = `${epochId}\0${serverName}`;
    const existing = this.#sessions.get(key);
    if (existing !== undefined) return existing;
    const opening = this.#openSession(service, key, epochId, serverName);
    this.#sessions.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.#sessions.get(key) === opening) this.#sessions.delete(key);
      throw error;
    }
  }

  async #openSession(
    service: McpSessionService,
    key: string,
    epochId: string,
    serverName: string,
  ): Promise<RegisteredSession> {
    const session = await service.open({ epochId, serverName, target: devWebHostTarget });
    const lease: McpAppSessionLease = await service.acquireAppLease(session.id);
    let disposed = false;
    let unsubscribe = (): void => undefined;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      await lease.release();
    };
    const watched = lease.watchSessionClosed(() => {
      this.#forgetSession(key, session.id);
    });
    unsubscribe = watched.unsubscribe;
    if (watched.closed) {
      await dispose();
      throw new Error('MCP App session closed while it was being registered.');
    }
    const registered = Object.freeze({ dispose, session });
    if (this.#closed) {
      await dispose();
      throw requestError(diagnostic('AB8022', 'Web host routes are not available.', 503));
    }
    return registered;
  }

  #forgetSession(key: string, sessionId: string): void {
    const current = this.#sessions.get(key);
    if (current === undefined) return;
    this.#sessions.delete(key);
    for (const openingKey of this.#openingCalls.keys()) {
      if (openingKey.startsWith(`${sessionId}\0`)) this.#openingCalls.delete(openingKey);
    }
    void current.then((registered) => registered.dispose()).catch(() => undefined);
  }

  #openingCallKey(sessionId: string, toolName: string): string {
    return `${sessionId}\0${toolName}`;
  }
}
