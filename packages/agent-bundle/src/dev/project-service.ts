import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { discoverProject } from '../config/discover.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from '../config/ignore.ts';
import { loadConfig } from '../config/load.ts';
import { normalizeProject } from '../config/normalize.ts';
import { validateModel, validateSource } from '../config/validate.ts';
import { type Diagnostic, withDiagnosticRecovery } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import {
  createProjectContext,
  type ProjectContext,
  type ProjectSourceSnapshotInput,
} from '../core/project-context.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import type { SourceStatus } from './types.ts';

export type ProjectCommand = 'build' | 'inspect' | 'validate';

export interface ProjectServiceLogger {
  log?(event: string, details: Readonly<Record<string, unknown>>): void;
}

export interface ProjectServiceOptions {
  readonly configPath?: string;
  readonly logger?: ProjectServiceLogger;
  readonly mode?: string;
  readonly outputRoots?: readonly string[];
  readonly registry?: TargetRegistry;
  readonly root: string;
  readonly targets?: readonly string[];
}

export interface PreparedProject {
  readonly configPath: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly model?: NormalizedPlugin;
  readonly outputRoots: readonly string[];
  readonly projectContext?: ProjectContext;
  readonly registry: TargetRegistry;
  readonly root: string;
  readonly source: SourceStatus;
}

export type { ProjectSourceInput, ProjectSourceSnapshotInput } from '../core/project-context.ts';

/** Broad source snapshot carried from preparation through artifact publication. */
export interface ProjectSourceSnapshot {
  readonly inputs: readonly ProjectSourceSnapshotInput[];
  readonly revision: string;
}

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...withDiagnosticRecovery(diagnostic) })));

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

export const snapshotProjectSource = async (
  root: string,
  configPath: string,
  outputRoots: readonly string[] = [],
): Promise<ProjectSourceSnapshot> => {
  const requestedRoot = resolve(root);
  const resolvedRoot = await realpath(requestedRoot);
  const resolvedOutputRoots = await resolveOutputRoots(requestedRoot, resolvedRoot, outputRoots);
  const requestedConfigPath = resolve(requestedRoot, configPath);
  relativeSourcePath(requestedRoot, requestedConfigPath);
  const resolvedConfigPath = await realpath(requestedConfigPath);
  relativeSourcePath(resolvedRoot, resolvedConfigPath);
  const sources = new Set<string>([resolvedConfigPath, ...(await sourcePaths(resolvedRoot, resolvedOutputRoots))]);
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
): SourceStatus => Object.freeze({
  diagnostics,
  revision,
  state: hasErrors(diagnostics) ? 'invalid' : 'ready',
});

const preparedProject = (
  configPath: string,
  snapshot: ProjectSourceSnapshot,
  diagnostics: readonly Diagnostic[],
  outputRoots: readonly string[],
  projectContext: ProjectContext | undefined,
  registry: TargetRegistry,
  root: string,
  source: SourceStatus,
  model?: NormalizedPlugin,
): PreparedProject => Object.freeze({
  configPath,
  diagnostics,
  ...(model === undefined ? {} : { model }),
  outputRoots,
  ...(projectContext === undefined ? {} : { projectContext }),
  registry,
  root,
  source,
});

export type ProjectDiagnosticCode = 'AB7000' | 'AB7001' | 'AB7002' | 'AB7003' | 'AB7004';

export const projectDiagnosticRecoveries: Readonly<Record<ProjectDiagnosticCode, string>> = Object.freeze({
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
  );
};

/** Loads, discovers, validates, and normalizes source once for dev consumers. */
export class ProjectService {
  readonly #options: ProjectServiceOptions;
  readonly #registry: TargetRegistry;

  constructor(options: ProjectServiceOptions) {
    this.#options = Object.freeze({ ...options });
    this.#registry = options.registry ?? createDefaultRegistry();
  }

  async prepare(command: ProjectCommand): Promise<PreparedProject> {
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
    try {
      loaded = await loadConfig({
        command,
        configPath: this.#options.configPath,
        mode: this.#options.mode ?? 'production',
        root: requestedRoot,
        targets: this.#options.targets,
      });
      discovered = await discoverProject(root, loaded.config);
    } catch {
      const snapshot = await snapshotForLoadFailure(root, configPath, outputRoots);
      return failedPreparation('AB7000', 'Unable to load project source.', configPath, 'project.invalid-source', snapshot);
    }

    let snapshot: ProjectSourceSnapshot;
    try {
      snapshot = await snapshotProjectSource(root, loaded.configPath, outputRoots);
    } catch {
      return failedPreparation('AB7003', 'Unable to snapshot project source.', loaded.configPath, 'project.invalid-source');
    }
    let sourceDiagnostics: readonly Diagnostic[];
    try {
      sourceDiagnostics = freezeDiagnostics(validateSource(loaded, discovered, registry));
    } catch {
      return failedPreparation(
        'AB7001',
        'Unable to validate project source.',
        loaded.configPath,
        'project.invalid-source',
        snapshot,
      );
    }
    if (hasErrors(sourceDiagnostics)) {
      const source = sourceStatus(sourceDiagnostics, snapshot.revision);
      log(this.#options.logger, 'project.invalid-source', { diagnostics: sourceDiagnostics.length, root });
      return preparedProject(loaded.configPath, snapshot, sourceDiagnostics, outputRoots, undefined, registry, root, source);
    }

    let model: NormalizedPlugin;
    try {
      model = await normalizeProject(loaded, discovered, registry);
    } catch {
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
      diagnostics = [...validateModel(model, registry)];
      for (const target of model.targets) {
        if (!registry.has(target.name)) continue;
        const adapter = registry.get(target.name);
        diagnostics.push(...adapter.validateModel(model));
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
    const source = sourceStatus(frozenDiagnostics, snapshot.revision);
    log(this.#options.logger, 'project.prepared', {
      diagnostics: frozenDiagnostics.length,
      root,
      targets: model.targets.map((target) => target.name),
    });
    return preparedProject(loaded.configPath, snapshot, frozenDiagnostics, outputRoots, projectContext, registry, root, source, model);
  }
}
