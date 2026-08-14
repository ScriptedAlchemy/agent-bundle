import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { discoverProject } from '../config/discover.ts';
import { loadConfig } from '../config/load.ts';
import { normalizeProject } from '../config/normalize.ts';
import { validateModel, validateSource } from '../config/validate.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import type { DiscoveredProject } from '../config/discover.ts';
import type { SourceStatus } from './types.ts';

export type ProjectCommand = 'build' | 'inspect' | 'validate';

export interface ProjectServiceLogger {
  log?(event: string, details: Readonly<Record<string, unknown>>): void;
}

export interface ProjectServiceOptions {
  readonly configPath?: string;
  readonly logger?: ProjectServiceLogger;
  readonly mode?: string;
  readonly root: string;
  readonly targets?: readonly string[];
}

export interface PreparedProject {
  readonly diagnostics: readonly Diagnostic[];
  readonly model?: NormalizedPlugin;
  readonly registry: TargetRegistry;
  readonly root: string;
  readonly source: SourceStatus;
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

const relativeSourcePath = (root: string, source: string): string =>
  relative(root, source).replaceAll('\\', '/');

const sourceInput = async (root: string, source: string) => {
  const path = relativeSourcePath(root, source);
  try {
    return Object.freeze({
      digest: createHash('sha256').update(await readFile(source)).digest('hex'),
      path,
    });
  } catch (error) {
    return Object.freeze({ error: errorCode(error), path });
  }
};

const sourceRevision = async (
  root: string,
  configPath: string,
  discovered?: DiscoveredProject,
): Promise<string> => {
  const sources = new Set<string>([configPath]);
  for (const skill of discovered?.skills ?? []) {
    sources.add(skill.source);
    for (const resource of skill.resources) {
      sources.add(resource.source);
    }
  }

  const inputs = await Promise.all([...sources].map((source) => sourceInput(root, source)));
  return digest({
    inputs: inputs.sort((left, right) => left.path.localeCompare(right.path)),
  });
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
  diagnostics: readonly Diagnostic[],
  registry: TargetRegistry,
  root: string,
  source: SourceStatus,
  model?: NormalizedPlugin,
): PreparedProject => Object.freeze({
  diagnostics,
  ...(model === undefined ? {} : { model }),
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
      const source = sourceStatus(diagnostics, await sourceRevision(root, configPath));
      log(this.#options.logger, 'project.invalid-source', { diagnostics: diagnostics.length, root });
      return preparedProject(diagnostics, registry, root, source);
    }

    const revision = await sourceRevision(root, loaded.configPath, discovered);
    const sourceDiagnostics = freezeDiagnostics(validateSource(loaded, discovered));
    if (hasErrors(sourceDiagnostics)) {
      const source = sourceStatus(sourceDiagnostics, revision);
      log(this.#options.logger, 'project.invalid-source', { diagnostics: sourceDiagnostics.length, root });
      return preparedProject(sourceDiagnostics, registry, root, source);
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
      const source = sourceStatus(diagnostics, revision);
      log(this.#options.logger, 'project.prepared', { diagnostics: diagnostics.length, root, targets: [] });
      return preparedProject(diagnostics, registry, root, source);
    }

    const diagnostics: Diagnostic[] = [...validateModel(model, registry)];
    for (const target of model.targets) {
      if (registry.has(target.name)) {
        diagnostics.push(...registry.get(target.name).plan(model).diagnostics);
      }
    }
    const frozenDiagnostics = freezeDiagnostics(diagnostics);
    const source = sourceStatus(frozenDiagnostics, revision);
    log(this.#options.logger, 'project.prepared', {
      diagnostics: frozenDiagnostics.length,
      root,
      targets: model.targets.map((target) => target.name),
    });
    return preparedProject(frozenDiagnostics, registry, root, source, model);
  }
}
