import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { build, type BuildOptions, type BuildResult } from '../build/build.ts';
import { listArtifactFiles } from '../build/emit.ts';
import { validateArtifact, type ValidateArtifactOptions } from '../build/validate-artifact.ts';
import { DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import { digest } from '../core/digest.ts';
import type { NormalizedPlugin } from '../core/types.ts';
import { EpochStore, type EpochStaging } from './epoch-store.ts';
import { snapshotProjectSource, type PreparedProject, type ProjectSourceInput } from './project-service.ts';
import { freezeArtifactEpoch, type ArtifactEpoch, type DiagnosticSummary } from './types.ts';

export interface SucceededArtifactEpochResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly epoch: ArtifactEpoch;
  readonly outcome: 'succeeded';
}

export interface FailedArtifactEpochResult {
  readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  readonly outcome: 'failed';
}

export type ArtifactEpochResult = SucceededArtifactEpochResult | FailedArtifactEpochResult;

export type ArtifactCompiler = (options: BuildOptions) => Promise<BuildResult>;
export type ArtifactValidator = (context: ValidateArtifactOptions) => Promise<readonly Diagnostic[]>;

export interface ArtifactServiceOptions {
  readonly compile?: ArtifactCompiler;
  readonly createAttempt?: (projectRoot: string) => Promise<string>;
  readonly createEpochId?: () => string;
  readonly epochStore: EpochStore;
  readonly move?: (source: string, destination: string) => Promise<void>;
  readonly now?: () => Date;
  readonly removeAttempt?: (path: string) => Promise<void>;
  readonly validateArtifact?: ArtifactValidator;
}

const stagingMarkerFileName = '.agent-bundle-epoch-stage.json';

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));

const summarizeDiagnostics = (diagnostics: readonly Diagnostic[]): DiagnosticSummary => Object.freeze({
  errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
  infos: diagnostics.filter((diagnostic) => diagnostic.severity === 'info').length,
  warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failureDiagnostics = (
  error: unknown,
  configPath: string,
): readonly [Diagnostic, ...Diagnostic[]] => {
  if (error instanceof DiagnosticError && error.diagnostics.length > 0) {
    const diagnostics = error.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }));
    const first = diagnostics[0];
    if (first !== undefined) return Object.freeze([first, ...diagnostics.slice(1)]);
  }
  return Object.freeze([Object.freeze({
    code: 'AB7100',
    message: `Unable to compile artifact epoch: ${errorMessage(error)}`,
    severity: 'error' as const,
    sourcePath: configPath,
  })]);
};

const targetDigests = async (
  artifactRoot: string,
  model: NormalizedPlugin,
): Promise<Readonly<Record<string, string>>> => Object.freeze(Object.fromEntries(
  await Promise.all(model.targets.map(async (target) => [
    target.name,
    digest(await listArtifactFiles(join(artifactRoot, target.name))),
  ])),
));

const createAttempt = async (projectRoot: string): Promise<string> => {
  const attemptsRoot = join(resolve(projectRoot), '.agent-bundle', 'attempts');
  await mkdir(attemptsRoot, { recursive: true });
  return mkdtemp(join(attemptsRoot, 'attempt-'));
};

const moveArtifactContents = async (
  source: string,
  stagingRoot: string,
  move: (source: string, destination: string) => Promise<void>,
): Promise<void> => {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === stagingMarkerFileName) {
      throw new Error('Compiler output must not replace the epoch store staging marker.');
    }
    await move(join(source, entry.name), join(stagingRoot, entry.name));
  }
};

const requireBuildableProject = (prepared: PreparedProject): NormalizedPlugin | undefined =>
  prepared.model === undefined || hasErrors(prepared.diagnostics) ? undefined : prepared.model;

const sameInputs = (left: readonly ProjectSourceInput[], right: readonly ProjectSourceInput[]): boolean =>
  left.length === right.length && left.every((input, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      input.error === candidate.error &&
      input.path === candidate.path &&
      input.sha256 === candidate.sha256;
  });

const projectSourceChangedDiagnostic = (configPath: string): Diagnostic => Object.freeze({
  code: 'AB7101',
  message: 'Project source changed while the artifact was compiling; publication was rejected.',
  severity: 'error',
  sourcePath: configPath,
});

const cleanupDiagnostic = (
  resource: 'build attempt' | 'staging epoch',
  error: unknown,
  configPath: string,
  severity: Diagnostic['severity'],
): Diagnostic => Object.freeze({
  code: 'AB7100',
  message: `Unable to clean up ${resource} after artifact epoch build: ${errorMessage(error)}`,
  severity,
  sourcePath: configPath,
});

const canonicalProjectPath = (root: string, value: string): string => {
  if (!isAbsolute(value)) return value;
  const projectRelative = relative(root, value).replaceAll('\\', '/');
  return projectRelative === '..' || projectRelative.startsWith('../') ? value : projectRelative;
};

const canonicalProvenance = (
  root: string,
  provenance: NormalizedPlugin['metadata']['provenance'],
) => Object.freeze({ ...provenance, sourcePath: canonicalProjectPath(root, provenance.sourcePath) });

const canonicalModel = (model: NormalizedPlugin, root: string): unknown => Object.freeze({
  ...model,
  extensions: Object.freeze(Object.fromEntries(Object.entries(model.extensions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, extension]) => [key, Object.freeze({
      ...extension,
      provenance: canonicalProvenance(root, extension.provenance),
    })]))),
  hooks: model.hooks.map((hook) => Object.freeze({
    ...hook,
    provenance: canonicalProvenance(root, hook.provenance),
    source: canonicalProjectPath(root, hook.source),
  })),
  ...(model.mcpApps === undefined
    ? {}
    : {
      mcpApps: model.mcpApps.map((app) => Object.freeze({
        ...app,
        provenance: canonicalProvenance(root, app.provenance),
        source: canonicalProjectPath(root, app.source),
        ...(app.template === undefined ? {} : { template: canonicalProjectPath(root, app.template) }),
      })),
    }),
  mcpServers: model.mcpServers.map((server) => Object.freeze({
    ...server,
    provenance: canonicalProvenance(root, server.provenance),
    ...(server.source === undefined ? {} : { source: canonicalProjectPath(root, server.source) }),
  })),
  metadata: Object.freeze({
    ...model.metadata,
    provenance: canonicalProvenance(root, model.metadata.provenance),
  }),
  ...(model.nativeHooks === undefined
    ? {}
    : {
      nativeHooks: model.nativeHooks.map((hook) => Object.freeze({
        ...hook,
        provenance: canonicalProvenance(root, hook.provenance),
        source: canonicalProjectPath(root, hook.source),
      })),
    }),
  scripts: model.scripts.map((script) => Object.freeze({
    ...script,
    provenance: canonicalProvenance(root, script.provenance),
    source: canonicalProjectPath(root, script.source),
  })),
  skills: model.skills.map((skill) => Object.freeze({
    ...skill,
    dir: canonicalProjectPath(root, skill.dir),
    provenance: canonicalProvenance(root, skill.provenance),
    resources: skill.resources.map((resource) => Object.freeze({
      ...resource,
      source: canonicalProjectPath(root, resource.source),
    })),
    source: canonicalProjectPath(root, skill.source),
  })),
  targets: model.targets.map((target) => Object.freeze({
    ...target,
    provenance: canonicalProvenance(root, target.provenance),
  })),
});

/** Compiles one prepared project into an immutable, fully validated epoch. */
export class ArtifactService {
  readonly #compile: ArtifactCompiler;
  readonly #createAttempt: (projectRoot: string) => Promise<string>;
  readonly #createEpochId: () => string;
  readonly #epochStore: EpochStore;
  readonly #move: (source: string, destination: string) => Promise<void>;
  readonly #now: () => Date;
  readonly #removeAttempt: (path: string) => Promise<void>;
  readonly #validateArtifact: ArtifactValidator;

  constructor(options: ArtifactServiceOptions) {
    this.#compile = options.compile ?? build;
    this.#createAttempt = options.createAttempt ?? createAttempt;
    this.#createEpochId = options.createEpochId ?? randomUUID;
    this.#epochStore = options.epochStore;
    this.#move = options.move ?? rename;
    this.#now = options.now ?? (() => new Date());
    this.#removeAttempt = options.removeAttempt ?? ((path) => rm(path, { force: true, recursive: true }));
    this.#validateArtifact = options.validateArtifact ?? validateArtifact;
  }

  async build(prepared: PreparedProject): Promise<ArtifactEpochResult> {
    const model = requireBuildableProject(prepared);
    if (model === undefined) {
      return Object.freeze({
        diagnostics: failureDiagnostics(new DiagnosticError(prepared.diagnostics), prepared.configPath),
        outcome: 'failed',
      });
    }
    if (prepared.source.revision === undefined) {
      return Object.freeze({
        diagnostics: failureDiagnostics(
          new Error('Prepared projects must include a source revision before artifact compilation.'),
          prepared.configPath,
        ),
        outcome: 'failed',
      });
    }
    if (prepared.configDigest === undefined) {
      return Object.freeze({
        diagnostics: failureDiagnostics(
          new Error('Prepared projects must include a configuration digest before artifact compilation.'),
          prepared.configPath,
        ),
        outcome: 'failed',
      });
    }

    const attemptRoot = await this.#createAttempt(prepared.root);
    const artifactRoot = join(attemptRoot, 'artifact');
    let staging: EpochStaging | undefined;
    let stagingClosed = false;
    let result: ArtifactEpochResult;

    try {
      await this.#compile({
        model,
        outputRoot: artifactRoot,
        projectRoot: prepared.root,
        registry: prepared.registry,
      });
      const validationDiagnostics = freezeDiagnostics(await this.#validateArtifact({ artifactRoot }));
      const diagnostics = freezeDiagnostics([...prepared.diagnostics, ...validationDiagnostics]);
      if (hasErrors(diagnostics)) throw new DiagnosticError(diagnostics);

      const currentSource = await snapshotProjectSource(prepared.root, prepared.configPath);
      if (!sameInputs(prepared.sourceInputs, currentSource.inputs)) {
        throw new DiagnosticError([projectSourceChangedDiagnostic(prepared.configPath)]);
      }

      const epochId = this.#createEpochId();
      const epoch = freezeArtifactEpoch({
        configDigest: prepared.configDigest,
        createdAt: this.#now().toISOString(),
        diagnostics: summarizeDiagnostics(diagnostics),
        id: epochId,
        manifestPath: join(prepared.root, '.agent-bundle', 'epochs', epochId, 'agent-bundle.manifest.json'),
        modelDigest: digest(canonicalModel(model, prepared.root)),
        projectRevision: prepared.source.revision,
        targetDigests: await targetDigests(artifactRoot, model),
      });
      staging = await this.#epochStore.createStagingEpoch({
        epoch,
        targets: model.targets.map((target) => target.name),
      });
      await moveArtifactContents(artifactRoot, staging.root, this.#move);
      const published = await staging.publish(async (stagingRoot) => {
        const stagedDiagnostics = freezeDiagnostics(await this.#validateArtifact({
          allowEpochStagingMarker: true,
          artifactRoot: stagingRoot,
        }));
        if (hasErrors(stagedDiagnostics)) throw new DiagnosticError(stagedDiagnostics);
      });
      stagingClosed = true;
      result = Object.freeze({ diagnostics, epoch: published, outcome: 'succeeded' });
    } catch (error) {
      result = Object.freeze({
        diagnostics: failureDiagnostics(error, prepared.configPath),
        outcome: 'failed',
      });
    }

    const cleanups: readonly Readonly<{
      readonly close: () => Promise<void>;
      readonly resource: 'build attempt' | 'staging epoch';
    }>[] = [
      ...(staging === undefined || stagingClosed
        ? []
        : [{ close: () => staging.close(), resource: 'staging epoch' as const }]),
      { close: () => this.#removeAttempt(attemptRoot), resource: 'build attempt' },
    ];
    const cleanupResults = await Promise.allSettled(cleanups.map(({ close }) => close()));
    const cleanupDiagnostics = cleanupResults.flatMap((cleanupResult, index): readonly Diagnostic[] => {
      if (cleanupResult.status === 'fulfilled') return [];
      const cleanup = cleanups[index];
      return cleanup === undefined
        ? []
        : [cleanupDiagnostic(
          cleanup.resource,
          cleanupResult.reason,
          prepared.configPath,
          result.outcome === 'succeeded' ? 'warning' : 'error',
        )];
    });
    if (cleanupDiagnostics.length === 0) return result;

    const diagnostics = freezeDiagnostics([...result.diagnostics, ...cleanupDiagnostics]);
    if (result.outcome === 'succeeded') {
      return Object.freeze({ diagnostics, epoch: result.epoch, outcome: 'succeeded' });
    }

    const [firstDiagnostic, ...remainingDiagnostics] = diagnostics;
    if (firstDiagnostic === undefined) return result;
    const failedDiagnostics: [Diagnostic, ...Diagnostic[]] = [firstDiagnostic, ...remainingDiagnostics];
    return Object.freeze({
      diagnostics: Object.freeze(failedDiagnostics),
      outcome: 'failed',
    });
  }
}
