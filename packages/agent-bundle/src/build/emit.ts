import { createHash } from 'node:crypto';
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

import { stableJson } from '../core/digest.ts';
import { assertInside } from '../core/paths.ts';
import type { TargetArtifactEntry } from '../adapters/types.ts';

export interface ManifestFile {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

export interface ArtifactFile extends ManifestFile {
  readonly mode: number;
}

export interface ArtifactManifest {
  readonly files: readonly ManifestFile[];
  readonly targets: readonly string[];
  readonly version: number;
}

const normalizeRelativePath = (path: string): string => path.replaceAll('\\', '/');

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

const writeEntry = async (root: string, entry: TargetArtifactEntry): Promise<void> => {
  const destination = assertInside(root, resolve(root, entry.relativePath));
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
  const destinations = new Set<string>();
  for (const entry of options.entries) {
    const destination = normalizeRelativePath(entry.relativePath);
    if (destinations.has(destination)) {
      throw new Error(`Duplicate planned artifact destination ${JSON.stringify(destination)}.`);
    }
    destinations.add(destination);
    await writeEntry(options.root, entry);
  }
};

export const listArtifactFiles = async (
  root: string,
  prefix = '',
): Promise<readonly ArtifactFile[]> => {
  const directory = await readdir(join(root, prefix), { withFileTypes: true });
  const files: ArtifactFile[] = [];

  for (const entry of directory.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listArtifactFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) continue;

    const absolutePath = join(root, path);
    const [contents, metadata] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ]);
    files.push({
      bytes: contents.byteLength,
      mode: metadata.mode & 0o777,
      path: normalizeRelativePath(path),
      sha256: createHash('sha256').update(contents).digest('hex'),
    });
  }

  return files;
};

export const writeManifest = async (options: {
  readonly artifactRoot: string;
  readonly targets: readonly string[];
}): Promise<ArtifactManifest> => {
  const files = await listArtifactFiles(options.artifactRoot);
  const manifest: ArtifactManifest = {
    files: Object.freeze(files.map(({ bytes, path, sha256 }) => ({ bytes, path, sha256 }))),
    targets: Object.freeze([...options.targets].sort()),
    version: 1,
  };
  await writeFile(
    join(options.artifactRoot, 'agent-bundle.manifest.json'),
    `${stableJson(manifest)}\n`,
    'utf8',
  );
  return Object.freeze(manifest);
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
