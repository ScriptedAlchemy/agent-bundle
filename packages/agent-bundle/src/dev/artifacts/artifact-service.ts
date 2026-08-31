import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { build, type BuildOptions, type BuildResult } from '../../build/build.ts';
import { listArtifactFiles } from '../../build/emit.ts';
import {
  recheckValidatedArtifactSnapshot,
  validateArtifact,
  validateArtifactWithSnapshot,
  type ValidateArtifactOptions,
} from '../../build/validate-artifact.ts';
import { freezeDiagnostics, hasErrors, DiagnosticError, type Diagnostic } from '../../core/diagnostics.ts';
import { digest } from '../../core/digest.ts';
import type { ProjectSourceInput, ProjectSourceSnapshotInput } from '../../core/project-context.ts';
import type { NormalizedPlugin } from '../../core/types.ts';
import {
  EpochPostCommitCleanupError,
  EpochPostCommitDurabilityError,
  EpochStore,
  type EpochStaging,
} from '../epoch-store.ts';
import {
  publishNativePlaygroundCatalogSnapshot,
  type NativePlaygroundCatalogPublicationOptions,
  type NativePlaygroundCatalogPublicationReceipt,
} from '../playground/native-playground-service.ts';
import { snapshotProjectSource, type PreparedProject } from '../project-service.ts';
import { freezeArtifactEpoch, type ArtifactEpoch, type DiagnosticSummary } from '../types.ts';

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
  /** Captures server-owned native Playground choices before this epoch becomes active. */
  readonly publishNativeCatalog?: (options: NativePlaygroundCatalogPublicationOptions) => Promise<NativePlaygroundCatalogPublicationReceipt>;
  readonly now?: () => Date;
  readonly removeAttempt?: (path: string) => Promise<void>;
  readonly validateArtifact?: ArtifactValidator;
}

const stagingMarkerFileName = '.agent-bundle-epoch-stage.json';

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
    message: `Unable to compile the build: ${errorMessage(error)}`,
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

const sameInputs = (left: readonly ProjectSourceInput[], right: readonly ProjectSourceSnapshotInput[]): boolean =>
  left.length === right.length && left.every((input, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      input.path === candidate.path &&
      candidate.error === undefined &&
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
  message: `Unable to clean up ${resource} after the build: ${errorMessage(error)}`,
  severity,
  sourcePath: configPath,
});

const postCommitDiagnostic = (error: Error, configPath: string): Diagnostic => Object.freeze({
  code: 'AB7102',
  message: `Artifact epoch was committed, but follow-up work was incomplete: ${error.message}`,
  severity: 'warning',
  sourcePath: configPath,
});

/** Compiles one prepared project into an immutable, fully validated epoch. */
export class ArtifactService {
  readonly #compile: ArtifactCompiler;
  readonly #createAttempt: (projectRoot: string) => Promise<string>;
  readonly #createEpochId: () => string;
  readonly #epochStore: EpochStore;
  readonly #move: (source: string, destination: string) => Promise<void>;
  readonly #publishNativeCatalog: (options: NativePlaygroundCatalogPublicationOptions) => Promise<NativePlaygroundCatalogPublicationReceipt>;
  readonly #now: () => Date;
  readonly #removeAttempt: (path: string) => Promise<void>;
  readonly #validateArtifact?: ArtifactValidator;

  constructor(options: ArtifactServiceOptions) {
    this.#compile = options.compile ?? build;
    this.#createAttempt = options.createAttempt ?? createAttempt;
    this.#createEpochId = options.createEpochId ?? randomUUID;
    this.#epochStore = options.epochStore;
    this.#move = options.move ?? rename;
    this.#publishNativeCatalog = options.publishNativeCatalog ?? publishNativePlaygroundCatalogSnapshot;
    this.#now = options.now ?? (() => new Date());
    this.#removeAttempt = options.removeAttempt ?? ((path) => rm(path, { force: true, recursive: true }));
    this.#validateArtifact = options.validateArtifact;
  }

  async build(prepared: PreparedProject): Promise<ArtifactEpochResult> {
    const model = requireBuildableProject(prepared);
    if (model === undefined) {
      return Object.freeze({
        diagnostics: failureDiagnostics(new DiagnosticError(prepared.diagnostics), prepared.configPath),
        outcome: 'failed',
      });
    }
    const projectContext = prepared.projectContext;
    if (projectContext === undefined) {
      return Object.freeze({
        diagnostics: failureDiagnostics(
          new Error('Prepared projects must include a project context before artifact compilation.'),
          prepared.configPath,
        ),
        outcome: 'failed',
      });
    }

    const attemptRoot = await this.#createAttempt(prepared.root);
    const artifactRoot = join(attemptRoot, 'artifact');
    let staging: EpochStaging | undefined;
    let stagingClosed = false;
    let buildDiagnostics = freezeDiagnostics(prepared.diagnostics);
    let result: ArtifactEpochResult;

    try {
      await this.#compile({
        model,
        outputRoot: artifactRoot,
        projectContext,
        projectRoot: prepared.root,
        registry: prepared.registry,
        ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
      });
      const firstValidation = this.#validateArtifact === undefined
        ? await validateArtifactWithSnapshot({
          artifactRoot,
          registry: prepared.registry,
        })
        : {
          diagnostics: await this.#validateArtifact({
            artifactRoot,
            registry: prepared.registry,
          }),
          snapshot: undefined,
      };
      const validationDiagnostics = freezeDiagnostics(firstValidation.diagnostics);
      buildDiagnostics = freezeDiagnostics([...prepared.diagnostics, ...validationDiagnostics]);
      if (hasErrors(buildDiagnostics)) throw new DiagnosticError(buildDiagnostics);

      const currentSource = await (prepared.snapshotSource ?? (() => snapshotProjectSource(
        prepared.root,
        prepared.configPath,
        prepared.outputRoots,
      )))();
      if (!sameInputs(projectContext.sourceInputs, currentSource.inputs)) {
        throw new DiagnosticError([projectSourceChangedDiagnostic(prepared.configPath)]);
      }

      const epochId = this.#createEpochId();
      const epoch = freezeArtifactEpoch({
        configDigest: projectContext.configDigest,
        createdAt: this.#now().toISOString(),
        diagnostics: summarizeDiagnostics(buildDiagnostics),
        id: epochId,
        manifestPath: join(prepared.root, '.agent-bundle', 'epochs', epochId, 'agent-bundle.manifest.json'),
        modelDigest: projectContext.modelDigest,
        projectRevision: projectContext.revision,
        targetDigests: await targetDigests(artifactRoot, model),
      });
      staging = await this.#epochStore.createStagingEpoch({
        epoch,
        targets: model.targets.map((target) => target.name),
      });
      await moveArtifactContents(artifactRoot, staging.root, this.#move);
      const published = await staging.publish(async (stagingRoot) => {
        const stagedDiagnostics = freezeDiagnostics(
          firstValidation.snapshot === undefined
            ? await (this.#validateArtifact ?? validateArtifact)({
              allowEpochStagingMarker: true,
              artifactRoot: stagingRoot,
              registry: prepared.registry,
            })
            : await recheckValidatedArtifactSnapshot(firstValidation.snapshot, {
              allowEpochStagingMarker: true,
              artifactRoot: stagingRoot,
              registry: prepared.registry,
            }),
        );
        if (hasErrors(stagedDiagnostics)) throw new DiagnosticError(stagedDiagnostics);
      }, async (publishingEpoch) => {
        return this.#publishNativeCatalog(Object.freeze({ epoch: publishingEpoch, projectRoot: prepared.root }));
      });
      stagingClosed = true;
      result = Object.freeze({ diagnostics: buildDiagnostics, epoch: published, outcome: 'succeeded' });
    } catch (error) {
      if (error instanceof EpochPostCommitCleanupError || error instanceof EpochPostCommitDurabilityError) {
        stagingClosed = true;
        result = Object.freeze({
          diagnostics: freezeDiagnostics([...buildDiagnostics, postCommitDiagnostic(error, prepared.configPath)]),
          epoch: error.committedEpoch,
          outcome: 'succeeded',
        });
      } else {
        result = Object.freeze({
          diagnostics: failureDiagnostics(error, prepared.configPath),
          outcome: 'failed',
        });
      }
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
