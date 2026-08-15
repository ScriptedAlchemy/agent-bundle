import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { discoverProject } from '../config/discover.ts';
import { isProjectPathIgnored, readProjectIgnoreRules } from '../config/ignore.ts';
import { loadConfig } from '../config/load.ts';
import { normalizeProject } from '../config/normalize.ts';
import { validateModel, validateSource } from '../config/validate.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
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
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

const log = (
  logger: ProjectServiceLogger | undefined,
  event: string,
  details: Readonly<Record<string, unknown>>,
): void => {
  logger?.log?.(event, Object.freeze({ ...details }));
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : error instanceof Error
      ? error.name
      : typeof error;

const relativeSourcePath = (root: string, source: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedSource = resolve(resolvedRoot, source);
  const projectRelative = relative(resolvedRoot, resolvedSource);
  if (projectRelative === '..' || projectRelative.startsWith('../')) {
    throw new RangeError(`Project source path ${JSON.stringify(resolvedSource)} is outside project root ${JSON.stringify(resolvedRoot)}.`);
  }
  if (projectRelative.length === 0) {
    throw new RangeError('Project source path must not be the project root.');
  }
  return projectRelative.replaceAll('\\', '/');
};

const sourceInput = async (root: string, source: string): Promise<ProjectSourceSnapshotInput> => {
  const path = relativeSourcePath(root, source);
  try {
    return Object.freeze({
      sha256: createHash('sha256').update(await readFile(source)).digest('hex'),
      path,
    });
  } catch (error) {
    return Object.freeze({ error: errorCode(error), path });
  }
};

const isWithinOutputRoot = (source: string, outputRoot: string): boolean => {
  const path = relative(outputRoot, source);
  return path.length === 0 || (path !== '..' && !path.startsWith('../'));
};

const resolveOutputRoots = (root: string, outputRoots: readonly string[] | undefined): readonly string[] => {
  const resolvedRoot = resolve(root);
  const roots = [...new Set((outputRoots ?? []).map((outputRoot) => resolve(resolvedRoot, outputRoot)))];
  for (const outputRoot of roots) {
    const projectRelative = relative(resolvedRoot, outputRoot);
    if (projectRelative === '') {
      throw new RangeError('Configured output root must not be the project root.');
    }
    if (projectRelative === '..' || projectRelative.startsWith('../')) {
      throw new RangeError(`Configured output root ${JSON.stringify(outputRoot)} is outside project root ${JSON.stringify(resolvedRoot)}.`);
    }
  }
  return Object.freeze(roots.sort((left, right) => left.localeCompare(right)));
};

const sourcePaths = async (root: string, outputRoots: readonly string[]): Promise<readonly string[]> => {
  const rules = await readProjectIgnoreRules(root);
  const paths: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const source = join(directory, entry.name);
      if (isProjectPathIgnored(rules, root, source)) continue;
      if (outputRoots.some((outputRoot) => isWithinOutputRoot(source, outputRoot))) continue;
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
  const resolvedRoot = resolve(root);
  const resolvedOutputRoots = resolveOutputRoots(resolvedRoot, outputRoots);
  const resolvedConfigPath = resolve(resolvedRoot, configPath);
  relativeSourcePath(resolvedRoot, resolvedConfigPath);
  const sources = new Set<string>([resolvedConfigPath, ...(await sourcePaths(resolvedRoot, resolvedOutputRoots))]);
  const inputs = Object.freeze((await Promise.all([...sources].map((source) => sourceInput(root, source))))
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

/** Loads, discovers, validates, and normalizes source once for dev consumers. */
export class ProjectService {
  readonly #options: ProjectServiceOptions;

  constructor(options: ProjectServiceOptions) {
    this.#options = Object.freeze({ ...options });
  }

  async prepare(command: ProjectCommand): Promise<PreparedProject> {
    const root = resolve(this.#options.root);
    const outputRoots = resolveOutputRoots(root, this.#options.outputRoots);
    const registry = createDefaultRegistry();
    const configPath = resolve(root, this.#options.configPath ?? 'agent-bundle.config.ts');
    log(this.#options.logger, 'project.load', { command, root });

    let loaded;
    let discovered;
    try {
      loaded = await loadConfig({
        command,
        configPath: this.#options.configPath,
        mode: this.#options.mode ?? 'production',
        root,
        targets: this.#options.targets,
      });
      discovered = await discoverProject(root, loaded.config);
    } catch (error) {
      const diagnostics = freezeDiagnostics([{
        code: 'AB7000',
        message: `Unable to load project source: ${errorMessage(error)}`,
        severity: 'error',
        sourcePath: configPath,
      }]);
      const snapshot = await snapshotForLoadFailure(root, configPath, outputRoots);
      const source = sourceStatus(diagnostics, snapshot.revision);
      log(this.#options.logger, 'project.invalid-source', { diagnostics: diagnostics.length, root });
      return preparedProject(configPath, snapshot, diagnostics, outputRoots, undefined, registry, root, source);
    }

    const snapshot = await snapshotProjectSource(root, loaded.configPath, outputRoots);
    const sourceDiagnostics = freezeDiagnostics(validateSource(loaded, discovered, registry));
    if (hasErrors(sourceDiagnostics)) {
      const source = sourceStatus(sourceDiagnostics, snapshot.revision);
      log(this.#options.logger, 'project.invalid-source', { diagnostics: sourceDiagnostics.length, root });
      return preparedProject(loaded.configPath, snapshot, sourceDiagnostics, outputRoots, undefined, registry, root, source);
    }

    let model: NormalizedPlugin;
    try {
      model = await normalizeProject(loaded, discovered, registry);
    } catch (error) {
      const diagnostics = freezeDiagnostics([{
        code: 'AB7001',
        message: `Unable to normalize project source: ${errorMessage(error)}`,
        severity: 'error',
        sourcePath: loaded.configPath,
      }]);
      const source = sourceStatus(diagnostics, snapshot.revision);
      log(this.#options.logger, 'project.prepared', { diagnostics: diagnostics.length, root, targets: [] });
      return preparedProject(loaded.configPath, snapshot, diagnostics, outputRoots, undefined, registry, root, source);
    }

    const diagnostics: Diagnostic[] = [...validateModel(model, registry)];
    for (const target of model.targets) {
      if (registry.has(target.name)) {
        diagnostics.push(...registry.get(target.name).plan(model).diagnostics);
      }
    }
    let projectContext: ProjectContext | undefined;
    try {
      projectContext = createProjectContext({
        configPath: loaded.configPath,
        model,
        root,
        sourceInputs: snapshot.inputs,
      });
    } catch (error) {
      diagnostics.push({
        code: 'AB7001',
        message: `Unable to create project context: ${errorMessage(error)}`,
        severity: 'error',
        sourcePath: loaded.configPath,
      });
    }
    const frozenDiagnostics = freezeDiagnostics(diagnostics);
    const source = sourceStatus(frozenDiagnostics, snapshot.revision);
    log(this.#options.logger, 'project.prepared', {
      diagnostics: frozenDiagnostics.length,
      root,
      targets: model.targets.map((target) => target.name),
    });
    return preparedProject(loaded.configPath, snapshot, frozenDiagnostics, outputRoots, projectContext, registry, root, source, model);
  }
}
