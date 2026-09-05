import { compileEvidenceFileName } from './compile-evidence.ts';
import {
  createArtifactManifestFile,
  inspectArtifactFile,
  writeManifest,
} from './emit.ts';
import { readArtifactManifest } from './manifest-file.ts';
import {
  assembleArtifactManifest,
  type ArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactManifestFileKind,
  type ArtifactManifestProvenance,
} from './manifest.ts';

const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path.localeCompare(right.path);

/**
 * A compiled file is described by the compile evidence record beside it, byte
 * for byte; the record is the compiler's and only a rebuild produces another.
 * Reindexing may neither touch those files nor the record, or the evidence
 * would describe bytes the artifact no longer ships (`AB6039`).
 */
const requireReindexable = (file: ArtifactManifestFile): void => {
  if (file.kind === 'bundle' || file.path === compileEvidenceFileName) {
    throw new Error(`Cannot reindex compiled artifact path ${JSON.stringify(file.path)}: rebuild instead.`);
  }
};

/**
 * Rewrites the manifest of a copied artifact whose non-compiled files changed
 * (a dev install's rewritten MCP document, an install marker): the changed
 * rows are re-measured, added rows enter with empty provenance, and every
 * other row is carried over so the document stays the compiler's.
 */
export const reindexArtifactManifest = async (
  root: string,
  changes: {
    readonly added?: readonly { path: string; kind: Exclude<ArtifactManifestFileKind, 'bundle'> }[];
    readonly changed?: readonly string[];
    readonly removed?: readonly string[];
  },
): Promise<ArtifactManifest> => {
  const read = await readArtifactManifest(root);
  if (read.status !== 'ok') {
    const detail = read.status === 'invalid' ? `: ${read.detail}` : '';
    throw new Error(`Cannot reindex artifact manifest ${JSON.stringify(read.path)}${detail}.`);
  }

  const files = new Map(read.manifest.files.map((file) => [file.path, file]));
  const provenance = new Map(read.manifest.compiler.provenance.map((entry) => [entry.path, entry]));

  for (const path of changes.removed ?? []) {
    const previous = files.get(path);
    if (previous === undefined) {
      throw new Error(`Cannot remove unindexed artifact path ${JSON.stringify(path)}.`);
    }
    requireReindexable(previous);
    files.delete(path);
    provenance.delete(path);
  }

  for (const path of changes.changed ?? []) {
    const previous = files.get(path);
    if (previous === undefined) {
      throw new Error(`Cannot update unindexed artifact path ${JSON.stringify(path)}.`);
    }
    requireReindexable(previous);
    files.set(path, createArtifactManifestFile(await inspectArtifactFile(root, path), previous.kind));
  }

  for (const added of changes.added ?? []) {
    if (files.has(added.path)) {
      throw new Error(`Cannot add already indexed artifact path ${JSON.stringify(added.path)}.`);
    }
    if (added.path === compileEvidenceFileName) {
      throw new Error(`Cannot add ${JSON.stringify(added.path)}: only the compiler writes compile evidence.`);
    }
    files.set(
      added.path,
      createArtifactManifestFile(await inspectArtifactFile(root, added.path), added.kind),
    );
    provenance.set(added.path, Object.freeze({
      path: added.path,
      sourceInputs: Object.freeze([]),
    }) satisfies ArtifactManifestProvenance);
  }

  const manifest: ArtifactManifest = {
    ...read.manifest,
    compiler: {
      ...read.manifest.compiler,
      provenance: Object.freeze([...provenance.values()].sort(byPath)),
    },
    files: Object.freeze([...files.values()].sort(byPath)),
  };
  const assembled = assembleArtifactManifest(manifest);
  return writeManifest({ artifactRoot: read.root, manifest: assembled.manifest });
};
