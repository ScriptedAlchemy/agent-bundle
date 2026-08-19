import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { build } from '../api.ts';
import { createDefaultRegistry, type TargetRegistry } from '../adapters/registry.ts';
import { parseArtifactManifest, type ArtifactManifest } from '../build/manifest.ts';
import { validateArtifact } from '../build/validate-artifact.ts';
import { digest } from '../core/digest.ts';
import { EvalHarnessError } from './errors.ts';
import type { EvalArtifactBinding } from './run-store.ts';
import { isErrno } from '../core/errors.ts';

export interface PrepareEvalArtifactOptions {
  /** An explicit already-built artifact root. Nothing is ever guessed from an ambient output directory. */
  readonly artifact?: string;
  readonly configPath?: string;
  readonly projectRoot: string;
  readonly registry?: TargetRegistry;
  readonly runDirectory: string;
  readonly targets?: readonly string[];
}

export interface PreparedEvalArtifact {
  readonly binding: EvalArtifactBinding;
  readonly manifest: ArtifactManifest;
  readonly root: string;
}

const manifestName = 'agent-bundle.manifest.json';
const runOwnedArtifactSegments = Object.freeze(['artifacts', 'target']);

const harnessError = (
  code: ConstructorParameters<typeof EvalHarnessError>[0],
  message: string,
): EvalHarnessError => new EvalHarnessError(code, message);

/** One digest per generated target, derived from the manifest's own recorded file hashes. */
export const evalTargetDigests = (manifest: ArtifactManifest): Readonly<Record<string, string>> => {
  const buckets = new Map<string, { path: string; sha256: string }[]>(
    manifest.targets.map((target) => [target.name, []]),
  );
  for (const file of manifest.files) {
    const separator = file.path.indexOf('/');
    if (separator <= 0) continue;
    const bucket = buckets.get(file.path.slice(0, separator));
    if (bucket !== undefined) bucket.push({ path: file.path.slice(separator + 1), sha256: file.sha256 });
  }
  return Object.freeze(Object.fromEntries([...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([target, files]) => [
      target,
      digest({
        files: files.sort((left, right) => left.path.localeCompare(right.path)),
        runtime: manifest.runtime,
        target,
      }),
    ])));
};

const readValidatedArtifact = async (
  artifactRoot: string,
  registry: TargetRegistry,
  source: EvalArtifactBinding['source'],
): Promise<PreparedEvalArtifact> => {
  let metadata;
  try {
    metadata = await lstat(artifactRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw harnessError('EVAL_ARTIFACT_MISSING', `Eval artifact ${JSON.stringify(artifactRoot)} does not exist.`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw harnessError('EVAL_ARTIFACT_MISSING', `Eval artifact ${JSON.stringify(artifactRoot)} must be a non-symlink directory.`);
  }

  const diagnostics = await validateArtifact({ artifactRoot, registry });
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw harnessError(
      'EVAL_ARTIFACT_INVALID',
      `Eval artifact ${JSON.stringify(artifactRoot)} failed validation: ${errors.map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`).join(' ')}`,
    );
  }

  const manifestPath = join(artifactRoot, manifestName);
  let manifest: ArtifactManifest;
  try {
    manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw harnessError(
      'EVAL_ARTIFACT_INVALID',
      `Eval artifact manifest ${JSON.stringify(manifestPath)} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({
    binding: Object.freeze({ manifestPath, source, targetDigests: evalTargetDigests(manifest) }),
    manifest,
    root: artifactRoot,
  });
};

/**
 * Explicit artifacts are read exactly where the author pointed. Current-source runs
 * build exactly one immutable copy inside the run directory that every trial shares.
 */
export const prepareEvalArtifact = async (
  options: PrepareEvalArtifactOptions,
): Promise<PreparedEvalArtifact> => {
  const registry = options.registry ?? createDefaultRegistry();
  if (options.artifact !== undefined) {
    return readValidatedArtifact(resolve(options.artifact), registry, 'explicit');
  }

  const runDirectory = resolve(options.runDirectory);
  const artifactRoot = join(runDirectory, ...runOwnedArtifactSegments);
  const containment = relative(runDirectory, artifactRoot);
  if (containment.length === 0 || isAbsolute(containment) || containment.startsWith('..')) {
    throw harnessError('EVAL_ARTIFACT_INVALID', 'The run-owned artifact copy must live inside the run directory.');
  }
  await build({
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    output: artifactRoot,
    registry,
    root: options.projectRoot,
    ...(options.targets === undefined ? {} : { targets: [...options.targets] }),
  });
  return readValidatedArtifact(artifactRoot, registry, 'run-owned');
};
