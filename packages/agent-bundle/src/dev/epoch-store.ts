import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { freezeArtifactEpoch, type ArtifactEpoch } from './types.ts';

export interface EpochStoreOptions {
  readonly projectRoot: string;
}

export interface CreateStagingEpochOptions {
  readonly epoch: ArtifactEpoch;
  readonly targets: readonly string[];
}

export type StagingValidator = (stagingRoot: string) => Promise<void>;

export type EpochStoreErrorCode =
  | 'EPOCH_ALREADY_EXISTS'
  | 'EPOCH_ID_INVALID'
  | 'EPOCH_METADATA_INVALID'
  | 'EPOCH_NOT_FOUND'
  | 'EPOCH_STAGING_CLOSED'
  | 'EPOCH_STAGING_INCOMPLETE'
  | 'EPOCH_TARGET_INVALID';

export class EpochStoreError extends Error {
  readonly code: EpochStoreErrorCode;

  constructor(code: EpochStoreErrorCode, message: string) {
    super(message);
    this.name = 'EpochStoreError';
    this.code = code;
  }
}

interface EpochMetadata {
  readonly epoch: ArtifactEpoch;
  readonly version: 1;
}

const activeEpochFileName = 'active-epoch.json';
const metadataDirectoryName = '.metadata';
const stagingPrefix = '.stage-';

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

const isSafePathSegment = (value: string): boolean =>
  /^[a-z0-9][a-z0-9._-]*$/iu.test(value) && value !== '.' && value !== '..';

const assertSafeEpochId = (value: string): void => {
  if (!isSafePathSegment(value)) {
    throw new EpochStoreError(
      'EPOCH_ID_INVALID',
      'Epoch id must be a non-empty path-safe identifier.',
    );
  }
};

const assertSafeTarget = (value: string): void => {
  if (!isSafePathSegment(value)) {
    throw new EpochStoreError(
      'EPOCH_TARGET_INVALID',
      'Epoch target names must be non-empty path-safe identifiers.',
    );
  }
};

const normalizeEpoch = (value: unknown): ArtifactEpoch | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const epoch = value as Partial<ArtifactEpoch>;
  const diagnostics = epoch.diagnostics;
  const targetDigests = epoch.targetDigests;
  if (
    typeof epoch.configDigest !== 'string' ||
    typeof epoch.createdAt !== 'string' ||
    typeof epoch.id !== 'string' ||
    typeof epoch.manifestPath !== 'string' ||
    typeof epoch.modelDigest !== 'string' ||
    typeof epoch.projectRevision !== 'string' ||
    typeof diagnostics !== 'object' ||
    diagnostics === null ||
    typeof diagnostics.errors !== 'number' ||
    typeof diagnostics.infos !== 'number' ||
    typeof diagnostics.warnings !== 'number' ||
    !Number.isSafeInteger(diagnostics.errors) ||
    !Number.isSafeInteger(diagnostics.infos) ||
    !Number.isSafeInteger(diagnostics.warnings) ||
    diagnostics.errors < 0 ||
    diagnostics.infos < 0 ||
    diagnostics.warnings < 0 ||
    typeof targetDigests !== 'object' ||
    targetDigests === null ||
    Array.isArray(targetDigests)
  ) {
    return undefined;
  }
  const targetEntries = Object.entries(targetDigests);
  if (targetEntries.some(([target, digest]) => !isSafePathSegment(target) || typeof digest !== 'string')) {
    return undefined;
  }
  if (!isSafePathSegment(epoch.id)) return undefined;

  return freezeArtifactEpoch({
    configDigest: epoch.configDigest,
    createdAt: epoch.createdAt,
    diagnostics: {
      errors: diagnostics.errors,
      infos: diagnostics.infos,
      warnings: diagnostics.warnings,
    },
    id: epoch.id,
    manifestPath: epoch.manifestPath,
    modelDigest: epoch.modelDigest,
    projectRevision: epoch.projectRevision,
    targetDigests: Object.fromEntries(
      targetEntries.sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
};

const assertEpoch = (value: ArtifactEpoch): ArtifactEpoch => {
  const epoch = normalizeEpoch(value);
  if (epoch === undefined) {
    throw new EpochStoreError(
      'EPOCH_METADATA_INVALID',
      'Artifact epoch metadata does not match the ArtifactEpoch contract.',
    );
  }
  return epoch;
};

const compareNewestFirst = (left: ArtifactEpoch, right: ArtifactEpoch): number =>
  right.createdAt === left.createdAt
    ? right.id.localeCompare(left.id)
    : right.createdAt.localeCompare(left.createdAt);

export class EpochReference {
  readonly #epochId: string;
  readonly #store: EpochStore;
  #closed = false;

  constructor(store: EpochStore, epochId: string) {
    this.#store = store;
    this.#epochId = epochId;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#store.releaseEpochReference(this.#epochId);
  }
}

export class EpochStaging {
  readonly #epoch: ArtifactEpoch;
  readonly #store: EpochStore;
  readonly #targets: readonly string[];
  #closed = false;

  constructor(store: EpochStore, root: string, epoch: ArtifactEpoch, targets: readonly string[]) {
    this.#store = store;
    this.root = root;
    this.#epoch = epoch;
    this.#targets = targets;
  }

  readonly root: string;

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await rm(this.root, { force: true, recursive: true });
  }

  async publish(validate: StagingValidator): Promise<ArtifactEpoch> {
    if (this.#closed) {
      throw new EpochStoreError('EPOCH_STAGING_CLOSED', 'Epoch staging is already closed.');
    }

    try {
      await validate(this.root);
      for (const target of this.#targets) {
        let metadata;
        try {
          metadata = await stat(join(this.root, target));
        } catch (error) {
          if (isErrno(error, 'ENOENT')) {
            throw new EpochStoreError(
              'EPOCH_STAGING_INCOMPLETE',
              `Staged epoch is missing selected target ${JSON.stringify(target)}.`,
            );
          }
          throw error;
        }
        if (!metadata.isDirectory()) {
          throw new EpochStoreError(
            'EPOCH_STAGING_INCOMPLETE',
            `Staged epoch target ${JSON.stringify(target)} is not a directory.`,
          );
        }
      }
      return await this.#store.publishStaging(this.root, this.#epoch);
    } finally {
      this.#closed = true;
      await rm(this.root, { force: true, recursive: true });
    }
  }
}

/** Filesystem-backed store for immutable artifact epochs in one project. */
export class EpochStore {
  readonly #activeEpochPath: string;
  readonly #epochMetadataPath: string;
  readonly #epochsPath: string;
  readonly #references = new Map<string, number>();

  constructor(options: EpochStoreOptions) {
    const agentBundlePath = join(resolve(options.projectRoot), '.agent-bundle');
    this.#activeEpochPath = join(agentBundlePath, activeEpochFileName);
    this.#epochsPath = join(agentBundlePath, 'epochs');
    this.#epochMetadataPath = join(this.#epochsPath, metadataDirectoryName);
  }

  async createStagingEpoch(options: CreateStagingEpochOptions): Promise<EpochStaging> {
    assertSafeEpochId(options.epoch.id);
    const epoch = assertEpoch(options.epoch);
    for (const target of options.targets) assertSafeTarget(target);
    await mkdir(this.#epochsPath, { recursive: true });
    const root = await mkdtemp(join(this.#epochsPath, stagingPrefix));
    return new EpochStaging(this, root, epoch, Object.freeze([...options.targets]));
  }

  async acquireEpochReference(epochId: string): Promise<EpochReference> {
    assertSafeEpochId(epochId);
    if (!(await pathExists(join(this.#epochsPath, epochId)))) {
      throw new EpochStoreError('EPOCH_NOT_FOUND', `Epoch ${JSON.stringify(epochId)} does not exist.`);
    }
    this.#references.set(epochId, (this.#references.get(epochId) ?? 0) + 1);
    return new EpochReference(this, epochId);
  }

  async releaseEpochReference(epochId: string): Promise<void> {
    const count = this.#references.get(epochId) ?? 0;
    if (count <= 1) {
      this.#references.delete(epochId);
      return;
    }
    this.#references.set(epochId, count - 1);
  }

  async publishStaging(stagingRoot: string, candidate: ArtifactEpoch): Promise<ArtifactEpoch> {
    const epoch = assertEpoch(candidate);
    const epochRoot = join(this.#epochsPath, epoch.id);
    if (await pathExists(epochRoot)) {
      throw new EpochStoreError('EPOCH_ALREADY_EXISTS', `Epoch ${JSON.stringify(epoch.id)} already exists.`);
    }

    let moved = false;
    try {
      await rename(stagingRoot, epochRoot);
      moved = true;
      await this.#writeEpochMetadata(epoch);
      await this.#writeActiveMetadata(epoch);
    } catch (error) {
      if (moved) {
        await Promise.all([
          rm(epochRoot, { force: true, recursive: true }),
          rm(this.#metadataPathFor(epoch.id), { force: true }),
        ]);
      }
      throw error;
    }
    await this.cleanup();
    return epoch;
  }

  async readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#activeEpochPath, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw new EpochStoreError(
        'EPOCH_METADATA_INVALID',
        'Active epoch metadata cannot be parsed as JSON.',
      );
    }
    const metadata = this.#parseMetadata(value);
    if (metadata === undefined) {
      throw new EpochStoreError(
        'EPOCH_METADATA_INVALID',
        'Active epoch metadata does not match the ArtifactEpoch contract.',
      );
    }
    return metadata.epoch;
  }

  async cleanup(): Promise<void> {
    const active = await this.readActiveEpoch();
    const metadata = await this.#readAllEpochMetadata();
    const protectedIds = new Set<string>(active === undefined ? [] : [active.id]);
    for (const epochId of this.#references.keys()) protectedIds.add(epochId);

    const retainedUnreferenced = metadata
      .filter((entry) => !protectedIds.has(entry.epoch.id))
      .sort((left, right) => compareNewestFirst(left.epoch, right.epoch))
      .slice(0, 5)
      .map((entry) => entry.epoch.id);
    for (const epochId of retainedUnreferenced) protectedIds.add(epochId);

    await Promise.all(
      metadata
        .filter((entry) => !protectedIds.has(entry.epoch.id))
        .map(async (entry) => {
          await Promise.all([
            rm(join(this.#epochsPath, entry.epoch.id), { force: true, recursive: true }),
            rm(this.#metadataPathFor(entry.epoch.id), { force: true }),
          ]);
        }),
    );
  }

  async recoverStaging(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.#epochsPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(stagingPrefix))
        .map((entry) => rm(join(this.#epochsPath, entry.name), { force: true, recursive: true })),
    );
  }

  #metadataPathFor(epochId: string): string {
    return join(this.#epochMetadataPath, `${epochId}.json`);
  }

  async #writeEpochMetadata(epoch: ArtifactEpoch): Promise<void> {
    await this.#writeJsonAtomically(this.#metadataPathFor(epoch.id), { epoch, version: 1 });
  }

  async #writeActiveMetadata(epoch: ArtifactEpoch): Promise<void> {
    await this.#writeJsonAtomically(this.#activeEpochPath, { epoch, version: 1 });
  }

  async #writeJsonAtomically(path: string, value: EpochMetadata): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await writeFile(temporaryPath, `${stableJson(value)}\n`, 'utf8');
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  #parseMetadata(value: unknown): EpochMetadata | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const metadata = value as Partial<EpochMetadata>;
    const epoch = normalizeEpoch(metadata.epoch);
    return metadata.version === 1 && epoch !== undefined ? Object.freeze({ epoch, version: 1 }) : undefined;
  }

  async #readAllEpochMetadata(): Promise<readonly EpochMetadata[]> {
    let entries;
    try {
      entries = await readdir(this.#epochMetadataPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return Object.freeze([]);
      throw error;
    }
    const metadata = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        try {
          return this.#parseMetadata(JSON.parse(await readFile(join(this.#epochMetadataPath, entry.name), 'utf8')));
        } catch {
          return undefined;
        }
      }));
    return Object.freeze(metadata.filter((entry): entry is EpochMetadata => entry !== undefined));
  }
}
