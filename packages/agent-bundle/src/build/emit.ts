import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename as renameFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { sha256Hex } from '../core/digest.ts';
import { assertInside, exists, toPosixPath } from '../core/paths.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import {
  compileEvidenceFileName,
  serializeCompileEvidenceRecord,
  type CompileEvidenceRecord,
} from './compile-evidence.ts';
import {
  artifactManifestName,
  assembleArtifactManifest,
  parseArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactManifestProvenance,
  type ArtifactManifest,
} from './manifest.ts';
import type { ArtifactOutputProvenance } from './provenance.ts';
import { deepFreeze } from '../core/freeze.ts';

export type ManifestFile = ArtifactManifestFile;

export interface ArtifactFile {
  readonly bytes: number;
  readonly mode: number;
  readonly path: string;
  readonly sha256: string;
}

export type ArtifactFilesystemEntryKind = 'directory' | 'file' | 'other' | 'symlink';

export interface ArtifactFilesystemEntry {
  readonly kind: ArtifactFilesystemEntryKind;
  readonly path: string;
}

export interface ArtifactFilesystemSnapshot {
  readonly entries: readonly ArtifactFilesystemEntry[];
  readonly files: readonly ArtifactFile[];
}

export { artifactManifestName } from './manifest.ts';

const normalizeRelativePath = toPosixPath;

const executableFileMode = (file: ArtifactFile): number | undefined =>
  (file.mode & 0o111) === 0 ? undefined : file.mode;

export const resolveArtifactDestination = (root: string, relativePath: string): string =>
  assertInside(root, resolve(root, relativePath));

export const inspectArtifactFile = async (
  root: string,
  relativePath: string,
): Promise<ArtifactFile> => {
  const destination = resolveArtifactDestination(root, relativePath);
  const metadata = await lstat(destination);
  if (!metadata.isFile()) {
    throw new Error(`Artifact path ${JSON.stringify(relativePath)} is not a file.`);
  }
  const contents = await readFile(destination);
  return Object.freeze({
    bytes: contents.byteLength,
    mode: metadata.mode & 0o777,
    path: normalizeRelativePath(relativePath),
    sha256: sha256Hex(contents),
  });
};

export const createArtifactManifestFile = (
  file: ArtifactFile,
  kind: ArtifactManifestFile['kind'],
): ArtifactManifestFile => {
  const mode = executableFileMode(file);
  return Object.freeze({
    bytes: file.bytes,
    kind,
    ...(mode === undefined ? {} : { mode }),
    path: file.path,
    sha256: file.sha256,
  });
};

export const assertUniqueArtifactDestinations = (
  destinations: readonly string[],
): void => {
  const seen = new Set<string>();
  for (const destination of destinations) {
    if (seen.has(destination)) {
      throw new Error(`Duplicate planned artifact destination ${JSON.stringify(destination)}.`);
    }
    seen.add(destination);
  }
};

const writeEntry = async (destination: string, entry: TargetArtifactEntry): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });

  if (entry.kind === 'write') {
    await writeFile(destination, entry.content, 'utf8');
    return;
  }

  const [contents, sourceMetadata] = await Promise.all([
    readFile(entry.source),
    stat(entry.source),
  ]);
  if (contents.byteLength !== entry.bytes) {
    throw new Error(
      `Planned byte count for ${JSON.stringify(entry.source)} does not match its current content.`,
    );
  }
  await writeFile(destination, contents);
  await chmod(destination, sourceMetadata.mode & 0o777);
};

export const emitPlanEntries = async (options: {
  readonly entries: readonly TargetArtifactEntry[];
  readonly root: string;
}): Promise<void> => {
  const planned = options.entries.map((entry) => ({
    destination: resolveArtifactDestination(options.root, entry.relativePath),
    entry,
  }));
  assertUniqueArtifactDestinations(planned.map(({ destination }) => destination));

  await Promise.all(planned.map(({ destination, entry }) => writeEntry(destination, entry)));
};

const filesystemEntryKind = (metadata: Awaited<ReturnType<typeof lstat>>): ArtifactFilesystemEntryKind => {
  if (metadata.isDirectory()) return 'directory';
  if (metadata.isFile()) return 'file';
  return metadata.isSymbolicLink() ? 'symlink' : 'other';
};

const inspectArtifactDirectory = async (
  root: string,
  prefix: string,
): Promise<ArtifactFilesystemSnapshot> => {
  const directoryPath = join(root, prefix);
  const directoryMetadata = await lstat(directoryPath);
  if (!directoryMetadata.isDirectory()) {
    return {
      entries: deepFreeze([{
        kind: filesystemEntryKind(directoryMetadata),
        path: prefix === '' ? '.' : normalizeRelativePath(prefix),
      }]),
      files: Object.freeze([]),
    };
  }

  const directory = await readdir(directoryPath);
  // Entries are inspected concurrently; collection order stays the sorted-name order.
  const inspections = await Promise.all(directory
    .sort((left, right) => left.localeCompare(right))
    .map(async (name): Promise<ArtifactFilesystemSnapshot> => {
      const path = join(prefix, name);
      const normalizedPath = normalizeRelativePath(path);
      const absolutePath = join(root, path);
      const metadata = await lstat(absolutePath);
      const kind = filesystemEntryKind(metadata);
      const entry: ArtifactFilesystemEntry = { kind, path: normalizedPath };

      if (kind === 'directory') {
        const nested = await inspectArtifactDirectory(root, path);
        return { entries: [entry, ...nested.entries], files: nested.files };
      }
      if (kind !== 'file') return { entries: [entry], files: [] };

      const contents = await readFile(absolutePath);
      return {
        entries: [entry],
        files: [{
          bytes: contents.byteLength,
          mode: metadata.mode & 0o777,
          path: normalizedPath,
          sha256: sha256Hex(contents),
        }],
      };
    }));

  return {
    entries: Object.freeze(inspections.flatMap((inspection) => inspection.entries)),
    files: Object.freeze(inspections.flatMap((inspection) => inspection.files)),
  };
};

export const inspectArtifactFilesystem = async (root: string): Promise<ArtifactFilesystemSnapshot> =>
  inspectArtifactDirectory(root, '');

export const listArtifactFiles = async (
  root: string,
  prefix = '',
): Promise<readonly ArtifactFile[]> => (await inspectArtifactDirectory(root, prefix)).files;

export const createArtifactManifestFiles = (options: {
  readonly files: readonly ArtifactFile[];
  readonly outputProvenance: readonly ArtifactOutputProvenance[];
}): {
  readonly files: readonly ArtifactManifestFile[];
  readonly provenance: readonly ArtifactManifestProvenance[];
} => {
  const filesByPath = new Map<string, ArtifactFile>();
  for (const file of options.files) {
    if (file.path === artifactManifestName) {
      throw new Error('Artifact manifest must not include itself in the file table.');
    }
    if (filesByPath.has(file.path)) {
      throw new Error(`Artifact files contain duplicate path ${JSON.stringify(file.path)}.`);
    }
    filesByPath.set(file.path, file);
  }

  const provenanceByPath = new Map<string, ArtifactOutputProvenance>();
  for (const provenance of options.outputProvenance) {
    if (provenance.path === artifactManifestName) {
      throw new Error('Output provenance must not include the artifact manifest.');
    }
    if (provenanceByPath.has(provenance.path)) {
      throw new Error(`Output provenance contains duplicate path ${JSON.stringify(provenance.path)}.`);
    }
    provenanceByPath.set(provenance.path, provenance);
  }

  if (filesByPath.size !== provenanceByPath.size) {
    throw new Error('Output provenance must contain exactly one record for every pre-manifest artifact file.');
  }

  const manifestFiles: ArtifactManifestFile[] = [];
  const manifestProvenance: ArtifactManifestProvenance[] = [];
  for (const [path, file] of filesByPath) {
    const provenance = provenanceByPath.get(path);
    if (provenance === undefined) {
      throw new Error('Output provenance must contain exactly one record for every pre-manifest artifact file.');
    }
    manifestFiles.push(createArtifactManifestFile(file, provenance.kind));
    manifestProvenance.push({
      path,
      sourceInputs: provenance.sourceInputs,
    });
  }
  for (const path of provenanceByPath.keys()) {
    if (!filesByPath.has(path)) {
      throw new Error('Output provenance must contain exactly one record for every pre-manifest artifact file.');
    }
  }

  const byPath = (left: { readonly path: string }, right: { readonly path: string }): number =>
    left.path.localeCompare(right.path);
  return Object.freeze({
    files: Object.freeze(manifestFiles.sort(byPath)),
    provenance: Object.freeze(manifestProvenance.sort(byPath)),
  });
};

export const writeManifest = async (options: {
  readonly artifactRoot: string;
  readonly manifest: ArtifactManifest;
}): Promise<ArtifactManifest> => {
  const assembled = assembleArtifactManifest(options.manifest);
  const manifestPath = join(options.artifactRoot, artifactManifestName);
  await writeFile(manifestPath, assembled.bytes, 'utf8');
  return parseArtifactManifest(await readFile(manifestPath, 'utf8'));
};

export const writeCompileEvidence = async (options: {
  readonly artifactRoot: string;
  readonly evidence: CompileEvidenceRecord;
}): Promise<void> => {
  await writeFile(
    join(options.artifactRoot, compileEvidenceFileName),
    serializeCompileEvidenceRecord(options.evidence),
    'utf8',
  );
};

export const publishArtifact = async (options: {
  readonly outputRoot: string;
  readonly rename?: (source: string, destination: string) => Promise<void>;
  readonly stageRoot: string;
}): Promise<void> => {
  const move = options.rename ?? renameFile;
  const backupRoot = join(
    dirname(options.outputRoot),
    `.${basename(options.outputRoot)}.backup-${basename(options.stageRoot)}`,
  );
  const hadOutput = await exists(options.outputRoot);
  let restoreRequired = false;

  try {
    if (hadOutput) {
      await move(options.outputRoot, backupRoot);
      restoreRequired = true;
    }
    try {
      await move(options.stageRoot, options.outputRoot);
    } catch (error) {
      if (restoreRequired) {
        await move(backupRoot, options.outputRoot);
        restoreRequired = false;
      }
      throw error;
    }
    if (restoreRequired) {
      restoreRequired = false;
      await rm(backupRoot, { force: true, recursive: true });
    }
  } finally {
    await rm(options.stageRoot, { force: true, recursive: true });
    if (!restoreRequired) {
      await rm(backupRoot, { force: true, recursive: true });
    }
  }
};
