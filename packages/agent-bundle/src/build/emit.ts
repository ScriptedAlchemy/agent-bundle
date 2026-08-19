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

import { sha256Hex, stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { assertInside } from '../core/paths.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';
import {
  artifactHookIndexName,
  compareArtifactHooks,
  type ArtifactHook,
  type ArtifactHookIndex,
} from './hook-index.ts';
import {
  assembleArtifactManifest,
  parseArtifactManifest,
  type ArtifactManifestFile,
  type ArtifactManifest,
} from './manifest.ts';
import type { ArtifactOutputProvenance } from './provenance.ts';

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

export { artifactHookIndexName } from './hook-index.ts';
export type { ArtifactHook, ArtifactHookIndex } from './hook-index.ts';
export const artifactManifestName = 'agent-bundle.manifest.json';

const normalizeRelativePath = (path: string): string => path.replaceAll('\\', '/');

const executableFileMode = (file: ArtifactFile): number | undefined =>
  (file.mode & 0o111) === 0 ? undefined : file.mode;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

export const resolveArtifactDestination = (root: string, relativePath: string): string =>
  assertInside(root, resolve(root, relativePath));

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

  for (const { destination, entry } of planned) {
    await writeEntry(destination, entry);
  }
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
      entries: Object.freeze([Object.freeze({
        kind: filesystemEntryKind(directoryMetadata),
        path: prefix === '' ? '.' : normalizeRelativePath(prefix),
      })]),
      files: Object.freeze([]),
    };
  }

  const directory = await readdir(directoryPath);
  const files: ArtifactFile[] = [];
  const entries: ArtifactFilesystemEntry[] = [];

  for (const name of directory.sort((left, right) => left.localeCompare(right))) {
    const path = join(prefix, name);
    const normalizedPath = normalizeRelativePath(path);
    const absolutePath = join(root, path);
    const metadata = await lstat(absolutePath);
    const kind = filesystemEntryKind(metadata);
    entries.push({ kind, path: normalizedPath });

    if (kind === 'directory') {
      const nested = await inspectArtifactDirectory(root, path);
      entries.push(...nested.entries);
      files.push(...nested.files);
      continue;
    }
    if (kind !== 'file') continue;

    const contents = await readFile(absolutePath);
    files.push({
      bytes: contents.byteLength,
      mode: metadata.mode & 0o777,
      path: normalizedPath,
      sha256: sha256Hex(contents),
    });
  }

  return {
    entries: Object.freeze(entries),
    files: Object.freeze(files),
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
}): readonly ArtifactManifestFile[] => {
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
  for (const [path, file] of filesByPath) {
    const provenance = provenanceByPath.get(path);
    if (provenance === undefined) {
      throw new Error('Output provenance must contain exactly one record for every pre-manifest artifact file.');
    }
    const mode = executableFileMode(file);
    manifestFiles.push({
      bytes: file.bytes,
      kind: provenance.kind,
      ...(mode === undefined ? {} : { mode }),
      path,
      sha256: file.sha256,
      sourceInputs: provenance.sourceInputs,
    });
  }
  for (const path of provenanceByPath.keys()) {
    if (!filesByPath.has(path)) {
      throw new Error('Output provenance must contain exactly one record for every pre-manifest artifact file.');
    }
  }

  return Object.freeze(manifestFiles.sort((left, right) => left.path.localeCompare(right.path)));
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

export const writeHookIndex = async (options: {
  readonly artifactRoot: string;
  readonly hooks: readonly ArtifactHook[];
}): Promise<ArtifactHookIndex> => {
  const hooks = options.hooks
    .slice()
    .sort(compareArtifactHooks)
    .map((hook) => Object.freeze({ ...hook }));
  const index: ArtifactHookIndex = {
    hooks: Object.freeze(hooks),
  };
  await writeFile(
    join(options.artifactRoot, artifactHookIndexName),
    `${stableJson(index)}\n`,
    'utf8',
  );
  return Object.freeze(index);
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
