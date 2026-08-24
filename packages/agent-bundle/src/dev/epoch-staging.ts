import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rename, rm, type open } from 'node:fs/promises';
import { join } from 'node:path';

import { mapConcurrent } from '../core/async.ts';
import { stableJson } from '../core/digest.ts';
import { readPinnedFile, syncPath, writeNewPinnedFile } from '../core/durable-fs.ts';
import { CodedError, isErrno } from '../core/errors.ts';
import { isInside } from '../core/paths.ts';
import { freezeArtifactEpoch, type ArtifactEpoch } from './types.ts';

/**
 * Staging publication/recovery path for the epoch store.
 *
 * The store error vocabulary lives here (epoch-store.ts re-exports it) so the
 * dependency between the store and this module stays one-way: the staging
 * path constructs these errors, and epoch-store.ts imports this sibling.
 */

export type EpochStoreErrorCode =
  | 'EPOCH_ALREADY_EXISTS'
  | 'EPOCH_ID_INVALID'
  | 'EPOCH_MANIFEST_INVALID'
  | 'EPOCH_METADATA_INVALID'
  | 'EPOCH_NOT_FOUND'
  | 'EPOCH_STAGING_CLOSED'
  | 'EPOCH_STAGING_INVALID'
  | 'EPOCH_TARGET_INVALID'
  | 'EPOCH_TARGET_SET_INVALID';

export class EpochStoreError extends CodedError<EpochStoreErrorCode> {
  constructor(code: EpochStoreErrorCode, message: string) {
    super('EpochStoreError', code, message);
  }
}

export class EpochPostCommitCleanupError extends Error {
  readonly committedEpoch: ArtifactEpoch;

  constructor(committedEpoch: ArtifactEpoch, cleanupError: unknown) {
    super('Epoch publication committed, but retention cleanup failed.', { cause: cleanupError });
    this.name = 'EpochPostCommitCleanupError';
    this.committedEpoch = freezeArtifactEpoch(committedEpoch);
    Object.freeze(this);
  }
}

export interface EpochDurabilityStorage {
  readonly open: typeof open;
  readonly remove: typeof rm;
}

export type StagingValidator = (stagingRoot: string) => Promise<void>;

/** A publication-bound resource is rolled back only by the publisher that created it. */
export interface EpochPublicationReceipt {
  rollback(): Promise<void>;
}

export type EpochPreActivation = (epoch: ArtifactEpoch) => Promise<EpochPublicationReceipt | void>;

/** Opaque, store-created staging root that can be published at most once. */
export interface EpochStaging {
  close(): Promise<void>;
  publish(validate: StagingValidator, beforeActivate?: EpochPreActivation): Promise<ArtifactEpoch>;
  readonly root: string;
}

export interface StagingRecord {
  readonly epoch: ArtifactEpoch;
  readonly markerContents: string;
  readonly root: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly targets: readonly string[];
}

/**
 * Store-private seams the staging path needs, passed explicitly by the store
 * instead of exporting its private internals.
 */
export interface EpochStagingContext {
  /** Retention pass run under the already-held lease after a committed publish. */
  readonly cleanupUnderLease: () => Promise<void>;
  readonly durabilityStorage: EpochDurabilityStorage;
  readonly epochsPath: string;
  readonly manifestRelativePath: (epoch: ArtifactEpoch) => string;
  readonly metadataPathFor: (epochId: string) => string;
  /** Invalidates the store's active-epoch cache and marks retention dirty. */
  readonly onCommitted: () => void;
  readonly runLeaseTransition: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly writeActiveMetadata: (epoch: ArtifactEpoch) => Promise<void>;
  readonly writeEpochMetadata: (epoch: ArtifactEpoch) => Promise<void>;
}

const stagingMarkerFileName = '.agent-bundle-epoch-stage.json';
const stagingMarkerMaximumBytes = 1024;
export const stagingPrefix = '.stage-';
const syncTreeConcurrency = 16;

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

export class EpochStagingHandle implements EpochStaging {
  readonly #close: () => Promise<void>;
  readonly #publish: (validate: StagingValidator, beforeActivate?: EpochPreActivation) => Promise<ArtifactEpoch>;
  #closed = false;

  constructor(
    root: string,
    publish: (validate: StagingValidator, beforeActivate?: EpochPreActivation) => Promise<ArtifactEpoch>,
    close: () => Promise<void>,
  ) {
    this.root = root;
    this.#publish = publish;
    this.#close = close;
  }

  readonly root: string;

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#close();
  }

  async publish(validate: StagingValidator, beforeActivate?: EpochPreActivation): Promise<ArtifactEpoch> {
    if (this.#closed) {
      throw new EpochStoreError('EPOCH_STAGING_CLOSED', 'Epoch staging is already closed.');
    }
    this.#closed = true;
    return this.#publish(validate, beforeActivate);
  }
}

export const syncDurablePath = async (storage: EpochDurabilityStorage, path: string, directory = false): Promise<void> => {
  await syncPath(path, { directory, open: storage.open });
};

/** Writes the store-owned staging marker and returns its exact contents. */
export const createStagingMarker = async (root: string): Promise<string> => {
  const markerContents = `${stableJson({ token: randomUUID() })}\n`;
  await writeNewPinnedFile(join(root, stagingMarkerFileName), markerContents, {
    invalid: () =>
      new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging marker could not be created safely.'),
  });
  return markerContents;
};

/** Removes leftover staging directories from crashed or interrupted publishes. */
export const removeStagingRemnants = async (epochsPath: string): Promise<void> => {
  let entries;
  try {
    entries = await readdir(epochsPath, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(stagingPrefix))
      .map((entry) => rm(join(epochsPath, entry.name), { force: true, recursive: true })),
  );
};

const removeStagingMarker = async (storage: EpochDurabilityStorage, record: StagingRecord): Promise<void> => {
  const markerPath = join(record.root, stagingMarkerFileName);
  await syncDurablePath(storage, markerPath);
  await storage.remove(markerPath);
  await syncDurablePath(storage, record.root, true);
};

const syncStagedTree = async (storage: EpochDurabilityStorage, path: string): Promise<void> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new EpochStoreError('EPOCH_STAGING_INVALID', 'Staged epoch contents must not contain symbolic links.');
  }
  if (metadata.isFile()) {
    await syncDurablePath(storage, path);
    return;
  }
  if (!metadata.isDirectory()) {
    throw new EpochStoreError('EPOCH_STAGING_INVALID', 'Staged epoch contents must be regular files or directories.');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const directories: string[] = [];
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(child);
    else files.push(child);
  }
  await Promise.all([
    mapConcurrent(directories, syncTreeConcurrency, (child) => syncStagedTree(storage, child)),
    mapConcurrent(files, syncTreeConcurrency, (child) => syncStagedTree(storage, child)),
  ]);
  await syncDurablePath(storage, path, true);
};

export const verifyStaging = async (context: EpochStagingContext, record: StagingRecord): Promise<void> => {
  let rootMetadata;
  try {
    rootMetadata = await lstat(record.root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging root no longer exists.');
    }
    throw error;
  }
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.dev !== record.rootDevice ||
    rootMetadata.ino !== record.rootInode
  ) {
    throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging root was replaced.');
  }
  const markerReplaced = (): EpochStoreError =>
    new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging marker was replaced.');
  let markerContents: string;
  try {
    markerContents = await readPinnedFile(join(record.root, stagingMarkerFileName), {
      changedWhileOpening: markerReplaced,
      changedWhileReading: markerReplaced,
      maximumBytes: stagingMarkerMaximumBytes,
      unsafe: markerReplaced,
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging marker is missing.');
    }
    throw error;
  }
  if (markerContents !== record.markerContents) throw markerReplaced();

  const [epochsRoot, stagingRoot] = await Promise.all([
    realpath(context.epochsPath),
    realpath(record.root),
  ]);
  if (!isInside(epochsRoot, stagingRoot)) {
    throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The staging root escapes the epoch store.');
  }

  for (const target of record.targets) {
    const targetPath = join(record.root, target);
    let targetMetadata;
    try {
      targetMetadata = await lstat(targetPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError(
          'EPOCH_STAGING_INVALID',
          `Staged epoch is missing selected target ${JSON.stringify(target)}.`,
        );
      }
      throw error;
    }
    if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
      throw new EpochStoreError(
        'EPOCH_STAGING_INVALID',
        `Staged epoch target ${JSON.stringify(target)} must be a contained non-symlink directory.`,
      );
    }
    if (!isInside(stagingRoot, await realpath(targetPath))) {
      throw new EpochStoreError(
        'EPOCH_STAGING_INVALID',
        `Staged epoch target ${JSON.stringify(target)} escapes the staging root.`,
      );
    }
  }

  const manifestPath = join(record.root, context.manifestRelativePath(record.epoch));
  let manifestMetadata;
  try {
    manifestMetadata = await lstat(manifestPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new EpochStoreError('EPOCH_MANIFEST_INVALID', 'Staged epoch manifest is missing.');
    }
    throw error;
  }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || !isInside(stagingRoot, await realpath(manifestPath))) {
    throw new EpochStoreError('EPOCH_MANIFEST_INVALID', 'Staged epoch manifest must be a contained non-symlink file.');
  }
};

export const publishVerifiedStaging = async (
  context: EpochStagingContext,
  record: StagingRecord,
  beforeActivate: EpochPreActivation | undefined,
): Promise<ArtifactEpoch> => {
  const epochRoot = join(context.epochsPath, record.epoch.id);
  if (await pathExists(epochRoot)) {
    throw new EpochStoreError('EPOCH_ALREADY_EXISTS', `Epoch ${JSON.stringify(record.epoch.id)} already exists.`);
  }

  let publication: EpochPublicationReceipt | undefined;
  if (beforeActivate !== undefined) {
    publication = (await beforeActivate(record.epoch)) ?? undefined;
  }
  return context.runLeaseTransition(async () => {
    let moved = false;
    try {
      if (await pathExists(epochRoot)) {
        throw new EpochStoreError('EPOCH_ALREADY_EXISTS', `Epoch ${JSON.stringify(record.epoch.id)} already exists.`);
      }
      await syncStagedTree(context.durabilityStorage, record.root);
      await removeStagingMarker(context.durabilityStorage, record);
      await rename(record.root, epochRoot);
      moved = true;
      await syncDurablePath(context.durabilityStorage, context.epochsPath, true);
      await context.writeEpochMetadata(record.epoch);
      await context.writeActiveMetadata(record.epoch);
      context.onCommitted();
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(moved ? [
          rm(epochRoot, { force: true, recursive: true }),
          rm(context.metadataPathFor(record.epoch.id), { force: true }),
        ] : []),
        ...(publication === undefined ? [] : [publication.rollback()]),
      ]);
      const cleanupFailures = cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'Epoch publication and rollback both failed.', { cause: error });
      }
      throw error;
    }
    try {
      await context.cleanupUnderLease();
    } catch (error) {
      throw new EpochPostCommitCleanupError(record.epoch, error);
    }
    return record.epoch;
  });
};
