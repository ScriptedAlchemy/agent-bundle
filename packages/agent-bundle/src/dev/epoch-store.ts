import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { serialQueue } from '../core/async.ts';
import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { isInside } from '../core/paths.ts';
import { freezeArtifactEpoch, type ArtifactEpoch } from './types.ts';

export interface EpochStoreOptions {
  /** @internal Deterministic cleanup-failure seam. */
  readonly cleanupRemove?: typeof rm;
  readonly projectRoot: string;
  /** @internal Deterministic staging-marker durability seam. */
  readonly stagingMarkerStorage?: EpochStagingMarkerStorage;
}

export interface EpochStagingMarkerStorage {
  readonly open: typeof open;
  readonly remove: typeof rm;
}

export interface CreateStagingEpochOptions {
  readonly epoch: ArtifactEpoch;
  readonly targets: readonly string[];
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

export type EpochCleanupResource = 'directory' | 'metadata' | 'native-playground-catalog';

export interface EpochCleanupFailure {
  readonly epochId: string;
  readonly reason: unknown;
  readonly resource: EpochCleanupResource;
}

export class EpochCleanupError extends Error {
  readonly failures: readonly EpochCleanupFailure[];

  constructor(failures: readonly EpochCleanupFailure[]) {
    super('One or more epoch cleanup operations failed.');
    this.name = 'EpochCleanupError';
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
    Object.freeze(this);
  }
}

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

interface StagingRecord {
  readonly epoch: ArtifactEpoch;
  readonly markerContents: string;
  readonly root: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly targets: readonly string[];
}

const activeEpochFileName = 'active-epoch.json';
const metadataDirectoryName = '.metadata';
const nativePlaygroundCatalogDirectoryName = 'native-playground';
const stagingMarkerFileName = '.agent-bundle-epoch-stage.json';
const stagingPrefix = '.stage-';

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

const cleanupFailure = (
  epochId: string,
  resource: EpochCleanupResource,
  reason: unknown,
): EpochCleanupFailure => Object.freeze({ epochId, reason, resource });

class EpochStagingHandle implements EpochStaging {
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

export class EpochReference {
  readonly #epochId: string;
  readonly #store: EpochStore;
  #close: Promise<void> | undefined;

  constructor(store: EpochStore, epoch: ArtifactEpoch, root: string) {
    this.#store = store;
    this.#epochId = epoch.id;
    this.epoch = epoch;
    this.root = root;
  }

  /** Detached immutable metadata for the exact epoch this lease pins. */
  readonly epoch: ArtifactEpoch;

  /** Immutable epoch directory validated before this reference was acquired. */
  readonly root: string;

  close(): Promise<void> {
    this.#close ??= this.#store.releaseEpochReference(this.#epochId);
    return this.#close;
  }
}

/** Filesystem-backed store for immutable artifact epochs in one project. */
export class EpochStore {
  readonly #activeEpochPath: string;
  readonly #cleanupRemove: typeof rm;
  readonly #epochMetadataPath: string;
  readonly #epochsPath: string;
  readonly #references = new Map<string, number>();
  readonly #staging = new Map<symbol, StagingRecord>();
  readonly #stagingMarkerStorage: EpochStagingMarkerStorage;
  readonly #transitions = serialQueue();

  constructor(options: EpochStoreOptions) {
    const agentBundlePath = join(resolve(options.projectRoot), '.agent-bundle');
    this.#activeEpochPath = join(agentBundlePath, activeEpochFileName);
    this.#cleanupRemove = options.cleanupRemove ?? rm;
    this.#epochsPath = join(agentBundlePath, 'epochs');
    this.#epochMetadataPath = join(this.#epochsPath, metadataDirectoryName);
    this.#stagingMarkerStorage = options.stagingMarkerStorage ?? Object.freeze({ open, remove: rm });
  }

  async createStagingEpoch(options: CreateStagingEpochOptions): Promise<EpochStaging> {
    return this.#transitions.run(async () => {
      assertSafeEpochId(options.epoch.id);
      const epoch = assertEpoch(options.epoch);
      const targets = this.#assertTargetSet(epoch, options.targets);
      this.#manifestRelativePath(epoch);
      await mkdir(this.#epochsPath, { recursive: true });
      const root = await mkdtemp(join(this.#epochsPath, stagingPrefix));
      const metadata = await lstat(root);
      const markerContents = `${stableJson({ token: randomUUID(), version: 1 })}\n`;
      await writeFile(join(root, stagingMarkerFileName), markerContents, 'utf8');
      const token = Symbol('epoch-staging');
      this.#staging.set(token, {
        epoch,
        markerContents,
        root,
        rootDevice: metadata.dev,
        rootInode: metadata.ino,
        targets,
      });
      return new EpochStagingHandle(
        root,
        async (validate, beforeActivate) => this.#publishStaging(token, validate, beforeActivate),
        async () => this.#closeStaging(token),
      );
    });
  }

  async acquireEpochReference(epochId: string): Promise<EpochReference> {
    return this.#transitions.run(async () => {
      assertSafeEpochId(epochId);
      await this.#assertEpochDirectory(epochId);
      return this.#acquireEpochReference(await this.#readEpochMetadata(epochId).then((metadata) => metadata.epoch));
    });
  }

  /** Resolves and leases the current epoch without allowing a publish between those operations. */
  async acquireActiveEpochReference(): Promise<EpochReference> {
    return this.#transitions.run(async () => {
      const epoch = await this.#readActiveEpoch();
      if (epoch === undefined) {
        throw new EpochStoreError('EPOCH_NOT_FOUND', 'No active artifact epoch is available.');
      }
      return this.#acquireEpochReference(epoch);
    });
  }

  /** Returns detached safe epoch identities, ordered newest first. */
  async listEpochs(): Promise<readonly ArtifactEpoch[]> {
    return this.#transitions.run(async () => Object.freeze((await this.#readAllEpochMetadata())
      .map((metadata) => freezeArtifactEpoch(metadata.epoch))
      .sort(compareNewestFirst)));
  }

  async releaseEpochReference(epochId: string): Promise<void> {
    await this.#transitions.run(async () => {
      const count = this.#references.get(epochId) ?? 0;
      if (count === 1) {
        this.#references.delete(epochId);
        await this.#cleanup();
        return;
      }
      if (count > 1) this.#references.set(epochId, count - 1);
    });
  }

  async readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
    return this.#transitions.run(async () => this.#readActiveEpoch());
  }

  async cleanup(): Promise<void> {
    await this.#transitions.run(async () => this.#cleanup());
  }

  async recoverStaging(): Promise<void> {
    await this.#transitions.run(async () => {
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
    });
  }

  async #readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
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
    await this.#validateActiveEpoch(metadata.epoch);
    return metadata.epoch;
  }

  async #acquireEpochReference(epoch: ArtifactEpoch): Promise<EpochReference> {
    const epochPath = await this.#assertEpochDirectory(epoch.id);
    this.#references.set(epoch.id, (this.#references.get(epoch.id) ?? 0) + 1);
    return new EpochReference(this, freezeArtifactEpoch(epoch), epochPath);
  }

  async #assertEpochDirectory(epochId: string): Promise<string> {
    const epochPath = join(this.#epochsPath, epochId);
    try {
      const metadata = await lstat(epochPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new EpochStoreError('EPOCH_NOT_FOUND', `Epoch ${JSON.stringify(epochId)} does not exist.`);
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError('EPOCH_NOT_FOUND', `Epoch ${JSON.stringify(epochId)} does not exist.`);
      }
      throw error;
    }
    return epochPath;
  }

  async #cleanup(): Promise<void> {
    const active = await this.#readActiveEpoch();
    const metadata = await this.#readAllEpochMetadata();
    const protectedIds = new Set<string>(active === undefined ? [] : [active.id]);
    for (const epochId of this.#references.keys()) protectedIds.add(epochId);

    const retainedUnreferenced = metadata
      .filter((entry) => !protectedIds.has(entry.epoch.id))
      .sort((left, right) => compareNewestFirst(left.epoch, right.epoch))
      .slice(0, 5)
      .map((entry) => entry.epoch.id);
    for (const epochId of retainedUnreferenced) protectedIds.add(epochId);

    const attempts = await Promise.allSettled(
      metadata
        .filter((entry) => !protectedIds.has(entry.epoch.id))
        .map(async (entry) => {
          let resource: EpochCleanupResource = 'native-playground-catalog';
          try {
            // Keep epoch metadata and the immutable epoch itself discoverable
            // until its paired native catalog sidecar is gone, so a failed
            // sidecar deletion can be retried rather than orphaned.
            await this.#cleanupRemove(this.#nativePlaygroundCatalogPathFor(entry.epoch.id), { force: true });
            resource = 'directory';
            await this.#cleanupRemove(join(this.#epochsPath, entry.epoch.id), { force: true, recursive: true });
            resource = 'metadata';
            await this.#cleanupRemove(this.#metadataPathFor(entry.epoch.id), { force: true });
          } catch (reason) {
            throw cleanupFailure(entry.epoch.id, resource, reason);
          }
        }),
    );
    const failures = attempts
      .flatMap((attempt): EpochCleanupFailure[] =>
        attempt.status === 'rejected' ? [attempt.reason as EpochCleanupFailure] : [])
      .sort((left, right) =>
        left.epochId.localeCompare(right.epochId) || left.resource.localeCompare(right.resource));
    if (failures.length > 0) throw new EpochCleanupError(failures);
  }

  async #closeStaging(token: symbol): Promise<void> {
    await this.#transitions.run(async () => {
      const record = this.#staging.get(token);
      if (record === undefined) return;
      this.#staging.delete(token);
      await rm(record.root, { force: true, recursive: true });
    });
  }

  async #publishStaging(
    token: symbol,
    validate: StagingValidator,
    beforeActivate: EpochPreActivation | undefined,
  ): Promise<ArtifactEpoch> {
    return this.#transitions.run(async () => {
      const record = this.#staging.get(token);
      if (record === undefined) {
        throw new EpochStoreError('EPOCH_STAGING_CLOSED', 'Epoch staging is already closed.');
      }
      this.#staging.delete(token);
      try {
        await validate(record.root);
        await this.#verifyStaging(record);
        return await this.#publishVerifiedStaging(record, beforeActivate);
      } finally {
        await rm(record.root, { force: true, recursive: true });
      }
    });
  }

  async #publishVerifiedStaging(record: StagingRecord, beforeActivate: EpochPreActivation | undefined): Promise<ArtifactEpoch> {
    const epochRoot = join(this.#epochsPath, record.epoch.id);
    if (await pathExists(epochRoot)) {
      throw new EpochStoreError('EPOCH_ALREADY_EXISTS', `Epoch ${JSON.stringify(record.epoch.id)} already exists.`);
    }

    let moved = false;
    let publication: EpochPublicationReceipt | undefined;
    try {
      if (beforeActivate !== undefined) {
        publication = (await beforeActivate(record.epoch)) ?? undefined;
      }
      await this.#removeStagingMarker(record);
      await rename(record.root, epochRoot);
      moved = true;
      await this.#writeEpochMetadata(record.epoch);
      await this.#writeActiveMetadata(record.epoch);
    } catch (error) {
      const cleanupResults = await Promise.allSettled([
        ...(moved ? [
          rm(epochRoot, { force: true, recursive: true }),
          rm(this.#metadataPathFor(record.epoch.id), { force: true }),
        ] : []),
        ...(publication === undefined ? [] : [publication.rollback()]),
      ]);
      const cleanupFailures = cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], 'Epoch publication and rollback both failed.', { cause: error });
      }
      throw error;
    }
    await this.#cleanup();
    return record.epoch;
  }

  async #removeStagingMarker(record: StagingRecord): Promise<void> {
    const markerPath = join(record.root, stagingMarkerFileName);
    await this.#syncPath(markerPath);
    await this.#stagingMarkerStorage.remove(markerPath);
    await this.#syncPath(record.root);
  }

  async #syncPath(path: string): Promise<void> {
    const handle = await this.#stagingMarkerStorage.open(path, 'r');
    try { await handle.sync(); }
    finally { await handle.close(); }
  }

  async #verifyStaging(record: StagingRecord): Promise<void> {
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
    try {
      const markerMetadata = await lstat(join(record.root, stagingMarkerFileName));
      if (
        !markerMetadata.isFile() ||
        markerMetadata.isSymbolicLink() ||
        await readFile(join(record.root, stagingMarkerFileName), 'utf8') !== record.markerContents
      ) {
        throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging marker was replaced.');
      }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError('EPOCH_STAGING_INVALID', 'The store-created staging marker is missing.');
      }
      throw error;
    }

    const [epochsRoot, stagingRoot] = await Promise.all([
      realpath(this.#epochsPath),
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

    const manifestPath = join(record.root, this.#manifestRelativePath(record.epoch));
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
  }

  async #validateActiveEpoch(epoch: ArtifactEpoch): Promise<void> {
    const activeMetadata = await this.#readEpochMetadata(epoch.id);
    if (stableJson(activeMetadata.epoch) !== stableJson(epoch)) {
      throw new EpochStoreError(
        'EPOCH_METADATA_INVALID',
        'Active epoch metadata does not match its persisted epoch metadata.',
      );
    }

    const epochRoot = join(this.#epochsPath, epoch.id);
    let epochRootMetadata;
    try {
      epochRootMetadata = await lstat(epochRoot);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch directory does not exist.');
      }
      throw error;
    }
    if (!epochRootMetadata.isDirectory() || epochRootMetadata.isSymbolicLink()) {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch directory must be a non-symlink directory.');
    }

    const [epochsRoot, activeEpochRoot] = await Promise.all([
      realpath(this.#epochsPath),
      realpath(epochRoot),
    ]);
    if (!isInside(epochsRoot, activeEpochRoot)) {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch directory escapes the epoch store.');
    }

    for (const target of Object.keys(epoch.targetDigests)) {
      const targetPath = join(epochRoot, target);
      let targetMetadata;
      try {
        targetMetadata = await lstat(targetPath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          throw new EpochStoreError(
            'EPOCH_METADATA_INVALID',
            `Active epoch is missing target ${JSON.stringify(target)}.`,
          );
        }
        throw error;
      }
      if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
        throw new EpochStoreError(
          'EPOCH_METADATA_INVALID',
          `Active epoch target ${JSON.stringify(target)} must be a non-symlink directory.`,
        );
      }
      if (!isInside(activeEpochRoot, await realpath(targetPath))) {
        throw new EpochStoreError(
          'EPOCH_METADATA_INVALID',
          `Active epoch target ${JSON.stringify(target)} escapes the epoch directory.`,
        );
      }
    }

    let manifestRelativePath: string;
    try {
      manifestRelativePath = this.#manifestRelativePath(epoch);
    } catch {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch manifest path escapes the epoch directory.');
    }
    const manifestPath = join(epochRoot, manifestRelativePath);
    let manifestMetadata;
    try {
      manifestMetadata = await lstat(manifestPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch manifest does not exist.');
      }
      throw error;
    }
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.isSymbolicLink() ||
      !isInside(activeEpochRoot, await realpath(manifestPath))
    ) {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch manifest must be a contained non-symlink file.');
    }
  }

  #assertTargetSet(epoch: ArtifactEpoch, targets: readonly string[]): readonly string[] {
    for (const target of targets) assertSafeTarget(target);
    const selected = [...targets].sort();
    const expected = Object.keys(epoch.targetDigests).sort();
    if (
      selected.length !== expected.length ||
      new Set(selected).size !== selected.length ||
      selected.some((target, index) => target !== expected[index])
    ) {
      throw new EpochStoreError(
        'EPOCH_TARGET_SET_INVALID',
        'Selected epoch targets must exactly match the artifact epoch target digests.',
      );
    }
    return Object.freeze(selected);
  }

  #manifestRelativePath(epoch: ArtifactEpoch): string {
    const epochRoot = join(this.#epochsPath, epoch.id);
    const manifestPath = resolve(epoch.manifestPath);
    if (!isInside(epochRoot, manifestPath)) {
      throw new EpochStoreError(
        'EPOCH_MANIFEST_INVALID',
        'Artifact epoch manifestPath must be contained by its final epoch directory.',
      );
    }
    return relative(epochRoot, manifestPath);
  }

  #metadataPathFor(epochId: string): string {
    return join(this.#epochMetadataPath, `${epochId}.json`);
  }

  #nativePlaygroundCatalogPathFor(epochId: string): string {
    return join(this.#epochMetadataPath, nativePlaygroundCatalogDirectoryName, `${epochId}.json`);
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

  async #readEpochMetadata(epochId: string): Promise<EpochMetadata> {
    let metadata: EpochMetadata | undefined;
    try {
      metadata = this.#parseMetadata(JSON.parse(await readFile(this.#metadataPathFor(epochId), 'utf8')));
    } catch {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Epoch metadata cannot be parsed as JSON.');
    }
    if (metadata === undefined || metadata.epoch.id !== epochId) {
      throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Epoch metadata does not match its persisted epoch id.');
    }
    return metadata;
  }

  async #readAllEpochMetadata(): Promise<readonly EpochMetadata[]> {
    let entries;
    try {
      entries = await readdir(this.#epochMetadataPath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return Object.freeze([]);
      throw error;
    }
    return Object.freeze(await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const epochId = entry.name.slice(0, -'.json'.length);
        if (!isSafePathSegment(epochId)) {
          throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Epoch metadata file name is not path-safe.');
        }
        return this.#readEpochMetadata(epochId);
      })));
  }

}
