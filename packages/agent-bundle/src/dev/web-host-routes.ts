import type { Resource, Tool } from '@modelcontextprotocol/client';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { digest } from '../core/digest.ts';
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
  readWebManifestDocument,
  type WebManifestApp,
} from '../web-host/manifest.ts';
import { renderWebHostPage, webHostContentSecurityPolicy } from '../web-host/page.ts';
import { readWebHostPageScript } from '../web-host/page-script.ts';
import {
  resolveAppOpening,
  type AppSelectionSource,
  type ResolvedAppOpening,
} from '../web-host/select-app.ts';
import {
  selectWebLaunch,
  WebLaunchSelectionError,
  type SelectedWebLaunch,
} from './web-host-launch-selection.ts';

const manifestFileName = 'agent-bundle.manifest.json';
const maxRetainedOpeningCalls = 64;
const maxRetainedOpeningExecutions = 256;
const maxRetainedOpeningResults = 64;

interface WebOpeningCall extends McpAppOpeningCall {
  readonly notice?: string;
}

type OpeningExecution =
  | Readonly<{ readonly call: Promise<WebOpeningCall>; readonly outcome: 'in-flight' }>
  | Readonly<{ readonly outcome: 'succeeded' }>
  | Readonly<{ readonly outcome: 'failed-unknown' }>;

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

/** How the launch of a web-exposed server is selected across the artifact's declared projections. */
export interface WebHostLaunchOptions {
  readonly projectRoot: string;
  readonly registry: TargetRegistry;
}

export interface WebHostRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly epochs?: WebHostEpochSource;
  readonly launch?: WebHostLaunchOptions;
  readonly mcpSessions?: McpSessionService;
  readonly previews?: McpAppRoutePreviewService;
  readonly sandboxOrigin: () => string | undefined;
  readonly sessionToken: string;
}

interface WebHostRoute {
  readonly app: string;
  readonly server: string;
  /** Explicit projection choice from `?target=`; validated, never a fallback. */
  readonly target?: string;
}

const routeSegment = (value: string): string =>
  decodedOpaqueSegment(value, {
    code: 'AB8020',
    message: 'Web host route path is not valid.',
    rejectBlank: true,
  });

const requestedTarget = (requestUrl: string | undefined): string | undefined => {
  let target: string | null;
  try {
    target = new URL(requestUrl ?? '', 'http://localhost').searchParams.get('target');
  } catch {
    throw requestError(diagnostic('AB8020', 'Web host route path is not valid.', 400));
  }
  if (target === null) return undefined;
  if (target.trim().length === 0) {
    throw requestError(diagnostic('AB8020', 'The target query parameter must name a declared projection.', 400));
  }
  return target;
};

const route = (requestUrl: string | undefined): WebHostRoute | false | undefined => {
  const pathname = rawPathname(requestUrl);
  if (pathname !== '/web' && !pathname.startsWith('/web/')) return undefined;
  const parts = pathname.split('/');
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'web') return false;
  const requested = requestedTarget(requestUrl);
  return Object.freeze({
    app: routeSegment(parts[3]!),
    server: routeSegment(parts[2]!),
    ...(requested === undefined ? {} : { target: requested }),
  });
};

const jsonInput = (
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, McpAppJsonValue>> => {
  const input = canonicalMcpAppJson(value ?? {}, 'MCP App opening input');
  if (!isRecord(input)) throw new TypeError('MCP App opening input must be a JSON object.');
  return input;
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
  readonly #launch: WebHostLaunchOptions | undefined;
  readonly #mcpSessions: McpSessionService | undefined;
  readonly #previews: McpAppRoutePreviewService | undefined;
  readonly #sandboxOrigin: () => string | undefined;
  readonly #sessionToken: string;
  readonly #openingCalls = new Map<string, McpAppOpeningCall>();
  readonly #openingExecutions = new Map<string, OpeningExecution>();
  readonly #openingResults = new Map<string, WebOpeningCall>();
  readonly #sessions = new Map<string, Promise<RegisteredSession>>();
  #closed = false;

  constructor(options: WebHostRoutesOptions) {
    this.#authorize = options.authorize;
    this.#epochs = options.epochs;
    this.#launch = options.launch;
    this.#mcpSessions = options.mcpSessions;
    this.#previews = options.previews;
    this.#sandboxOrigin = options.sandboxOrigin;
    this.#sessionToken = options.sessionToken;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#openingCalls.clear();
    this.#openingExecutions.clear();
    this.#openingResults.clear();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      void session.then((registered) => registered.dispose()).catch(() => undefined);
    }
  }

  /**
   * Retires sessions of every epoch but the newly published one. New page
   * loads acquire sessions on the new epoch; an old session nobody leases
   * beyond this registry closes now, releasing its process and epoch
   * reference, while one that pages still lease stays valid for them — no
   * longer handed out, and closed at the release of its last page lease. A
   * failed rebuild publishes no epoch, so it never reaches this method and
   * the last working session is kept.
   */
  adoptActiveEpoch(activeEpochId: string): void {
    if (this.#closed) return;
    const service = this.#mcpSessions;
    for (const [key, opening] of [...this.#sessions.entries()]) {
      if (key.startsWith(`${activeEpochId}\0`)) continue;
      this.#sessions.delete(key);
      void opening.then(async (registered) => {
        if (service === undefined) return;
        await registered.dispose();
        if (service.closeSessionWhenUnleased(registered.session.id)) {
          this.#dropSessionState(registered.session.id);
        }
      }).catch(() => undefined);
    }
  }

  /**
   * Every `/web` page shares its server's session with every other page of
   * that server, so a page binds only the call stamped into its own seed:
   * without `opening`, two tabs on one tool would read each other's result.
   */
  openingCall(sessionId: string, toolName: string, opening: string | undefined): McpAppOpeningCall | undefined {
    return opening === undefined ? undefined : this.#openingCalls.get(this.#openingCallKey(sessionId, toolName, opening));
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
    const launchOptions = this.#launch;
    const mcpSessions = this.#mcpSessions;
    const sandboxOrigin = this.#sandboxOrigin();
    if (epochs === undefined || launchOptions === undefined || mcpSessions === undefined || this.#previews === undefined || sandboxOrigin === undefined) {
      throw requestError(diagnostic('AB8022', 'Web host routes are not available.', 404));
    }

    try {
      const exposed = await this.#exposedApp(epochs, launchOptions, parsed);
      if (exposed.app === undefined || exposed.launch === undefined) {
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
      const { app, epochId, launch } = exposed;
      if (method === 'HEAD') {
        writePage(response, method, sandboxOrigin, '');
        return true;
      }
      const registered = await this.#session(mcpSessions, epochId, app.server, launch);
      const source = selectionSource(registered.session);
      const resolved = await resolveAppOpening(source, {
        input: jsonInput(app.input),
        resourceUri: app.resourceUri,
        server: app.server,
        ...(app.tool === undefined ? {} : { tool: app.tool }),
      });
      const call = await this.#openingCallFor(source, registered.session.id, resolved);
      const opening = randomUUID();
      this.#retainOpeningCall(
        this.#openingCallKey(registered.session.id, resolved.tool.name, opening),
        call,
      );
      const body = renderWebHostPage({
        script: await readWebHostPageScript(),
        seed: {
          autoApprove: app.allow,
          input: call.input,
          opening,
          ...(call.notice === undefined ? {} : { openingNotice: call.notice }),
          previewProfile: 'portable',
          result: call.result,
          sessionId: registered.session.id,
          title: app.app,
          token: this.#sessionToken,
          tokenHeader: 'x-agent-bundle-session',
          toolName: resolved.tool.name,
        },
      });
      writePage(response, method, sandboxOrigin, body);
    } catch (error) {
      if (error instanceof WebLaunchSelectionError) {
        responseDiagnostic(response, diagnostic('AB8023', error.message, error.code === 'launch-ambiguous' ? 409 : 404));
        return true;
      }
      if (isRequestDiagnostic(error)) throw error;
      throw requestError(diagnostic('AB8023', 'MCP App could not be opened.', 502));
    }
    return true;
  }

  /**
   * The call that opens the page. A tool annotated `readOnlyHint: true` runs
   * once per page load — a refresh re-reads live state. Any other opening
   * tool may mutate, so a page open is not an unbounded mutation: its first
   * call per session, tool, App, and input owns a bounded execution record.
   * Concurrent first loads share an in-flight call; later loads rebind a
   * retained result, or receive a fail-closed result when that result was
   * evicted or the call failed. A new session (a new epoch after rebuild)
   * may run the tool once again.
   */
  async #openingCallFor(
    source: AppSelectionSource,
    sessionId: string,
    resolved: ResolvedAppOpening,
  ): Promise<WebOpeningCall> {
    const call = async (): Promise<WebOpeningCall> => Object.freeze({
      input: resolved.input,
      result: await source.callTool(resolved.tool.name, resolved.input),
    });
    const readOnly = isRecord(resolved.tool['annotations']) && resolved.tool['annotations']['readOnlyHint'] === true;
    if (readOnly) return call();
    const key = `${sessionId}\0${resolved.tool.name}\0${resolved.resourceUri}\0${digest(resolved.input)}`;
    const execution = this.#openingExecutions.get(key);
    if (execution?.outcome === 'in-flight') return execution.call;
    if (execution?.outcome === 'succeeded') {
      return this.#openingResults.get(key) ??
        this.#unavailableOpeningCall(resolved.input, 'Opening tool result no longer retained; re-run explicitly from the App.');
    }
    if (execution?.outcome === 'failed-unknown') {
      return this.#unavailableOpeningCall(resolved.input, 'Opening tool outcome is unknown; re-run explicitly from the App.');
    }
    if (this.#openingExecutions.size >= maxRetainedOpeningExecutions) {
      return this.#unavailableOpeningCall(resolved.input, 'Automatic opening limit reached; run the tool explicitly from the App.');
    }
    const pending = call();
    const inFlight = Object.freeze({ call: pending, outcome: 'in-flight' }) satisfies OpeningExecution;
    this.#openingExecutions.set(key, inFlight);
    try {
      const result = await pending;
      if (this.#openingExecutions.get(key) === inFlight) {
        this.#openingExecutions.set(key, Object.freeze({ outcome: 'succeeded' }));
        this.#retainOpeningResult(key, result);
      }
      return result;
    } catch (error) {
      if (this.#openingExecutions.get(key) === inFlight) {
        this.#openingExecutions.set(key, Object.freeze({ outcome: 'failed-unknown' }));
      }
      throw error;
    }
  }

  async #exposedApp(
    epochs: WebHostEpochSource,
    launchOptions: WebHostLaunchOptions,
    requested: WebHostRoute,
  ): Promise<Readonly<{
    readonly app?: WebManifestApp;
    readonly epochId: string;
    readonly launch?: SelectedWebLaunch;
    readonly names: readonly string[];
  }>> {
    let reference: WebHostEpochReference;
    try {
      reference = await epochs.acquireActiveEpochReference();
    } catch {
      throw requestError(diagnostic('AB8022', 'Web host routes are not available without an active artifact epoch.', 404));
    }
    try {
      const document = await readWebManifestDocument(join(reference.root, manifestFileName));
      const apps: readonly WebManifestApp[] = document.web?.apps ?? [];
      const requestedName = `${requested.server}/${requested.app}`;
      const app = apps.find((candidate) => candidate.app === requestedName);
      const names = Object.freeze(apps.map((candidate) => candidate.app).sort((left, right) => left.localeCompare(right)));
      if (app === undefined) {
        return Object.freeze({ epochId: reference.epoch.id, names });
      }
      const launch = await selectWebLaunch({
        artifactRoot: reference.root,
        declaredTargets: document.targets,
        registry: launchOptions.registry,
        ...(requested.target === undefined ? {} : { requestedTarget: requested.target }),
        serverName: app.server,
        workspaceRoot: launchOptions.projectRoot,
      });
      return Object.freeze({ app, epochId: reference.epoch.id, launch, names });
    } finally {
      await reference.close();
    }
  }

  async #session(
    service: McpSessionService,
    epochId: string,
    serverName: string,
    launch: SelectedWebLaunch,
  ): Promise<RegisteredSession> {
    // The resolved launch identity keys the session beside the epoch and
    // server: two projections sharing one normalized launch share the
    // session, while explicit targets with materially different launches
    // never collide on epoch + server alone.
    const key = `${epochId}\0${serverName}\0${launch.launchId}`;
    const existing = this.#sessions.get(key);
    if (existing !== undefined) return existing;
    const opening = this.#openSession(service, key, epochId, serverName, launch.target);
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
    target: string,
  ): Promise<RegisteredSession> {
    const session = await service.open({ epochId, serverName, target });
    const lease: McpAppSessionLease = await service.acquireAppLease(session.id);
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await lease.release();
    };
    const watched = lease.watchSessionClosed(() => {
      this.#forgetSession(key, session.id);
    });
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
    this.#dropSessionState(sessionId);
    const current = this.#sessions.get(key);
    if (current === undefined) return;
    this.#sessions.delete(key);
    void current.then((registered) => registered.dispose()).catch(() => undefined);
  }

  #dropSessionState(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const openingKey of this.#openingCalls.keys()) {
      if (openingKey.startsWith(prefix)) this.#openingCalls.delete(openingKey);
    }
    for (const executionKey of this.#openingExecutions.keys()) {
      if (executionKey.startsWith(prefix)) this.#openingExecutions.delete(executionKey);
    }
    for (const resultKey of this.#openingResults.keys()) {
      if (resultKey.startsWith(prefix)) this.#openingResults.delete(resultKey);
    }
  }

  #retainOpeningCall(key: string, call: McpAppOpeningCall): void {
    this.#openingCalls.set(key, call);
    for (const oldest of this.#openingCalls.keys()) {
      if (this.#openingCalls.size <= maxRetainedOpeningCalls) break;
      this.#openingCalls.delete(oldest);
    }
  }

  #retainOpeningResult(key: string, call: WebOpeningCall): void {
    this.#openingResults.set(key, call);
    for (const oldest of this.#openingResults.keys()) {
      if (this.#openingResults.size <= maxRetainedOpeningResults) break;
      this.#openingResults.delete(oldest);
    }
  }

  #unavailableOpeningCall(
    input: Readonly<Record<string, McpAppJsonValue>>,
    message: string,
  ): WebOpeningCall {
    return Object.freeze({
      input,
      notice: message,
      result: Object.freeze({
        content: Object.freeze([Object.freeze({ text: message, type: 'text' })]),
        isError: true,
      }),
    });
  }

  #openingCallKey(sessionId: string, toolName: string, opening: string): string {
    return `${sessionId}\0${toolName}\0${opening}`;
  }
}
