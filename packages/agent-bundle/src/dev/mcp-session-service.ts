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
import { freezeJsonValue } from './types.ts';
import type {
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
const maxRetainedTraceEntries = 512;
const inspectorEnvironmentAllowlist = new Set(['FORCE_COLOR', 'LANG', 'LC_ALL', 'NO_COLOR', 'TZ']);

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
  getNegotiatedProtocolVersion?(): string | undefined;
  getProtocolEra?(): 'legacy' | 'modern' | undefined;
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
  readonly protocolEra: 'legacy' | 'modern' | undefined;
  readonly protocolVersion: string | undefined;
  readonly server: Implementation | undefined;
}

export interface McpSessionFrame {
  readonly direction: 'client' | 'server';
  /** A deep-frozen snapshot of the JSON-RPC object received from or sent to the SDK transport. */
  readonly message: unknown;
  readonly sequence: number;
}

export type McpSessionEvent =
  | Readonly<{ readonly sequence: number; readonly text: string; readonly type: 'stderr' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'progress' }>
  | Readonly<{ readonly payload: unknown; readonly sequence: number; readonly type: 'logging' }>;

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

export interface McpSessionServiceCloseFailure {
  readonly error: unknown;
  readonly resource: 'opening' | 'session';
  readonly sessionId?: McpSessionId;
}

/** Reports every session-service lifecycle failure after all tracked work settles. */
export class McpSessionServiceCloseError extends Error {
  readonly failures: readonly McpSessionServiceCloseFailure[];

  constructor(failures: readonly McpSessionServiceCloseFailure[]) {
    super('MCP session service could not close every lifecycle resource.');
    this.name = 'McpSessionServiceCloseError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
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
  readonly inspectorEnv: Readonly<Record<string, string>>;
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

interface TraceSubscription {
  closed: boolean;
  lastDeliveredSequence: number;
  listener: McpSessionTraceListener;
  pending: McpSessionTraceEntry[];
  replaying: boolean;
}

const inspectorCommandAllowlist = new Set(['bun', 'bun.exe', 'deno', 'deno.exe', 'node', 'node.exe']);
const inspectorRuntimeArgumentAllowlist = new Set(['--enable-source-maps']);
const safeLocaleValue = /^[A-Za-z0-9_.@-]{1,128}$/u;
const safeTimeZoneValue = /^[A-Za-z0-9_+./-]{1,128}$/u;
const credentialShaped = /(?:api[-_]?key|authorization|bearer|credential|cookie|password|secret|token)/iu;

const hasCredentialShapedPathSegment = (path: string): boolean =>
  path.split(/[\\/]/u).some((segment) => credentialShaped.test(segment));

const inspectorCommand = (command: string): string =>
  inspectorCommandAllowlist.has(command) ? command : '[REDACTED]';

const inspectorArtifactArgument = (argument: string, targetRoot: string): string => {
  if (inspectorRuntimeArgumentAllowlist.has(argument)) return argument;
  if (!isAbsolute(argument) && !argument.startsWith('./') && !argument.startsWith('../')) return '[REDACTED]';
  if (hasCredentialShapedPathSegment(argument)) return '[REDACTED]';
  const resolved = resolve(targetRoot, argument);
  return resolved === targetRoot || resolved.startsWith(`${targetRoot}/`) ? argument : '[REDACTED]';
};

const inspectorArguments = (args: readonly string[], targetRoot: string): readonly string[] =>
  Object.freeze(args.map((argument) => inspectorArtifactArgument(argument, targetRoot)));

const safeInspectorEnvironmentValue = (key: string, value: string): boolean => {
  if (key === 'FORCE_COLOR') return /^(0|1|2|3)$/u.test(value);
  if (key === 'NO_COLOR') return value === '0' || value === '1';
  if (key === 'LANG' || key === 'LC_ALL') return safeLocaleValue.test(value) && !credentialShaped.test(value);
  if (key === 'TZ') return safeTimeZoneValue.test(value) && !credentialShaped.test(value);
  return false;
};

const inspectorEnvironment = (env: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> => {
  const projected: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (inspectorEnvironmentAllowlist.has(key) && safeInspectorEnvironmentValue(key, value)) projected[key] = value;
  }
  return Object.freeze(projected);
};

const inspectorUrl = (url: URL): string => {
  const sanitized = new URL(url);
  sanitized.hash = '';
  sanitized.password = '';
  sanitized.search = '';
  sanitized.username = '';
  const segments = sanitized.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => {
    try {
      return credentialShaped.test(decodeURIComponent(segment));
    } catch {
      return true;
    }
  })) sanitized.pathname = '/';
  return sanitized.href;
};

const cloneJsonSnapshot = (value: unknown, ancestors = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('MCP protocol frames must contain only finite JSON numbers.');
  }
  if (typeof value !== 'object') {
    throw new TypeError(`MCP protocol frames must contain only JSON values, not ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError('MCP protocol frames cannot contain cyclic references.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (
          typeof key !== 'string' ||
          (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
        ) throw new TypeError('MCP protocol frame arrays cannot contain non-index properties.');
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new TypeError('MCP protocol frame arrays cannot contain holes or accessors.');
        }
        copy.push(cloneJsonSnapshot(descriptor.value, ancestors));
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('MCP protocol frame objects must have a plain-object prototype.');
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('MCP protocol frame objects cannot contain symbol properties.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError('MCP protocol frame objects cannot contain accessors.');
      }
      copy[key] = cloneJsonSnapshot(descriptor.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
};

const detachedJsonSnapshot = (value: unknown): unknown => freezeJsonValue(cloneJsonSnapshot(value));

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
  readonly #id: McpSessionId;
  readonly #onClose: () => void;
  readonly #pluginData: string;
  readonly #resolved: ResolvedSessionServer;
  readonly #launch: ResolvedLaunch;
  readonly #workspaceRoot: string;
  readonly #frames: McpSessionFrame[] = [];
  readonly #events: McpSessionEvent[] = [];
  readonly #requests = new Map<string, AbortController>();
  readonly #trace: McpSessionTraceEntry[] = [];
  readonly #traceSubscriptions = new Set<TraceSubscription>();
  readonly #undeliveredTraceEntries: McpSessionTraceEntry[] = [];
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
  #traceDispatching = false;
  #traceDroppedThroughSequence = 0;
  #traceSequence = 0;

  constructor(options: {
    readonly binding: McpSessionBinding;
    readonly createClient: () => McpClient;
    readonly createSseTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly createStdioTransport: (options: StdioOptions) => StdioTransport;
    readonly createStreamableHttpTransport: (url: URL, options: RemoteTransportOptions) => Transport;
    readonly epochReference: EpochReference;
    readonly id: McpSessionId;
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
    this.#id = options.id;
    this.#onClose = options.onClose;
    this.#pluginData = options.pluginData;
    this.#resolved = options.resolved;
    this.#workspaceRoot = options.workspaceRoot;
    this.#launch = this.#resolveLaunch();
  }

  get binding(): McpSessionBinding {
    return this.#binding;
  }

  get id(): McpSessionId {
    return this.#id;
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
    this.#assertTraceCursor(afterSequence);
    const overflow = afterSequence < this.#traceDroppedThroughSequence
      ? Object.freeze({ afterSequence, droppedThroughSequence: this.#traceDroppedThroughSequence })
      : undefined;
    return Object.freeze({
      entries: Object.freeze(this.#trace.filter((entry) => entry.sequence > afterSequence)),
      ...(overflow === undefined ? {} : { overflow }),
    });
  }

  subscribeTrace(
    options: McpSessionTraceSubscriptionOptions,
    listener: McpSessionTraceListener,
  ): McpSessionTraceSubscription;
  subscribeTrace(
    listener: McpSessionTraceListener,
    options?: McpSessionTraceSubscriptionOptions,
  ): McpSessionTraceSubscription;
  subscribeTrace(
    first: McpSessionTraceSubscriptionOptions | McpSessionTraceListener,
    second?: McpSessionTraceListener | McpSessionTraceSubscriptionOptions,
  ): McpSessionTraceSubscription {
    const listener = typeof first === 'function'
      ? first
      : typeof second === 'function'
        ? second
        : undefined;
    const options = typeof first === 'function'
      ? typeof second === 'function' ? undefined : second
      : first;
    if (typeof listener !== 'function') throw new TypeError('An MCP session trace listener is required.');
    const afterSequence = options?.afterSequence ?? 0;
    this.#assertTraceCursor(afterSequence);
    const boundary = this.#traceSequence;
    const subscription: TraceSubscription = {
      closed: false,
      lastDeliveredSequence: afterSequence,
      listener,
      pending: [],
      replaying: true,
    };
    this.#traceSubscriptions.add(subscription);

    const firstRetained = this.#trace[0]?.sequence;
    const replayEntries = this.#trace.filter((entry) => entry.sequence > afterSequence && entry.sequence <= boundary);
    if (firstRetained !== undefined && afterSequence < firstRetained - 1) {
      this.#deliverTraceGap(subscription, Object.freeze({
        earliestAvailableSequence: firstRetained,
        latestDroppedSequence: firstRetained - 1,
        requestedAfterSequence: afterSequence,
        type: 'replay.gap',
      }));
    }
    for (const entry of replayEntries) this.#deliverTraceEntry(subscription, entry);
    while (!subscription.closed && subscription.pending.length > 0) {
      const entry = subscription.pending.shift();
      if (entry !== undefined) this.#deliverTraceEntry(subscription, entry);
    }
    subscription.replaying = false;

    return Object.freeze({
      unsubscribe: () => this.#removeTraceSubscription(subscription),
    });
  }

  inspectorConfig(): McpSessionInspectorConfig {
    if (this.#launch.kind === 'stdio') {
      return Object.freeze({
        launch: Object.freeze({
          args: inspectorArguments(this.#launch.args, this.#resolved.targetRoot),
          command: inspectorCommand(this.#launch.command),
          ...(this.#launch.cwd === undefined ? {} : { cwd: this.#launch.cwd }),
          env: this.#launch.inspectorEnv,
          kind: 'stdio',
        }),
        origin: 'artifact',
      });
    }
    return Object.freeze({
      launch: Object.freeze({ kind: this.#launch.kind, url: inspectorUrl(this.#launch.url) }),
      origin: 'artifact',
    });
  }

  stderr(): string {
    return this.#capture?.output() ?? this.#stderrOutput;
  }

  async initialize(options?: McpSessionRequestOptions): Promise<McpSessionConnectionState> {
    return this.#operation('initialize', () => this.#withLifecycle(async () => {
      this.#assertOpen();
      if (this.#connection === undefined) await this.#connect(options);
      this.#assertOpen();
      return this.connection;
    }));
  }

  async listTools(options?: McpSessionRequestOptions): Promise<readonly Tool[]> {
    return this.#operation('listTools', async () => {
      const listed = await this.#clientFor(options).listTools(undefined, requestOptions(options));
      return Object.freeze([...listed.tools]);
    });
  }

  async listResources(options?: McpSessionRequestOptions): Promise<readonly Resource[]> {
    return this.#operation('listResources', async () => {
      const listed = await this.#clientFor(options).listResources(undefined, requestOptions(options));
      return Object.freeze([...listed.resources]);
    });
  }

  async listResourceTemplates(options?: McpSessionRequestOptions): Promise<readonly ResourceTemplateType[]> {
    return this.#operation('listResourceTemplates', async () => {
      const listed = await this.#clientFor(options).listResourceTemplates(undefined, requestOptions(options));
      return Object.freeze([...listed.resourceTemplates]);
    });
  }

  async listPrompts(options?: McpSessionRequestOptions): Promise<readonly Prompt[]> {
    return this.#operation('listPrompts', async () => {
      const listed = await this.#clientFor(options).listPrompts(undefined, requestOptions(options));
      return Object.freeze([...listed.prompts]);
    });
  }

  async getPrompt(options: McpSessionPromptOptions): Promise<GetPromptResult> {
    return this.#operation('getPrompt', () => this.#clientFor(options).getPrompt({
      ...(options.arguments === undefined ? {} : { arguments: options.arguments }),
      name: options.name,
    }, requestOptions(options)));
  }

  async readResource(options: McpSessionResourceOptions): Promise<{ readonly contents: readonly unknown[] }> {
    return this.#operation('readResource', () =>
      this.#clientFor(options).readResource({ uri: options.uri }, requestOptions(options)));
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
    return this.#operation('restart', () => this.#withLifecycle(async () => {
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

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#operation('close', () => this.#withLifecycle(() => this.#close()));
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
    const snapshot = detachedJsonSnapshot(message);
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
    this.#trace.push(entry);
    if (this.#trace.length > maxRetainedTraceEntries) {
      const dropped = this.#trace.shift();
      if (dropped !== undefined) this.#traceDroppedThroughSequence = dropped.sequence;
    }
    for (const subscription of this.#traceSubscriptions) {
      if (subscription.replaying) subscription.pending.push(entry);
    }
    this.#undeliveredTraceEntries.push(entry);
    this.#drainLiveTraceEntries();
  }

  #assertTraceCursor(afterSequence: number): void {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError('MCP session trace cursor must be a nonnegative safe integer.');
    }
    if (afterSequence > this.#traceSequence) {
      throw new RangeError('MCP session trace cursor cannot be ahead of the current trace.');
    }
  }

  #removeTraceSubscription(subscription: TraceSubscription): void {
    subscription.closed = true;
    this.#traceSubscriptions.delete(subscription);
  }

  #notifyTrace(subscription: TraceSubscription, message: McpSessionTraceMessage): void {
    try {
      subscription.listener(message);
    } catch {
      // Observers that throw cannot interfere with lifecycle or later subscribers.
      this.#removeTraceSubscription(subscription);
    }
  }

  #deliverTraceGap(subscription: TraceSubscription, gap: McpSessionTraceReplayGap): void {
    if (!subscription.closed) this.#notifyTrace(subscription, gap);
  }

  #deliverTraceEntry(subscription: TraceSubscription, entry: McpSessionTraceEntry): void {
    if (subscription.closed || entry.sequence <= subscription.lastDeliveredSequence) return;
    subscription.lastDeliveredSequence = entry.sequence;
    this.#notifyTrace(subscription, entry);
  }

  #drainLiveTraceEntries(): void {
    if (this.#traceDispatching) return;
    this.#traceDispatching = true;
    try {
      while (this.#undeliveredTraceEntries.length > 0) {
        const entry = this.#undeliveredTraceEntries.shift();
        if (entry === undefined) continue;
        for (const subscription of this.#traceSubscriptions) {
          if (!subscription.replaying) this.#deliverTraceEntry(subscription, entry);
        }
      }
    } finally {
      this.#traceDispatching = false;
    }
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
    this.#traceSequence += 1;
    return this.#traceSequence;
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
        inspectorEnv: inspectorEnvironment(resolved.env),
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
  readonly #projectRoot: string;
  readonly #openingSessions = new Set<OpeningSession>();
  readonly #sessions = new Map<string, McpSession>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: McpSessionServiceOptions) {
    if (!isAbsolute(options.projectRoot)) throw new Error('MCP session service project root must be absolute.');
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
    this.#projectRoot = resolve(options.projectRoot);
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
        id: sessionId,
        onClose: () => this.#sessions.delete(sessionId),
        pluginData,
        resolved: { server, target, targetRoot },
        workspaceRoot: resolve(options.workspaceRoot ?? this.#projectRoot),
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

  get(id: McpSessionId): McpSession | undefined {
    return this.#sessions.get(id);
  }

  async closeSession(id: McpSessionId): Promise<boolean> {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    await session.close();
    return true;
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
    const openingResults = await Promise.allSettled(openings.map((opening) => opening.done));
    const sessions = [...this.#sessions.entries()];
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
