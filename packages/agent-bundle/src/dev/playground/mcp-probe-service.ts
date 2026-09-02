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

const hasAbsolutePath = (value: string): boolean =>
  /(?:file:|(?:^|[\s"'([{])\/[^\s,;{}()[\]<>"']+|(?:^|[\s"'([{])[A-Za-z]:[\\/]|\\\\)/u.test(value);

/**
 * Probe text follows the Dev Log browser-wire precedent without coupling this
 * read-only service to log retention: credential text is removed first,
 * bundle paths become a label, and every other absolute path fails closed.
 */
const redactProbeText = (value: string, bundleRoot: string, maximum: number): string => {
  const redacted = redactCredentialText(value).replace(
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

export class McpProbeService {
  readonly #clock: () => number;
  readonly #createClient: () => McpProbeClient;
  readonly #createPluginData: () => Promise<string>;
  readonly #createStdioTransport: NonNullable<McpProbeServiceOptions['createStdioTransport']>;
  readonly #createStreamableHttpTransport: NonNullable<McpProbeServiceOptions['createStreamableHttpTransport']>;
  readonly #inFlight = new Map<string, Promise<McpProbeReport>>();
  readonly #now: () => Date;
  readonly #prepared: McpProbeServiceOptions['prepared'];
  readonly #projectRoot: string;
  readonly #registry: TargetRegistry;
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
    this.#prepared = options.prepared;
    this.#projectRoot = resolve(options.projectRoot);
    this.#registry = options.registry ?? createDefaultRegistry();
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
    try {
      const launch = resolveMcpSessionLaunch({
        pluginData,
        resolved: {
          runtime,
          server,
          target: options.host,
          targetRoot: bundleRoot,
        },
        workspaceRoot: this.#projectRoot,
      });
      const projectedLaunch = inspectorLaunch(
        mcpSessionInspectorConfig(launch, bundleRoot).launch,
      );
      return await this.#execute({
        bundleRoot,
        generatedAt,
        host: options.host,
        launch,
        projectedLaunch,
        serverName: options.serverName,
        startedAt,
      });
    } finally {
      await rm(pluginData, { force: true, recursive: true });
    }
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
    readonly projectedLaunch: McpProbeLaunch;
    readonly serverName: string;
    readonly startedAt: number;
  }): Promise<McpProbeReport> {
    const client = this.#createClient();
    const transport = this.#transport(options.launch);
    let report: McpProbeReport;
    try {
      try {
        await this.#withinBudget(
          client.connect(transport),
          options.startedAt,
          'connect',
          () => transport.close(),
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
          () => transport.close(),
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
      await Promise.allSettled([client.close(), transport.close()]);
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
      await onTimeout().catch(() => undefined);
      throw new McpProbeTimeoutError(kind);
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void onTimeout().catch(() => undefined);
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
