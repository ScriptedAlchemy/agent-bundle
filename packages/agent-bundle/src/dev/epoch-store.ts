import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { serialQueue } from '../core/async.ts';
import { stableJson } from '../core/digest.ts';
import { writeJsonFileAtomically } from '../core/durable-fs.ts';
import { isErrno } from '../core/errors.ts';
import { isInside, isSafePathSegment } from '../core/paths.ts';
import { hasExactOwnKeys, isRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { sharedEpochLeaseRegistry } from './epoch-lease-registry.ts';
import {
  createStagingMarker,
  EpochStagingHandle,
  EpochStoreError,
  publishVerifiedStaging,
  removeStagingRemnants,
  stagingPrefix,
  syncDurablePath,
  verifyStaging,
  type EpochDurabilityStorage,
  type EpochPreActivation,
  type EpochStaging,
  type EpochStagingContext,
  type StagingRecord,
  type StagingValidator,
} from './epoch-staging.ts';
import { freezeArtifactEpoch, type ArtifactEpoch } from './types.ts';

export {
  EpochPostCommitCleanupError,
  EpochStoreError,
  type EpochDurabilityStorage,
  type EpochPreActivation,
  type EpochPublicationReceipt,
  type EpochStaging,
  type EpochStoreErrorCode,
  type StagingValidator,
} from './epoch-staging.ts';

export interface EpochStoreOptions {
  /** @internal Deterministic cleanup-failure seam. */
  readonly cleanupRemove?: typeof rm;
  /** @internal Deterministic durability-failure seam. */
  readonly durabilityStorage?: EpochDurabilityStorage;
  readonly projectRoot: string;
}

export interface CreateStagingEpochOptions {
  readonly epoch: ArtifactEpoch;
  readonly targets: readonly string[];
}

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

interface ActiveEpochPointerStat {
  readonly ctimeMs: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

type ActiveEpochCache =
  | Readonly<{ readonly epoch: ArtifactEpoch; readonly pointer: ActiveEpochPointerStat; readonly present: true }>
  | Readonly<{ readonly present: false }>;

interface EpochMetadata {
  readonly epoch: ArtifactEpoch;
}

const activeEpochFileName = 'active-epoch.json';
const metadataDirectoryName = '.metadata';
const nativePlaygroundCatalogDirectoryName = 'native-playground';
const artifactEpochKeys = [
  'configDigest',
  'createdAt',
  'diagnostics',
  'id',
  'manifestPath',
  'modelDigest',
  'projectRevision',
  'targetDigests',
] as const;
const epochDiagnosticsKeys = ['errors', 'infos', 'warnings'] as const;

const sameActiveEpochPointer = (left: ActiveEpochPointerStat, right: ActiveEpochPointerStat): boolean =>
  left.ctimeMs === right.ctimeMs && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size;

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
  if (!isRecord(value) || !hasExactOwnKeys(value, artifactEpochKeys)) return undefined;
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
    !isRecord(diagnostics) ||
    !hasExactOwnKeys(diagnostics, epochDiagnosticsKeys) ||
    typeof diagnostics.errors !== 'number' ||
    typeof diagnostics.infos !== 'number' ||
    typeof diagnostics.warnings !== 'number' ||
    !Number.isSafeInteger(diagnostics.errors) ||
    !Number.isSafeInteger(diagnostics.infos) ||
    !Number.isSafeInteger(diagnostics.warnings) ||
    diagnostics.errors < 0 ||
    diagnostics.infos < 0 ||
    diagnostics.warnings < 0 ||
    !isRecord(targetDigests)
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
  #activeEpochCache: ActiveEpochCache | undefined;
  readonly #agentBundlePath: string;
  #cleanupDirty = false;
  readonly #cleanupRemove: typeof rm;
  readonly #durabilityStorage: EpochDurabilityStorage;
  readonly #epochMetadataPath: string;
  readonly #epochsPath: string;
  readonly #staging = new Map<symbol, StagingRecord>();
  readonly #stagingContext: EpochStagingContext;
  readonly #transitions = serialQueue();

  constructor(options: EpochStoreOptions) {
    const agentBundlePath = join(resolve(options.projectRoot), '.agent-bundle');
    this.#activeEpochPath = join(agentBundlePath, activeEpochFileName);
    this.#agentBundlePath = agentBundlePath;
    this.#cleanupRemove = options.cleanupRemove ?? rm;
    this.#durabilityStorage = options.durabilityStorage ?? Object.freeze({ open, remove: rm });
    this.#epochsPath = join(agentBundlePath, 'epochs');
    this.#epochMetadataPath = join(this.#epochsPath, metadataDirectoryName);
    this.#stagingContext = {
      cleanupUnderLease: async () => this.#cleanupUnderLease(),
      durabilityStorage: this.#durabilityStorage,
      epochsPath: this.#epochsPath,
      manifestRelativePath: (epoch) => this.#manifestRelativePath(epoch),
      metadataPathFor: (epochId) => this.#metadataPathFor(epochId),
      onCommitted: () => {
        this.#activeEpochCache = undefined;
        this.#cleanupDirty = true;
      },
      runLeaseTransition: async (operation) => this.#runLeaseTransition(operation),
      writeActiveMetadata: async (epoch) => this.#writeActiveMetadata(epoch),
      writeEpochMetadata: async (epoch) => this.#writeEpochMetadata(epoch),
    };
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
      const markerContents = await createStagingMarker(root);
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
    return this.#transitions.run(async () => this.#runLeaseTransition(async () => {
      assertSafeEpochId(epochId);
      await this.#assertEpochDirectory(epochId);
      return this.#acquireEpochReference(await this.#readEpochMetadata(epochId).then((metadata) => metadata.epoch));
    }));
  }

  /** Resolves and leases the current epoch without allowing a publish between those operations. */
  async acquireActiveEpochReference(): Promise<EpochReference> {
    return this.#transitions.run(async () => this.#runLeaseTransition(async () => {
      const epoch = await this.#readActiveEpoch();
      if (epoch === undefined) {
        throw new EpochStoreError('EPOCH_NOT_FOUND', 'No active artifact epoch is available.');
      }
      return this.#acquireEpochReference(epoch);
    }));
  }

  /** Returns detached safe epoch identities, ordered newest first. */
  async listEpochs(): Promise<readonly ArtifactEpoch[]> {
    return this.#transitions.run(async () => Object.freeze((await this.#readAllEpochMetadata())
      .map((metadata) => freezeArtifactEpoch(metadata.epoch))
      .sort(compareNewestFirst)));
  }

  async releaseEpochReference(epochId: string): Promise<void> {
    await this.#transitions.run(async () => this.#runLeaseTransition(async () => {
      const referenceKey = join(this.#epochsPath, epochId);
      const count = sharedEpochLeaseRegistry.referenceCount(referenceKey);
      if (count === 1) {
        sharedEpochLeaseRegistry.release(referenceKey);
        if (!await this.#isCachedActiveEpoch(epochId)) this.#cleanupDirty = true;
        await this.#cleanupUnderLease();
        return;
      }
      if (count > 1) sharedEpochLeaseRegistry.release(referenceKey);
    }));
  }

  async readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
    return this.#transitions.run(async () => this.#readActiveEpoch());
  }

  async cleanup(): Promise<void> {
    await this.#transitions.run(async () => this.#cleanup());
  }

  async recoverStaging(): Promise<void> {
    await this.#transitions.run(async () => removeStagingRemnants(this.#epochsPath));
  }

  async #readActiveEpoch(options: { refresh?: boolean } = {}): Promise<ArtifactEpoch | undefined> {
    if (options.refresh !== true) {
      const cached = await this.#readActiveEpochFromCache();
      if (cached !== 'miss') return cached;
    }

    let value: unknown;
    try {
      value = parseJsonWithoutDuplicateKeys(await readFile(this.#activeEpochPath, 'utf8'));
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        this.#activeEpochCache = { present: false };
        return undefined;
      }
      this.#activeEpochCache = undefined;
      throw new EpochStoreError(
        'EPOCH_METADATA_INVALID',
        'Active epoch metadata cannot be parsed as JSON.',
      );
    }
    const metadata = this.#parseMetadata(value);
    if (metadata === undefined) {
      this.#activeEpochCache = undefined;
      throw new EpochStoreError(
        'EPOCH_METADATA_INVALID',
        'Active epoch metadata does not match the ArtifactEpoch contract.',
      );
    }
    try {
      await this.#validateActiveEpoch(metadata.epoch);
    } catch (error) {
      this.#activeEpochCache = undefined;
      throw error;
    }
    const pointer = await this.#statActiveEpochPointer();
    this.#activeEpochCache = pointer === undefined
      ? { present: false }
      : { epoch: metadata.epoch, pointer, present: true };
    return metadata.epoch;
  }

  async #readActiveEpochFromCache(): Promise<ArtifactEpoch | undefined | 'miss'> {
    const probe = await this.#statActiveEpochPointer();
    const cache = this.#activeEpochCache;
    if (probe === undefined) {
      this.#activeEpochCache = { present: false };
      return undefined;
    }
    if (cache?.present === true && sameActiveEpochPointer(cache.pointer, probe)) return cache.epoch;
    return 'miss';
  }

  async #statActiveEpochPointer(): Promise<ActiveEpochPointerStat | undefined> {
    try {
      const metadata = await lstat(this.#activeEpochPath);
      return {
        ctimeMs: metadata.ctimeMs,
        ino: metadata.ino,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
      };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async #isCachedActiveEpoch(epochId: string): Promise<boolean> {
    const cache = this.#activeEpochCache;
    if (cache?.present !== true) return false;
    const probe = await this.#statActiveEpochPointer();
    return probe !== undefined && sameActiveEpochPointer(cache.pointer, probe) && cache.epoch.id === epochId;
  }

  async #acquireEpochReference(epoch: ArtifactEpoch): Promise<EpochReference> {
    const epochPath = await this.#assertEpochDirectory(epoch.id);
    sharedEpochLeaseRegistry.retain(epochPath);
    return new EpochReference(this, freezeArtifactEpoch(epoch), epochPath);
  }

  async #runLeaseTransition<T>(operation: () => Promise<T>): Promise<T> {
    return sharedEpochLeaseRegistry.runLeaseTransition(this.#agentBundlePath, operation);
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
    this.#cleanupDirty = true;
    await this.#runLeaseTransition(async () => this.#cleanupUnderLease());
  }

  async #cleanupUnderLease(): Promise<void> {
    if (!this.#cleanupDirty) return;
    const active = await this.#readActiveEpoch({ refresh: true });
    const metadata = await this.#readAllEpochMetadata();
    const protectedIds = new Set<string>(active === undefined ? [] : [active.id]);
    for (const entry of metadata) {
      if (sharedEpochLeaseRegistry.referenceCount(join(this.#epochsPath, entry.epoch.id)) > 0) {
        protectedIds.add(entry.epoch.id);
      }
    }

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
    this.#cleanupDirty = false;
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
        await verifyStaging(this.#stagingContext, record);
        return await publishVerifiedStaging(this.#stagingContext, record, beforeActivate);
      } finally {
        await rm(record.root, { force: true, recursive: true });
      }
    });
  }

  async #validateActiveEpoch(epoch: ArtifactEpoch): Promise<void> {
    let activeMetadata: EpochMetadata;
    try {
      activeMetadata = await this.#readEpochMetadata(epoch.id);
    } catch (error) {
      if (error instanceof EpochStoreError && error.code === 'EPOCH_NOT_FOUND') {
        // An active pointer at an epoch without persisted metadata is corrupt active metadata.
        throw new EpochStoreError('EPOCH_METADATA_INVALID', 'Active epoch metadata references an epoch without persisted metadata.');
      }
      throw error;
    }
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
    await this.#writeJsonAtomically(this.#metadataPathFor(epoch.id), { epoch });
  }

  async #writeActiveMetadata(epoch: ArtifactEpoch): Promise<void> {
    await this.#writeJsonAtomically(this.#activeEpochPath, { epoch });
  }

  async #writeJsonAtomically(path: string, value: EpochMetadata): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    await syncDurablePath(this.#durabilityStorage, dirname(directory), true);
    await writeJsonFileAtomically(path, `${stableJson(value)}\n`, {
      open: this.#durabilityStorage.open,
      temporaryPath: join(directory, `.${basename(path)}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`),
    });
  }

  #parseMetadata(value: unknown): EpochMetadata | undefined {
    if (!isRecord(value)) return undefined;
    if (!hasExactOwnKeys(value, ['epoch'])) return undefined;
    const metadata = value as Partial<EpochMetadata>;
    const epoch = normalizeEpoch(metadata.epoch);
    return epoch === undefined ? undefined : Object.freeze({ epoch });
  }

  async #readEpochMetadata(epochId: string): Promise<EpochMetadata> {
    let bytes: string;
    try {
      bytes = await readFile(this.#metadataPathFor(epochId), 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new EpochStoreError('EPOCH_NOT_FOUND', `Epoch ${JSON.stringify(epochId)} metadata does not exist.`);
      }
      throw error;
    }
    let metadata: EpochMetadata | undefined;
    try {
      metadata = this.#parseMetadata(parseJsonWithoutDuplicateKeys(bytes));
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
