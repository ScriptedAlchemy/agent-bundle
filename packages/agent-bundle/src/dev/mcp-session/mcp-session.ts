import {
  specTypeSchemas,
  type CallToolResult,
  type CancelTaskResult,
  type CreateTaskResult,
  type GetPromptResult,
  type GetTaskResult,
  type ListTasksResult,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
  type StandardSchemaV1,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { Effect, FileSystem, type Scope, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import type { Stream } from 'node:stream';

import { isRecord, snapshotStrictJsonValue } from '../../core/strict-json.ts';
import { runPromise, runSync } from '../../effect/boundary.ts';
import { liftPromise, liftTry } from '../../effect/lift.ts';
import { runWithPlatform } from '../../effect/platform.ts';
import type { EpochReference } from '../epoch-store.ts';
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
  McpSessionError,
  McpSessionStaleEpochError,
  type McpClient,
  type McpRequestOptions as RequestOptions,
  type McpSessionConnectionState,
  type McpSessionEvent,
  type McpSessionFrame,
  type McpSessionPromptOptions,
  type McpSessionReplay,
  type McpSessionRequestOptions,
  type McpSessionResourceOptions,
  type McpSessionTaskCallOptions,
  type McpSessionTaskListOptions,
  type McpSessionTaskOptions,
  type McpSessionToolCallOptions,
  type RemoteTransportOptions,
  type StdioOptions,
  type StdioTransport,
} from './mcp-session-types.ts';

// A session request can legitimately sit behind an rsbuild compile or Chrome
// startup on a two-core machine; a five-second ceiling manufactured request
// timeouts there. Thirty seconds stays interactive while remaining well under
// the MCP SDK's own sixty-second default.
const defaultTimeoutMs = 30_000;
const maxStderrBytes = 1_000_000;
const maxRetainedEvents = 512;
const maxRetainedFrames = 512;

type RawMcpFrame = Parameters<Transport['send']>[0];

interface StderrCapture {
  readonly exceeded: () => boolean;
  readonly output: () => string;
  readonly stop: () => void;
}

/** The server notification methods surfaced as session events, by event kind. */
const notificationEventKinds: Readonly<Record<string, 'logging' | 'progress' | undefined>> = Object.freeze({
  'notifications/message': 'logging',
  'notifications/progress': 'progress',
});

const resolveTimeoutMs = (timeout: number): number => {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('MCP session timeoutMs must be a positive finite number.');
  }
  return timeout;
};

export const requestOptions = (
  options: McpSessionRequestOptions | undefined,
  sessionTimeoutMs = defaultTimeoutMs,
): RequestOptions => {
  const timeout = resolveTimeoutMs(options?.timeoutMs ?? sessionTimeoutMs);
  return { ...(options?.signal === undefined ? {} : { signal: options.signal }), timeout };
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
  readonly #assertEpochAvailable: (() => Promise<void>) | undefined;
  readonly #binding: McpSessionBinding;
  readonly #createClient: () => McpClient;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochReference: EpochReference;
  readonly #id: McpSessionId;
  readonly #onClose: () => void;
  readonly #onClosing: () => void;
  readonly #pluginData: string;
  readonly #releasePluginData: () => Promise<void>;
  readonly #resolved: ResolvedMcpSessionServer;
  readonly #launch: ResolvedMcpSessionLaunch;
  readonly #timeoutMs: number;
  readonly #traceLog: McpSessionTraceLog;
  readonly #workspaceRoot: string;
  readonly #frames: McpSessionFrame[] = [];
  readonly #events: McpSessionEvent[] = [];
  /**
   * In-flight tool calls by `requestId`. Each controller is owned by its
   * request's scope (see {@link #admitRequest}); `cancel()` and `#cancelAll`
   * abort it with their reason and the SDK decides how the call rejects.
   */
  readonly #requests = new Map<string, AbortController>();
  #capture: StderrCapture | undefined;
  #client: McpClient | undefined;
  #staleEpochFailure: McpSessionStaleEpochError | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #connection: McpSessionConnectionState | undefined;
  #droppedThroughSequence = 0;
  /** Serializes initialize / restart / close. */
  readonly #lifecycle: Semaphore.Semaphore = runSync(Semaphore.make(1));
  #sequence = 0;
  #stderrOutput = '';
  #stderrOverflow = false;

  constructor(options: {
    /** Fail-closed probe that the session's pinned epoch still exists in its store. */
    readonly assertEpochAvailable?: () => Promise<void>;
    readonly binding: McpSessionBinding;
    readonly createClient: () => McpClient;
    readonly createStdioTransport: (options: StdioOptions) => StdioTransport;
    readonly createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly epochReference: EpochReference;
    readonly id: McpSessionId;
    readonly onClose: () => void;
    readonly onClosing?: () => void;
    readonly pluginData: string;
    /**
     * Releases `pluginData` on close; the service passes the close of its
     * session-lifetime scope. Default: remove the directory.
     */
    readonly releasePluginData?: () => Promise<void>;
    readonly resolved: ResolvedMcpSessionServer;
    readonly timeoutMs?: number;
    readonly traceSink?: McpSessionTraceSink;
    readonly workspaceRoot: string;
  }) {
    this.#assertEpochAvailable = options.assertEpochAvailable;
    this.#binding = Object.freeze({ ...options.binding });
    this.#createClient = options.createClient;
    this.#createStdioTransport = options.createStdioTransport;
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport;
    this.#epochReference = options.epochReference;
    this.#id = options.id;
    this.#onClose = options.onClose;
    this.#onClosing = options.onClosing ?? (() => undefined);
    this.#pluginData = options.pluginData;
    this.#releasePluginData = options.releasePluginData ?? (() => runWithPlatform(Effect.flatMap(
      FileSystem.FileSystem,
      (fs) => fs.remove(this.#pluginData, { force: true, recursive: true }),
    )));
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
    return this.#operation('initialize', () => runPromise(this.#lifecycle.withPermit(
      Effect.gen({ self: this }, function* (this: McpSession) {
        yield* this.#assertOpenEffect();
        if (this.#connection === undefined) yield* this.#connectEffect(options);
        yield* this.#assertOpenEffect();
        return this.connection;
      }),
    )));
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
    return this.#operation('callTool', () => runPromise(this.#callToolEffect(options, (client, params, wire) => client.callTool(params, wire))));
  }

  /**
   * A task-augmented `tools/call` (#369): the same request slot and
   * cancellation as `callTool`, but the request carries `params.task` and the
   * server answers with the `CreateTaskResult` handle. The call is outside the
   * SDK's typed `callTool`, so it goes through `request()` with the SDK's own
   * result schema.
   */
  async callToolTask(options: McpSessionTaskCallOptions): Promise<CreateTaskResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('MCP session tool call was aborted.');
    }
    return this.#operation('callToolTask', () => runPromise(this.#callToolEffect(options, (client, params, wire) => {
      if (client.request === undefined) throw new TypeError('MCP session client cannot issue a task-augmented tools/call: it has no request() method.');
      return client.request({ method: 'tools/call', params: { ...params, task: { ...options.task } } }, specTypeSchemas.CreateTaskResult, wire);
    })));
  }

  /** `tasks/get`: the status, progress, and retention of one task this session created. */
  async getTask(options: McpSessionTaskOptions): Promise<GetTaskResult> {
    return this.#operation('getTask', () => this.#taskRequest(
      { method: 'tasks/get', params: { taskId: options.taskId } },
      specTypeSchemas.GetTaskResult,
      options,
    ));
  }

  /** `tasks/result`: the final `CallToolResult`, blocking until the task settles (bounded by the request timeout). */
  async getTaskResult(options: McpSessionTaskOptions): Promise<CallToolResult> {
    return this.#operation('getTaskResult', () => this.#taskRequest(
      { method: 'tasks/result', params: { taskId: options.taskId } },
      specTypeSchemas.CallToolResult,
      options,
    ));
  }

  /** `tasks/cancel`: interrupts the task's render; the server answers with the cancelled task. */
  async cancelTask(options: McpSessionTaskOptions): Promise<CancelTaskResult> {
    return this.#operation('cancelTask', () => this.#taskRequest(
      { method: 'tasks/cancel', params: { taskId: options.taskId } },
      specTypeSchemas.CancelTaskResult,
      options,
    ));
  }

  /** `tasks/list`: every task the server still retains for this session. */
  async listTasks(options: McpSessionTaskListOptions = {}): Promise<ListTasksResult> {
    return this.#operation('listTasks', () => this.#taskRequest(
      { method: 'tasks/list', params: options.cursor === undefined ? {} : { cursor: options.cursor } },
      specTypeSchemas.ListTasksResult,
      options,
    ));
  }

  /** The SDK request path task methods take: outside the typed surface, validated by the SDK result schema. */
  async #taskRequest<T extends StandardSchemaV1>(
    request: { readonly method: string; readonly params?: Record<string, unknown> },
    resultSchema: T,
    options: McpSessionRequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>> {
    const client = this.#clientFor();
    if (client.request === undefined) throw new TypeError(`MCP session client cannot issue ${request.method}: it has no request() method.`);
    return client.request(request, resultSchema, requestOptions(options, this.#timeoutMs));
  }

  /**
   * One tool call as a scoped Effect. The request slot is the scoped
   * resource: `acquireRelease` admits the `requestId` (failing closed on a
   * duplicate) and owns its `AbortController`; release aborts the controller
   * and frees the slot, so an interrupted fiber can no longer leak a live SDK
   * request. `cancel()` and `#cancelAll` abort the same controller with their
   * reason, and the host signal is composed in with `AbortSignal.any`, so the
   * SDK still decides how an aborted request rejects — exactly as before.
   *
   * `scopedAbortSignal` (`Effect.abortSignal`) is the same
   * `acquireRelease(new AbortController, abort)` shape, but it exposes only
   * the signal and aborts without a reason; this contract needs both.
   */
  #callToolEffect<Result>(
    options: McpSessionToolCallOptions,
    send: (
      client: McpClient,
      params: { readonly _meta?: McpSessionToolCallOptions['_meta']; readonly arguments: Record<string, unknown>; readonly name: string },
      wire: RequestOptions,
    ) => Promise<Result>,
  ): Effect.Effect<Result, unknown> {
    return this.#assertEpochCurrentEffect().pipe(Effect.andThen(Effect.suspend(() => {
      if (options.signal?.aborted) {
        return Effect.fail(options.signal.reason ?? new Error('MCP session tool call was aborted.'));
      }
      const requestId = options.requestId ?? randomUUID();
      if (requestId.trim().length === 0) {
        return Effect.fail(McpSessionError.invalidRequestId());
      }
      const call = Effect.gen({ self: this }, function* (this: McpSession) {
        const controller = yield* this.#admitRequest(requestId);
        const client = yield* liftTry(() => this.#clientFor());
        const result = yield* liftPromise(() => send(client, {
          ...(options._meta === undefined ? {} : { _meta: options._meta }),
          arguments: options.arguments,
          name: options.name,
        }, {
          signal: options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]),
          timeout: requestOptions(options, this.#timeoutMs).timeout,
        }));
        yield* liftTry(() => {
          this.#throwIfStderrExceeded();
        });
        return result;
      });
      return Effect.scoped(call).pipe(
        Effect.catch((error) => this.#substituteStaleEpochFailure(error)),
      );
    })));
  }

  /**
   * Admits one in-flight request as a scoped resource. Acquire fails closed
   * when the `requestId` is already active; release aborts the request's
   * controller (a no-op once the SDK call settled) and frees the slot.
   */
  #admitRequest(requestId: string): Effect.Effect<AbortController, McpSessionError, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.suspend(() => {
        if (this.#requests.has(requestId)) return Effect.fail(McpSessionError.duplicateRequestId(requestId));
        const controller = new AbortController();
        this.#requests.set(requestId, controller);
        return Effect.succeed(controller);
      }),
      (controller) => Effect.sync(() => {
        this.#requests.delete(requestId);
        controller.abort();
      }),
    );
  }

  /**
   * A call that failed while the epoch vanished mid-flight reports the
   * stale epoch, not the incidental abort or timeout it produced.
   */
  #substituteStaleEpochFailure(error: unknown): Effect.Effect<never, unknown> {
    return Effect.suspend(() => {
      const probe = this.#assertEpochAvailable;
      if (this.#staleEpochFailure !== undefined || this.#closed || probe === undefined) {
        return Effect.fail(this.#staleEpochFailure ?? error);
      }
      return liftPromise(() => probe()).pipe(
        Effect.catch((cause) => Effect.sync(() => {
          this.#failStaleEpoch(cause);
        })),
        Effect.andThen(Effect.suspend(() => Effect.fail(this.#staleEpochFailure ?? error))),
      );
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
    return this.#operation('restart', () => runPromise(this.#lifecycle.withPermit(
      Effect.gen({ self: this }, function* (this: McpSession) {
        yield* this.#assertOpenEffect();
        this.#cancelAll('MCP session restarted.');
        yield* liftPromise(() => this.#closeClient());
        yield* this.#assertOpenEffect();
        this.#connection = undefined;
        yield* this.#connectEffect(options);
        yield* this.#assertOpenEffect();
        return this.connection;
      }),
    )));
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
    void this.#operation('close', () => runPromise(this.#lifecycle.withPermit(this.#closeEffect())))
      .then(closing.resolve, closing.reject);
    return closing.promise;
  }

  /**
   * Session teardown as one Effect. Every release step always runs, in
   * order — drain the client, remove plugin data, release the epoch lease,
   * notify the owner — and the last failing step's error is re-raised once
   * every resource has been visited (last-failure-wins).
   */
  #closeEffect(): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const failures: unknown[] = [];
      const step = (release: () => Promise<void>): Effect.Effect<void> =>
        liftPromise(release).pipe(
          Effect.catch((error) => Effect.sync(() => {
            failures.push(error);
          })),
          Effect.asVoid,
        );
      return Effect.gen({ self: this }, function* (this: McpSession) {
        this.#cancelAll('MCP session closed.');
        yield* step(() => this.#closeClient());
        yield* step(this.#releasePluginData);
        yield* step(() => this.#epochReference.close());
        this.#onClose();
        if (failures.length > 0) {
          return yield* Effect.fail(failures[failures.length - 1]);
        }
      });
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw McpSessionError.closed();
  }

  #assertOpenEffect(): Effect.Effect<void, McpSessionError> {
    return Effect.suspend(() => this.#closed
      ? Effect.fail(McpSessionError.closed())
      : Effect.void);
  }

  /**
   * Fails a tool call closed when the pinned epoch no longer exists — the
   * project changed underneath the session (often another process's build
   * retention, which cannot observe this process's epoch leases). Discovery
   * cancels every in-flight request with the same typed failure and closes
   * the session, mirroring the stderr-overflow contract. The #134 contract
   * rides the typed error channel as `McpSessionStaleEpochError`.
   */
  #assertEpochCurrentEffect(): Effect.Effect<void, McpSessionStaleEpochError> {
    return Effect.suspend(() => {
      if (this.#staleEpochFailure !== undefined) return Effect.fail(this.#staleEpochFailure);
      const probe = this.#assertEpochAvailable;
      if (probe === undefined) return Effect.void;
      return liftPromise(() => probe()).pipe(
        Effect.catch((cause) => Effect.fail(this.#failStaleEpoch(cause))),
        Effect.asVoid,
      );
    });
  }

  #failStaleEpoch(cause: unknown): McpSessionStaleEpochError {
    this.#staleEpochFailure ??= new McpSessionStaleEpochError(this.#binding.epochId, { cause });
    const failure = this.#staleEpochFailure;
    this.#cancelAll(failure.message);
    void this.close().catch(() => undefined);
    return failure;
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
    if (this.#connection === undefined) throw McpSessionError.notInitialized();
    this.#throwIfStderrExceeded();
    return this.#client!;
  }

  #connectEffect(options?: McpSessionRequestOptions): Effect.Effect<void, unknown> {
    return Effect.suspend(() => {
      const client = this.#createClient();
      const connectState: { capture?: StderrCapture } = {};
      return Effect.gen({ self: this }, function* (this: McpSession) {
        const recording = yield* liftTry(() => {
          const transport = this.#transport((nextCapture) => {
            connectState.capture = nextCapture;
          });
          return new RecordingTransport(transport, (direction, message) => this.#recordFrame(direction, message));
        });
        yield* liftPromise(() => client.connect(recording, requestOptions(options, this.#timeoutMs)));
        yield* liftTry(() => {
          this.#throwIfStderrExceeded(connectState.capture);
          this.#assertOpen();
          this.#client = client;
          this.#capture = connectState.capture;
          this.#connection = Object.freeze({
            capabilities: client.getServerCapabilities(),
            protocolEra: client.getProtocolEra?.(),
            protocolVersion: client.getNegotiatedProtocolVersion?.(),
            server: client.getServerVersion(),
          });
        });
      }).pipe(
        // A failed connect drains the replacement client and stops its
        // stderr capture before the failure re-raises; a cleanup failure
        // replaces the original error.
        Effect.catch((error) => liftPromise(async () => {
          try {
            await client.close();
          } finally {
            connectState.capture?.stop();
          }
        }).pipe(Effect.andThen(Effect.fail(error)))),
      );
    });
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
    const kind = notificationEventKinds[notification.method];
    if (kind === undefined) return;
    this.#retain(
      this.#events,
      Object.freeze({ payload: notification.params, sequence: this.#nextSequence(), type: kind }),
      maxRetainedEvents,
    );
    this.#recordTrace(Object.freeze({
      kind,
      occurredAt: Date.now(),
      payload: notification.params,
      sequence: this.#nextTraceSequence(),
    }));
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
