import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Implementation,
  type ServerCapabilities,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Stream } from 'node:stream';

import { Effect, type FileSystem } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { createDefaultRegistry, TargetRegistry } from '../adapters/registry.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { joinArtifact, resolveContained } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { liftPromise } from '../effect/lift.ts';
import { readFileString, runWithPlatform, withTempDirectory } from '../effect/platform.ts';
import { resolveMcpPathTokens } from './mcp-path-tokens.ts';
import { readTargetMcpServer, type ModernMcpServer, type TargetMcpRuntimeContract } from './mcp-runtime.ts';

const defaultTimeoutMs = 5_000;
const maxStderrBytes = 1_000_000;

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
  getServerCapabilities(): ServerCapabilities | undefined;
  getServerVersion(): Implementation | undefined;
  listTools(
    params?: undefined,
    options?: RequestOptions,
  ): Promise<{ readonly tools: readonly Tool[] }>;
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

interface McpServiceDependencies {
  readonly createClient?: () => McpClient;
  readonly createStdioTransport?: (options: StdioOptions) => StdioTransport;
  readonly createStreamableHttpTransport?: (
    url: URL,
    options: RemoteTransportOptions,
  ) => Transport;
  readonly registry?: TargetRegistry;
}

export interface McpOperationOptions {
  readonly artifact: string;
  readonly server: string;
  readonly signal?: AbortSignal;
  readonly target: string;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
}

export type McpListOptions = McpOperationOptions;

export interface McpInvokeOptions extends McpOperationOptions {
  readonly input: Record<string, unknown>;
  readonly tool: string;
}

export interface McpConnectionState {
  readonly capabilities: ServerCapabilities | undefined;
  readonly server: Implementation | undefined;
  readonly stderr: string;
}

export interface McpListResult extends McpConnectionState {
  readonly tools: readonly Tool[];
}

export interface McpInvokeResult extends McpConnectionState {
  readonly result: CallToolResult;
}

interface StderrCapture {
  readonly exceeded: () => boolean;
  readonly output: () => string;
  readonly stop: () => void;
  readonly waitForEnd: (timeoutMs: number) => Promise<void>;
}

const captureStderr = (stream: Stream | null, close: () => Promise<void>): StderrCapture => {
  if (stream === null) {
    return {
      exceeded: () => false,
      output: () => '',
      stop: () => undefined,
      waitForEnd: async () => undefined,
    };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  let finished = false;
  const finishedGate = Promise.withResolvers<void>();
  const onFinished = () => {
    if (finished) return;
    finished = true;
    finishedGate.resolve();
  };
  const onData = (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes + buffer.byteLength > maxStderrBytes) {
      overflow = true;
      void close().catch(() => undefined);
      return;
    }
    bytes += buffer.byteLength;
    chunks.push(buffer);
  };
  stream.on('data', onData);
  stream.once('close', onFinished);
  stream.once('end', onFinished);
  return {
    exceeded: () => overflow,
    output: () => Buffer.concat(chunks).toString(),
    stop: () => {
      stream.off('data', onData);
      stream.off('close', onFinished);
      stream.off('end', onFinished);
    },
    waitForEnd: async (timeoutMs) => {
      if (finished) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        finishedGate.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
};

const timeoutFor = (options: McpOperationOptions): number => {
  const timeout = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('MCP operation timeoutMs must be a positive finite number.');
  }
  return timeout;
};

export class McpService {
  readonly #createClient: () => McpClient;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (
    url: URL,
    options: RemoteTransportOptions,
  ) => Transport;
  readonly #registry: TargetRegistry;

  constructor(dependencies: McpServiceDependencies = {}) {
    this.#createClient = dependencies.createClient ?? (() => new Client({
      name: 'agent-bundle',
      version: '0.1.0',
    }));
    this.#createStdioTransport = dependencies.createStdioTransport ?? ((options) =>
      new StdioClientTransport(options));
    this.#createStreamableHttpTransport = dependencies.createStreamableHttpTransport ?? ((url, options) =>
      new StreamableHTTPClientTransport(url, {
        requestInit: options.headers === undefined ? undefined : { headers: options.headers },
      }));
    this.#registry = dependencies.registry ?? createDefaultRegistry();
  }

  async list(options: McpListOptions): Promise<McpListResult> {
    const { connection, value } = await this.#run(options, async (client, requestOptions) => {
      const listed = await client.listTools(undefined, requestOptions);
      return Object.freeze([...listed.tools]);
    });
    return { ...connection, tools: value };
  }

  async invoke(options: McpInvokeOptions): Promise<McpInvokeResult> {
    const { connection, value } = await this.#run(options, async (client, requestOptions) => {
      const result = await client.callTool({ arguments: options.input, name: options.tool }, requestOptions);
      return result;
    });
    return { ...connection, result: value };
  }

  async #run<Result>(
    options: McpOperationOptions,
    operation: (
      client: McpClient,
      requestOptions: RequestOptions,
    ) => Promise<Result>,
  ): Promise<{ readonly connection: McpConnectionState; readonly value: Result }> {
    const artifact = resolve(options.artifact);
    const runtime = this.#runtime(options.target);
    const diagnostics = await validateArtifact({ artifactRoot: artifact, registry: this.#registry });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) throw new DiagnosticError(errors);

    // Every selected host reads the composite root as its plugin root (#555).
    const targetRoot = artifact;
    // The per-connection plugin-data directory lives exactly as long as the
    // connection: `withTempDirectory` is the `mkdtemp` + `finally rm` bracket
    // (cleanup failure wins, as the throwing `finally` did). The client and
    // stderr capture are closed inside the bracket, before the removal.
    return runWithPlatform(Effect.gen({ self: this }, function* (this: McpService) {
      const server = yield* this.#server(targetRoot, options.target, runtime, options.server);
      return yield* withTempDirectory(
        { directory: tmpdir(), prefix: 'agent-bundle-mcp-' },
        (pluginData) => liftPromise(() => this.#connect(options, operation, { pluginData, runtime, server, targetRoot })),
      );
    }));
  }

  async #connect<Result>(
    options: McpOperationOptions,
    operation: (
      client: McpClient,
      requestOptions: RequestOptions,
    ) => Promise<Result>,
    launch: {
      readonly pluginData: string;
      readonly runtime: TargetMcpRuntimeContract;
      readonly server: ModernMcpServer;
      readonly targetRoot: string;
    },
  ): Promise<{ readonly connection: McpConnectionState; readonly value: Result }> {
    const requestOptions: RequestOptions = { signal: options.signal, timeout: timeoutFor(options) };
    const client = this.#createClient();
    let capture: StderrCapture | undefined;
    let closed = false;

    try {
      const roots = {
        pluginData: launch.pluginData,
        pluginRoot: launch.targetRoot,
        workspaceRoot: resolve(options.workspaceRoot ?? process.cwd()),
      };
      const transport = this.#transport(launch.server, launch.runtime, options.target, launch.targetRoot, roots, (nextCapture) => {
        capture = nextCapture;
      });
      await client.connect(transport, requestOptions);
      this.#throwIfStderrExceeded(capture);
      const value = await operation(client, requestOptions);
      this.#throwIfStderrExceeded(capture);
      const capabilities = client.getServerCapabilities();
      const serverVersion = client.getServerVersion();
      await client.close();
      closed = true;
      await capture?.waitForEnd(requestOptions.timeout);
      this.#throwIfStderrExceeded(capture);
      return {
        connection: {
          capabilities,
          server: serverVersion,
          stderr: capture?.output() ?? '',
        },
        value,
      };
    } catch (error) {
      this.#throwIfStderrExceeded(capture);
      throw error;
    } finally {
      try {
        if (!closed) await client.close();
      } finally {
        capture?.stop();
      }
    }
  }

  #server(
    targetRoot: string,
    target: string,
    runtime: TargetMcpRuntimeContract,
    name: string,
  ): Effect.Effect<ModernMcpServer, Error | PlatformError, FileSystem.FileSystem> {
    if (name.trim().length === 0) {
      return Effect.fail(new Error('MCP server name must be nonempty.'));
    }
    const path = joinArtifact(targetRoot, runtime.manifestPath);
    return Effect.flatMap(readFileString(path), (contents) => Effect.suspend(() => {
      let document: unknown;
      try {
        document = parseJsonWithoutDuplicateKeys(contents);
      } catch {
        return Effect.fail(new Error(`MCP manifest for target ${JSON.stringify(target)} is not valid JSON.`));
      }
      const result = readTargetMcpServer(runtime, document, name);
      if (result.status === 'missing') {
        return Effect.fail(new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(name)}.`));
      }
      if (result.status === 'invalid') {
        return Effect.fail(new Error(`MCP server ${JSON.stringify(name)} in target ${JSON.stringify(target)} is invalid.`));
      }
      return Effect.succeed(result.server);
    }));
  }

  #runtime(name: string): TargetMcpRuntimeContract {
    if (!this.#registry.has(name) || !this.#registry.supports(name, 'mcp')) {
      throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    }
    const runtime = this.#registry.mcpRuntime(name);
    if (runtime === undefined) {
      throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
    }
    return runtime;
  }

  #throwIfStderrExceeded(capture: StderrCapture | undefined): void {
    if (capture?.exceeded()) {
      throw new RangeError('MCP server stderr exceeds the 1 MB limit.');
    }
  }

  #transport(
    server: ModernMcpServer,
    runtime: TargetMcpRuntimeContract,
    target: string,
    targetRoot: string,
    roots: { readonly pluginData: string; readonly pluginRoot: string; readonly workspaceRoot: string },
    setCapture: (capture: StderrCapture) => void,
  ): Transport {
    const resolved = resolveMcpPathTokens({ roots, runtime, server, target });
    if (resolved.kind === 'stdio') {
      const cwd = resolved.cwd === undefined
        ? undefined
        : resolveContained(targetRoot, resolved.cwd);
      const env = resolved.env;
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const transport = this.#createStdioTransport({
        args: [...resolved.args],
        command: resolved.command,
        ...(cwd === undefined ? {} : { cwd }),
        env: { ...inheritedEnv, ...env },
        stderr: 'pipe',
      });
      setCapture(captureStderr(transport.stderr, () => transport.close()));
      return transport;
    }

    const url = new URL(resolved.url);
    return this.#createStreamableHttpTransport(
      url,
      { ...(resolved.headers === undefined ? {} : { headers: { ...resolved.headers } }) },
    );
  }
}
