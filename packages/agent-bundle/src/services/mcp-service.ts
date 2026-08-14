import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Implementation,
  type ServerCapabilities,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, posix, resolve } from 'node:path';
import type { Stream } from 'node:stream';

import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';

const defaultTimeoutMs = 5_000;
const maxStderrBytes = 1_000_000;

type NativeTarget = 'portable' | 'codex' | 'claude';

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
  readonly env?: Record<string, string>;
  readonly stderr: 'pipe';
}

interface RemoteTransportOptions {
  readonly headers?: Record<string, string>;
}

interface McpServiceDependencies {
  readonly createClient?: () => McpClient;
  readonly createSseTransport?: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly createStdioTransport?: (options: StdioOptions) => StdioTransport;
  readonly createStreamableHttpTransport?: (
    url: URL,
    options: RemoteTransportOptions,
  ) => Transport;
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

interface StderrCapture {
  readonly exceeded: () => boolean;
  readonly output: () => string;
  readonly stop: () => void;
  readonly waitForEnd: (timeoutMs: number) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.entries(value).some(([key, item]) => typeof key !== 'string' || typeof item !== 'string')) {
    return undefined;
  }
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

const expandTokens = (
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
  let resolveFinished: (() => void) | undefined;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const onFinished = () => {
    if (finished) return;
    finished = true;
    resolveFinished?.();
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
        finishedPromise,
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
  readonly #createSseTransport: (url: URL, options: RemoteTransportOptions) => Transport;
  readonly #createStdioTransport: (options: StdioOptions) => StdioTransport;
  readonly #createStreamableHttpTransport: (
    url: URL,
    options: RemoteTransportOptions,
  ) => Transport;

  constructor(dependencies: McpServiceDependencies = {}) {
    this.#createClient = dependencies.createClient ?? (() => new Client({
      name: 'agent-bundle',
      version: '0.1.0',
    }));
    this.#createSseTransport = dependencies.createSseTransport ?? ((url, options) =>
      new SSEClientTransport(url, {
        eventSourceInit: options.headers === undefined ? undefined : {
          fetch: (input, init) => fetch(input, {
            ...init,
            headers: new Headers({ ...Object.fromEntries(new Headers(init?.headers)), ...options.headers }),
          }),
        },
        requestInit: options.headers === undefined ? undefined : { headers: options.headers },
      }));
    this.#createStdioTransport = dependencies.createStdioTransport ?? ((options) =>
      new StdioClientTransport(options));
    this.#createStreamableHttpTransport = dependencies.createStreamableHttpTransport ?? ((url, options) =>
      new StreamableHTTPClientTransport(url, {
        requestInit: options.headers === undefined ? undefined : { headers: options.headers },
      }));
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
    const target = this.#target(options.target);
    const diagnostics = await validateArtifact({ artifactRoot: artifact });
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) throw new DiagnosticError(errors);

    const targetRoot = joinArtifact(artifact, target);
    const server = await this.#server(artifact, target, options.server);
    const pluginData = await mkdtemp(resolve(tmpdir(), 'agent-bundle-mcp-'));
    const roots = {
      pluginData,
      pluginRoot: targetRoot,
      workspaceRoot: resolve(options.workspaceRoot ?? process.cwd()),
    };
    const requestOptions: RequestOptions = { signal: options.signal, timeout: timeoutFor(options) };
    const client = this.#createClient();
    let capture: StderrCapture | undefined;
    let closed = false;

    try {
      const transport = this.#transport(server, target, targetRoot, roots, (nextCapture) => {
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
        await rm(pluginData, { force: true, recursive: true });
      }
    }
  }

  #server(artifact: string, target: NativeTarget, name: string): Promise<ManifestServer> {
    if (name.trim().length === 0) {
      return Promise.reject(new Error('MCP server name must be nonempty.'));
    }
    const path = joinArtifact(artifact, `${target}/${manifestPath(target)}`);
    return readFile(path, 'utf8').then((contents) => {
      let document: unknown;
      try {
        document = JSON.parse(contents);
      } catch {
        throw new Error(`MCP manifest for target ${JSON.stringify(target)} is not valid JSON.`);
      }
      if (!isRecord(document) || !isRecord(document.mcpServers) || !Object.hasOwn(document.mcpServers, name)) {
        throw new Error(`Expected exactly one ${target} MCP server matching ${JSON.stringify(name)}.`);
      }
      const server = parseManifestServer(document.mcpServers[name]);
      if (server === undefined) {
        throw new Error(`MCP server ${JSON.stringify(name)} in target ${JSON.stringify(target)} is invalid.`);
      }
      return server;
    });
  }

  #target(name: string): NativeTarget {
    if (name === 'portable' || name === 'codex' || name === 'claude') return name;
    throw new Error(`Unsupported MCP target ${JSON.stringify(name)}.`);
  }

  #throwIfStderrExceeded(capture: StderrCapture | undefined): void {
    if (capture?.exceeded()) {
      throw new RangeError('MCP server stderr exceeds the 1 MB limit.');
    }
  }

  #transport(
    server: ManifestServer,
    target: NativeTarget,
    targetRoot: string,
    roots: { readonly pluginData: string; readonly pluginRoot: string; readonly workspaceRoot: string },
    setCapture: (capture: StderrCapture) => void,
  ): Transport {
    if (server.kind === 'stdio') {
      const cwd = server.cwd === undefined
        ? undefined
        : resolveContained(targetRoot, expandTokens(server.cwd, target, roots));
      const args = server.args.map((argument) => {
        const expanded = expandTokens(argument, target, roots);
        return target === 'codex' && expanded.startsWith('./')
          ? resolveContained(targetRoot, expanded)
          : expanded;
      });
      const env = server.env === undefined
        ? undefined
        : Object.fromEntries(Object.entries(server.env).map(([key, value]) => [
            key,
            expandTokens(value, target, roots),
          ]));
      const inheritedEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
      const transport = this.#createStdioTransport({
        args,
        command: expandTokens(server.command, target, roots),
        ...(cwd === undefined ? {} : { cwd }),
        ...(env === undefined ? {} : { env: { ...inheritedEnv, ...env } }),
        stderr: 'pipe',
      });
      setCapture(captureStderr(transport.stderr, () => transport.close()));
      return transport;
    }

    const headers = server.headers === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [
          key,
          expandTokens(value, target, roots),
        ]));
    const url = new URL(expandTokens(server.url, target, roots));
    return server.kind === 'streamable-http'
      ? this.#createStreamableHttpTransport(url, { ...(headers === undefined ? {} : { headers }) })
      : this.#createSseTransport(url, { ...(headers === undefined ? {} : { headers }) });
  }
}

const joinArtifact = (root: string, relativePath: string): string => {
  if (!safeArtifactPath(relativePath)) {
    throw new Error(`Unsafe artifact path ${JSON.stringify(relativePath)}.`);
  }
  return assertInside(root, resolve(root, relativePath));
};
