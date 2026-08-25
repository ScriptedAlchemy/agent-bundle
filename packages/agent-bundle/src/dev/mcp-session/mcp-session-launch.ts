import { isAbsolute, resolve } from 'node:path';

import { assertInside } from '../../core/paths.ts';
import { resolveMcpPathTokens } from '../../services/mcp-path-tokens.ts';
import type { ModernMcpServer, TargetMcpRuntimeContract } from '../../services/mcp-runtime.ts';
import type { McpSessionInspectorConfig } from './mcp-session-protocol.ts';

export interface ResolvedMcpSessionServer {
  readonly runtime: TargetMcpRuntimeContract;
  readonly server: ModernMcpServer;
  readonly target: string;
  readonly targetRoot: string;
}

export interface ResolvedMcpStdioLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inspectorEnv: Readonly<Record<string, string>>;
  readonly kind: 'stdio';
}

export interface ResolvedMcpRemoteLaunch {
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: 'streamable-http';
  readonly url: URL;
}

export type ResolvedMcpSessionLaunch = ResolvedMcpStdioLaunch | ResolvedMcpRemoteLaunch;

export interface ResolveMcpSessionLaunchOptions {
  readonly pluginData: string;
  readonly resolved: ResolvedMcpSessionServer;
  readonly workspaceRoot: string;
}

const inspectorEnvironmentAllowlist = new Set(['FORCE_COLOR', 'LANG', 'LC_ALL', 'NO_COLOR', 'TZ']);
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

export const resolveMcpSessionLaunch = (options: ResolveMcpSessionLaunchOptions): ResolvedMcpSessionLaunch => {
  const resolved = resolveMcpPathTokens({
    roots: {
      pluginData: options.pluginData,
      pluginRoot: options.resolved.targetRoot,
      workspaceRoot: options.workspaceRoot,
    },
    runtime: options.resolved.runtime,
    server: options.resolved.server,
    target: options.resolved.target,
  });
  if (resolved.kind === 'stdio') {
    const cwd = resolved.cwd === undefined
      ? undefined
      : assertInside(options.resolved.targetRoot, resolve(options.resolved.targetRoot, resolved.cwd));
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    return Object.freeze({
      args: Object.freeze([...resolved.args]),
      command: resolved.command,
      ...(cwd === undefined ? {} : { cwd }),
      env: Object.freeze({ ...inheritedEnv, ...(resolved.env ?? {}) }),
      inspectorEnv: inspectorEnvironment(resolved.env),
      kind: 'stdio',
    });
  }

  const headers = resolved.headers === undefined ? undefined : Object.freeze({ ...resolved.headers });
  return Object.freeze({
    ...(headers === undefined ? {} : { headers }),
    kind: 'streamable-http',
    url: new URL(resolved.url),
  });
};

export const mcpSessionInspectorConfig = (
  launch: ResolvedMcpSessionLaunch,
  targetRoot: string,
): McpSessionInspectorConfig => {
  if (launch.kind === 'stdio') {
    return Object.freeze({
      launch: Object.freeze({
        args: inspectorArguments(launch.args, targetRoot),
        command: inspectorCommand(launch.command),
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
        env: launch.inspectorEnv,
        kind: 'stdio',
      }),
      origin: 'artifact',
    });
  }
  return Object.freeze({
    launch: Object.freeze({ kind: launch.kind, url: inspectorUrl(launch.url) }),
    origin: 'artifact',
  });
};
