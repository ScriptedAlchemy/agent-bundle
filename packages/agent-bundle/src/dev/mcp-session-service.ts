import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { Stream } from 'node:stream';

import { createDefaultRegistry, TargetRegistry } from '../adapters/registry.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { serialQueue } from '../core/async.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { joinArtifact } from '../core/paths.ts';
import { isRecord, parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue } from '../core/strict-json.ts';
import {
  readTargetMcpServer,
  type ModernMcpServer,
  type TargetMcpRuntimeContract,
} from '../services/mcp-runtime.ts';
import { EpochStore, type EpochReference } from './epoch-store.ts';
import type {
  McpAppBridgeResource,
  McpAppBridgeSession,
  McpAppBridgeTool,
  McpAppJsonValue,
  McpAppSessionLease,
} from './mcp-app-binding-service.ts';
import type {
  McpSessionBinding,
  McpSessionId,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceListener,
  McpSessionTraceReplay,
  McpSessionTraceSubscription,
  McpSessionTraceSubscriptionOptions,
} from './mcp-session-protocol.ts';
import {
  mcpSessionInspectorConfig,
  resolveMcpSessionLaunch,
  type ResolvedMcpSessionLaunch,
  type ResolvedMcpSessionServer,
} from './mcp-session-launch.ts';
import { McpSessionTraceLog, type McpSessionTraceSink } from './mcp-session-trace.ts';
import { RecordingTransport } from './mcp-recording-transport.ts';
import {
  canonicalMcpAppJson,
  canonicalMcpAppResource,
  canonicalMcpAppTool,
  mcpAppClientCapabilities,
} from './mcp-session-apps.ts';

import {
  McpSessionServiceCloseError,
  type McpClient,
  type McpRequestOptions as RequestOptions,
  type McpSessionConnectionState,
  type McpSessionEvent,
  type McpSessionFrame,
  type McpSessionPromptOptions,
  type McpSessionReplay,
  type McpSessionRequestOptions,
  type McpSessionResourceOptions,
  type McpSessionServiceCloseFailure,
  type McpSessionServiceOptions,
  type McpSessionToolCallOptions,
  type OpenMcpSessionOptions,
  type RemoteTransportOptions,
  type StdioOptions,
  type StdioTransport,
} from './mcp-session-types.ts';

export { McpSessionServiceCloseError };
export { mcpAppClientCapabilities };
export type {
  McpSessionConnectionState,
  McpSessionEvent,
  McpSessionFrame,
  McpSessionPromptOptions,
  McpSessionReplay,
  McpSessionRequestOptions,
  McpSessionResourceOptions,
  McpSessionServiceCloseFailure,
  McpSessionServiceOptions,
  McpSessionToolCallOptions,
  OpenMcpSessionOptions,
} from './mcp-session-types.ts';
export type { McpSessionTraceSink } from './mcp-session-trace.ts';

export type {
  McpSessionBinding,
  McpSessionId,
  McpSessionInspectorConfig,
  McpSessionOperation,
  McpSessionReplayOverflow,
  McpSessionTraceEntry,
  McpSessionTraceListener,
  McpSessionTraceMessage,
  McpSessionTraceReplay,
  McpSessionTraceReplayGap,
  McpSessionTraceSubscription,
  McpSessionTraceSubscriptionOptions,
} from './mcp-session-protocol.ts';

const defaultTimeoutMs = 5_000;
const maxStderrBytes = 1_000_000;
const maxRetainedEvents = 512;
const maxRetainedFrames = 512;

type RawMcpFrame = Parameters<Transport['send']>[0];

interface StderrCapture {
  readonly exceeded: () => boolean;
  readonly output: () => string;
  readonly stop: () => void;
}

interface OpeningSession {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  readonly finish: (result: PromiseSettledResult<void>) => void;
}

type McpAppSessionCloseListener = Parameters<McpAppSessionLease['watchSessionClosed']>[0];

interface ActiveSession {
  readonly closeWatchers: Set<McpAppSessionCloseListener>;
  readonly session: McpSession;
  appLeaseCount: number;
  closed: boolean;
}

type McpAppLeaseIdentity = McpAppBridgeSession['identity'] & Readonly<{
  readonly binding: McpSessionBinding;
  readonly sessionId: McpSessionId;
}>;

const mcpAppLeaseIdentity = (session: McpSession): McpAppLeaseIdentity => {
  const identity: { readonly binding: McpSessionBinding; readonly sessionId: McpSessionId } = {
    binding: session.binding,
    sessionId: session.id,
  };
  Object.defineProperties(identity, {
    epochId: { value: session.binding.epochId },
    serverName: { value: session.binding.serverName },
    target: { value: session.binding.target },
  });
  return Object.freeze(identity) as McpAppLeaseIdentity;
};

const resolveTimeoutMs = (timeout: number): number => {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('MCP session timeoutMs must be a positive finite number.');
  }
  return timeout;
};

const requestOptions = (
  options: McpSessionRequestOptions | undefined,
  sessionTimeoutMs = defaultTimeoutMs,
): RequestOptions => {
  const timeout = resolveTimeoutMs(options?.timeoutMs ?? sessionTimeoutMs);
  return { ...(options?.signal === undefined ? {} : { signal: options.signal }), timeout };
};

const openingSession = (): OpeningSession => {
  const done = Promise.withResolvers<void>();
  void done.promise.catch(() => undefined);
  return Object.freeze({
    abort: new AbortController(),
    done: done.promise,
    finish: (result: PromiseSettledResult<void>) => {
      if (result.status === 'rejected') {
        done.reject(result.reason);
      } else {
        done.resolve();
      }
    },
  });
};

const captureStderr = (
  stream: Stream | null,
  onText: (text: string) => void,
  onOverflow: () => void,
): StderrCapture => {
  if (stream === null) {
    return { exceeded: () => false, output: () => '', stop: () => undefined };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes + buffer.byteLength > maxStderrBytes) {
      if (!overflow) {
        overflow = true;
        onOverflow();
      }
      return;
    }
    bytes += buffer.byteLength;
    chunks.push(buffer);
    onText(buffer.toString());
  };
  stream.on('data', onData);
  return {
    exceeded: () => overflow,
    output: () => Buffer.concat(chunks).toString(),
    stop: () => stream.off('data', onData),
  };
};


/**
 * One MCP connection whose generated command, environment, data directory, and
 * artifact epoch are fixed when the session opens.
 */
export class McpSession {
  readonly #binding: McpSessionBinding;
  readonly #createClient: () => McpClient;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochReference: EpochReference;
  readonly #id: McpSessionId;
  readonly #onClose: () => void;
  readonly #onClosing: () => void;
  readonly #pluginData: string;
  readonly #resolved: ResolvedMcpSessionServer;
  readonly #launch: ResolvedMcpSessionLaunch;
  readonly #timeoutMs: number;
  readonly #traceLog: McpSessionTraceLog;
  readonly #workspaceRoot: string;
  readonly #frames: McpSessionFrame[] = [];
  readonly #events: McpSessionEvent[] = [];
  readonly #requests = new Map<string, AbortController>();
  #capture: StderrCapture | undefined;
  #client: McpClient | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #connection: McpSessionConnectionState | undefined;
  #droppedThroughSequence = 0;
  readonly #lifecycle = serialQueue();
  #sequence = 0;
  #stderrOutput = '';
  #stderrOverflow = false;

  constructor(options: {
    readonly binding: McpSessionBinding;
    readonly createClient: () => McpClient;
    readonly createStdioTransport: (options: StdioOptions) => StdioTransport;
    readonly createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly epochReference: EpochReference;
    readonly id: McpSessionId;
    readonly onClose: () => void;
    readonly onClosing?: () => void;
    readonly pluginData: string;
    readonly resolved: ResolvedMcpSessionServer;
    readonly timeoutMs?: number;
    readonly traceSink?: McpSessionTraceSink;
    readonly workspaceRoot: string;
  }) {
    this.#binding = Object.freeze({ ...options.binding });
    this.#createClient = options.createClient;
    this.#createStdioTransport = options.createStdioTransport;
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport;
    this.#epochReference = options.epochReference;
    this.#id = options.id;
    this.#onClose = options.onClose;
    this.#onClosing = options.onClosing ?? (() => undefined);
    this.#pluginData = options.pluginData;
    this.#resolved = options.resolved;
    this.#timeoutMs = resolveTimeoutMs(options.timeoutMs ?? defaultTimeoutMs);
    this.#traceLog = new McpSessionTraceLog(this.#binding, options.traceSink);
    this.#workspaceRoot = options.workspaceRoot;
    this.#launch = resolveMcpSessionLaunch({
      pluginData: this.#pluginData,
      resolved: this.#resolved,
      workspaceRoot: this.#workspaceRoot,
    });
  }

  get binding(): McpSessionBinding {
    return this.#binding;
  }

  get id(): McpSessionId {
    return this.#id;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get connection(): McpSessionConnectionState {
    if (this.#connection === undefined) throw new Error('MCP session has not initialized.');
    return this.#connection;
  }

  frames(): readonly McpSessionFrame[] {
    return Object.freeze([...this.#frames]);
  }

  events(): readonly McpSessionEvent[] {
    return Object.freeze([...this.#events]);
  }

  replay(afterSequence = 0): McpSessionReplay {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('MCP session replay cursor must be a nonnegative safe integer.');
    }
    const overflow = afterSequence < this.#droppedThroughSequence
      ? Object.freeze({ afterSequence, droppedThroughSequence: this.#droppedThroughSequence })
      : undefined;
    return Object.freeze({
      events: Object.freeze(this.#events.filter((event) => event.sequence > afterSequence)),
      frames: Object.freeze(this.#frames.filter((frame) => frame.sequence > afterSequence)),
      ...(overflow === undefined ? {} : { overflow }),
    });
  }

  trace(afterSequence = 0): McpSessionTraceReplay {
    return this.#traceLog.replay(afterSequence);
  }

  subscribeTrace(
    options: McpSessionTraceSubscriptionOptions,
    listener: McpSessionTraceListener,
  ): McpSessionTraceSubscription {
    return this.#traceLog.subscribe(options, listener);
  }

  inspectorConfig(): McpSessionInspectorConfig {
    return mcpSessionInspectorConfig(this.#launch, this.#resolved.targetRoot);
  }

  stderr(): string {
    return this.#capture?.output() ?? this.#stderrOutput;
  }

  async initialize(options?: McpSessionRequestOptions): Promise<McpSessionConnectionState> {
    return this.#operation('initialize', () => this.#lifecycle.run(async () => {
      this.#assertOpen();
      if (this.#connection === undefined) await this.#connect(options);
      this.#assertOpen();
      return this.connection;
    }));
  }

  async listTools(options?: McpSessionRequestOptions): Promise<readonly Tool[]> {
    return this.#operation('listTools', async () => {
      const listed = await this.#clientFor().listTools(undefined, requestOptions(options, this.#timeoutMs));
      return Object.freeze([...listed.tools]);
    });
  }

  async listResources(options?: McpSessionRequestOptions): Promise<readonly Resource[]> {
    return this.#operation('listResources', async () => {
      const listed = await this.#clientFor().listResources(undefined, requestOptions(options, this.#timeoutMs));
      return Object.freeze([...listed.resources]);
    });
  }

  async listResourceTemplates(options?: McpSessionRequestOptions): Promise<readonly ResourceTemplateType[]> {
    return this.#operation('listResourceTemplates', async () => {
      const listed = await this.#clientFor().listResourceTemplates(undefined, requestOptions(options, this.#timeoutMs));
      return Object.freeze([...listed.resourceTemplates]);
    });
  }

  async listPrompts(options?: McpSessionRequestOptions): Promise<readonly Prompt[]> {
    return this.#operation('listPrompts', async () => {
      const listed = await this.#clientFor().listPrompts(undefined, requestOptions(options, this.#timeoutMs));
      return Object.freeze([...listed.prompts]);
    });
  }

  async getPrompt(options: McpSessionPromptOptions): Promise<GetPromptResult> {
    return this.#operation('getPrompt', () => this.#clientFor().getPrompt({
      ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
      name: options.name,
    }, requestOptions(options, this.#timeoutMs)));
  }

  async readResource(options: McpSessionResourceOptions): Promise<{ readonly contents: readonly unknown[] }> {
    return this.#operation('readResource', () =>
      this.#clientFor().readResource({ uri: options.uri }, requestOptions(options, this.#timeoutMs)));
  }

  async callTool(options: McpSessionToolCallOptions): Promise<CallToolResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('MCP session tool call was aborted.');
    }
    return this.#operation('callTool', async () => {
      const requestId = options.requestId ?? randomUUID();
      if (requestId.trim().length === 0) throw new Error('MCP session requestId must be nonempty.');
      if (this.#requests.has(requestId)) throw new Error(`MCP session request ${JSON.stringify(requestId)} is already active.`);
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#requests.set(requestId, controller);
      try {
        const result = await this.#clientFor().callTool({ arguments: options.arguments, name: options.name }, {
          signal: controller.signal,
          timeout: requestOptions(options, this.#timeoutMs).timeout,
        });
        this.#throwIfStderrExceeded();
        return result;
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
        this.#requests.delete(requestId);
      }
    });
  }

  cancel(requestId: string): boolean {
    this.#recordOperation('cancel', 'started');
    const controller = this.#requests.get(requestId);
    if (controller === undefined) {
      this.#recordOperation('cancel', 'failed');
      return false;
    }
    controller.abort(new Error(`MCP session request ${JSON.stringify(requestId)} was cancelled.`));
    this.#recordOperation('cancel', 'succeeded');
    return true;
  }

  async restart(options?: McpSessionRequestOptions): Promise<McpSessionConnectionState> {
    return this.#operation('restart', () => this.#lifecycle.run(async () => {
      this.#assertOpen();
      this.#cancelAll('MCP session restarted.');
      await this.#closeClient();
      this.#assertOpen();
      this.#connection = undefined;
      await this.#connect(options);
      this.#assertOpen();
      return this.connection;
    }));
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const closing = Promise.withResolvers<void>();
    this.#closePromise = closing.promise;
    try {
      this.#onClosing();
    } catch {
      // Lifecycle observers cannot prevent client, temporary-data, or epoch cleanup.
    }
    void this.#operation('close', () => this.#lifecycle.run(() => this.#close())).then(closing.resolve, closing.reject);
    return closing.promise;
  }

  async #close(): Promise<void> {
    this.#cancelAll('MCP session closed.');
    try {
      await this.#closeClient();
    } finally {
      try {
        await rm(this.#pluginData, { force: true, recursive: true });
      } finally {
        try {
          await this.#epochReference.close();
        } finally {
          this.#onClose();
        }
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MCP session is closed.');
  }

  async #operation<Result>(operation: McpSessionOperation, run: () => Promise<Result>): Promise<Result> {
    this.#recordOperation(operation, 'started');
    try {
      const result = await run();
      this.#recordOperation(operation, 'succeeded');
      return result;
    } catch (error) {
      this.#recordOperation(operation, 'failed');
      throw error;
    }
  }

  #clientFor(): McpClient {
    this.#assertOpen();
    if (this.#connection === undefined) {
      throw new Error('MCP session must initialize before protocol operations.');
    }
    this.#throwIfStderrExceeded();
    return this.#client!;
  }

  async #connect(options?: McpSessionRequestOptions): Promise<void> {
    const client = this.#createClient();
    let capture: StderrCapture | undefined;
    try {
      const transport = this.#transport((nextCapture) => {
        capture = nextCapture;
      });
      const recording = new RecordingTransport(transport, (direction, message) => this.#recordFrame(direction, message));
      await client.connect(recording, requestOptions(options, this.#timeoutMs));
      this.#throwIfStderrExceeded(capture);
      this.#assertOpen();
      this.#client = client;
      this.#capture = capture;
      this.#connection = Object.freeze({
        capabilities: client.getServerCapabilities(),
        protocolEra: client.getProtocolEra?.(),
        protocolVersion: client.getNegotiatedProtocolVersion?.(),
        server: client.getServerVersion(),
      });
    } catch (error) {
      try {
        await client.close();
      } finally {
        capture?.stop();
      }
      throw error;
    }
  }

  async #closeClient(): Promise<void> {
    const client = this.#client;
    const capture = this.#capture;
    this.#client = undefined;
    this.#capture = undefined;
    try {
      await client?.close();
    } finally {
      if (capture !== undefined) this.#stderrOutput = capture.output();
      capture?.stop();
    }
  }

  #cancelAll(reason: string): void {
    for (const controller of this.#requests.values()) controller.abort(new Error(reason));
  }

  #recordFrame(direction: McpSessionFrame['direction'], message: RawMcpFrame): void {
    const snapshot = snapshotStrictJsonValue(message);
    const sequence = this.#nextSequence();
    this.#retain(this.#frames, Object.freeze({ direction, message: snapshot, sequence }), maxRetainedFrames);
    this.#recordTrace(Object.freeze({
      direction,
      kind: 'frame',
      message: snapshot,
      occurredAt: Date.now(),
      sequence: this.#nextTraceSequence(),
    }));
    const notification: unknown = snapshot;
    if (direction !== 'server' || !isRecord(notification) || typeof notification.method !== 'string') return;
    if (notification.method === 'notifications/progress') {
      const event = Object.freeze({ payload: notification.params, sequence: this.#nextSequence(), type: 'progress' as const });
      this.#retain(
        this.#events,
        event,
        maxRetainedEvents,
      );
      this.#recordTrace(Object.freeze({
        kind: 'progress',
        occurredAt: Date.now(),
        payload: notification.params,
        sequence: this.#nextTraceSequence(),
      }));
    } else if (notification.method === 'notifications/message') {
      const event = Object.freeze({ payload: notification.params, sequence: this.#nextSequence(), type: 'logging' as const });
      this.#retain(
        this.#events,
        event,
        maxRetainedEvents,
      );
      this.#recordTrace(Object.freeze({
        kind: 'logging',
        occurredAt: Date.now(),
        payload: notification.params,
        sequence: this.#nextTraceSequence(),
      }));
    }
  }

  #recordStderr(text: string): void {
    const event = Object.freeze({ sequence: this.#nextSequence(), text, type: 'stderr' as const });
    this.#retain(this.#events, event, maxRetainedEvents);
    this.#recordTrace(Object.freeze({ kind: 'stderr', occurredAt: Date.now(), text, sequence: this.#nextTraceSequence() }));
  }

  #recordOperation(operation: McpSessionOperation, phase: 'started' | 'succeeded' | 'failed'): void {
    this.#recordTrace(Object.freeze({
      kind: 'operation',
      occurredAt: Date.now(),
      operation,
      phase,
      sequence: this.#nextTraceSequence(),
    }));
  }

  #recordTrace(entry: McpSessionTraceEntry): void {
    this.#traceLog.record(entry);
  }

  #retain<Entry extends { readonly sequence: number }>(entries: Entry[], entry: Entry, maximum: number): void {
    entries.push(entry);
    if (entries.length <= maximum) return;
    const dropped = entries.shift();
    if (dropped !== undefined) this.#droppedThroughSequence = Math.max(this.#droppedThroughSequence, dropped.sequence);
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #nextTraceSequence(): number {
    return this.#traceLog.nextSequence();
  }

  #throwIfStderrExceeded(capture = this.#capture): void {
    if (this.#stderrOverflow || capture?.exceeded()) throw new RangeError('MCP server stderr exceeds the 1 MB limit.');
  }

  #transport(setCapture: (capture: StderrCapture) => void): Transport {
    if (this.#launch.kind === 'stdio') {
      const transport = this.#createStdioTransport({
        args: [...this.#launch.args],
        command: this.#launch.command,
        ...(this.#launch.cwd === undefined ? {} : { cwd: this.#launch.cwd }),
        env: { ...this.#launch.env },
        stderr: 'pipe',
      });
      setCapture(captureStderr(
        transport.stderr,
        (text) => this.#recordStderr(text),
        () => this.#handleStderrOverflow(),
      ));
      return transport;
    }
    const headers = this.#launch.headers === undefined ? undefined : { ...this.#launch.headers };
    return this.#createStreamableHttpTransport(
      this.#launch.url,
      { ...(headers === undefined ? {} : { headers }) },
    );
  }

  #handleStderrOverflow(): void {
    this.#stderrOverflow = true;
    void this.close().catch(() => undefined);
  }

}

/** Owns persistent MCP sessions and releases every epoch reference on shutdown. */
export class McpSessionService {
  readonly #createClient: () => McpClient;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochStore: EpochStore;
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #traceSink: McpSessionTraceSink | undefined;
  readonly #openingSessions = new Set<OpeningSession>();
  readonly #sessions = new Map<string, ActiveSession>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: McpSessionServiceOptions) {
    if (!isAbsolute(options.projectRoot)) throw new Error('MCP session service project root must be absolute.');
    this.#createClient = options.createClient ??
      (() => new Client({ name: 'agent-bundle', version: '0.1.0' }, { capabilities: mcpAppClientCapabilities }));
    this.#createStdioTransport = options.createStdioTransport ?? ((stdioOptions) => new StdioClientTransport(stdioOptions));
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport ?? ((url, transportOptions) =>
      new StreamableHTTPClientTransport(url, {
        requestInit: transportOptions.headers === undefined ? undefined : { headers: transportOptions.headers },
      }));
    this.#epochStore = options.epochStore;
    this.#projectRoot = resolve(options.projectRoot);
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#traceSink = options.traceSink;
  }

  async open(options: OpenMcpSessionOptions): Promise<McpSession> {
    if (this.#closed) throw new Error('MCP session service is closed.');
    const timeoutMs = requestOptions(options).timeout;
    const opening = openingSession();
    this.#openingSessions.add(opening);
    const signal = options.signal === undefined
      ? opening.abort.signal
      : AbortSignal.any([options.signal, opening.abort.signal]);
    let cleanupFailed = false;
    let cleanupFailure: unknown;
    try {
      return await this.#open({ ...options, signal, timeoutMs }, (error) => {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupFailure = error;
        }
      });
    } finally {
      this.#openingSessions.delete(opening);
      opening.finish(cleanupFailed
        ? { reason: cleanupFailure, status: 'rejected' }
        : { status: 'fulfilled', value: undefined });
    }
  }

  async #open(
    options: OpenMcpSessionOptions,
    reportCleanupFailure: (error: unknown) => void,
  ): Promise<McpSession> {
    const target = options.target;
    const runtime = this.#runtime(target);
    if (options.serverName.trim().length === 0) throw new Error('MCP server name must be nonempty.');
    const epochReference = await this.#epochStore.acquireEpochReference(options.epochId);
    let pluginData: string | undefined;
    let session: McpSession | undefined;
    try {
      const epochRoot = epochReference.root;
      const diagnostics = await validateArtifact({
        allowEpochStagingMarker: true,
        artifactRoot: epochRoot,
        registry: this.#registry,
      });
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (errors.length > 0) throw new DiagnosticError(errors);
      const targetRoot = joinArtifact(epochRoot, target);
      const server = await this.#server(targetRoot, target, runtime, options.serverName);
      pluginData = await mkdtemp(resolve(tmpdir(), 'agent-bundle-mcp-'));
      const sessionId = randomUUID();
      session = new McpSession({
        binding: { epochId: options.epochId, serverName: options.serverName, target },
        createClient: this.#createClient,
        createStdioTransport: this.#createStdioTransport,
        createStreamableHttpTransport: this.#createStreamableHttpTransport,
        epochReference,
        id: sessionId,
        onClose: () => this.#invalidateSession(sessionId, new Error('MCP session closed.')),
        onClosing: () => this.#invalidateSession(sessionId, new Error('MCP session is closing.')),
        pluginData,
        resolved: { runtime, server, target, targetRoot },
        timeoutMs: options.timeoutMs,
        ...(this.#traceSink === undefined ? {} : { traceSink: this.#traceSink }),
        workspaceRoot: resolve(options.workspaceRoot ?? this.#projectRoot),
      });
      await session.initialize({ signal: options.signal });
      if (this.#closed) throw new Error('MCP session service is closed.');
      this.#sessions.set(sessionId, {
        appLeaseCount: 0,
        closeWatchers: new Set(),
        closed: false,
        session,
      });
      return session;
    } catch (error) {
      if (session !== undefined) {
        try {
          await session.close();
        } catch (cleanupError) {
          reportCleanupFailure(cleanupError);
          throw cleanupError;
        }
      } else {
        const cleanupFailures: unknown[] = [];
        try {
          if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        try {
          await epochReference.close();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        for (const failure of cleanupFailures) reportCleanupFailure(failure);
        if (cleanupFailures.length > 0) throw cleanupFailures[cleanupFailures.length - 1];
      }
      throw error;
    }
  }

  get(id: McpSessionId): McpSession | undefined {
    const entry = this.#sessions.get(id);
    return entry?.closed === false ? entry.session : undefined;
  }

  async acquireAppLease(sessionId: string): Promise<McpAppSessionLease> {
    const entry = this.#sessions.get(sessionId);
    if (entry === undefined || entry.closed) throw new Error(`Unknown MCP App session ${JSON.stringify(sessionId)}.`);
    entry.appLeaseCount += 1;
    const identity = mcpAppLeaseIdentity(entry.session);
    let bridgeResources: Promise<readonly McpAppBridgeResource[]> | undefined;
    let bridgeTools: Promise<readonly McpAppBridgeTool[]> | undefined;
    let released = false;
    const assertActive = (): void => {
      if (entry.closed) throw new Error('MCP App session is closed.');
    };
    const bridgeSession: McpAppBridgeSession = Object.freeze({
      callTool: async ({ arguments: toolArguments, name }: {
        readonly arguments: McpAppJsonValue | undefined;
        readonly name: string;
      }) => {
        assertActive();
        const argumentsSnapshot = canonicalMcpAppJson(toolArguments ?? {}, 'MCP App tool arguments');
        if (!isRecord(argumentsSnapshot)) throw new TypeError('MCP App tool arguments must be a JSON object.');
        const result = await entry.session.callTool({ arguments: argumentsSnapshot, name });
        assertActive();
        return canonicalMcpAppJson(
          result,
          'MCP App tool result',
        );
      },
      identity,
      listBridgeResources: async () => {
        assertActive();
        bridgeResources ??= entry.session.listResources().then((resources) =>
          Object.freeze(resources.map(canonicalMcpAppResource)));
        const resources = await bridgeResources;
        assertActive();
        return resources;
      },
      listBridgeTools: async () => {
        assertActive();
        bridgeTools ??= entry.session.listTools().then((tools) => Object.freeze(tools.map(canonicalMcpAppTool)));
        const tools = await bridgeTools;
        assertActive();
        return tools;
      },
      readResource: async ({ uri }: { readonly uri: string }) => {
        assertActive();
        const result = await entry.session.readResource({ uri });
        assertActive();
        return canonicalMcpAppJson(result, 'MCP App resource result');
      },
    });
    return Object.freeze({
      release: async () => {
        if (released) return;
        released = true;
        entry.appLeaseCount = Math.max(0, entry.appLeaseCount - 1);
      },
      session: bridgeSession,
      watchSessionClosed: (listener: McpAppSessionCloseListener) => {
        if (typeof listener !== 'function') throw new TypeError('MCP App session close listener must be a function.');
        if (entry.closed) return Object.freeze({ closed: true, unsubscribe: () => undefined });
        entry.closeWatchers.add(listener);
        let subscribed = true;
        return Object.freeze({
          closed: false,
          unsubscribe: () => {
            if (!subscribed) return;
            subscribed = false;
            entry.closeWatchers.delete(listener);
          },
        });
      },
    });
  }

  async closeSession(id: McpSessionId): Promise<boolean> {
    const entry = this.#invalidateSession(id, new Error('MCP session control closed.'));
    if (entry === undefined) return false;
    await entry.session.close();
    return true;
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const sessions = [...this.#sessions.entries()].flatMap(([id]) => {
      const entry = this.#invalidateSession(id, new Error('MCP session service is closed.'));
      return entry === undefined ? [] : [[id, entry.session] as const];
    });
    this.#closePromise = this.#close(sessions);
    return this.#closePromise;
  }

  async #close(sessions: readonly (readonly [string, McpSession])[]): Promise<void> {
    const openings = [...this.#openingSessions];
    for (const opening of openings) opening.abort.abort(new Error('MCP session service is closed.'));
    const openingResults = await Promise.allSettled(openings.map((opening) => opening.done));
    const sessionResults = await Promise.allSettled(sessions.map(([, session]) => session.close()));
    const failures = Object.freeze([
      ...openingResults.flatMap((result): readonly McpSessionServiceCloseFailure[] =>
        result.status === 'rejected'
          ? [Object.freeze({ error: result.reason, resource: 'opening' as const })]
          : []),
      ...sessionResults.flatMap((result, index): readonly McpSessionServiceCloseFailure[] => {
        const sessionId = sessions[index]?.[0];
        return result.status === 'rejected' && sessionId !== undefined
          ? [Object.freeze({ error: result.reason, resource: 'session' as const, sessionId })]
          : [];
      }),
    ]);
    if (failures.length > 0) throw new McpSessionServiceCloseError(failures);
  }

  #invalidateSession(id: string, reason: unknown): ActiveSession | undefined {
    const entry = this.#sessions.get(id);
    if (entry === undefined || entry.closed) return undefined;
    entry.closed = true;
    this.#sessions.delete(id);
    const watchers = [...entry.closeWatchers];
    entry.closeWatchers.clear();
    for (const watcher of watchers) {
      try {
        void Promise.resolve(watcher(reason)).catch(() => undefined);
      } catch {
        // App cleanup callbacks cannot interfere with the control session's shutdown.
      }
    }
    return entry;
  }

  #runtime(name: string): TargetMcpRuntimeContract {
    if (!this.#registry.has(name) || !this.#registry.supports(name, 'mcp')) {
      throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    }
    const runtime = this.#registry.mcpRuntime(name);
    if (runtime === undefined) throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    return runtime;
  }

  async #server(
    targetRoot: string,
    target: string,
    runtime: TargetMcpRuntimeContract,
    name: string,
  ): Promise<ModernMcpServer> {
    const path = joinArtifact(targetRoot, runtime.manifestPath);
    let document: unknown;
    try {
      document = parseJsonWithoutDuplicateKeys(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`MCP manifest for target ${JSON.stringify(target)} is not valid JSON.`, { cause: error });
      }
      throw error;
    }
    const result = readTargetMcpServer(runtime, document, name);
    if (result.status === 'missing') {
      throw new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(name)}.`);
    }
    if (result.status === 'invalid') {
      throw new Error(`MCP server ${JSON.stringify(name)} in target ${JSON.stringify(target)} is invalid.`);
    }
    return result.server;
  }
}
