import { resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { dataArrayValues, hasDataKeys, isPlainDataRecord, ownDataValue } from '../core/strict-json.ts';
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

export interface ModernMcpServerEntry {
  readonly name: string;
  readonly server: ModernMcpServer;
}

export type ModernMcpServersReadResult =
  | Readonly<{ readonly servers: readonly ModernMcpServerEntry[]; readonly status: 'found' }>
  | Readonly<{ readonly status: 'invalid' }>;

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
  readModernServers(document: unknown): ModernMcpServersReadResult;
  resolveStdioArgument(value: string, roots: McpRuntimeRoots): string;
  resolveValue(
    field: McpRuntimeValueField,
    roots: McpRuntimeRoots,
    value: string,
  ): McpRuntimeValueResolution;
}

interface CreateTargetMcpRuntimeOptions {
  readonly manifestPath: string;
  /**
   * Resolves a server record's transport type. Defaults to reading the
   * record's `type` field; targets whose document format is
   * shape-discriminated (for example Cursor's typeless entries) supply their
   * own resolver.
   */
  readonly readServerType?: (server: unknown) => string | undefined;
  readonly remoteTypes: readonly string[];
  readonly validatedButNonModernRemoteTypes?: readonly string[];
  readonly resolveStdioArgument?: TargetMcpRuntimeContract['resolveStdioArgument'];
  readonly resolveValue: TargetMcpRuntimeContract['resolveValue'];
}

const stringArray = (value: unknown): readonly string[] | undefined => {
  const values = dataArrayValues(value);
  if (values === undefined) return undefined;
  const strings: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') return undefined;
    strings.push(entry);
  }
  return Object.freeze(strings);
};

const stringRecord = (value: unknown): Readonly<Record<string, string>> | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
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
  if (!isPlainDataRecord(value)) return undefined;
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

const streamableHttpServer = (value: unknown): ModernMcpStreamableHttpServer | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
  const headers = ownDataValue(value, 'headers');
  const url = ownDataValue(value, 'url');
  if (headers === undefined || url === undefined || !url.found || typeof url.value !== 'string') return undefined;
  const copiedHeaders = headers.found && headers.value !== undefined ? stringRecord(headers.value) : undefined;
  if (headers.found && headers.value !== undefined && copiedHeaders === undefined) return undefined;
  return Object.freeze({
    ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
    kind: 'streamable-http',
    url: url.value,
  });
};

const typedServerType = (server: unknown): string | undefined => {
  if (!isPlainDataRecord(server)) return undefined;
  const type = ownDataValue(server, 'type');
  if (type === undefined || !type.found || typeof type.value !== 'string') return undefined;
  return type.value;
};

const readModernMcpServers = (
  document: unknown,
  remoteTypes: ReadonlySet<string>,
  validatedButNonModernRemoteTypes: ReadonlySet<string>,
  readServerType: (server: unknown) => string | undefined,
): ModernMcpServersReadResult => {
  if (!isPlainDataRecord(document)) return { status: 'invalid' };
  const servers = ownDataValue(document, 'mcpServers');
  if (servers === undefined || !servers.found || !isPlainDataRecord(servers.value)) return { status: 'invalid' };
  const validatedRemoteTypes = new Set([...remoteTypes, ...validatedButNonModernRemoteTypes]);
  const entries: ModernMcpServerEntry[] = [];
  for (const name of Object.keys(servers.value).sort((left, right) => left.localeCompare(right))) {
    const value = servers.value[name];
    if (!isPlainDataRecord(value)) return { status: 'invalid' };
    const type = readServerType(value);
    if (type === undefined) return { status: 'invalid' };
    const server = type === 'stdio'
      ? stdioServer(value)
      : validatedRemoteTypes.has(type)
        ? streamableHttpServer(value)
        : undefined;
    if (server === undefined) return { status: 'invalid' };
    if (type !== 'stdio' && validatedButNonModernRemoteTypes.has(type)) continue;
    entries.push(Object.freeze({ name, server }));
  }
  return Object.freeze({ servers: Object.freeze(entries), status: 'found' });
};

const snapshotModernServer = (value: unknown): ModernMcpServer | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
  const kind = ownDataValue(value, 'kind');
  if (kind === undefined || !kind.found || typeof kind.value !== 'string') return undefined;

  if (kind.value === 'stdio') {
    if (!hasDataKeys(value, ['args', 'command', 'kind'], ['cwd', 'env'])) return undefined;
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
  }

  if (kind.value !== 'streamable-http') return undefined;
  if (!hasDataKeys(value, ['kind', 'url'], ['headers'])) return undefined;
  const headers = ownDataValue(value, 'headers');
  const url = ownDataValue(value, 'url');
  if (headers === undefined || url === undefined || !url.found || typeof url.value !== 'string') return undefined;
  const copiedHeaders = headers.found && headers.value !== undefined ? stringRecord(headers.value) : undefined;
  if (headers.found && headers.value !== undefined && copiedHeaders === undefined) return undefined;
  return Object.freeze({
    ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
    kind: 'streamable-http',
    url: url.value,
  });
};

const snapshotModernServers = (value: unknown): readonly ModernMcpServerEntry[] | undefined => {
  const entries = dataArrayValues(value);
  if (entries === undefined) return undefined;
  const names = new Set<string>();
  const servers: ModernMcpServerEntry[] = [];
  for (const entry of entries) {
    if (!hasDataKeys(entry, ['name', 'server'])) return undefined;
    const name = ownDataValue(entry, 'name');
    const server = ownDataValue(entry, 'server');
    if (
      name === undefined || !name.found || typeof name.value !== 'string' || name.value.length === 0 ||
      server === undefined || !server.found || names.has(name.value)
    ) return undefined;
    const snapshot = snapshotModernServer(server.value);
    if (snapshot === undefined) return undefined;
    names.add(name.value);
    servers.push(Object.freeze({ name: name.value, server: snapshot }));
  }
  servers.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(servers);
};

const snapshotModernServersResult = (value: unknown): ModernMcpServersReadResult | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
  const status = ownDataValue(value, 'status');
  if (status === undefined || !status.found || typeof status.value !== 'string') return undefined;
  if (status.value === 'invalid') {
    return hasDataKeys(value, ['status']) ? Object.freeze({ status: 'invalid' }) : undefined;
  }
  if (status.value !== 'found') return undefined;
  if (!hasDataKeys(value, ['servers', 'status'])) return undefined;
  const servers = ownDataValue(value, 'servers');
  if (servers === undefined || !servers.found) return undefined;
  const snapshot = snapshotModernServers(servers.value);
  return snapshot === undefined ? undefined : Object.freeze({ servers: snapshot, status: 'found' });
};

/** Safely invokes and snapshots a target-provided modern MCP manifest reader. */
export const readTargetMcpServers = (
  runtime: TargetMcpRuntimeContract,
  document: unknown,
): ModernMcpServersReadResult => {
  try {
    return snapshotModernServersResult(runtime.readModernServers(document)) ?? Object.freeze({ status: 'invalid' });
  } catch {
    // Target manifest readers are untrusted; a throw is an invalid document.
    return Object.freeze({ status: 'invalid' });
  }
};

/** Safely invokes and validates a target-provided modern MCP manifest reader. */
export const readTargetMcpServer = (
  runtime: TargetMcpRuntimeContract,
  document: unknown,
  name: string,
): ModernMcpServerReadResult => {
  const result = readTargetMcpServers(runtime, document);
  if (result.status === 'invalid') return Object.freeze({ status: 'invalid' });
  const found = result.servers.find((entry) => entry.name === name);
  return found === undefined
    ? Object.freeze({ status: 'missing' })
    : Object.freeze({ server: found.server, status: 'found' });
};

export const createTargetMcpRuntime = ({
  manifestPath,
  readServerType = typedServerType,
  remoteTypes,
  validatedButNonModernRemoteTypes = [],
  resolveStdioArgument = noRelativeArgumentResolution,
  resolveValue,
}: CreateTargetMcpRuntimeOptions): TargetMcpRuntimeContract => {
  const nativeRemoteTypes = new Set(remoteTypes);
  const nonModernRemoteTypes = new Set(validatedButNonModernRemoteTypes);
  return Object.freeze({
    manifestPath,
    readModernServers: (document: unknown) =>
      readModernMcpServers(document, nativeRemoteTypes, nonModernRemoteTypes, readServerType),
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
