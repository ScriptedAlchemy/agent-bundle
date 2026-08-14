import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type GetPromptResult,
  type Implementation,
  type Prompt,
  type Resource,
  type ResourceTemplateType,
  type ServerCapabilities,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, posix, resolve } from 'node:path';
import type { Stream } from 'node:stream';

import { createDefaultRegistry } from '../adapters/registry.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';
import { resolveMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { EpochStore, type EpochReference } from './epoch-store.ts';

const defaultTimeoutMs = 5_000;
const maxStderrBytes = 1_000_000;
const maxRetainedEvents = 512;
const maxRetainedFrames = 512;

type NativeTarget = 'portable' | 'codex' | 'claude';
type RawMcpFrame = Parameters<Transport['send']>[0];

interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout: number;
}

interface McpClient {
  callTool(
    params: { readonly arguments: Record<string, unknown>; readonly name: string },
    options?: RequestOptions,
  ): Promise<CallToolResult>;
  close(): Promise<void>;
  connect(transport: Transport, options?: RequestOptions): Promise<void>;
  getPrompt(
    params: { readonly arguments?: Record<string, string>; readonly name: string },
    options?: RequestOptions,
  ): Promise<GetPromptResult>;
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  listPrompts(params?: undefined, options?: RequestOptions): Promise<{ readonly prompts: readonly Prompt[] }>;
  listResources(params?: undefined, options?: RequestOptions): Promise<{ readonly resources: readonly Resource[] }>;
  listResourceTemplates(
    params?: undefined,
    options?: RequestOptions,
  ): Promise<{ readonly resourceTemplates: readonly ResourceTemplateType[] }>;
  listTools(params?: undefined, options?: RequestOptions): Promise<{ readonly tools: readonly Tool[] }>;
  readResource(params: { readonly uri: string }, options?: RequestOptions): Promise<{ readonly contents: readonly unknown[] }>;
}

interface StdioTransport extends Transport {
  readonly stderr: Stream | null;
}

interface StdioOptions {
  readonly args: string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Record<string, string>;
  readonly stderr: 'pipe';
}

interface RemoteTransportOptions {
  readonly headers?: Record<string, string>;
}

interface StdioManifestServer {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
}

interface RemoteManifestServer {
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: 'streamable-http' | 'sse';
  readonly url: string;
}

type ManifestServer = StdioManifestServer | RemoteManifestServer;

export interface McpSessionBinding {
  readonly epochId: string;
  readonly serverName: string;
  readonly target: string;
}

export interface OpenMcpSessionOptions extends McpSessionBinding {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
}

export interface McpSessionRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface McpSessionToolCallOptions extends McpSessionRequestOptions {
  readonly arguments: Record<string, unknown>;
  readonly name: string;
  /** A caller-chosen identifier used to cancel an in-flight tool call. */
  readonly requestId?: string;
}

export interface McpSessionPromptOptions extends McpSessionRequestOptions {
  readonly arguments?: Record<string, string>;
  readonly name: string;
}

export interface McpSessionResourceOptions extends McpSessionRequestOptions {
  readonly uri: string;
}

export interface McpSessionConnectionState {
  readonly capabilities: ServerCapabilities | undefined;
  readonly server: Implementation | undefined;
}

export interface McpSessionFrame {
  readonly direction: 'client' | 'server';
  /** The exact JSON-RPC object received from or sent to the SDK transport. */
  readonly message: RawMcpFrame;
  readonly sequence: number;
}

export type McpSessionEvent =
  | Readonly<{ readonly sequence: number; readonly text: string; readonly type: 'stderr' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'progress' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'logging' }>;

export interface McpSessionReplayOverflow {
  /** The caller's cursor falls before data that has been evicted from retention. */
  readonly afterSequence: number;
  /** A subsequent replay must begin after this sequence to be complete. */
  readonly droppedThroughSequence: number;
}

export interface McpSessionReplay {
  readonly events: readonly McpSessionEvent[];
  readonly frames: readonly McpSessionFrame[];
  readonly overflow?: McpSessionReplayOverflow;
}

export interface McpSessionServiceOptions {
  readonly createClient?: () => McpClient;
  readonly createSseTransport?: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly createStdioTransport?: (options: StdioOptions) => StdioTransport;
  readonly createStreamableHttpTransport?: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly epochStore: EpochStore;
  readonly projectRoot: string;
}

interface ResolvedSessionServer {
  readonly server: ManifestServer;
  readonly target: NativeTarget;
  readonly targetRoot: string;
}

interface ResolvedStdioLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
}

interface ResolvedRemoteLaunch {
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: 'streamable-http' | 'sse';
  readonly url: URL;
}

type ResolvedLaunch = ResolvedStdioLaunch | ResolvedRemoteLaunch;

interface StderrCapture {
  readonly exceeded: () => boolean;
  readonly output: () => string;
  readonly stop: () => void;
}

interface OpeningSession {
  readonly abort: AbortController;
  readonly done: Promise<void>;
  readonly finish: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item as string]));
};

const safeArtifactPath = (path: string): boolean =>
  path.length > 0 &&
  !isAbsolute(path) &&
  path === posix.normalize(path) &&
  path !== '..' &&
  !path.startsWith('../');

const manifestPath = (target: NativeTarget): string =>
  target === 'portable' ? 'mcp.json' : '.mcp.json';

const parseManifestServer = (value: unknown): ManifestServer | undefined => {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  if (value.type === 'stdio') {
    const env = stringRecord(value.env);
    if (
      typeof value.command !== 'string' ||
      (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== 'string'))) ||
      (value.cwd !== undefined && typeof value.cwd !== 'string') ||
      (value.env !== undefined && env === undefined)
    ) {
      return undefined;
    }
    return {
      args: value.args === undefined ? [] : [...value.args],
      command: value.command,
      ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
      ...(env === undefined ? {} : { env }),
      kind: 'stdio',
    };
  }

  const kind = value.type === 'http' ? 'streamable-http' : value.type;
  const headers = stringRecord(value.headers);
  if (
    (kind !== 'streamable-http' && kind !== 'sse') ||
    typeof value.url !== 'string' ||
    (value.headers !== undefined && headers === undefined)
  ) {
    return undefined;
  }
  return {
    ...(headers === undefined ? {} : { headers }),
    kind,
    url: value.url,
  };
};

const expandRemoteTokens = (
  value: string,
  target: NativeTarget,
  roots: { readonly pluginData: string; readonly pluginRoot: string; readonly workspaceRoot: string },
): string => {
  if (target === 'portable') {
    return value
      .replaceAll('${PLUGIN_ROOT}', roots.pluginRoot)
      .replaceAll('${PLUGIN_DATA}', roots.pluginData);
  }
  if (target === 'claude') {
    return value
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', roots.pluginRoot)
      .replaceAll('${CLAUDE_PLUGIN_DATA}', roots.pluginData)
      .replaceAll('${CLAUDE_PROJECT_DIR}', roots.workspaceRoot);
  }
  return value;
};

const resolveContained = (root: string, path: string): string =>
  isAbsolute(path) ? path : assertInside(root, resolve(root, path));

const requestOptions = (options: McpSessionRequestOptions | undefined): RequestOptions => {
  const timeout = options?.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('MCP session timeoutMs must be a positive finite number.');
  }
  return { ...(options?.signal === undefined ? {} : { signal: options.signal }), timeout };
};

const openingSession = (): OpeningSession => {
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  return Object.freeze({
    abort: new AbortController(),
    done,
    finish: () => resolveDone?.(),
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

const joinArtifact = (root: string, relativePath: string): string => {
  if (!safeArtifactPath(relativePath)) {
    throw new Error(`Unsafe artifact path ${JSON.stringify(relativePath)}.`);
  }
  return assertInside(root, resolve(root, relativePath));
};

class RecordingTransport implements Transport {
  readonly #inner: Transport;
  readonly #record: (direction: McpSessionFrame['direction'], message: RawMcpFrame) => void;
  #onclose: Transport['onclose'];
  #onerror: Transport['onerror'];
  #onmessage: Transport['onmessage'];

  constructor(inner: Transport, record: (direction: McpSessionFrame['direction'], message: RawMcpFrame) => void) {
    this.#inner = inner;
    this.#record = record;
    this.#inner.onclose = () => this.#onclose?.();
    this.#inner.onerror = (error) => this.#onerror?.(error);
    this.#inner.onmessage = ((message, extra) => {
      this.#record('server', message);
      this.#onmessage?.(message, extra);
    }) as Transport['onmessage'];
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.#inner.hasPerRequestStream;
  }

  get onclose(): Transport['onclose'] {
    return this.#onclose;
  }

  set onclose(next: Transport['onclose']) {
    this.#onclose = next;
  }

  get onerror(): Transport['onerror'] {
    return this.#onerror;
  }

  set onerror(next: Transport['onerror']) {
    this.#onerror = next;
  }

  get onmessage(): Transport['onmessage'] {
    return this.#onmessage;
  }

  set onmessage(next: Transport['onmessage']) {
    this.#onmessage = next;
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.#inner.setSupportedProtocolVersions?.(versions);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async send(message: RawMcpFrame, options?: Parameters<Transport['send']>[1]): Promise<void> {
    this.#record('client', message);
    await this.#inner.send(message, options);
  }

  async start(): Promise<void> {
    await this.#inner.start();
  }
}

/**
 * One MCP connection whose generated command, environment, data directory, and
 * artifact epoch are fixed when the session opens.
 */
export class McpSession {
  readonly #binding: McpSessionBinding;
  readonly #createClient: () => McpClient;
  readonly #createSseTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochReference: EpochReference;
  readonly #onClose: () => void;
  readonly #pluginData: string;
  readonly #resolved: ResolvedSessionServer;
  readonly #launch: ResolvedLaunch;
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
  #lifecycleTail: Promise<void> = Promise.resolve();
  #sequence = 0;
  #stderrOutput = '';
  #stderrOverflow = false;

  constructor(options: {
    readonly binding: McpSessionBinding;
    readonly createClient: () => McpClient;
    readonly createSseTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly createStdioTransport: (options: StdioOptions) => StdioTransport;
    readonly createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly epochReference: EpochReference;
    readonly onClose: () => void;
    readonly pluginData: string;
    readonly resolved: ResolvedSessionServer;
    readonly workspaceRoot: string;
  }) {
    this.#binding = Object.freeze({ ...options.binding });
    this.#createClient = options.createClient;
    this.#createSseTransport = options.createSseTransport;
    this.#createStdioTransport = options.createStdioTransport;
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport;
    this.#epochReference = options.epochReference;
    this.#onClose = options.onClose;
    this.#pluginData = options.pluginData;
    this.#resolved = options.resolved;
    this.#workspaceRoot = options.workspaceRoot;
    this.#launch = this.#resolveLaunch();
  }

  get binding(): McpSessionBinding {
    return this.#binding;
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

  stderr(): string {
    return this.#capture?.output() ?? this.#stderrOutput;
  }

  async initialize(options?: McpSessionRequestOptions): Promise<McpSessionConnectionState> {
    return this.#withLifecycle(async () => {
      this.#assertOpen();
      if (this.#connection === undefined) await this.#connect(options);
      this.#assertOpen();
      return this.connection;
    });
  }

  async listTools(options?: McpSessionRequestOptions): Promise<readonly Tool[]> {
    const listed = await this.#clientFor(options).listTools(undefined, requestOptions(options));
    return Object.freeze([...listed.tools]);
  }

  async listResources(options?: McpSessionRequestOptions): Promise<readonly Resource[]> {
    const listed = await this.#clientFor(options).listResources(undefined, requestOptions(options));
    return Object.freeze([...listed.resources]);
  }

  async listResourceTemplates(options?: McpSessionRequestOptions): Promise<readonly ResourceTemplateType[]> {
    const listed = await this.#clientFor(options).listResourceTemplates(undefined, requestOptions(options));
    return Object.freeze([...listed.resourceTemplates]);
  }

  async listPrompts(options?: McpSessionRequestOptions): Promise<readonly Prompt[]> {
    const listed = await this.#clientFor(options).listPrompts(undefined, requestOptions(options));
    return Object.freeze([...listed.prompts]);
  }

  async getPrompt(options: McpSessionPromptOptions): Promise<GetPromptResult> {
    return this.#clientFor(options).getPrompt({
      ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
      name: options.name,
    }, requestOptions(options));
  }

  async readResource(options: McpSessionResourceOptions): Promise<{ readonly contents: readonly unknown[] }> {
    return this.#clientFor(options).readResource({ uri: options.uri }, requestOptions(options));
  }

  async callTool(options: McpSessionToolCallOptions): Promise<CallToolResult> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('MCP session tool call was aborted.');
    }
    const requestId = options.requestId ?? randomUUID();
    if (requestId.trim().length === 0) throw new Error('MCP session requestId must be nonempty.');
    if (this.#requests.has(requestId)) throw new Error(`MCP session request ${JSON.stringify(requestId)} is already active.`);
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    this.#requests.set(requestId, controller);
    try {
      const result = await this.#clientFor(options).callTool({ arguments: options.arguments, name: options.name }, {
        signal: controller.signal,
        timeout: requestOptions(options).timeout,
      });
      this.#throwIfStderrExceeded();
      return result;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.#requests.delete(requestId);
    }
  }

  cancel(requestId: string): boolean {
    const controller = this.#requests.get(requestId);
    if (controller === undefined) return false;
    controller.abort(new Error(`MCP session request ${JSON.stringify(requestId)} was cancelled.`));
    return true;
  }

  async restart(options?: McpSessionRequestOptions): Promise<McpSessionConnectionState> {
    return this.#withLifecycle(async () => {
      this.#assertOpen();
      this.#cancelAll('MCP session restarted.');
      await this.#closeClient();
      this.#assertOpen();
      this.#connection = undefined;
      await this.#connect(options);
      this.#assertOpen();
      return this.connection;
    });
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#withLifecycle(() => this.#close());
    return this.#closePromise;
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

  async #withLifecycle<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#lifecycleTail;
    let release: (() => void) | undefined;
    this.#lifecycleTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  #clientFor(options?: McpSessionRequestOptions): McpClient {
    this.#assertOpen();
    if (this.#connection === undefined) {
      throw new Error('MCP session must initialize before protocol operations.');
    }
    this.#throwIfStderrExceeded();
    void options;
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
      await client.connect(recording, requestOptions(options));
      this.#throwIfStderrExceeded(capture);
      this.#assertOpen();
      this.#client = client;
      this.#capture = capture;
      this.#connection = Object.freeze({
        capabilities: client.getServerCapabilities(),
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
    const sequence = this.#nextSequence();
    this.#retain(this.#frames, Object.freeze({ direction, message, sequence }), maxRetainedFrames);
    const notification: unknown = message;
    if (direction !== 'server' || !isRecord(notification) || typeof notification.method !== 'string') return;
    if (notification.method === 'notifications/progress') {
      this.#retain(
        this.#events,
        Object.freeze({ payload: notification.params, sequence: this.#nextSequence(), type: 'progress' }),
        maxRetainedEvents,
      );
    } else if (notification.method === 'notifications/message') {
      this.#retain(
        this.#events,
        Object.freeze({ payload: notification.params, sequence: this.#nextSequence(), type: 'logging' }),
        maxRetainedEvents,
      );
    }
  }

  #recordStderr(text: string): void {
    this.#retain(this.#events, Object.freeze({ sequence: this.#nextSequence(), text, type: 'stderr' }), maxRetainedEvents);
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
    return this.#launch.kind === 'streamable-http'
      ? this.#createStreamableHttpTransport(this.#launch.url, { ...(headers === undefined ? {} : { headers }) })
      : this.#createSseTransport(this.#launch.url, { ...(headers === undefined ? {} : { headers }) });
  }

  #handleStderrOverflow(): void {
    this.#stderrOverflow = true;
    void this.close().catch(() => undefined);
  }

  #resolveLaunch(): ResolvedLaunch {
    const roots = {
      pluginData: this.#pluginData,
      pluginRoot: this.#resolved.targetRoot,
      workspaceRoot: this.#workspaceRoot,
    };
    if (this.#resolved.server.kind === 'stdio') {
      const resolved = resolveMcpPathTokens({
        adapter: createDefaultRegistry().get(this.#resolved.target),
        roots,
        server: this.#resolved.server,
      });
      const cwd = resolved.cwd === undefined ? undefined : resolveContained(this.#resolved.targetRoot, resolved.cwd);
      const args = resolved.args.map((argument) =>
        this.#resolved.target === 'codex' && argument.startsWith('./')
          ? resolveContained(this.#resolved.targetRoot, argument)
          : argument);
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      return Object.freeze({
        args: Object.freeze(args),
        command: resolved.command,
        ...(cwd === undefined ? {} : { cwd }),
        env: Object.freeze({ ...inheritedEnv, ...(resolved.env ?? {}) }),
        kind: 'stdio',
      });
    }

    const headers = this.#resolved.server.headers === undefined
      ? undefined
      : Object.freeze(Object.fromEntries(Object.entries(this.#resolved.server.headers).map(([key, value]) => [
          key,
          expandRemoteTokens(value, this.#resolved.target, roots),
        ])));
    return Object.freeze({
      ...(headers === undefined ? {} : { headers }),
      kind: this.#resolved.server.kind,
      url: new URL(expandRemoteTokens(this.#resolved.server.url, this.#resolved.target, roots)),
    });
  }
}

/** Owns persistent MCP sessions and releases every epoch reference on shutdown. */
export class McpSessionService {
  readonly #createClient: () => McpClient;
  readonly #createSseTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #epochStore: EpochStore;
  readonly #openingSessions = new Set<OpeningSession>();
  readonly #sessions = new Map<string, McpSession>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: McpSessionServiceOptions) {
    this.#createClient = options.createClient ?? (() => new Client({ name: 'agent-bundle', version: '0.1.0' }));
    this.#createSseTransport = options.createSseTransport ?? ((url, transportOptions) => new SSEClientTransport(url, {
      eventSourceInit: transportOptions.headers === undefined ? undefined : {
        fetch: (input, init) => fetch(input, {
          ...init,
          headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...transportOptions.headers }),
        }),
      },
      requestInit: transportOptions.headers === undefined ? undefined : { headers: transportOptions.headers },
    }));
    this.#createStdioTransport = options.createStdioTransport ?? ((stdioOptions) => new StdioClientTransport(stdioOptions));
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport ?? ((url, transportOptions) =>
      new StreamableHTTPClientTransport(url, {
        requestInit: transportOptions.headers === undefined ? undefined : { headers: transportOptions.headers },
      }));
    this.#epochStore = options.epochStore;
  }

  async open(options: OpenMcpSessionOptions): Promise<McpSession> {
    if (this.#closed) throw new Error('MCP session service is closed.');
    const opening = openingSession();
    this.#openingSessions.add(opening);
    const signal = options.signal === undefined
      ? opening.abort.signal
      : AbortSignal.any([options.signal, opening.abort.signal]);
    try {
      return await this.#open({ ...options, signal });
    } finally {
      this.#openingSessions.delete(opening);
      opening.finish();
    }
  }

  async #open(options: OpenMcpSessionOptions): Promise<McpSession> {
    const target = this.#target(options.target);
    if (options.serverName.trim().length === 0) throw new Error('MCP server name must be nonempty.');
    const epochReference = await this.#epochStore.acquireEpochReference(options.epochId);
    let pluginData: string | undefined;
    let session: McpSession | undefined;
    try {
      const epochRoot = epochReference.root;
      const diagnostics = await validateArtifact({ allowEpochStagingMarker: true, artifactRoot: epochRoot });
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      if (errors.length > 0) throw new DiagnosticError(errors);
      const targetRoot = joinArtifact(epochRoot, target);
      const server = await this.#server(epochRoot, target, options.serverName);
      pluginData = await mkdtemp(resolve(tmpdir(), 'agent-bundle-mcp-'));
      const sessionId = randomUUID();
      session = new McpSession({
        binding: { epochId: options.epochId, serverName: options.serverName, target },
        createClient: this.#createClient,
        createSseTransport: this.#createSseTransport,
        createStdioTransport: this.#createStdioTransport,
        createStreamableHttpTransport: this.#createStreamableHttpTransport,
        epochReference,
        onClose: () => this.#sessions.delete(sessionId),
        pluginData,
        resolved: { server, target, targetRoot },
        workspaceRoot: resolve(options.workspaceRoot ?? process.cwd()),
      });
      await session.initialize(options);
      if (this.#closed) throw new Error('MCP session service is closed.');
      this.#sessions.set(sessionId, session);
      return session;
    } catch (error) {
      if (session !== undefined) {
        await session.close();
      } else {
        try {
          if (pluginData !== undefined) await rm(pluginData, { force: true, recursive: true });
        } finally {
          await epochReference.close();
        }
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    const openings = [...this.#openingSessions];
    for (const opening of openings) opening.abort.abort(new Error('MCP session service is closed.'));
    await Promise.allSettled(openings.map((opening) => opening.done));
    await Promise.all([...this.#sessions.values()].map((session) => session.close()));
  }

  #target(name: string): NativeTarget {
    if (name === 'portable' || name === 'codex' || name === 'claude') return name;
    throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
  }

  async #server(epochRoot: string, target: NativeTarget, name: string): Promise<ManifestServer> {
    const path = joinArtifact(epochRoot, `${target}/${manifestPath(target)}`);
    let document: unknown;
    try {
      document = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`MCP manifest for target ${JSON.stringify(target)} is not valid JSON.`, { cause: error });
      }
      throw error;
    }
    if (!isRecord(document) || !isRecord(document.mcpServers) || !Object.hasOwn(document.mcpServers, name)) {
      throw new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(name)}.`);
    }
    const server = parseManifestServer(document.mcpServers[name]);
    if (server === undefined) {
      throw new Error(`MCP server ${JSON.stringify(name)} in target ${JSON.stringify(target)} is invalid.`);
    }
    return server;
  }
}
