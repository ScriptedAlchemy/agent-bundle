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

interface ParsedRemoteMcpServer {
  readonly headers?: Readonly<Record<string, string>>;
  readonly type: string;
  readonly url: string;
}

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
  readonly remoteTypes: readonly string[];
  readonly validatedButNonModernRemoteTypes?: readonly string[];
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

const hasDataKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (!plainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return Reflect.ownKeys(value).length >= required.length &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};

const ownDataValue = (value: object, key: string): OwnDataValue | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { found: false, value: undefined };
  return 'value' in descriptor ? { found: true, value: descriptor.value } : undefined;
};

const canonicalArrayValues = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined || !('value' in length) ||
    typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 ||
    Reflect.ownKeys(value).length !== length.value + 1
  ) {
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
};

const stringArray = (value: unknown): readonly string[] | undefined => {
  const values = canonicalArrayValues(value);
  if (values === undefined) return undefined;
  const strings: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') return undefined;
    strings.push(entry);
  }
  return Object.freeze(strings);
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

const remoteServer = (value: unknown): ParsedRemoteMcpServer | undefined => {
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
    (headers.found && headers.value !== undefined && copiedHeaders === undefined)
  ) return undefined;
  return Object.freeze({
    ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
    type: type.value,
    url: url.value,
  });
};

const readModernMcpServers = (
  document: unknown,
  remoteTypes: ReadonlySet<string>,
  validatedButNonModernRemoteTypes: ReadonlySet<string>,
): ModernMcpServersReadResult => {
  if (!plainDataRecord(document)) return { status: 'invalid' };
  const servers = ownDataValue(document, 'mcpServers');
  if (servers === undefined || !servers.found || !plainDataRecord(servers.value)) return { status: 'invalid' };
  const entries: ModernMcpServerEntry[] = [];
  for (const name of Object.keys(servers.value).sort((left, right) => left.localeCompare(right))) {
    const value = servers.value[name];
    if (!plainDataRecord(value)) return { status: 'invalid' };
    const type = ownDataValue(value, 'type');
    if (type === undefined || !type.found || typeof type.value !== 'string') return { status: 'invalid' };
    if (type.value === 'stdio') {
      const server = stdioServer(value);
      if (server === undefined) return { status: 'invalid' };
      entries.push(Object.freeze({ name, server }));
      continue;
    }

    const server = remoteServer(value);
    if (server === undefined) return { status: 'invalid' };
    if (remoteTypes.has(server.type)) {
      entries.push(Object.freeze({
        name,
        server: Object.freeze({
          ...(server.headers === undefined ? {} : { headers: server.headers }),
          kind: 'streamable-http',
          url: server.url,
        }),
      }));
      continue;
    }
    if (validatedButNonModernRemoteTypes.has(server.type)) continue;
    return { status: 'invalid' };
  }
  return Object.freeze({ servers: Object.freeze(entries), status: 'found' });
};

const snapshotModernServer = (value: unknown): ModernMcpServer | undefined => {
  if (!plainDataRecord(value)) return undefined;
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
  if (!hasDataKeys(value, ['kind', 'url'], ['headers'])) return undefined;
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

const snapshotModernServers = (value: unknown): readonly ModernMcpServerEntry[] | undefined => {
  const entries = canonicalArrayValues(value);
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
  if (!plainDataRecord(value)) return undefined;
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
  remoteTypes,
  validatedButNonModernRemoteTypes = [],
  resolveStdioArgument = noRelativeArgumentResolution,
  resolveValue,
}: CreateTargetMcpRuntimeOptions): TargetMcpRuntimeContract => {
  const nativeRemoteTypes = new Set(remoteTypes);
  const nativeValidatedButNonModernRemoteTypes = new Set(validatedButNonModernRemoteTypes);
  return Object.freeze({
    manifestPath,
    readModernServers: (document: unknown) => readModernMcpServers(
      document,
      nativeRemoteTypes,
      nativeValidatedButNonModernRemoteTypes,
    ),
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
