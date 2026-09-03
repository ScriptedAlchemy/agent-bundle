import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  Resource,
  ResourceTemplateType,
  Tool,
  Transport,
} from '@modelcontextprotocol/client';
import { Effect, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { Stream } from 'node:stream';

import { isRecord, snapshotStrictJsonValue } from '../../core/strict-json.ts';
import { runPromise, runSync } from '../../effect/boundary.ts';
import { liftPromise, liftTry } from '../../effect/lift.ts';
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
    return this.#operation('callTool', () => runPromise(this.#callToolEffect(options)));
  }

  #callToolEffect(options: McpSessionToolCallOptions): Effect.Effect<CallToolResult, unknown> {
    return this.#assertEpochCurrentEffect().pipe(Effect.andThen(Effect.suspend(() => {
      if (options.signal?.aborted) {
        return Effect.fail(options.signal.reason ?? new Error('MCP session tool call was aborted.'));
      }
      const requestId = options.requestId ?? randomUUID();
      if (requestId.trim().length === 0) {
        return Effect.fail(new Error('MCP session requestId must be nonempty.'));
      }
      if (this.#requests.has(requestId)) {
        return Effect.fail(new Error(`MCP session request ${JSON.stringify(requestId)} is already active.`));
      }
      const controller = new AbortController();
      const onAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.#requests.set(requestId, controller);
      return Effect.gen({ self: this }, function* (this: McpSession) {
        const client = yield* liftTry(() => this.#clientFor());
        const result = yield* liftPromise(() => client.callTool({
          ...(options._meta === undefined ? {} : { _meta: options._meta }),
          arguments: options.arguments,
          name: options.name,
        }, {
          signal: controller.signal,
          timeout: requestOptions(options, this.#timeoutMs).timeout,
        }));
        yield* liftTry(() => {
          this.#throwIfStderrExceeded();
        });
        return result;
      }).pipe(
        Effect.catch((error) => this.#substituteStaleEpochFailure(error)),
        Effect.ensuring(Effect.sync(() => {
          options.signal?.removeEventListener('abort', onAbort);
          this.#requests.delete(requestId);
        })),
      );
    })));
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
        yield* step(() => rm(this.#pluginData, { force: true, recursive: true }));
        yield* step(() => this.#epochReference.close());
        this.#onClose();
        if (failures.length > 0) {
          return yield* Effect.fail(failures[failures.length - 1]);
        }
      });
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MCP session is closed.');
  }

  #assertOpenEffect(): Effect.Effect<void, Error> {
    return Effect.suspend(() => this.#closed
      ? Effect.fail(new Error('MCP session is closed.'))
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
    if (this.#connection === undefined) {
      throw new Error('MCP session must initialize before protocol operations.');
    }
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
