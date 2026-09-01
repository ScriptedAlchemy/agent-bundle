import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { configuredPayloadRoots, discoverProject } from '../config/discover.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from '../config/ignore.ts';
import { loadConfig } from '../config/load.ts';
import { normalizeEvalConfig } from '../eval/config.ts';
import {
  normalizeProject,
} from '../config/normalize.ts';
import { validateModel, validateSource } from '../config/validate.ts';
import { deduplicateDiagnostics, type Diagnostic, withDiagnosticRecovery } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import {
  createProjectContext,
  packageVersionMismatchDiagnostic,
  type ProjectContext,
  type ProjectSourceSnapshotInput,
} from '../core/project-context.ts';
import type {
  AgentBundleConfig,
  AgentBundleDevConfig,
  AgentBundleDevRuntimeConfig,
  AgentBundleToolsConfig,
  NormalizedMcpApp,
  NormalizedMcpServer,
  NormalizedPlugin,
} from '../core/types.ts';
import type { DevRuntimePreparedMcpApp, DevRuntimePreparedMcpServer, DevRuntimePreparedProject } from './runtime-provider.ts';
import { freezeJsonValue, type JsonObject, type JsonValue, type SourceStatus } from './types.ts';

export type ProjectCommand = 'build' | 'dev' | 'inspect' | 'validate';

export interface ProjectServiceLogger {
  log?(event: string, details: Readonly<Record<string, unknown>>): void;
}

export interface ProjectServiceOptions {
  readonly configPath?: string;
  readonly includeDevRuntime?: boolean;
  readonly logger?: ProjectServiceLogger;
  readonly mode?: string;
  readonly outputRoots?: readonly string[];
  readonly registry?: TargetRegistry;
  readonly root: string;
  readonly targets?: readonly string[];
}

export interface PreparedProject {
  readonly configPath: string;
  /** The validated development-only Agent API flag from the prepared configuration. */
  readonly devAgentApiEnabled?: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly devRuntime?: DevRuntimePreparedProject;
  readonly devRuntimeDiagnostic?: Diagnostic;
  readonly model?: NormalizedPlugin;
  readonly outputRoots: readonly string[];
  readonly projectContext?: ProjectContext;
  readonly registry: TargetRegistry;
  readonly root: string;
  /**
   * Re-snapshots the project with the same output and payload roots the
   * prepared identity hashed; a divergent re-snapshot would make
   * payload-bearing projects always appear drifted to epoch publication.
   */
  readonly snapshotSource: () => Promise<ProjectSourceSnapshot>;
  readonly source: SourceStatus;
  /** The consumer bundler escape hatch, passed through for build lowering. */
  readonly tools?: AgentBundleToolsConfig;
}

export type { ProjectSourceInput, ProjectSourceSnapshotInput } from '../core/project-context.ts';

/** Broad source snapshot carried from preparation through artifact publication. */
export interface ProjectSourceSnapshot {
  readonly inputs: readonly ProjectSourceSnapshotInput[];
  readonly revision: string;
}

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => Object.freeze(
  deduplicateDiagnostics(diagnostics.map(withDiagnosticRecovery))
    .map((diagnostic) => Object.freeze({ ...diagnostic })),
);

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

const log = (
  logger: ProjectServiceLogger | undefined,
  event: string,
  details: Readonly<Record<string, unknown>>,
): void => {
  logger?.log?.(event, Object.freeze({ ...details }));
};

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.name
      : typeof error;

export type ProjectPathApi = Pick<typeof import('node:path').win32, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>;

const nativePath: ProjectPathApi = { isAbsolute, relative, resolve, sep };

export const containedPathComponents = (
  root: string,
  candidate: string,
  path: ProjectPathApi = nativePath,
): readonly string[] | undefined => {
  const pathRelative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    pathRelative === '..' ||
    pathRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(pathRelative)
  ) return undefined;
  return pathRelative.length === 0 ? [] : pathRelative.split(path.sep);
};

const relativeSourcePath = (root: string, source: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedSource = resolve(resolvedRoot, source);
  const components = containedPathComponents(resolvedRoot, resolvedSource);
  if (components === undefined) {
    throw new RangeError(`Project source path ${JSON.stringify(resolvedSource)} is outside project root ${JSON.stringify(resolvedRoot)}.`);
  }
  if (components.length === 0) throw new RangeError('Project source path must not be the project root.');
  return components.join('/');
};

const sourceInput = async (root: string, source: string): Promise<ProjectSourceSnapshotInput> => {
  try {
    const resolvedSource = await realpath(source);
    const path = relativeSourcePath(root, resolvedSource);
    return Object.freeze({
      sha256: createHash('sha256').update(await readFile(resolvedSource)).digest('hex'),
      path,
    });
  } catch (error) {
    if (error instanceof RangeError) throw error;
    const path = relativeSourcePath(root, source);
    return Object.freeze({ error: errorCode(error), path });
  }
};

const isNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const physicalOutputRoot = async (
  root: string,
  parts: readonly string[],
  requestedOutputRoot: string,
): Promise<string> => {
  let physical = root;
  for (let index = 0; index < parts.length; index += 1) {
    const candidate = join(physical, parts[index]);
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return join(physical, ...parts.slice(index));
    }
    if (entry.isSymbolicLink()) {
      try {
        physical = await realpath(candidate);
      } catch {
        throw new RangeError(`Configured output root ${JSON.stringify(requestedOutputRoot)} contains an unresolved symlink.`);
      }
    } else {
      physical = candidate;
    }
    if (index === parts.length - 1 && physical === root) {
      throw new RangeError('Configured output root must not be the project root.');
    }
    if (containedPathComponents(root, physical) === undefined) {
      throw new RangeError(`Configured output root ${JSON.stringify(requestedOutputRoot)} is outside project root ${JSON.stringify(root)}.`);
    }
  }
  return physical;
};

const resolveOutputRoots = async (
  requestedRoot: string,
  root: string,
  outputRoots: readonly string[] | undefined,
): Promise<readonly string[]> => {
  const requestedProjectRoot = resolve(requestedRoot);
  const canonicalRoot = resolve(root);
  const resolveOutputRoot = async (outputRoot: string): Promise<string> => {
    const requestedOutputRoot = resolve(requestedProjectRoot, outputRoot);
    const requestedComponents = containedPathComponents(requestedProjectRoot, requestedOutputRoot);
    let canonicalOutputRoot: string;
    if (requestedComponents !== undefined) {
      canonicalOutputRoot = resolve(canonicalRoot, ...requestedComponents);
    } else if (isAbsolute(outputRoot) && containedPathComponents(canonicalRoot, requestedOutputRoot) !== undefined) {
      canonicalOutputRoot = requestedOutputRoot;
    } else {
      throw new RangeError(`Configured output root ${JSON.stringify(requestedOutputRoot)} is outside project root ${JSON.stringify(canonicalRoot)}.`);
    }
    const components = containedPathComponents(canonicalRoot, canonicalOutputRoot);
    if (components === undefined) {
      throw new RangeError(`Configured output root ${JSON.stringify(requestedOutputRoot)} is outside project root ${JSON.stringify(canonicalRoot)}.`);
    }
    if (components.length === 0) {
      throw new RangeError('Configured output root must not be the project root.');
    }
    return physicalOutputRoot(canonicalRoot, components, requestedOutputRoot);
  };
  const roots = await Promise.all((outputRoots ?? []).map(resolveOutputRoot));
  return Object.freeze([...new Set(roots)].sort((left, right) => left.localeCompare(right)));
};

const sourcePaths = async (root: string, outputRoots: readonly string[]): Promise<readonly string[]> => {
  const rules = await readProjectIgnoreRules(root);
  const paths: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(directory, entry.name);
      if (isProjectPathIgnored(rules, root, source)) continue;
      if (outputRoots.some((outputRoot) => containedPathComponents(outputRoot, source) !== undefined)) continue;
      if (entry.isDirectory()) {
        await visit(source);
        continue;
      }
      if (entry.isFile()) paths.push(source);
    }
  };

  await visit(root);
  return Object.freeze(paths.sort((left, right) => left.localeCompare(right)));
};

const payloadSourcePaths = async (
  root: string,
  payloadRoots: readonly string[],
): Promise<readonly string[]> => {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // A payload that does not exist yet contributes no source inputs.
      return;
    }
    for (const entry of entries) {
      const source = join(directory, entry.name);
      if (entry.isDirectory()) await visit(source);
      else if (entry.isFile()) paths.push(source);
    }
  };
  for (const payloadRoot of payloadRoots) {
    const resolved = resolve(root, payloadRoot);
    if (containedPathComponents(root, resolved) === undefined) continue;
    await visit(resolved);
  }
  return Object.freeze(paths.sort((left, right) => left.localeCompare(right)));
};

export const snapshotProjectSource = async (
  root: string,
  configPath: string,
  outputRoots: readonly string[] = [],
  payloadRoots: readonly string[] = [],
): Promise<ProjectSourceSnapshot> => {
  const requestedRoot = resolve(root);
  const resolvedRoot = await realpath(requestedRoot);
  const resolvedOutputRoots = await resolveOutputRoots(requestedRoot, resolvedRoot, outputRoots);
  const requestedConfigPath = resolve(requestedRoot, configPath);
  relativeSourcePath(requestedRoot, requestedConfigPath);
  const resolvedConfigPath = await realpath(requestedConfigPath);
  relativeSourcePath(resolvedRoot, resolvedConfigPath);
  // Declared prebuilt payload files join the identity even though payload
  // directories are ignored for source discovery: the artifact packages
  // their exact bytes, so the project revision must change with them.
  const sources = new Set<string>([
    resolvedConfigPath,
    ...(await sourcePaths(resolvedRoot, resolvedOutputRoots)),
    ...(await payloadSourcePaths(resolvedRoot, payloadRoots)),
  ]);
  const inputs = Object.freeze((await Promise.all([...sources].map((source) => sourceInput(resolvedRoot, source))))
    .sort((left, right) => left.path.localeCompare(right.path)));
  return Object.freeze({
    inputs,
    revision: digest({ inputs }),
  });
};

const emptySnapshot = (): ProjectSourceSnapshot => Object.freeze({
  inputs: Object.freeze([]),
  revision: digest({ inputs: [] }),
});

const snapshotForLoadFailure = async (
  root: string,
  configPath: string,
  outputRoots: readonly string[],
): Promise<ProjectSourceSnapshot> => {
  try {
    return await snapshotProjectSource(root, configPath, outputRoots);
  } catch {
    return emptySnapshot();
  }
};

const sourceStatus = (
  diagnostics: readonly Diagnostic[],
  revision: string,
  identity?: Readonly<{ readonly packageName: string; readonly packageVersion: string }>,
): SourceStatus => Object.freeze({
  diagnostics,
  ...(identity === undefined ? {} : {
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
  }),
  revision,
  state: hasErrors(diagnostics) ? 'invalid' : 'ready',
});

const sourceDiagnostic = (message: string, sourcePath: string): Diagnostic => Object.freeze({
  code: 'AB8200',
  message,
  severity: 'error',
  sourcePath,
});

const configExtensionFiniteJsonDiagnosticMessage = 'A registered config extension must contain strict finite JSON data.';

const isConfigExtensionFiniteJsonError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('AB4500:');

const runtimeDeclaration = (
  include: boolean,
  config: unknown,
  configPath: string,
): Readonly<{ declaration?: AgentBundleDevRuntimeConfig; diagnostic?: Diagnostic }> => {
  if (!include) return Object.freeze({});
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return Object.freeze({ diagnostic: sourceDiagnostic('Development configuration must be an object.', configPath) });
  }
  const dev = Object.getOwnPropertyDescriptor(config, 'dev');
  if (dev === undefined) return Object.freeze({});
  if (!('value' in dev) || typeof dev.value !== 'object' || dev.value === null || Array.isArray(dev.value)) {
    return Object.freeze({ diagnostic: sourceDiagnostic('Development configuration must be an object.', configPath) });
  }
  const runtime = Object.getOwnPropertyDescriptor(dev.value, 'runtime');
  if (runtime === undefined) return Object.freeze({});
  if (!('value' in runtime) || typeof runtime.value !== 'object' || runtime.value === null || Array.isArray(runtime.value)) {
    return Object.freeze({ diagnostic: sourceDiagnostic('Development runtime provider must be a nonempty project-relative module path.', configPath) });
  }
  const provider = Object.getOwnPropertyDescriptor(runtime.value, 'provider');
  if (provider === undefined || !('value' in provider) || typeof provider.value !== 'string' || provider.value.trim().length === 0) {
    return Object.freeze({ diagnostic: sourceDiagnostic('Development runtime provider must be a nonempty project-relative module path.', configPath) });
  }
  return Object.freeze({ declaration: Object.freeze({ provider: provider.value }) });
};

const agentApiEnabled = (config: AgentBundleConfig): boolean => {
  const dev = config.dev;
  if (dev === undefined) return false;
  if (typeof dev !== 'object' || dev === null || Array.isArray(dev)) {
    throw new TypeError('Configuration field "dev" must be an object when provided.');
  }
  const value = (dev as AgentBundleDevConfig).agentApi;
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError('Configuration field "dev.agentApi" must be a boolean when provided.');
  }
  return value === true;
};

const cloneJsonSnapshot = (value: unknown, ancestors = new Set<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('numbers must be finite');
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('value must be a finite JSON tree');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy: JsonValue[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (key !== 'length' && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length))) {
          throw new TypeError('arrays must contain only indexed values');
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('arrays cannot contain accessors or holes');
        copy.push(cloneJsonSnapshot(descriptor.value, ancestors));
      }
      return copy;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('objects must be plain');
    const copy: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError('objects cannot contain symbol properties');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) throw new TypeError('objects cannot contain accessors');
      copy[key] = cloneJsonSnapshot(descriptor.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
};

const appMetadata = (value: unknown): JsonObject => {
  const snapshot = cloneJsonSnapshot(value);
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new TypeError('MCP App metadata must be a JSON object');
  }
  return freezeJsonValue(snapshot) as JsonObject;
};

const stringRecord = (value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined =>
  value === undefined ? undefined : Object.freeze({ ...value });

const preparedMcpServer = (server: NormalizedMcpServer): DevRuntimePreparedMcpServer => Object.freeze({
  ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
  ...(server.command === undefined ? {} : { command: server.command }),
  ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
  ...(server.env === undefined ? {} : { env: stringRecord(server.env) }),
  ...(server.headers === undefined ? {} : { headers: stringRecord(server.headers) }),
  id: server.id,
  name: server.name,
  ...(server.source === undefined ? {} : { source: server.source }),
  targets: Object.freeze([...server.targets]),
  transport: server.transport,
  ...(server.url === undefined ? {} : { url: server.url }),
});

const preparedMcpApp = (app: NormalizedMcpApp): DevRuntimePreparedMcpApp => Object.freeze({
  ...(app._meta === undefined ? {} : { _meta: appMetadata(app._meta) }),
  id: app.id,
  name: app.name,
  resourceUri: app.resourceUri,
  serverId: app.serverId,
  serverName: app.serverName,
  source: app.source,
  targets: Object.freeze([...app.targets]),
  ...(app.template === undefined ? {} : { template: app.template }),
});

const preparedRuntime = (
  declaration: AgentBundleDevRuntimeConfig,
  model: NormalizedPlugin,
  revision: string,
): DevRuntimePreparedProject => Object.freeze({
  apps: Object.freeze((model.mcpApps ?? []).map(preparedMcpApp)),
  provider: declaration.provider,
  servers: Object.freeze(model.mcpServers.map(preparedMcpServer)),
  sourceRevision: revision,
});

const configWithRuntimeMetadataRemoved = (config: Record<string, unknown>): Readonly<{
  changed: boolean;
  config: Record<string, unknown>;
}> => {
  const mcp = Object.getOwnPropertyDescriptor(config, 'mcp');
  if (mcp === undefined || !('value' in mcp) || typeof mcp.value !== 'object' || mcp.value === null || Array.isArray(mcp.value)) {
    return Object.freeze({ changed: false, config });
  }
  const servers = Object.getOwnPropertyDescriptor(mcp.value, 'servers');
  if (servers === undefined || !('value' in servers) || typeof servers.value !== 'object' || servers.value === null || Array.isArray(servers.value)) {
    return Object.freeze({ changed: false, config });
  }

  const sanitizedServers: Record<string, unknown> = {};
  let changed = false;
  for (const [name, server] of Object.entries(servers.value)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) {
      sanitizedServers[name] = server;
      continue;
    }
    const apps = Object.getOwnPropertyDescriptor(server, 'apps');
    if (apps === undefined || !('value' in apps) || typeof apps.value !== 'object' || apps.value === null || Array.isArray(apps.value)) {
      sanitizedServers[name] = server;
      continue;
    }
    const sanitizedApps: Record<string, unknown> = {};
    for (const [appName, app] of Object.entries(apps.value)) {
      if (typeof app !== 'object' || app === null || Array.isArray(app)) {
        sanitizedApps[appName] = app;
        continue;
      }
      const meta = Object.getOwnPropertyDescriptor(app, '_meta');
      if (meta === undefined || ('value' in meta && (() => {
        try {
          appMetadata(meta.value);
          return true;
        } catch {
          return false;
        }
      })())) {
        sanitizedApps[appName] = app;
        continue;
      }
      const descriptors = Object.getOwnPropertyDescriptors(app);
      delete descriptors._meta;
      sanitizedApps[appName] = Object.defineProperties({}, descriptors);
      changed = true;
    }
    const descriptors = Object.getOwnPropertyDescriptors(server);
    descriptors.apps = { configurable: true, enumerable: true, value: sanitizedApps, writable: true };
    sanitizedServers[name] = Object.defineProperties({}, descriptors);
  }
  if (!changed) return Object.freeze({ changed: false, config });
  const mcpDescriptors = Object.getOwnPropertyDescriptors(mcp.value);
  mcpDescriptors.servers = { configurable: true, enumerable: true, value: sanitizedServers, writable: true };
  const configDescriptors = Object.getOwnPropertyDescriptors(config);
  configDescriptors.mcp = { configurable: true, enumerable: true, value: Object.defineProperties({}, mcpDescriptors), writable: true };
  return Object.freeze({
    changed: true,
    config: Object.defineProperties({}, configDescriptors),
  });
};

const preparedProject = (
  configPath: string,
  snapshot: ProjectSourceSnapshot,
  diagnostics: readonly Diagnostic[],
  outputRoots: readonly string[],
  projectContext: ProjectContext | undefined,
  registry: TargetRegistry,
  root: string,
  source: SourceStatus,
  snapshotSource: () => Promise<ProjectSourceSnapshot>,
  model?: NormalizedPlugin,
  devRuntime?: DevRuntimePreparedProject,
  devRuntimeDiagnostic?: Diagnostic,
  devAgentApiEnabled?: boolean,
  tools?: AgentBundleToolsConfig,
): PreparedProject => Object.freeze({
  configPath,
  ...(devAgentApiEnabled === true ? { devAgentApiEnabled } : {}),
  diagnostics,
  ...(model === undefined ? {} : { model }),
  ...(devRuntime === undefined ? {} : { devRuntime }),
  ...(devRuntimeDiagnostic === undefined ? {} : { devRuntimeDiagnostic }),
  outputRoots,
  ...(projectContext === undefined ? {} : { projectContext }),
  registry,
  root,
  snapshotSource,
  source,
  ...(tools === undefined ? {} : { tools }),
});

export type ProjectDiagnosticCode = 'AB4500' | 'AB7000' | 'AB7001' | 'AB7002' | 'AB7003' | 'AB7004';

export const projectDiagnosticRecoveries: Readonly<Record<ProjectDiagnosticCode, string>> = Object.freeze({
  AB4500: 'Correct the project configuration field named by this diagnostic, then inspect again.',
  AB7000: 'Fix the Agent Bundle configuration and source files, then inspect again.',
  AB7001: 'Fix normalized project configuration and source references, then inspect again.',
  AB7002: 'Ensure the project root and configured output roots are readable and remain inside the project root, then inspect again.',
  AB7003: 'Ensure project source files and ignore rules are readable and remain inside the project root, then inspect again.',
  AB7004: 'Choose a target selected by the project configuration, then inspect again.',
});

export const projectDiagnostic = (
  code: ProjectDiagnosticCode,
  message: string,
  options: { readonly sourcePath?: string; readonly target?: string } = {},
): Diagnostic => ({
  code,
  message,
  recovery: projectDiagnosticRecoveries[code],
  severity: 'error',
  ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  ...(options.target === undefined ? {} : { target: options.target }),
});

const invalidPreparedProject = (options: {
  readonly configPath: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly outputRoots: readonly string[];
  readonly registry: TargetRegistry;
  readonly root: string;
  readonly snapshot?: ProjectSourceSnapshot;
}): PreparedProject => {
  const snapshot = options.snapshot ?? emptySnapshot();
  return preparedProject(
    options.configPath,
    snapshot,
    options.diagnostics,
    options.outputRoots,
    undefined,
    options.registry,
    options.root,
    sourceStatus(options.diagnostics, snapshot.revision),
    // A failed preparation never resolved its payload roots; the re-snapshot
    // observes the same source tree the failure snapshot did.
    () => snapshotProjectSource(options.root, options.configPath, options.outputRoots),
  );
};

/** Loads, discovers, validates, and normalizes source once for dev consumers. */
export class ProjectService {
  readonly #options: ProjectServiceOptions;
  readonly #registry: TargetRegistry;
  /** One in-flight preparation per command, shared by concurrent callers. */
  readonly #preparing = new Map<ProjectCommand, Promise<PreparedProject>>();

  constructor(options: ProjectServiceOptions) {
    this.#options = Object.freeze({ ...options });
    this.#registry = options.registry ?? createDefaultRegistry();
  }

  /**
   * Preparation walks and hashes the whole project tree, so a burst of
   * concurrent callers — opening one Skill page issues a tree request plus one
   * request per embedded resource — would otherwise repeat that walk per
   * request. Concurrent callers share one preparation; the entry is dropped as
   * soon as it settles, so a later call still observes changed source.
   */
  async prepare(command: ProjectCommand): Promise<PreparedProject> {
    const pending = this.#preparing.get(command);
    if (pending !== undefined) return pending;
    const preparing = this.#prepare(command);
    this.#preparing.set(command, preparing);
    try {
      return await preparing;
    } finally {
      this.#preparing.delete(command);
    }
  }

  async #prepare(command: ProjectCommand): Promise<PreparedProject> {
    const requestedRoot = resolve(this.#options.root);
    const registry = this.#registry;
    const requestedConfigPath = resolve(requestedRoot, this.#options.configPath ?? 'agent-bundle.config.ts');
    let root = requestedRoot;
    let outputRoots: readonly string[] = Object.freeze([]);
    const failedPreparation = (
      code: ProjectDiagnosticCode,
      message: string,
      configPath: string,
      event: 'project.invalid-source' | 'project.prepared',
      snapshot?: ProjectSourceSnapshot,
    ): PreparedProject => {
      const diagnostics = freezeDiagnostics([projectDiagnostic(code, message, { sourcePath: configPath })]);
      log(this.#options.logger, event, {
        diagnostics: diagnostics.length,
        root,
        ...(event === 'project.prepared' ? { targets: [] } : {}),
      });
      return invalidPreparedProject({
        configPath,
        diagnostics,
        outputRoots,
        registry,
        root,
        ...(snapshot === undefined ? {} : { snapshot }),
      });
    };
    try {
      root = await realpath(requestedRoot);
      outputRoots = await resolveOutputRoots(requestedRoot, root, this.#options.outputRoots);
    } catch {
      return failedPreparation('AB7002', 'Unable to prepare project paths.', requestedConfigPath, 'project.invalid-source');
    }
    const configPath = resolve(root, this.#options.configPath ?? 'agent-bundle.config.ts');
    log(this.#options.logger, 'project.load', { command, root });

    let loaded;
    let discovered;
    let devAgentApiEnabled: boolean;
    try {
      loaded = await loadConfig({
        command,
        configPath: this.#options.configPath,
        mode: this.#options.mode ?? 'production',
        root: requestedRoot,
        targets: this.#options.targets,
      });
      devAgentApiEnabled = agentApiEnabled(loaded.config);
      // Eval runs are generated records, even when a project deliberately
      // stores them outside the conventional .agent-bundle directory.  Keep
      // the resolved configuration as the single source of that ownership.
      let evalRunsDir: string | undefined;
      try {
        evalRunsDir = normalizeEvalConfig(loaded.config.evals).runsDir;
      } catch {
        // EvalService owns malformed eval configuration diagnostics.  Do not
        // replace the established project-source error contract with one.
      }
      if (evalRunsDir !== undefined) {
        const evalOutputRoots = await resolveOutputRoots(
          requestedRoot,
          root,
          [evalRunsDir],
        );
        outputRoots = Object.freeze([...new Set([...outputRoots, ...evalOutputRoots])]
          .sort((left, right) => left.localeCompare(right)));
      }
      discovered = await discoverProject(root, loaded.config);
    } catch {
      const snapshot = await snapshotForLoadFailure(root, configPath, outputRoots);
      return failedPreparation('AB7000', 'Unable to load project source.', configPath, 'project.invalid-source', snapshot);
    }

    const payloadRoots = configuredPayloadRoots(root, loaded.config);
    let snapshot: ProjectSourceSnapshot;
    try {
      snapshot = await snapshotProjectSource(root, loaded.configPath, outputRoots, payloadRoots);
    } catch {
      return failedPreparation('AB7003', 'Unable to snapshot project source.', loaded.configPath, 'project.invalid-source');
    }
    const runtime = runtimeDeclaration(this.#options.includeDevRuntime === true, loaded.config, loaded.configPath);
    const runtimeMetadata = runtime.declaration === undefined
      ? Object.freeze({ changed: false, config: loaded.config })
      : configWithRuntimeMetadataRemoved(loaded.config as Record<string, unknown>);
    const preparedLoaded = runtimeMetadata.config === loaded.config
      ? loaded
      : { ...loaded, config: runtimeMetadata.config as AgentBundleConfig };
    const supplementalMetadataFailure = runtimeMetadata.changed;
    let sourceDiagnostics: readonly Diagnostic[];
    try {
      // The AB4750 freshness nudge only surfaces through `validate`; other
      // commands skip its full-project mtime walk.
      sourceDiagnostics = freezeDiagnostics(validateSource(preparedLoaded, discovered, registry, {
        payloadFreshness: command === 'validate',
      }));
    } catch {
      return failedPreparation(
        'AB7001',
        'Unable to validate project source.',
        loaded.configPath,
        'project.invalid-source',
        snapshot,
      );
    }
    const snapshotSource = (): Promise<ProjectSourceSnapshot> =>
      snapshotProjectSource(root, loaded.configPath, outputRoots, payloadRoots);
    if (hasErrors(sourceDiagnostics)) {
      const source = sourceStatus(sourceDiagnostics, snapshot.revision);
      log(this.#options.logger, 'project.invalid-source', { diagnostics: sourceDiagnostics.length, root });
      return preparedProject(loaded.configPath, snapshot, sourceDiagnostics, outputRoots, undefined, registry, root, source, snapshotSource);
    }

    let model: NormalizedPlugin;
    try {
      model = await normalizeProject(
        preparedLoaded,
        discovered,
        registry,
      );
    } catch (error) {
      if (isConfigExtensionFiniteJsonError(error)) {
        return failedPreparation(
          'AB4500',
          configExtensionFiniteJsonDiagnosticMessage,
          loaded.configPath,
          'project.prepared',
          snapshot,
        );
      }
      return failedPreparation(
        'AB7001',
        'Unable to normalize project source.',
        loaded.configPath,
        'project.prepared',
        snapshot,
      );
    }

    let diagnostics: Diagnostic[];
    try {
      // Non-error source diagnostics (payload warnings like AB4743/AB4745,
      // informational nudges like the AB4750 staleness note) surface through
      // `validate`, where an operator asks for exactly this judgment.
      // Development flows keep running without them — a payload that has not
      // been built yet is a normal dev state — and builds are separately
      // guarded by their own hard refusals.
      diagnostics = [
        ...(command === 'validate' ? sourceDiagnostics : []),
        ...validateModel(model, registry),
      ];
      for (const target of model.targets) {
        if (!registry.has(target.name)) continue;
        const adapter = registry.get(target.name);
        diagnostics.push(...adapter.plan(model).diagnostics);
      }
    } catch {
      return failedPreparation(
        'AB7001',
        'Unable to validate normalized project.',
        loaded.configPath,
        'project.prepared',
        snapshot,
      );
    }
    let projectContext: ProjectContext | undefined;
    try {
      projectContext = createProjectContext({
        configPath: loaded.configPath,
        model,
        root,
        sourceInputs: snapshot.inputs,
      });
    } catch {
      diagnostics.push(projectDiagnostic('AB7001', 'Unable to create project context.', { sourcePath: loaded.configPath }));
    }
    if (projectContext?.packageVersion !== undefined) {
      const mismatch = packageVersionMismatchDiagnostic(
        model.metadata.version,
        projectContext.packageVersion,
        loaded.configPath,
      );
      if (mismatch !== undefined) diagnostics.push(mismatch);
    }
    let frozenDiagnostics: readonly Diagnostic[];
    try {
      frozenDiagnostics = freezeDiagnostics(diagnostics);
    } catch {
      return failedPreparation(
        'AB7001',
        'Unable to validate normalized project.',
        loaded.configPath,
        'project.prepared',
        snapshot,
      );
    }
    const source = sourceStatus(
      frozenDiagnostics,
      snapshot.revision,
      projectContext?.packageName === undefined || projectContext.packageVersion === undefined
        ? undefined
        : { packageName: projectContext.packageName, packageVersion: projectContext.packageVersion },
    );
    log(this.#options.logger, 'project.prepared', {
      diagnostics: frozenDiagnostics.length,
      root,
      targets: model.targets.map((target) => target.name),
    });
    let devRuntime: DevRuntimePreparedProject | undefined;
    let devRuntimeDiagnostic = runtime.diagnostic;
    if (runtime.declaration !== undefined && !supplementalMetadataFailure) {
      try {
        devRuntime = preparedRuntime(runtime.declaration, model, snapshot.revision);
      } catch {
        devRuntimeDiagnostic = sourceDiagnostic('Development runtime MCP App metadata must contain only finite JSON data.', loaded.configPath);
      }
    }
    if (supplementalMetadataFailure) {
      devRuntimeDiagnostic = sourceDiagnostic('Development runtime MCP App metadata must contain only finite JSON data.', loaded.configPath);
    }
    const toolsValue = loaded.config.tools;
    const tools = typeof toolsValue === 'object' && toolsValue !== null && !Array.isArray(toolsValue)
      ? toolsValue as AgentBundleToolsConfig
      : undefined;
    return preparedProject(
      loaded.configPath,
      snapshot,
      frozenDiagnostics,
      outputRoots,
      projectContext,
      registry,
      root,
      source,
      snapshotSource,
      model,
      devRuntime,
      devRuntimeDiagnostic,
      devAgentApiEnabled,
      tools,
    );
  }
}
