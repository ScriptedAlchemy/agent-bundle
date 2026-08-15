import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { assertInside } from '../core/paths.ts';

export type McpRuntimeValueField = 'args' | 'cwd' | 'env' | 'headers' | 'url';

export interface McpRuntimeRoots {
  readonly pluginData: string;
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
}

export interface ModernMcpStdioServer {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
}

export interface ModernMcpStreamableHttpServer {
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: 'streamable-http';
  readonly url: string;
}

export type ModernMcpServer = ModernMcpStdioServer | ModernMcpStreamableHttpServer;

export type ModernMcpServerReadResult =
  | Readonly<{ readonly server: ModernMcpServer; readonly status: 'found' }>
  | Readonly<{ readonly status: 'invalid' }>
  | Readonly<{ readonly status: 'missing' }>;

export interface McpRuntimeValueResolution {
  readonly diagnostics: readonly Diagnostic[];
  readonly value: string;
}

export interface TargetMcpRuntimeContract {
  readonly manifestPath: string;
  readModernServer(document: unknown, name: string): ModernMcpServerReadResult;
  resolveStdioArgument(value: string, roots: McpRuntimeRoots): string;
  resolveValue(
    field: McpRuntimeValueField,
    roots: McpRuntimeRoots,
    value: string,
  ): McpRuntimeValueResolution;
}

interface CreateTargetMcpRuntimeOptions {
  readonly manifestPath: string;
  readonly remoteTypes: readonly string[];
  readonly resolveStdioArgument?: TargetMcpRuntimeContract['resolveStdioArgument'];
  readonly resolveValue: TargetMcpRuntimeContract['resolveValue'];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  const record: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (typeof item !== 'string') return undefined;
    record[key] = item;
  }
  return record;
};

const noRelativeArgumentResolution: TargetMcpRuntimeContract['resolveStdioArgument'] = (value) => value;

const stdioServer = (value: unknown): ModernMcpStdioServer | undefined => {
  if (!isRecord(value)) return undefined;
  const env = value.env === undefined ? undefined : stringRecord(value.env);
  if (
    typeof value.command !== 'string' ||
    (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== 'string'))) ||
    (value.cwd !== undefined && typeof value.cwd !== 'string') ||
    (value.env !== undefined && env === undefined)
  ) return undefined;
  return {
    args: value.args === undefined ? [] : [...value.args],
    command: value.command,
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(env === undefined ? {} : { env }),
    kind: 'stdio',
  };
};

const streamableHttpServer = (
  value: unknown,
  remoteTypes: ReadonlySet<string>,
): ModernMcpStreamableHttpServer | undefined => {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  const headers = value.headers === undefined ? undefined : stringRecord(value.headers);
  if (
    !remoteTypes.has(value.type) ||
    typeof value.url !== 'string' ||
    (value.headers !== undefined && headers === undefined)
  ) return undefined;
  return {
    ...(headers === undefined ? {} : { headers }),
    kind: 'streamable-http',
    url: value.url,
  };
};

const readModernMcpServer = (
  document: unknown,
  name: string,
  remoteTypes: ReadonlySet<string>,
): ModernMcpServerReadResult => {
  if (!isRecord(document) || !isRecord(document.mcpServers)) return { status: 'invalid' };
  if (!Object.hasOwn(document.mcpServers, name)) return { status: 'missing' };
  const value = document.mcpServers[name];
  if (!isRecord(value) || typeof value.type !== 'string') return { status: 'invalid' };

  if (value.type === 'stdio') {
    const server = stdioServer(value);
    return server === undefined ? { status: 'invalid' } : { server, status: 'found' };
  }

  const server = streamableHttpServer(value, remoteTypes);
  return server === undefined ? { status: 'invalid' } : { server, status: 'found' };
};

const validModernServer = (value: unknown): value is ModernMcpServer => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'stdio') return stdioServer(value) !== undefined;
  return value.kind === 'streamable-http' && streamableHttpServer(
    { ...value, type: 'streamable-http' },
    new Set(['streamable-http']),
  ) !== undefined;
};

/** Safely invokes and validates a target-provided modern MCP manifest reader. */
export const readTargetMcpServer = (
  runtime: TargetMcpRuntimeContract,
  document: unknown,
  name: string,
): ModernMcpServerReadResult => {
  try {
    const result: unknown = runtime.readModernServer(document, name);
    if (!isRecord(result) || typeof result.status !== 'string') return { status: 'invalid' };
    if (result.status === 'missing' || result.status === 'invalid') return { status: result.status };
    if (result.status !== 'found' || !validModernServer(result.server)) return { status: 'invalid' };
    return { server: result.server, status: 'found' };
  } catch {
    return { status: 'invalid' };
  }
};

export const createTargetMcpRuntime = ({
  manifestPath,
  remoteTypes,
  resolveStdioArgument = noRelativeArgumentResolution,
  resolveValue,
}: CreateTargetMcpRuntimeOptions): TargetMcpRuntimeContract => {
  const nativeRemoteTypes = new Set(remoteTypes);
  return Object.freeze({
    manifestPath,
    readModernServer: (document: unknown, name: string) => readModernMcpServer(document, name, nativeRemoteTypes),
    resolveStdioArgument,
    resolveValue,
  });
};

export const resolveTargetRelativeStdioArgument: TargetMcpRuntimeContract['resolveStdioArgument'] = (
  value,
  roots,
): string => value.startsWith('./')
  ? assertInside(roots.pluginRoot, resolve(roots.pluginRoot, value))
  : value;
