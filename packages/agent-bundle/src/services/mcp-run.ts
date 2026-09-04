import { loadEnv } from '@rsbuild/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { Effect, FileSystem } from 'effect';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { sha256Hex } from '../core/digest.ts';
import { joinArtifact, resolveContained } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { runPromise } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { resolveMcpPathTokens } from './mcp-path-tokens.ts';
import { forwardingSignals } from './mcp-run-signals.ts';
import {
  readTargetMcpServer,
  type ModernMcpStdioServer,
  type TargetMcpRuntimeContract,
} from './mcp-runtime.ts';

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
  /**
   * Root that plugin-root path tokens in *env values* expand to — the
   * durable-state anchors like `AGENT_BUNDLE_PLUGIN_ROOT`. Defaults to
   * `workspaceRoot`: under `mcp run` the artifact is an ephemeral build
   * product, so anchoring durable state on it would fragment that state per
   * rebuild. Point it back at the artifact target root for a byte-faithful
   * rehearsal of a copied-artifact launch.
   */
  readonly envPluginRoot?: string;
  /** Durable per-server state root replacing the plugin-data path token. */
  readonly pluginDataRoot: string;
  readonly registry?: TargetRegistry;
  readonly server: string;
  readonly target: string;
  readonly workspaceRoot: string;
}

const safeStateSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

/**
 * MCP server names are consumer input with no path-shape guarantee: a name
 * containing separators or leading dots (for example `../shared`) must never
 * traverse out of the per-server state root. Plain single-segment names pass
 * through untouched; anything else becomes a content-addressed segment.
 */
export const mcpServerStateDirectory = (server: string): string =>
  safeStateSegment.test(server) ? server : `server-${sha256Hex(server).slice(0, 16)}`;

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
    document = parseJsonWithoutDuplicateKeys(await runWithPlatform(readFileString(manifestPath)));
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

  /**
   * Per-field plugin-root split: `args`/`cwd` must stay artifact-rooted
   * (`args[0]` is the content-hashed bundle inside the target root), but env
   * values are durable-state anchors, so their plugin-root tokens expand to
   * the durable `envPluginRoot` instead of the rebuildable artifact.
   */
  const envPluginRoot = resolve(options.envPluginRoot ?? options.workspaceRoot);
  const launchRuntime: TargetMcpRuntimeContract = {
    manifestPath: runtime.manifestPath,
    readModernServers: (document) => runtime.readModernServers(document),
    resolveStdioArgument: (value, roots) => runtime.resolveStdioArgument(value, roots),
    resolveValue: (field, roots, value) => {
      if (field !== 'env') return runtime.resolveValue(field, roots, value);
      const envRoots = { ...roots, pluginRoot: envPluginRoot };
      const resolution = runtime.resolveValue(field, envRoots, value);
      // Targets without token interpolation (Codex) serialize the anchor as
      // a `./` path instead: the target's own relative-argument rule
      // re-anchors it against the durable root the tokens expand to.
      return { ...resolution, value: runtime.resolveStdioArgument(resolution.value, envRoots) };
    },
  };
  const resolved = resolveMcpPathTokens({
    roots: {
      pluginData: resolve(options.pluginDataRoot),
      pluginRoot: targetRoot,
      workspaceRoot: resolve(options.workspaceRoot),
    },
    runtime: launchRuntime,
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

export interface McpLaunchEnvironmentOptions extends ResolveMcpStdioLaunchOptions {
  /**
   * Explicit `.env` files replacing the conventional workspace-root set.
   * Files use Node's `--env-file` dialect and load in order, later files
   * winning on collision; relative paths resolve from the working directory.
   * A named file that cannot be read is an error, never a silent skip.
   */
  readonly envFiles?: readonly string[];
  /** Set false to launch without any `.env` layer. */
  readonly loadEnvFiles?: boolean;
  /** Configuration mode selecting `.env.<mode>` variants of the conventional set. */
  readonly mode?: string;
}

export interface RunMcpForegroundOptions extends McpLaunchEnvironmentOptions {
  /** Injectable only to make foreground process behavior deterministic in tests. */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly stdio: 'inherit' },
  ) => ChildProcess;
}

/**
 * The `.env` layer of the launch environment: explicit `--env-file` paths
 * when given, otherwise rsbuild's `loadEnv` convention (`.env`, `.env.local`,
 * `.env.<mode>`, `.env.<mode>.local`) at the workspace root — the same files
 * `createRslib` reads for the same consumers at build time. Loading targets a
 * scratch object so the real `process.env` is never mutated; `processEnv`
 * still seeds `${VAR}` interpolation inside env-file values.
 */
const loadLaunchFileEnv = async (
  options: McpLaunchEnvironmentOptions,
  processEnv: Readonly<Record<string, string>>,
): Promise<Record<string, string>> => {
  if (options.loadEnvFiles === false) return {};
  if (options.envFiles !== undefined && options.envFiles.length > 0) {
    const merged: Record<string, string> = {};
    for (const file of options.envFiles) {
      const path = resolve(file);
      let contents: string;
      try {
        contents = await runWithPlatform(readFileString(path));
      } catch {
        throw new Error(`Cannot read env file ${JSON.stringify(path)}.`);
      }
      Object.assign(merged, parseEnv(contents));
    }
    return merged;
  }
  return loadEnv({
    cwd: resolve(options.workspaceRoot),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    processEnv: { ...processEnv },
  }).parsed;
};

/**
 * The complete launch of one stdio server out of a built artifact: the
 * resolved command plus the layered environment `mcp run` and `serve-app`
 * share. Precedence, lowest to highest: manifest env (declared entries plus
 * the injected plugin-root anchor, path tokens expanded), the `.env` file
 * layer, then the operator's real `process.env` — an exported variable
 * always beats every file- or manifest-declared value. The plugin-data root
 * is created so the server's durable-state anchor exists before it starts.
 */
export const resolveMcpLaunchEnvironment = async (
  options: McpLaunchEnvironmentOptions,
): Promise<ResolvedMcpStdioLaunch> => {
  const launch = await resolveMcpStdioLaunch(options);
  await runWithPlatform(Effect.flatMap(
    FileSystem.FileSystem,
    (fs) => fs.makeDirectory(resolve(options.pluginDataRoot), { recursive: true }),
  ));
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const fileEnv = await loadLaunchFileEnv(options, inheritedEnv);
  return Object.freeze({
    args: launch.args,
    command: launch.command,
    cwd: launch.cwd,
    env: Object.freeze({ ...launch.env, ...fileEnv, ...inheritedEnv }),
  });
};

/** The child's exit code, or 128 + signal number for the two forwarded signals. */
const childExitCode = (child: ChildProcess): Promise<number> => new Promise<number>((resolveExit, rejectExit) => {
  child.once('error', rejectExit);
  child.once('exit', (code, signal) => {
    if (code !== null) {
      resolveExit(code);
      return;
    }
    resolveExit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
});

/**
 * Resolves the server's generated entry from the built artifact and runs it
 * in the foreground with inherited stdio. SIGINT/SIGTERM forward to the
 * child (a scoped resource, `forwardingSignals`, released however the wait
 * ends); the child's exit code (or 128 + signal number) is returned. The
 * launch environment is {@link resolveMcpLaunchEnvironment}'s.
 */
export const runMcpForeground = async (options: RunMcpForegroundOptions): Promise<number> => {
  const launch = await resolveMcpLaunchEnvironment(options);
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    env: { ...launch.env },
    stdio: 'inherit',
  });

  return runPromise(Effect.scoped(Effect.gen(function* () {
    yield* forwardingSignals(child);
    return yield* liftPromise(() => childExitCode(child));
  })));
};
