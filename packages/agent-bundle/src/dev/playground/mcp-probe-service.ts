import {
  Client,
  StreamableHTTPClientTransport,
  type Implementation,
  type ServerCapabilities,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { performance } from 'node:perf_hooks';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../../adapters/registry.ts';
import type {
  McpProbeFailure,
  McpProbeFailureKind,
  McpProbeHost,
  McpProbeLaunch,
  McpProbeReport,
  McpProbeSnapshot,
  McpProbeTool,
} from '../../contracts/mcp-probe.ts';
import { redactCredentialText } from '../../core/credentials.ts';
import { parseJsonWithoutDuplicateKeys } from '../../core/strict-json.ts';
import { resolveBundleRoot } from '../../install/doctor.ts';
import {
  readTargetMcpServer,
  type TargetMcpRuntimeContract,
} from '../../services/mcp-runtime.ts';
import {
  mcpSessionInspectorConfig,
  resolveMcpSessionLaunch,
  type ResolvedMcpSessionLaunch,
} from '../mcp-session/mcp-session-launch.ts';
import type { McpSessionInspectorConfig } from '../mcp-session/mcp-session-protocol.ts';
import type { RemoteTransportOptions, StdioOptions } from '../mcp-session/mcp-session-types.ts';

export const mcpProbeTimeoutMs = 10_000;
export const mcpProbeToolLimit = 200;
export const mcpProbeInstructionTextLimit = 2_048;
export const mcpProbeToolTextLimit = 2_048;
export const mcpProbeFailureTextLimit = 2_048;

const mcpProbeCapabilityLimit = 32;
const mcpProbeNameTextLimit = 256;
/** How long a probe response waits for transport teardown before detaching it. */
const mcpProbeTeardownWaitMs = 50;
/**
 * Upper bound a detached teardown may hold the plugin-data directory. The
 * stdio transport's close runs its own TERM/KILL sequence, so this only guards
 * against a transport whose close never settles.
 */
export const mcpProbePluginDataTeardownCapMs = 10_000;
/**
 * Delay before the one bounded removal retry that follows a teardown which
 * settled while the child still held the directory for a moment (Windows).
 */
const mcpProbePluginDataRetryDelayMs = 250;
const safeCapabilityName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const connectionErrorCodes = new Set([
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

export type McpProbeTransport = Transport;

export interface McpProbeClient {
  close(): Promise<void>;
  connect(transport: Transport): Promise<void>;
  getInstructions(): string | undefined;
  getNegotiatedProtocolVersion(): string | undefined;
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  listTools(): Promise<{ readonly tools: readonly Tool[] }>;
}

export interface McpProbeServiceOptions {
  readonly clock?: () => number;
  readonly createClient?: () => McpProbeClient;
  readonly createPluginData?: () => Promise<string>;
  readonly createStdioTransport?: (options: StdioOptions) => McpProbeTransport;
  readonly createStreamableHttpTransport?: (
    url: URL,
    options: RemoteTransportOptions,
  ) => McpProbeTransport;
  readonly now?: () => Date;
  /** Testing seam for the detached teardown cap; production keeps the named constant. */
  readonly pluginDataTeardownCapMs?: number;
  /** Testing seam for plugin-data removal; production removes the directory recursively. */
  readonly removePluginData?: (pluginData: string) => Promise<void>;
  readonly prepared: () => Readonly<{ readonly bundleSource: string }> | undefined;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly timeoutMs?: number;
}

export class McpProbeTargetNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProbeTargetNotFoundError';
  }
}

class McpProbeTimeoutError extends Error {
  readonly kind: McpProbeFailureKind;

  constructor(kind: McpProbeFailureKind) {
    super('The MCP probe exceeded its total time budget.');
    this.name = 'McpProbeTimeoutError';
    this.kind = kind;
  }
}

class McpProbeProtocolError extends Error {
  readonly kind: McpProbeFailureKind;

  constructor(kind: McpProbeFailureKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'McpProbeProtocolError';
    this.kind = kind;
  }
}

const truncate = (value: string, maximum: number): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;

const escapeExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const bundlePathPattern = (bundleRoot: string): RegExp => {
  const normalized = resolve(bundleRoot).replaceAll('\\', '/').replace(/\/+$/u, '');
  const root = escapeExpression(normalized).replaceAll('/', '[\\\\/]');
  const suffix = String.raw`(?:[\\/][^\s,;{}()[\]<>"'\x00-\x1F\x7F]*)*`;
  return new RegExp(String.raw`(?:file:\/\/)?${root}${suffix}`, 'gu');
};

/**
 * An absolute POSIX path starts the text or follows a separator; a `:` counts
 * as a separator (`cwd:/private`) only when it is not the `://` of a URI
 * scheme, so `https://example.com/docs` is link guidance, not a local path.
 * That exemption is limited to network schemes (`http`, `https`, `ws`,
 * `wss`): any other `scheme://…/…` — `unix:///home/…`, `vscode://file/home/…`,
 * `file:` — may carry a machine-local path in its authority or path and fails
 * closed like a bare absolute path.
 */
const localUriPathPattern = /\b(?!(?:https?|wss?):\/\/)[a-z][a-z0-9+.-]*:\/\/[^\s/]*\//iu;

const hasAbsolutePath = (value: string): boolean =>
  localUriPathPattern.test(value) ||
  /(?:file:|(?:^|[\s"'([{=,]|:(?!\/\/))\/[^\s,;{}()[\]<>"']+|(?:^|[\s"'([{=,:])[A-Za-z]:[\\/]|\\\\)/u.test(value);

/**
 * URL userinfo (`scheme://user:secret@host`) is a credential that the generic
 * credential redaction does not recognize; because URLs are exempt from the
 * absolute-path fail-closed rule, the userinfo is stripped before that check.
 * The authority runs until whitespace or one of the authority terminators
 * every WHATWG scheme shares (`/`, `?`, `#`); within it the match is greedy
 * through the *final* `@`, the delimiter URL parsers honour, so a raw `@`,
 * quote, or backslash inside a password cannot leave part of the credential
 * behind. `\` is deliberately not a terminator here: it only ends the
 * authority for special schemes, while non-special ones such as
 * `postgres://` accept it inside userinfo — masking errs toward redaction.
 */
const urlUserinfoPattern = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/giu;

/**
 * Probe text follows the Dev Log browser-wire precedent without coupling this
 * read-only service to log retention: credential text is removed first, URL
 * userinfo is masked, bundle paths become a label, and every other absolute
 * path fails closed.
 */
const redactProbeText = (value: string, bundleRoot: string, maximum: number): string => {
  const redacted = redactCredentialText(value).replace(urlUserinfoPattern, '$1[REDACTED]@').replace(
    bundlePathPattern(bundleRoot),
    (match) => {
      const normalized = match.replace(/^file:\/\//u, '').replaceAll('\\', '/');
      const root = resolve(bundleRoot).replaceAll('\\', '/').replace(/\/+$/u, '');
      return `<bundle>${normalized.slice(root.length)}`;
    },
  );
  return truncate(hasAbsolutePath(redacted) ? '[REDACTED]' : redacted, maximum);
};

const inspectorLaunch = (value: McpSessionInspectorConfig['launch']): McpProbeLaunch => {
  switch (value.kind) {
    case 'stdio':
      return Object.freeze({
        args: Object.freeze([...value.args]),
        command: value.command,
        ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
        env: Object.freeze({ ...value.env }),
        kind: value.kind,
      });
    case 'streamable-http':
      return Object.freeze({ kind: value.kind, url: value.url });
    default: {
      const exhaustive: never = value;
      throw new TypeError(`Unknown MCP probe launch ${String(exhaustive)}.`);
    }
  }
};

const capabilitySnapshot = (
  value: ServerCapabilities | undefined,
): Readonly<Record<string, boolean>> => {
  const capabilities: Record<string, boolean> = {};
  if (value === undefined) return Object.freeze(capabilities);
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
    if (
      Object.keys(capabilities).length >= mcpProbeCapabilityLimit ||
      !safeCapabilityName.test(key) ||
      !value[key as keyof ServerCapabilities]
    ) continue;
    capabilities[key] = true;
  }
  return Object.freeze(capabilities);
};

const probeTool = (value: Tool, bundleRoot: string): McpProbeTool => Object.freeze({
  ...(typeof value.description === 'string'
    ? { description: redactProbeText(value.description, bundleRoot, mcpProbeToolTextLimit) }
    : {}),
  name: redactProbeText(value.name, bundleRoot, mcpProbeNameTextLimit),
  ...(typeof value.title === 'string'
    ? { title: redactProbeText(value.title, bundleRoot, mcpProbeToolTextLimit) }
    : {}),
});

const serverInfoSnapshot = (
  value: Implementation,
  bundleRoot: string,
): McpProbeSnapshot['serverInfo'] => Object.freeze({
  name: redactProbeText(value.name, bundleRoot, mcpProbeNameTextLimit),
  ...(typeof value.title === 'string'
    ? { title: redactProbeText(value.title, bundleRoot, mcpProbeToolTextLimit) }
    : {}),
  version: redactProbeText(value.version, bundleRoot, mcpProbeNameTextLimit),
});

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const connectFailureKind = (error: unknown): McpProbeFailureKind => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && connectionErrorCodes.has(code)) return 'connect';
  return /(?:connect|connection|spawn|exited?|socket)/iu.test(errorDetail(error))
    ? 'connect'
    : 'handshake';
};

const failureSnapshot = (
  error: unknown,
  bundleRoot: string,
  fallbackKind: McpProbeFailureKind,
): McpProbeFailure => Object.freeze({
  detail: redactProbeText(errorDetail(error), bundleRoot, mcpProbeFailureTextLimit),
  kind: error instanceof McpProbeTimeoutError || error instanceof McpProbeProtocolError
    ? error.kind
    : fallbackKind,
});

const positiveTimeout = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('MCP probe timeout must be a positive safe integer.');
  }
  return value;
};

/**
 * Invoke a close callback so that both a synchronous throw and a rejection
 * become one settled promise; teardown chains must never depend on a close
 * being well behaved.
 */
const removePluginData = (pluginData: string): Promise<void> =>
  rm(pluginData, { force: true, maxRetries: 3, recursive: true, retryDelay: 50 });

const settledClose = (close: () => Promise<void>): Promise<void> => {
  try {
    return Promise.resolve(close()).then(() => undefined, () => undefined);
  } catch {
    return Promise.resolve();
  }
};

export class McpProbeService {
  readonly #clock: () => number;
  readonly #createClient: () => McpProbeClient;
  readonly #createPluginData: () => Promise<string>;
  readonly #createStdioTransport: NonNullable<McpProbeServiceOptions['createStdioTransport']>;
  readonly #createStreamableHttpTransport: NonNullable<McpProbeServiceOptions['createStreamableHttpTransport']>;
  readonly #inFlight = new Map<string, Promise<McpProbeReport>>();
  readonly #now: () => Date;
  readonly #pendingTeardowns = new Set<Promise<void>>();
  readonly #pluginDataTeardownCapMs: number;
  readonly #prepared: McpProbeServiceOptions['prepared'];
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
  readonly #removePluginData: (pluginData: string) => Promise<void>;
  readonly #timeoutMs: number;

  constructor(options: McpProbeServiceOptions) {
    this.#clock = options.clock ?? (() => performance.now());
    this.#createClient = options.createClient ??
      (() => new Client(
        { name: 'agent-bundle', version: '0.1.0' },
        { capabilities: {} },
      ));
    this.#createPluginData = options.createPluginData ??
      (() => mkdtemp(resolve(tmpdir(), 'agent-bundle-mcp-probe-')));
    this.#createStdioTransport = options.createStdioTransport ??
      ((stdioOptions) => new StdioClientTransport(stdioOptions));
    this.#createStreamableHttpTransport = options.createStreamableHttpTransport ??
      ((url, transportOptions) => new StreamableHTTPClientTransport(url, {
        requestInit: transportOptions.headers === undefined
          ? undefined
          : { headers: transportOptions.headers },
      }));
    this.#now = options.now ?? (() => new Date());
    this.#pluginDataTeardownCapMs = positiveTimeout(
      options.pluginDataTeardownCapMs ?? mcpProbePluginDataTeardownCapMs,
    );
    this.#prepared = options.prepared;
    this.#projectRoot = resolve(options.projectRoot);
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#removePluginData = options.removePluginData ?? removePluginData;
    this.#timeoutMs = positiveTimeout(options.timeoutMs ?? mcpProbeTimeoutMs);
  }

  probe(options: {
    readonly host: McpProbeHost;
    readonly serverName: string;
  }): Promise<McpProbeReport> {
    const key = `${options.host}:${options.serverName}`;
    const inFlight = this.#inFlight.get(key);
    if (inFlight !== undefined) return inFlight;
    const probe = this.#run(options);
    this.#inFlight.set(key, probe);
    const settle = (): void => {
      if (this.#inFlight.get(key) === probe) this.#inFlight.delete(key);
    };
    void probe.then(settle, settle);
    return probe;
  }

  /**
   * Resolve once every in-flight probe has answered and every detached
   * teardown — a transport close that outlived its probe's response boundary,
   * followed by that probe's plugin-data removal — has settled. In-flight
   * probes are part of the fence because a probe registers its teardown only
   * when it reaches its response boundary; a fence over teardowns alone would
   * let shutdown finish while a still-connecting probe holds a transport and a
   * plugin-data directory. Probe responses never wait on this.
   */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0 || this.#pendingTeardowns.size > 0) {
      await Promise.allSettled([...this.#inFlight.values(), ...this.#pendingTeardowns]);
    }
  }

  async #run(options: {
    readonly host: McpProbeHost;
    readonly serverName: string;
  }): Promise<McpProbeReport> {
    const startedAt = this.#clock();
    const generatedAt = this.#now().toISOString();
    const prepared = this.#prepared();
    if (prepared === undefined) {
      throw new McpProbeTargetNotFoundError('No prepared bundle is available for MCP probing.');
    }
    let bundleRoot: string;
    try {
      bundleRoot = await resolveBundleRoot(prepared.bundleSource, options.host);
    } catch {
      throw new McpProbeTargetNotFoundError(
        `No prepared ${options.host} bundle is available for MCP probing.`,
      );
    }
    const runtime = this.#runtime(options.host);
    const server = await this.#server(bundleRoot, options.host, runtime, options.serverName);
    const pluginData = await this.#createPluginData();
    let launch: ResolvedMcpSessionLaunch;
    let projectedLaunch: McpProbeLaunch;
    try {
      launch = resolveMcpSessionLaunch({
        pluginData,
        resolved: {
          runtime,
          server,
          target: options.host,
          targetRoot: bundleRoot,
        },
        workspaceRoot: this.#projectRoot,
      });
      projectedLaunch = inspectorLaunch(
        mcpSessionInspectorConfig(launch, bundleRoot).launch,
      );
    } catch (error) {
      // No transport was opened, so nothing can still hold the directory.
      await rm(pluginData, { force: true, recursive: true });
      throw error;
    }
    // From here on the transport teardown owns plugin-data removal (#execute):
    // the launched server may have the directory open until its close settles.
    return this.#execute({
      bundleRoot,
      generatedAt,
      host: options.host,
      launch,
      pluginData,
      projectedLaunch,
      serverName: options.serverName,
      startedAt,
    });
  }

  /**
   * Remove the probe's plugin-data directory once transport teardown has
   * settled (or the teardown cap has elapsed), never at the response
   * boundary: a stdio server that still holds the directory open while it
   * shuts down would otherwise race the removal — on Windows the `rm` can
   * reject outright and turn an honest timed-out report into a generic
   * failure, elsewhere the directory can vanish under the exiting child.
   * Removal failures stay on this detached path; they never reach the report.
   *
   * When the cap wins the race and the removal then fails — the transport is
   * still alive and holds the directory, which on Windows is an `EPERM` — one
   * more removal is chained to the teardown's eventual settlement instead of
   * swallowing the failure for good. That retry is best-effort and stays
   * outside the `settle()` fence on purpose: a transport that never settles
   * would otherwise hold Workbench shutdown open indefinitely, which is the
   * very case the cap bounds.
   */
  #removePluginDataAfter(teardown: Promise<unknown>, pluginData: string): Promise<void> {
    let cap: NodeJS.Timeout | undefined;
    let capWon = false;
    // The cap stays referenced on purpose: it is the only handle guaranteeing
    // the removal runs when a stalled teardown outlives Workbench shutdown,
    // and it is cleared the moment the teardown settles.
    const capped = new Promise<void>((resolvePromise) => {
      cap = setTimeout(() => {
        capWon = true;
        resolvePromise();
      }, this.#pluginDataTeardownCapMs);
    });
    const pending = Promise.race([teardown, capped])
      .then(() => {
        if (cap !== undefined) clearTimeout(cap);
        return this.#removePluginData(pluginData);
      })
      .then(() => undefined, () => {
        if (capWon) {
          void teardown.then(() => this.#removePluginData(pluginData)).catch(() => undefined);
          return;
        }
        // The teardown settled (a close may have failed fast) but the child
        // still held the directory for a moment: one bounded, fenced retry.
        this.#track(
          new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, mcpProbePluginDataRetryDelayMs); })
            .then(() => this.#removePluginData(pluginData))
            .then(() => undefined, () => undefined),
        );
      });
    this.#track(pending);
    return pending;
  }

  #track(pending: Promise<void>): void {
    this.#pendingTeardowns.add(pending);
    void pending.then(() => this.#pendingTeardowns.delete(pending));
  }

  #runtime(host: McpProbeHost): TargetMcpRuntimeContract {
    let runtime: TargetMcpRuntimeContract | undefined;
    try {
      runtime = this.#registry.mcpRuntime(host);
    } catch {
      runtime = undefined;
    }
    if (runtime === undefined) {
      throw new McpProbeTargetNotFoundError(
        `Host ${JSON.stringify(host)} has no MCP runtime available for probing.`,
      );
    }
    return runtime;
  }

  async #server(
    bundleRoot: string,
    host: McpProbeHost,
    runtime: TargetMcpRuntimeContract,
    serverName: string,
  ) {
    const document = parseJsonWithoutDuplicateKeys(
      await readFile(resolve(bundleRoot, runtime.manifestPath), 'utf8'),
    );
    const result = readTargetMcpServer(runtime, document, serverName);
    if (result.status === 'missing') {
      throw new McpProbeTargetNotFoundError(
        `MCP server ${JSON.stringify(serverName)} was not found for ${host}.`,
      );
    }
    if (result.status === 'invalid') {
      throw new Error(`The ${host} MCP manifest is invalid.`);
    }
    return result.server;
  }

  async #execute(options: {
    readonly bundleRoot: string;
    readonly generatedAt: string;
    readonly host: McpProbeHost;
    readonly launch: ResolvedMcpSessionLaunch;
    readonly pluginData: string;
    readonly projectedLaunch: McpProbeLaunch;
    readonly serverName: string;
    readonly startedAt: number;
  }): Promise<McpProbeReport> {
    let client: McpProbeClient;
    let transport: McpProbeTransport;
    try {
      client = this.#createClient();
      transport = this.#transport(options.launch);
    } catch (error) {
      // Nothing was launched, so the directory cannot be in use.
      await rm(options.pluginData, { force: true, recursive: true });
      throw error;
    }
    // One close promise per probe: a timeout starts the transport's TERM/KILL
    // path early, and the teardown below must follow that same close rather
    // than a duplicate call a non-reentrant transport answers immediately.
    let transportClose: Promise<void> | undefined;
    const closeTransport = (): Promise<void> => {
      transportClose ??= settledClose(() => transport.close());
      return transportClose;
    };
    let report: McpProbeReport;
    try {
      try {
        await this.#withinBudget(
          client.connect(transport),
          options.startedAt,
          'connect',
          closeTransport,
        );
      } catch (error) {
        const failure = failureSnapshot(
          error,
          options.bundleRoot,
          connectFailureKind(error),
        );
        report = this.#failureReport(options, failure, error instanceof McpProbeTimeoutError);
        return report;
      }

      const protocolVersion = client.getNegotiatedProtocolVersion();
      const serverInfo = client.getServerVersion();
      if (protocolVersion === undefined || protocolVersion.length === 0 || serverInfo === undefined) {
        const error = new McpProbeProtocolError(
          'handshake',
          'The MCP initialize response omitted required server metadata.',
        );
        return this.#failureReport(
          options,
          failureSnapshot(error, options.bundleRoot, 'handshake'),
          false,
        );
      }

      let listed: { readonly tools: readonly Tool[] };
      try {
        listed = await this.#withinBudget(
          client.listTools(),
          options.startedAt,
          'protocol',
          closeTransport,
        );
      } catch (error) {
        const protocolError = error instanceof McpProbeTimeoutError
          ? error
          : new McpProbeProtocolError('protocol', errorDetail(error), { cause: error });
        return this.#failureReport(
          options,
          failureSnapshot(protocolError, options.bundleRoot, 'protocol'),
          protocolError instanceof McpProbeTimeoutError,
        );
      }
      const tools = Object.freeze(
        listed.tools.slice(0, mcpProbeToolLimit).map((tool) => probeTool(tool, options.bundleRoot)),
      );
      const instructions = client.getInstructions();
      const snapshot: McpProbeSnapshot = Object.freeze({
        capabilities: capabilitySnapshot(client.getServerCapabilities()),
        ...(instructions === undefined
          ? {}
          : {
              instructions: redactProbeText(
                instructions,
                options.bundleRoot,
                mcpProbeInstructionTextLimit,
              ),
            }),
        protocolVersion: redactProbeText(
          protocolVersion,
          options.bundleRoot,
          mcpProbeNameTextLimit,
        ),
        serverInfo: serverInfoSnapshot(serverInfo, options.bundleRoot),
        tools,
        toolsTruncated: listed.tools.length > mcpProbeToolLimit,
      });
      report = Object.freeze({
        durationMs: Math.max(0, Math.round(this.#clock() - options.startedAt)),
        generatedAt: options.generatedAt,
        host: options.host,
        launch: options.projectedLaunch,
        serverName: options.serverName,
        snapshot,
        status: 'ok',
      });
      return report;
    } finally {
      let timer: NodeJS.Timeout | undefined;
      // Keep transport teardown running through its TERM/KILL path without
      // allowing a stalled close to extend the probe's total time budget. The
      // plugin-data removal is chained behind that teardown, so a close that
      // outlives this wait detaches together with the removal it gates.
      // Each close is invoked in isolation: a synchronously throwing close
      // must neither skip the other close nor abort before the plugin-data
      // removal below is registered. The transport close is the one a
      // timeout may already have started.
      const teardown = Promise.allSettled([
        settledClose(() => client.close()),
        closeTransport(),
      ]);
      const cleanup = this.#removePluginDataAfter(teardown, options.pluginData);
      const teardownWait = new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, mcpProbeTeardownWaitMs);
        timer.unref();
      });
      try {
        await Promise.race([cleanup, teardownWait]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  }

  #failureReport(
    options: {
      readonly generatedAt: string;
      readonly host: McpProbeHost;
      readonly projectedLaunch: McpProbeLaunch;
      readonly serverName: string;
      readonly startedAt: number;
    },
    failure: McpProbeFailure,
    timedOut: boolean,
  ): McpProbeReport {
    return Object.freeze({
      durationMs: Math.max(0, Math.round(this.#clock() - options.startedAt)),
      failure,
      generatedAt: options.generatedAt,
      host: options.host,
      launch: options.projectedLaunch,
      serverName: options.serverName,
      status: timedOut ? 'timed-out' : 'unreachable',
    });
  }

  #transport(launch: ResolvedMcpSessionLaunch): McpProbeTransport {
    switch (launch.kind) {
      case 'stdio':
        return this.#createStdioTransport({
          args: [...launch.args],
          command: launch.command,
          ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
          env: { ...launch.env },
          stderr: 'pipe',
        });
      case 'streamable-http':
        return this.#createStreamableHttpTransport(
          launch.url,
          launch.headers === undefined ? {} : { headers: { ...launch.headers } },
        );
      default: {
        const exhaustive: never = launch;
        throw new TypeError(`Unknown MCP probe transport ${String(exhaustive)}.`);
      }
    }
  }

  async #withinBudget<T>(
    operation: Promise<T>,
    startedAt: number,
    kind: McpProbeFailureKind,
    onTimeout: () => Promise<void>,
  ): Promise<T> {
    const remaining = Math.max(0, this.#timeoutMs - (this.#clock() - startedAt));
    if (remaining === 0) {
      // Same contract as the timer path below: the transport's own close
      // (TERM/KILL for stdio) keeps running, but a stalled close never holds
      // the timed-out report — #execute's bounded teardown owns that wait.
      void settledClose(onTimeout);
      throw new McpProbeTimeoutError(kind);
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void settledClose(onTimeout);
        reject(new McpProbeTimeoutError(kind));
      }, remaining);
      timer.unref();
    });
    try {
      return await Promise.race([operation, timedOut]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
