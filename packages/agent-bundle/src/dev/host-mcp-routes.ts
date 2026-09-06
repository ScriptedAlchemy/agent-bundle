import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { ProtocolError, Server, type ReadResourceResult } from '@modelcontextprotocol/server';

import { isHostSessionId } from '../contracts/host-sessions.ts';
import { EpochStoreError, type EpochStore } from './epoch-store.ts';
import {
  subscribeToEpochAdoption,
  type EpochAdoptionSource,
} from './epoch-adoption-policy.ts';
import type { ProjectEventHub, ProjectEventSubscription } from './events.ts';
import { diagnostic, requestError, singleHeader } from './http.ts';
import {
  McpSessionStaleEpochError,
  type McpSession,
  type McpSessionService,
} from './mcp-session/mcp-session-service.ts';

export const HOST_MCP_DEV_SESSION_CODE = 'AB8266';
const hostDevSessionHeader = 'x-agent-bundle-dev-session';
const hostDevPidHeader = 'x-agent-bundle-dev-pid';

export const hostDevSessionId = (headers: IncomingMessage['headers']): string | undefined => {
  const value = singleHeader(headers[hostDevSessionHeader]);
  if (value === undefined) return undefined;
  if (!isHostSessionId(value)) {
    throw requestError(diagnostic(
      HOST_MCP_DEV_SESSION_CODE,
      'AGENT_BUNDLE_DEV_SESSION must be a host-session id (hs_ + 16 lowercase characters).',
      400,
    ));
  }
  return value;
};

export const hostDevProcessId = (headers: IncomingMessage['headers']): number | undefined => {
  const value = singleHeader(headers[hostDevPidHeader]);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,9}$/u.test(value)) {
    throw requestError(diagnostic(HOST_MCP_DEV_SESSION_CODE, 'x-agent-bundle-dev-pid must be a process id.', 400));
  }
  return Number(value);
};

const hostMcpPathPrefix = '/mcp/host/';
const internalErrorCode = -32_603;

export const hostMcpEpochDriftCode = 'AB8024';

export class HostMcpEpochDriftError extends Error {
  readonly code = hostMcpEpochDriftCode;
  readonly epochId: string;

  constructor(epochId: string, options?: Readonly<{ readonly cause?: unknown }>) {
    super(
      `Active MCP epoch ${JSON.stringify(epochId)} is no longer available; the host session was invalidated.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'HostMcpEpochDriftError';
    this.epochId = epochId;
  }
}

interface HostMcpBinding {
  readonly serverName: string;
  readonly target?: string;
}

interface HostMcpEpochSession {
  closePromise?: Promise<void>;
  readonly epochId: string;
  inFlight: number;
  retired: boolean;
  readonly session: McpSession;
}

export interface HostMcpRoutesOptions {
  readonly adoption?: EpochAdoptionSource;
  readonly epochStore: EpochStore;
  readonly eventHub: ProjectEventHub;
  readonly mcpSessions: McpSessionService;
  readonly traceSessionId?: (devSession: string) => string;
  /** Resolves the Workbench host session owning a proxy process when the host did not forward `AGENT_BUNDLE_DEV_SESSION`. */
  readonly sessionForProcess?: (pid: number) => Promise<string | undefined>;
}

const requestSessionId = (request: IncomingMessage): string | undefined => {
  const value = request.headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : value;
};

const routeBinding = (requestTarget: string | undefined): HostMcpBinding | undefined => {
  const parsed = new URL(requestTarget ?? '/', 'http://127.0.0.1');
  if (!parsed.pathname.startsWith(hostMcpPathPrefix)) return undefined;
  const encodedName = parsed.pathname.slice(hostMcpPathPrefix.length);
  if (encodedName.length === 0 || encodedName.includes('/')) return undefined;
  const serverName = decodeURIComponent(encodedName);
  const targets = parsed.searchParams.getAll('target');
  if (serverName.trim().length === 0 || targets.length > 1) return undefined;
  const target = targets[0];
  if (target?.trim().length === 0 || [...parsed.searchParams.keys()].some((key) => key !== 'target')) return undefined;
  return Object.freeze({ serverName, ...(target === undefined ? {} : { target }) });
};

const isEpochDrift = (error: unknown): boolean =>
  error instanceof McpSessionStaleEpochError ||
  (error instanceof EpochStoreError &&
    (error.code === 'EPOCH_NOT_FOUND' || error.code === 'EPOCH_METADATA_INVALID'));

class HostMcpConnection {
  readonly #adoption: EpochAdoptionSource | undefined;
  readonly #binding: HostMcpBinding;
  readonly #devSession: string | undefined;
  readonly #epochStore: EpochStore;
  readonly #mcpSessions: McpSessionService;
  readonly #onSessionInitialized: (sessionId: string, connection: HostMcpConnection) => void;
  readonly #traceSessionId: (devSession: string) => string;
  readonly #epochSessions = new Set<HostMcpEpochSession>();
  readonly #server: Server;
  readonly transport: NodeStreamableHTTPServerTransport;
  #activeEpochSession: HostMcpEpochSession | undefined;
  #closed = false;
  #drift: HostMcpEpochDriftError | undefined;
  #failed = false;
  #failure: unknown;
  #lastEpochId: string | undefined;
  #transition = Promise.resolve();

  constructor(
    binding: HostMcpBinding,
    options: Pick<HostMcpRoutesOptions, 'adoption' | 'epochStore' | 'mcpSessions' | 'traceSessionId'> & {
      readonly devSession?: string;
    },
    onSessionInitialized: (sessionId: string, connection: HostMcpConnection) => void,
  ) {
    this.#adoption = options.adoption;
    this.#binding = binding;
    this.#devSession = options.devSession;
    this.#epochStore = options.epochStore;
    this.#mcpSessions = options.mcpSessions;
    this.#onSessionInitialized = onSessionInitialized;
    this.#traceSessionId = options.traceSessionId ?? ((id) => id);
    this.#server = new Server(
      { name: `agent-bundle-dev:${binding.serverName}`, version: '0.1.0' },
      {
        capabilities: {
          prompts: { listChanged: true },
          resources: { listChanged: true, subscribe: false },
          tools: { listChanged: true },
        },
      },
    );
    this.transport = new NodeStreamableHTTPServerTransport({
      onsessioninitialized: (sessionId) => this.#onSessionInitialized(sessionId, this),
      sessionIdGenerator: randomUUID,
    });
    this.#registerHandlers();
  }

  get binding(): HostMcpBinding {
    return this.#binding;
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async start(): Promise<void> {
    await this.#server.connect(this.transport);
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await this.transport.handleRequest(request, response);
  }

  refreshCatalog(epochId: string): void {
    this.#scheduleTransition(epochId, () => this.#swapEpoch(epochId));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#transition;
    await Promise.allSettled([
      ...[...this.#epochSessions].map((binding) => this.#closeEpochSession(binding)),
      this.#server.close(),
    ]);
  }

  #registerHandlers(): void {
    this.#server.setRequestHandler('tools/list', async () => ({
      tools: [...await this.#withActiveSession((session) => session.listTools())],
    }));
    this.#server.setRequestHandler('tools/call', async (request) =>
      this.#withActiveSession((session) => session.callTool({
        arguments: request.params.arguments ?? {},
        name: request.params.name,
      })));
    this.#server.setRequestHandler('resources/list', async () => ({
      resources: [...await this.#withActiveSession((session) => session.listResources())],
    }));
    this.#server.setRequestHandler('resources/templates/list', async () => ({
      resourceTemplates: [...await this.#withActiveSession((session) => session.listResourceTemplates())],
    }));
    this.#server.setRequestHandler('resources/read', async (request) => {
      const result = await this.#withActiveSession((session) => session.readResource({ uri: request.params.uri }));
      return { ...result, contents: [...result.contents] } as ReadResourceResult;
    });
    this.#server.setRequestHandler('prompts/list', async () => ({
      prompts: [...await this.#withActiveSession((session) => session.listPrompts())],
    }));
    this.#server.setRequestHandler('prompts/get', async (request) =>
      this.#withActiveSession((session) => session.getPrompt({
        ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
        name: request.params.name,
      })));
  }

  async #withActiveSession<Value>(operation: (session: McpSession) => Promise<Value>): Promise<Value> {
    const binding = await this.#activeSession();
    binding.inFlight += 1;
    try {
      const reference = await this.#epochStore.acquireEpochReference(binding.epochId);
      await reference.close();
      return await operation(binding.session);
    } catch (error) {
      if (!isEpochDrift(error)) throw error;
      throw this.#protocolDrift(this.#invalidate(binding.epochId, error));
    } finally {
      binding.inFlight -= 1;
      if (binding.retired && binding.inFlight === 0) {
        void this.#closeEpochSession(binding).catch(() => undefined);
      }
    }
  }

  async #activeSession(): Promise<HostMcpEpochSession> {
    await this.#transition;
    this.#assertUsable();
    if (this.#activeEpochSession === undefined) {
      this.#scheduleTransition(this.#lastEpochId ?? 'unknown', async () => {
        if (this.#activeEpochSession !== undefined) return;
        const adoptedEpochId = this.#adoption?.currentEpochId;
        if (this.#adoption !== undefined && adoptedEpochId === undefined) {
          throw new Error(
            '[AB7211] No development epoch has passed the contract matrix yet, so this host connection has nothing to serve; '
            + 'fix the reported contract violations and rebuild.',
          );
        }
        const reference = adoptedEpochId === undefined
          ? await this.#epochStore.acquireActiveEpochReference()
          : await this.#epochStore.acquireEpochReference(adoptedEpochId);
        this.#lastEpochId = reference.epoch.id;
        try {
          this.#activeEpochSession = await this.#openEpochSession(reference.epoch.id);
        } finally {
          await reference.close();
        }
      });
      await this.#transition;
      this.#assertUsable();
    }
    const binding = this.#activeEpochSession;
    if (binding === undefined) throw new Error('Host MCP epoch session did not initialize.');
    return binding;
  }

  async #openEpochSession(epochId: string): Promise<HostMcpEpochSession> {
    const target = this.#binding.target ?? await this.#targetFor(epochId);
    const devSession = this.#devSession;
    const session = await this.#mcpSessions.open({
      epochId,
      serverName: this.#binding.serverName,
      target,
      ...(devSession === undefined ? {} : { sessionId: () => this.#traceSessionId(devSession) }),
    });
    const binding: HostMcpEpochSession = {
      epochId,
      inFlight: 0,
      retired: false,
      session,
    };
    this.#epochSessions.add(binding);
    return binding;
  }

  async #swapEpoch(epochId: string): Promise<void> {
    if (this.#closed || this.#drift !== undefined || this.#failed) return;
    const current = this.#activeEpochSession;
    if (current?.epochId === epochId) return;
    const next = await this.#openEpochSession(epochId);
    try {
      await Promise.all([
        next.session.listTools(),
        next.session.listResources(),
        next.session.listResourceTemplates(),
        next.session.listPrompts(),
      ]);
      if (this.#closed) {
        await this.#closeEpochSession(next);
        return;
      }
      this.#lastEpochId = epochId;
      this.#activeEpochSession = next;
      if (current !== undefined) this.#retireEpochSession(current);
      await Promise.all([
        this.#server.sendToolListChanged(),
        this.#server.sendResourceListChanged(),
        this.#server.sendPromptListChanged(),
      ]);
    } catch (error) {
      await this.#closeEpochSession(next).catch(() => undefined);
      throw error;
    }
  }

  #scheduleTransition(epochId: string, transition: () => Promise<void>): void {
    this.#transition = this.#transition.then(transition).catch((error: unknown) => {
      if (isEpochDrift(error)) {
        this.#invalidate(epochId === 'unknown' ? this.#lastEpochId ?? epochId : epochId, error);
        return;
      }
      this.#fail(error);
    });
  }

  #retireEpochSession(binding: HostMcpEpochSession): void {
    binding.retired = true;
    if (this.#activeEpochSession === binding) this.#activeEpochSession = undefined;
    if (binding.inFlight === 0) void this.#closeEpochSession(binding).catch(() => undefined);
  }

  #closeEpochSession(binding: HostMcpEpochSession): Promise<void> {
    binding.closePromise ??= binding.session.close().finally(() => {
      this.#epochSessions.delete(binding);
    });
    return binding.closePromise;
  }

  async #targetFor(epochId: string): Promise<string> {
    const reference = await this.#epochStore.acquireEpochReference(epochId);
    try {
      const targets = Object.keys(reference.epoch.targetDigests).sort();
      const target = targets.includes('portable') ? 'portable' : targets[0];
      if (target === undefined) {
        throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active artifact epoch has no generated targets.');
      }
      return target;
    } finally {
      await reference.close();
    }
  }

  #invalidate(epochId: string, cause: unknown): HostMcpEpochDriftError {
    this.#drift ??= new HostMcpEpochDriftError(epochId, { cause });
    const failure = this.#drift;
    this.#activeEpochSession = undefined;
    for (const binding of this.#epochSessions) {
      void this.#closeEpochSession(binding).catch(() => undefined);
    }
    return failure;
  }

  #fail(cause: unknown): void {
    if (!this.#failed) this.#failure = cause;
    this.#failed = true;
    this.#activeEpochSession = undefined;
    for (const binding of this.#epochSessions) {
      void this.#closeEpochSession(binding).catch(() => undefined);
    }
  }

  #assertUsable(): void {
    if (this.#drift !== undefined) throw this.#protocolDrift(this.#drift);
    if (this.#failed) throw this.#failure;
    if (this.#closed) throw new Error('Host MCP connection is closed.');
  }

  #protocolDrift(error: HostMcpEpochDriftError): ProtocolError {
    return new ProtocolError(internalErrorCode, error.message, {
      code: error.code,
      epochId: error.epochId,
    });
  }
}

/** Stateful host-facing MCP transport whose handlers resolve the active artifact epoch per operation. */
export class HostMcpRoutes {
  readonly #adoption: EpochAdoptionSource | undefined;
  readonly #connections = new Set<HostMcpConnection>();
  readonly #epochStore: EpochStore;
  readonly #mcpSessions: McpSessionService;
  readonly #sessions = new Map<string, HostMcpConnection>();
  readonly #subscription: ProjectEventSubscription;
  readonly #sessionForProcess: HostMcpRoutesOptions['sessionForProcess'];
  readonly #traceSessionId: HostMcpRoutesOptions['traceSessionId'];
  #closed = false;

  constructor(options: HostMcpRoutesOptions) {
    this.#adoption = options.adoption;
    this.#epochStore = options.epochStore;
    this.#mcpSessions = options.mcpSessions;
    this.#sessionForProcess = options.sessionForProcess;
    this.#traceSessionId = options.traceSessionId;
    this.#subscription = subscribeToEpochAdoption(options.adoption, options.eventHub, (epochId) => {
      for (const connection of this.#connections) connection.refreshCatalog(epochId);
    });
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const binding = routeBinding(request.url);
    if (binding === undefined) return false;
    if (this.#closed) {
      response.writeHead(503).end();
      return true;
    }
    const sessionId = requestSessionId(request);
    if (sessionId !== undefined) {
      const connection = this.#sessions.get(sessionId);
      if (
        connection === undefined ||
        connection.binding.serverName !== binding.serverName ||
        connection.binding.target !== binding.target
      ) {
        response.writeHead(404).end();
        return true;
      }
      await connection.handle(request, response);
      if (request.method === 'DELETE') await this.#remove(connection);
      return true;
    }

    const pid = hostDevProcessId(request.headers);
    const devSession = hostDevSessionId(request.headers)
      ?? (pid === undefined ? undefined : await this.#sessionForProcess?.(pid));
    const connection = new HostMcpConnection(
      binding,
      {
        adoption: this.#adoption,
        epochStore: this.#epochStore,
        mcpSessions: this.#mcpSessions,
        ...(this.#traceSessionId === undefined ? {} : { traceSessionId: this.#traceSessionId }),
        ...(devSession === undefined ? {} : { devSession }),
      },
      (id, initialized) => this.#sessions.set(id, initialized),
    );
    this.#connections.add(connection);
    try {
      await connection.start();
      await connection.handle(request, response);
      if (connection.sessionId === undefined) await this.#remove(connection);
    } catch (error) {
      await this.#remove(connection);
      throw error;
    }
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription.unsubscribe();
    for (const connection of this.#connections) void this.#remove(connection);
  }

  async #remove(connection: HostMcpConnection): Promise<void> {
    this.#connections.delete(connection);
    if (connection.sessionId !== undefined) this.#sessions.delete(connection.sessionId);
    await connection.close();
  }
}
