import { loadEnv } from '@rsbuild/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { Effect, FileSystem } from 'effect';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { resolveManifestHostFromRoot } from '../build/manifest-projection.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { joinArtifact, resolveContained } from '../core/paths.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { runPromise } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { OPERATOR_ENV_FILE_NONE, OPERATOR_ENV_FILE_VARIABLE } from '../launch-env.ts';
import { resolveMcpPathTokens } from './mcp-path-tokens.ts';
import { forwardingSignals } from './mcp-run-signals.ts';
import {
  readTargetMcpServer,
  type ModernMcpStdioServer,
  type TargetMcpRuntimeContract,
} from './mcp-runtime.ts';

export { mcpServerStateDirectory } from '../core/mcp-state-directory.ts';

/**
 * The foreground MCP server runner behind `agent-bundle mcp run`: it resolves
 * the compiled entry from the artifact manifest (`executables.mcpServers[]`)
 * and executes it with inherited stdio until the server exits, under the
 * launch line the selected host's MCP document projects for that record.
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
   * Root that plugin-root path tokens in *env values* expand to. Env-declared
   * `AGENT_BUNDLE_PLUGIN_ROOT` expands to the project root by default so the
   * derived state root (keyed by that root) survives artifact rebuilds;
   * `AGENT_BUNDLE_STATE_ROOT` in the operator environment overrides the state
   * location. Point it at the artifact target root for a byte-faithful
   * rehearsal of a copied-artifact launch.
   */
  readonly envPluginRoot?: string;
  /** Durable per-server state root replacing the plugin-data path token. */
  readonly pluginDataRoot: string;
  readonly registry?: TargetRegistry;
  readonly server: string;
  readonly target?: string;
  readonly workspaceRoot: string;
}

const hostMcpDocument = async (
  artifact: string,
  documentPath: string | undefined,
  runtime: TargetMcpRuntimeContract,
  host: string,
  server: string,
): Promise<ModernMcpStdioServer> => {
  if (documentPath === undefined) {
    throw new Error(`Target ${JSON.stringify(host)} projects no MCP document, so it cannot run MCP server ${JSON.stringify(server)}.`);
  }
  const manifestPath = joinArtifact(artifact, documentPath);
  let document: unknown;
  try {
    document = parseJsonWithoutDuplicateKeys(await runWithPlatform(readFileString(manifestPath)));
  } catch {
    throw new Error(`MCP manifest for target ${JSON.stringify(host)} is not valid JSON.`);
  }
  const result = readTargetMcpServer(runtime, document, server);
  if (result.status === 'missing') {
    throw new Error(`MCP manifest for target ${JSON.stringify(host)} names no server ${JSON.stringify(server)}.`);
  }
  if (result.status === 'invalid') {
    throw new Error(`MCP server ${JSON.stringify(server)} in target ${JSON.stringify(host)} is invalid.`);
  }
  if (result.server.kind !== 'stdio') {
    throw new Error(`MCP server ${JSON.stringify(server)} is not a stdio server; only stdio servers can run in the foreground.`);
  }
  return result.server;
};

export const resolveMcpStdioLaunch = async (
  options: ResolveMcpStdioLaunchOptions,
): Promise<ResolvedMcpStdioLaunch> => {
  if (options.server.trim().length === 0) {
    throw new Error('MCP server name must be nonempty.');
  }
  const registry = options.registry ?? createDefaultRegistry();
  const artifact = resolve(options.artifact);
  const diagnostics = await validateArtifact({ artifactRoot: artifact, registry });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw new DiagnosticError(errors);

  const resolved = await resolveManifestHostFromRoot(artifact, {
    capability: 'mcp',
    ...(options.target === undefined ? {} : { requested: options.target }),
    server: options.server,
  }, registry);
  const host = resolved.host;
  const row = resolved.manifest.executables.mcpServers.find(
    (server) => server.name === options.server && server.hosts.includes(host),
  );
  if (row === undefined) {
    throw new Error(`No projection of this artifact runs MCP server ${options.server}.`);
  }
  switch (row.kind) {
    case 'compiled':
    case 'prebuilt':
      break;
    case 'command':
    case 'remote':
      throw new Error(
        `MCP server ${options.server} is a ${row.kind} server; only compiled and prebuilt servers can be run from the artifact.`,
      );
    default: {
      const exhaustive: never = row.kind;
      throw new TypeError(`Unhandled MCP server kind ${String(exhaustive)}.`);
    }
  }
  if (row.launch === undefined) {
    throw new Error(
      `MCP server ${options.server} is a ${row.kind} server without a launch record; only compiled and prebuilt servers can be run from the artifact.`,
    );
  }
  const runtime = registry.mcpRuntime(host);
  if (runtime === undefined) {
    throw new Error(`Unsupported MCP target ${JSON.stringify(host)}.`);
  }

  // Every selected host reads the composite root as its plugin root (#555).
  const targetRoot = artifact;
  const projection = resolved.manifest.projections.find((candidate) => candidate.host === host);
  const hostStdio = await hostMcpDocument(
    targetRoot,
    projection?.documents.mcp,
    runtime,
    host,
    options.server,
  );

  /**
   * Per-field plugin-root split: `args`/`cwd` must stay artifact-rooted
   * (`args[0]` is the content-hashed bundle inside the target root), but env
   * values are durable-state anchors, so their plugin-root tokens expand to
   * the durable `envPluginRoot` instead of the rebuildable artifact.
   */
  const envPluginRoot = resolve(options.envPluginRoot ?? options.workspaceRoot);
  const launchRuntime: TargetMcpRuntimeContract = {
    manifestPath: projection?.documents.mcp ?? runtime.manifestPath,
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
  const roots = {
    pluginData: resolve(options.pluginDataRoot),
    pluginRoot: targetRoot,
    workspaceRoot: resolve(options.workspaceRoot),
  };
  joinArtifact(targetRoot, row.launch.entry);
  if (row.launch.worker !== undefined) {
    joinArtifact(targetRoot, row.launch.worker);
  }
  const hostLaunch = resolveMcpPathTokens({ roots, runtime: launchRuntime, server: hostStdio, target: host });
  if (hostLaunch.kind !== 'stdio') {
    throw new Error(`MCP server ${JSON.stringify(options.server)} is not a stdio server; only stdio servers can run in the foreground.`);
  }
  // Validation binds this host launch to the manifest record; preserve its argument order.
  return Object.freeze({
    args: Object.freeze([...hostLaunch.args]),
    command: hostLaunch.command,
    cwd: hostLaunch.cwd === undefined ? targetRoot : resolveContained(targetRoot, hostLaunch.cwd),
    env: Object.freeze({ ...hostLaunch.env }),
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
 * What the spawned entry's own operator `.env` layer (#469) should do. The
 * generated shell reads `<plugin root>/.env` and `.env.local` at launch, and
 * under `mcp run` the plugin root is the workspace root, so by default it
 * re-reads the same files this process already composed — a no-op, because
 * the layer fills only missing variables. `--env-file` and `--no-env` name a
 * different set, so they are handed down as `AGENT_BUNDLE_ENV_FILE` and the
 * shell follows the operator's choice instead of the convention. An operator
 * who exported `AGENT_BUNDLE_ENV_FILE` keeps it: `process.env` wins anyway.
 */
const operatorEnvFileForChild = (
  options: McpLaunchEnvironmentOptions,
): Readonly<Record<string, string>> => {
  if (options.loadEnvFiles === false) return { [OPERATOR_ENV_FILE_VARIABLE]: OPERATOR_ENV_FILE_NONE };
  if (options.envFiles !== undefined && options.envFiles.length > 0) {
    return { [OPERATOR_ENV_FILE_VARIABLE]: options.envFiles.map((file) => resolve(file)).join(delimiter) };
  }
  return {};
};

/**
 * The complete launch of one stdio server out of a built artifact: the
 * resolved command plus the layered environment `mcp run` and `serve-app`
 * share. Precedence, lowest to highest: manifest env (declared entries plus
 * the injected plugin-root anchor, path tokens expanded), the `.env` file
 * layer, the `AGENT_BUNDLE_ENV_FILE` hand-down for the child's own operator
 * layer (#469), then the operator's real `process.env` — an exported variable
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
    env: Object.freeze({ ...launch.env, ...fileEnv, ...operatorEnvFileForChild(options), ...inheritedEnv }),
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
