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

interface OwnDataValue {
  readonly found: boolean;
  readonly value: unknown;
}

const plainDataRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
};

const ownDataValue = (value: object, key: string): OwnDataValue | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { found: false, value: undefined };
  return 'value' in descriptor ? { found: true, value: descriptor.value } : undefined;
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))
    ) return undefined;
  }
  const copy: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
};

const stringRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
  if (!plainDataRecord(value)) return undefined;
  const copy: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return undefined;
    copy[key] = descriptor.value;
  }
  return Object.freeze(copy);
};

const noRelativeArgumentResolution: TargetMcpRuntimeContract['resolveStdioArgument'] = (value) => value;

const stdioServer = (value: unknown): ModernMcpStdioServer | undefined => {
  if (!plainDataRecord(value)) return undefined;
  const args = ownDataValue(value, 'args');
  const command = ownDataValue(value, 'command');
  const cwd = ownDataValue(value, 'cwd');
  const env = ownDataValue(value, 'env');
  if (
    args === undefined || command === undefined || cwd === undefined || env === undefined ||
    !command.found || typeof command.value !== 'string'
  ) return undefined;
  const copiedArgs = args.found && args.value !== undefined ? stringArray(args.value) : Object.freeze([]);
  const cwdValue = cwd.found && cwd.value !== undefined ? cwd.value : undefined;
  const copiedEnv = env.found && env.value !== undefined ? stringRecord(env.value) : undefined;
  if (
    copiedArgs === undefined ||
    (cwdValue !== undefined && typeof cwdValue !== 'string') ||
    (env.found && env.value !== undefined && copiedEnv === undefined)
  ) return undefined;
  return Object.freeze({
    args: copiedArgs,
    command: command.value,
    ...(cwdValue === undefined ? {} : { cwd: cwdValue }),
    ...(copiedEnv === undefined ? {} : { env: copiedEnv }),
    kind: 'stdio',
  });
};

const streamableHttpServer = (
  value: unknown,
  remoteTypes: ReadonlySet<string>,
): ModernMcpStreamableHttpServer | undefined => {
  if (!plainDataRecord(value)) return undefined;
  const type = ownDataValue(value, 'type');
  const headers = ownDataValue(value, 'headers');
  const url = ownDataValue(value, 'url');
  if (
    type === undefined || headers === undefined || url === undefined ||
    !type.found || typeof type.value !== 'string' || !url.found || typeof url.value !== 'string'
  ) return undefined;
  const copiedHeaders = headers.found && headers.value !== undefined ? stringRecord(headers.value) : undefined;
  if (
    !remoteTypes.has(type.value) ||
    (headers.found && headers.value !== undefined && copiedHeaders === undefined)
  ) return undefined;
  return Object.freeze({
    ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
    kind: 'streamable-http',
    url: url.value,
  });
};

const readModernMcpServer = (
  document: unknown,
  name: string,
  remoteTypes: ReadonlySet<string>,
): ModernMcpServerReadResult => {
  if (!plainDataRecord(document)) return { status: 'invalid' };
  const servers = ownDataValue(document, 'mcpServers');
  if (servers === undefined || !servers.found || !plainDataRecord(servers.value)) return { status: 'invalid' };
  if (!Object.hasOwn(servers.value, name)) return { status: 'missing' };
  const value = servers.value[name];
  if (!plainDataRecord(value)) return { status: 'invalid' };
  const type = ownDataValue(value, 'type');
  if (type === undefined || !type.found || typeof type.value !== 'string') return { status: 'invalid' };

  if (type.value === 'stdio') {
    const server = stdioServer(value);
    return server === undefined ? { status: 'invalid' } : { server, status: 'found' };
  }

  const server = streamableHttpServer(value, remoteTypes);
  return server === undefined ? { status: 'invalid' } : { server, status: 'found' };
};

const snapshotModernServer = (value: unknown): ModernMcpServer | undefined => {
  if (!plainDataRecord(value)) return undefined;
  const kind = ownDataValue(value, 'kind');
  if (kind === undefined || !kind.found || typeof kind.value !== 'string') return undefined;

  if (kind.value === 'stdio') {
    const args = ownDataValue(value, 'args');
    const command = ownDataValue(value, 'command');
    const cwd = ownDataValue(value, 'cwd');
    const env = ownDataValue(value, 'env');
    if (
      args === undefined || !args.found ||
      command === undefined || !command.found || typeof command.value !== 'string' ||
      cwd === undefined ||
      env === undefined
    ) return undefined;
    const copiedArgs = stringArray(args.value);
    const commandValue = command.value;
    const cwdValue = cwd.found && cwd.value !== undefined ? cwd.value : undefined;
    const copiedEnv = env.found && env.value !== undefined ? stringRecord(env.value) : undefined;
    if (
      copiedArgs === undefined ||
      typeof commandValue !== 'string' ||
      (cwdValue !== undefined && typeof cwdValue !== 'string') ||
      (env.found && env.value !== undefined && copiedEnv === undefined)
    ) return undefined;
    return Object.freeze({
      args: copiedArgs,
      command: commandValue,
      ...(cwdValue === undefined ? {} : { cwd: cwdValue }),
      ...(copiedEnv === undefined ? {} : { env: copiedEnv }),
      kind: 'stdio',
    });
  }

  if (kind.value !== 'streamable-http') return undefined;
  const headers = ownDataValue(value, 'headers');
  const url = ownDataValue(value, 'url');
  if (headers === undefined || url === undefined || !url.found || typeof url.value !== 'string') return undefined;
  const urlValue = url.value;
  const copiedHeaders = headers.found && headers.value !== undefined ? stringRecord(headers.value) : undefined;
  if (typeof urlValue !== 'string' || (headers.found && headers.value !== undefined && copiedHeaders === undefined)) return undefined;
  return Object.freeze({
    ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
    kind: 'streamable-http',
    url: urlValue,
  });
};

/** Safely invokes and validates a target-provided modern MCP manifest reader. */
export const readTargetMcpServer = (
  runtime: TargetMcpRuntimeContract,
  document: unknown,
  name: string,
): ModernMcpServerReadResult => {
  try {
    const result: unknown = runtime.readModernServer(document, name);
    if (!plainDataRecord(result)) return Object.freeze({ status: 'invalid' });
    const status = ownDataValue(result, 'status');
    if (status === undefined || !status.found || typeof status.value !== 'string') return Object.freeze({ status: 'invalid' });
    if (status.value === 'missing' || status.value === 'invalid') return Object.freeze({ status: status.value });
    if (status.value !== 'found') return Object.freeze({ status: 'invalid' });
    const server = ownDataValue(result, 'server');
    if (server === undefined || !server.found) return Object.freeze({ status: 'invalid' });
    const snapshot = snapshotModernServer(server.value);
    return snapshot === undefined
      ? Object.freeze({ status: 'invalid' })
      : Object.freeze({ server: snapshot, status: 'found' });
  } catch {
    return Object.freeze({ status: 'invalid' });
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
