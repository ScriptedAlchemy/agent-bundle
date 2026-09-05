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
  type ArtifactManifestProvenance,
} from './manifest.ts';

const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
  left.path.localeCompare(right.path);

export const reindexArtifactManifest = async (
  root: string,
  changes: {
    readonly added?: readonly { path: string; kind: ArtifactManifestFile['kind'] }[];
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
    if (!files.delete(path)) {
      throw new Error(`Cannot remove unindexed artifact path ${JSON.stringify(path)}.`);
    }
    provenance.delete(path);
  }

  for (const path of changes.changed ?? []) {
    const previous = files.get(path);
    if (previous === undefined) {
      throw new Error(`Cannot update unindexed artifact path ${JSON.stringify(path)}.`);
    }
    files.set(path, createArtifactManifestFile(await inspectArtifactFile(root, path), previous.kind));
  }

  for (const added of changes.added ?? []) {
    if (files.has(added.path)) {
      throw new Error(`Cannot add already indexed artifact path ${JSON.stringify(added.path)}.`);
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
