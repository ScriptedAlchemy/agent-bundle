import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { assertInside, joinArtifact } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { resolveMcpPathTokens } from './mcp-path-tokens.ts';
import { readTargetMcpServer, type ModernMcpStdioServer } from './mcp-runtime.ts';

/**
 * The foreground MCP server runner behind `agent-bundle mcp run`: it resolves
 * the content-hashed generated entry out of the built target manifest — the
 * job consumers previously solved with bash launchers parsing `mcp.json` —
 * and executes it with inherited stdio until the server exits.
 */

export interface ResolvedMcpStdioLaunch {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ResolveMcpStdioLaunchOptions {
  readonly artifact: string;
  /** Durable per-server state root replacing the plugin-data path token. */
  readonly pluginDataRoot: string;
  readonly registry?: TargetRegistry;
  readonly server: string;
  readonly target: string;
  readonly workspaceRoot: string;
}

const resolveContained = (root: string, path: string): string =>
  isAbsolute(path) ? path : assertInside(root, resolve(root, path));

export const resolveMcpStdioLaunch = async (
  options: ResolveMcpStdioLaunchOptions,
): Promise<ResolvedMcpStdioLaunch> => {
  if (options.server.trim().length === 0) {
    throw new Error('MCP server name must be nonempty.');
  }
  const registry = options.registry ?? createDefaultRegistry();
  if (!registry.has(options.target) || !registry.supports(options.target, 'mcp')) {
    throw new Error(`Unsupported MCP target ${JSON.stringify(options.target)}.`);
  }
  const runtime = registry.mcpRuntime(options.target);
  if (runtime === undefined) {
    throw new Error(`Unsupported MCP target ${JSON.stringify(options.target)}.`);
  }

  const artifact = resolve(options.artifact);
  const diagnostics = await validateArtifact({ artifactRoot: artifact, registry });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw new DiagnosticError(errors);

  const targetRoot = joinArtifact(artifact, options.target);
  const manifestPath = joinArtifact(targetRoot, runtime.manifestPath);
  let document: unknown;
  try {
    document = parseJsonWithoutDuplicateKeys(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(`MCP manifest for target ${JSON.stringify(options.target)} is not valid JSON.`);
  }
  const result = readTargetMcpServer(runtime, document, options.server);
  if (result.status === 'missing') {
    throw new Error(`Expected exactly one ${options.target} MCP server matching ${JSON.stringify(options.server)}.`);
  }
  if (result.status === 'invalid') {
    throw new Error(`MCP server ${JSON.stringify(options.server)} in target ${JSON.stringify(options.target)} is invalid.`);
  }

  const resolved = resolveMcpPathTokens({
    roots: {
      pluginData: resolve(options.pluginDataRoot),
      pluginRoot: targetRoot,
      workspaceRoot: resolve(options.workspaceRoot),
    },
    runtime,
    server: result.server,
    target: options.target,
  });
  if (resolved.kind !== 'stdio') {
    throw new Error(`MCP server ${JSON.stringify(options.server)} is not a stdio server; only stdio servers can run in the foreground.`);
  }
  const stdio = resolved as ModernMcpStdioServer;
  return Object.freeze({
    args: Object.freeze([...stdio.args]),
    command: stdio.command,
    cwd: stdio.cwd === undefined ? targetRoot : resolveContained(targetRoot, stdio.cwd),
    env: Object.freeze({ ...stdio.env }),
  });
};

export interface RunMcpForegroundOptions extends ResolveMcpStdioLaunchOptions {
  /** Injectable only to make foreground process behavior deterministic in tests. */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly stdio: 'inherit' },
  ) => ChildProcess;
}

/**
 * Resolves the server's generated entry from the built artifact and runs it
 * in the foreground with inherited stdio. SIGINT/SIGTERM forward to the
 * child; the child's exit code (or 128 + signal number) is returned.
 */
export const runMcpForeground = async (options: RunMcpForegroundOptions): Promise<number> => {
  const launch = await resolveMcpStdioLaunch(options);
  await mkdir(resolve(options.pluginDataRoot), { recursive: true });
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...inheritedEnv, ...launch.env },
    stdio: 'inherit',
  });

  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    return await new Promise<number>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => {
        if (code !== null) {
          resolveExit(code);
          return;
        }
        resolveExit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
      });
    });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
};
