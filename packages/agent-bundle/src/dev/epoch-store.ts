import { Cause, Effect, Exit, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { isInside } from '../core/paths.ts';
import { hasExactOwnKeys, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { runPromise, runSync } from '../effect/boundary.ts';
import { liftPromise, liftTry } from '../effect/lift.ts';
import { freezeArtifactEpoch, type ArtifactEpoch } from './types.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface EpochStoreOptions {
  /** @internal Deterministic cleanup-failure seam. */
  readonly cleanupRemove?: typeof rm;
  /** @internal Deterministic publication-race seam. */
  readonly move?: typeof rename;
  /** @internal Deterministic durability-failure seam. */
  readonly durabilityStorage?: EpochDurabilityStorage;
  readonly projectRoot: string;
}

export interface EpochDurabilityStorage {
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
    this.failures = deepFreeze(failures.map((failure) => ({ ...failure })));
    Object.freeze(this);
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

export class EpochPostCommitDurabilityError extends Error {
  readonly committedEpoch: ArtifactEpoch;

  constructor(committedEpoch: ArtifactEpoch, durabilityError: unknown) {
    super('Epoch publication changed the active epoch, but active metadata durability could not be confirmed.', {
      cause: durabilityError,
    });
    this.name = 'EpochPostCommitDurabilityError';
    this.committedEpoch = freezeArtifactEpoch(committedEpoch);
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
}

interface StagingRecord {
  readonly epoch: ArtifactEpoch;
  readonly markerContents: string;
  readonly root: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly targets: readonly string[];
}

interface AtomicWriteProgress {
  renamed: boolean;
}

const activeEpochFileName = 'active-epoch.json';
const metadataDirectoryName = '.metadata';
const nativePlaygroundCatalogDirectoryName = 'native-playground';
const stagingMarkerFileName = '.agent-bundle-epoch-stage.json';
const stagingPrefix = '.stage-';
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
const artifactEpochOptionalKeys = ['packageName', 'packageVersion'] as const;
const epochDiagnosticsKeys = ['errors', 'infos', 'warnings'] as const;
const epochReferenceCounts = new Map<string, number>();
/**
 * Process-wide lease mutexes, one `Semaphore(1)` per resolved `.agent-bundle`
 * path. Cross-instance sharing is intentional: every EpochStore over the same
 * project serializes lease transitions through one permit and observes one
 * set of reference counts, so leases survive across store instances.
 */
const epochLeaseMutexes = new Map<string, Semaphore.Semaphore>();

/** Every required key present, every present key either required or optional. */
const hasRequiredOwnKeys = (
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean => {
  const allowed = new Set<string>([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
};

const leaseMutexFor = (agentBundlePath: string): Semaphore.Semaphore => {
  const existing = epochLeaseMutexes.get(agentBundlePath);
  if (existing !== undefined) return existing;
  const created = runSync(Semaphore.make(1));
  epochLeaseMutexes.set(agentBundlePath, created);
  return created;
};

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
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !hasRequiredOwnKeys(value, artifactEpochKeys, artifactEpochOptionalKeys)
  ) return undefined;
  const epoch = value as Partial<ArtifactEpoch>;
  const diagnostics = epoch.diagnostics;
  const targetDigests = epoch.targetDigests;
  if (
    typeof epoch.configDigest !== 'string' ||
    typeof epoch.createdAt !== 'string' ||
    typeof epoch.id !== 'string' ||
    typeof epoch.manifestPath !== 'string' ||
    typeof epoch.modelDigest !== 'string' ||
    (epoch.packageName !== undefined && typeof epoch.packageName !== 'string') ||
    (epoch.packageVersion !== undefined && typeof epoch.packageVersion !== 'string') ||
    typeof epoch.projectRevision !== 'string' ||
    typeof diagnostics !== 'object' ||
    diagnostics === null ||
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
    ...(epoch.packageName === undefined ? {} : { packageName: epoch.packageName }),
    ...(epoch.packageVersion === undefined ? {} : { packageVersion: epoch.packageVersion }),
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
  readonly #durabilityStorage: EpochDurabilityStorage;
  readonly #epochMetadataPath: string;
  readonly #epochsPath: string;
  readonly #move: typeof rename;
  /** The process-wide lease mutex shared by every store over this project. */
  readonly #leaseTransitions: Semaphore.Semaphore;
  readonly #staging = new Map<symbol, StagingRecord>();
  /** Serializes this store's state transitions. */
  readonly #transitions: Semaphore.Semaphore = runSync(Semaphore.make(1));

  constructor(options: EpochStoreOptions) {
    const agentBundlePath = join(resolve(options.projectRoot), '.agent-bundle');
    this.#activeEpochPath = join(agentBundlePath, activeEpochFileName);
    this.#cleanupRemove = options.cleanupRemove ?? rm;
    this.#durabilityStorage = options.durabilityStorage ?? Object.freeze({ open, remove: rm });
    this.#epochsPath = join(agentBundlePath, 'epochs');
    this.#epochMetadataPath = join(this.#epochsPath, metadataDirectoryName);
    this.#move = options.move ?? rename;
    this.#leaseTransitions = leaseMutexFor(agentBundlePath);
  }

  async createStagingEpoch(options: CreateStagingEpochOptions): Promise<EpochStaging> {
    return runPromise(this.#transitions.withPermit(
      Effect.gen({ self: this }, function* (this: EpochStore) {
        const epoch = yield* liftTry(() => {
          assertSafeEpochId(options.epoch.id);
          return assertEpoch(options.epoch);
        });
        const targets = yield* liftTry(() => this.#assertTargetSet(epoch, options.targets));
        yield* liftTry(() => this.#manifestRelativePath(epoch));
        yield* liftPromise(() => mkdir(this.#epochsPath, { recursive: true }));
        const root = yield* liftPromise(() => mkdtemp(join(this.#epochsPath, stagingPrefix)));
        const metadata = yield* liftPromise(() => lstat(root));
        const markerContents = `${stableJson({ token: randomUUID() })}\n`;
        yield* liftPromise(() => writeFile(join(root, stagingMarkerFileName), markerContents, 'utf8'));
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
      }),
    ));
  }

  async acquireEpochReference(epochId: string): Promise<EpochReference> {
    return runPromise(this.#transitions.withPermit(this.#leaseTransitions.withPermit(
      Effect.gen({ self: this }, function* (this: EpochStore) {
        yield* liftTry(() => assertSafeEpochId(epochId));
        yield* liftPromise(() => this.#assertEpochDirectory(epochId));
        const metadata = yield* liftPromise(() => this.#readEpochMetadata(epochId));
        return yield* liftPromise(() => this.#acquireEpochReference(metadata.epoch));
      }),
    )));
  }

  /** Resolves and leases the current epoch without allowing a publish between those operations. */
  async acquireActiveEpochReference(): Promise<EpochReference> {
    return runPromise(this.#transitions.withPermit(this.#leaseTransitions.withPermit(
      Effect.gen({ self: this }, function* (this: EpochStore) {
        const epoch = yield* liftPromise(() => this.#readActiveEpoch());
        if (epoch === undefined) {
          return yield* Effect.fail(new EpochStoreError('EPOCH_NOT_FOUND', 'No active artifact epoch is available.'));
        }
        return yield* liftPromise(() => this.#acquireEpochReference(epoch));
      }),
    )));
  }

  /** Returns detached safe epoch identities, ordered newest first. */
  async listEpochs(): Promise<readonly ArtifactEpoch[]> {
    return runPromise(this.#transitions.withPermit(
      liftPromise(async () => Object.freeze((await this.#readAllEpochMetadata())
        .map((metadata) => freezeArtifactEpoch(metadata.epoch))
        .sort(compareNewestFirst))),
    ));
  }

  /**
   * Releases one lease. The final release for an epoch runs the retention
   * pass while still holding both mutexes, so a concurrent acquire cannot
   * observe the epoch mid-deletion.
   */
  async releaseEpochReference(epochId: string): Promise<void> {
    await runPromise(this.#transitions.withPermit(this.#leaseTransitions.withPermit(
      Effect.suspend(() => {
        const referenceKey = join(this.#epochsPath, epochId);
        const count = epochReferenceCounts.get(referenceKey) ?? 0;
        if (count === 1) {
          epochReferenceCounts.delete(referenceKey);
          return this.#cleanupUnderLease();
        }
        if (count > 1) epochReferenceCounts.set(referenceKey, count - 1);
        return Effect.void;
      }),
    )));
  }

  async readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
    return runPromise(this.#transitions.withPermit(liftPromise(() => this.#readActiveEpoch())));
  }

  async cleanup(): Promise<void> {
    await runPromise(this.#transitions.withPermit(
      this.#leaseTransitions.withPermit(this.#cleanupUnderLease()),
    ));
  }

  /** Removes leftover staging directories from crashed or interrupted publishes. */
  async recoverStaging(): Promise<void> {
    await runPromise(this.#transitions.withPermit(liftPromise(async () => {
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
    })));
  }

  async #readActiveEpoch(): Promise<ArtifactEpoch | undefined> {
    let value: unknown;
    try {
      value = parseJsonWithoutDuplicateKeys(await readFile(this.#activeEpochPath, 'utf8'));
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
    epochReferenceCounts.set(epochPath, (epochReferenceCounts.get(epochPath) ?? 0) + 1);
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

  /**
   * The retention pass, always run while holding the process-wide lease
   * mutex. Eligible deletions run concurrently; every failure is collected
   * with its resource label, sorted, and reported as one `EpochCleanupError`.
   */
  #cleanupUnderLease(): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* (this: EpochStore) {
      const active = yield* liftPromise(() => this.#readActiveEpoch());
      const metadata = yield* liftPromise(() => this.#readAllEpochMetadata());
      const protectedIds = new Set<string>(active === undefined ? [] : [active.id]);
      for (const entry of metadata) {
        if ((epochReferenceCounts.get(join(this.#epochsPath, entry.epoch.id)) ?? 0) > 0) {
          protectedIds.add(entry.epoch.id);
        }
      }

      const retainedUnreferenced = metadata
        .filter((entry) => !protectedIds.has(entry.epoch.id))
        .sort((left, right) => compareNewestFirst(left.epoch, right.epoch))
        .slice(0, 5)
        .map((entry) => entry.epoch.id);
      for (const epochId of retainedUnreferenced) protectedIds.add(epochId);

      const attempts = yield* Effect.forEach(
        metadata.filter((entry) => !protectedIds.has(entry.epoch.id)),
        (entry) => Effect.exit(liftPromise(async () => {
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
        })),
        { concurrency: 'unbounded' },
      );
      const failures = attempts
        .flatMap((attempt): EpochCleanupFailure[] =>
          Exit.isFailure(attempt) ? [Cause.squash(attempt.cause) as EpochCleanupFailure] : [])
        .sort((left, right) =>
          left.epochId.localeCompare(right.epochId) || left.resource.localeCompare(right.resource));
      if (failures.length > 0) {
        return yield* Effect.fail(new EpochCleanupError(failures));
      }
    });
  }

  async #closeStaging(token: symbol): Promise<void> {
    await runPromise(this.#transitions.withPermit(Effect.suspend(() => {
      const record = this.#staging.get(token);
      if (record === undefined) return Effect.void;
      this.#staging.delete(token);
      return liftPromise(() => rm(record.root, { force: true, recursive: true })).pipe(Effect.asVoid);
    })));
  }

  async #publishStaging(
    token: symbol,
    validate: StagingValidator,
    beforeActivate: EpochPreActivation | undefined,
  ): Promise<ArtifactEpoch> {
    return runPromise(this.#transitions.withPermit(Effect.suspend(() => {
      const record = this.#staging.get(token);
      if (record === undefined) {
        return Effect.fail(new EpochStoreError('EPOCH_STAGING_CLOSED', 'Epoch staging is already closed.'));
      }
      this.#staging.delete(token);
      const attempt = Effect.gen({ self: this }, function* (this: EpochStore) {
        yield* liftPromise(() => validate(record.root));
        yield* liftPromise(() => this.#verifyStaging(record));
        return yield* this.#publishVerifiedStaging(record, beforeActivate);
      });
      // The staging root is removed whether the publish committed or failed;
      // a removal failure replaces the outcome, so it is deliberately not a
      // scope finalizer (which would have to swallow it).
      return Effect.gen({ self: this }, function* (this: EpochStore) {
        const outcome = yield* Effect.exit(attempt);
        yield* liftPromise(() => rm(record.root, { force: true, recursive: true }));
        return yield* outcome;
      });
    })));
  }

  /**
   * The publication saga under the process-wide lease mutex: sync the staged
   * tree, take the epoch directory, run the publisher's pre-activation, then
   * commit metadata. Compensations mirror progress — after the active-epoch
   * rename the publish is committed and later failures are post-commit by
   * contract; before it, the moved paths and the publisher-owned
   * receipt roll back concurrently, and rollback failures aggregate with the
   * original error.
   */
  #publishVerifiedStaging(
    record: StagingRecord,
    beforeActivate: EpochPreActivation | undefined,
  ): Effect.Effect<ArtifactEpoch, unknown> {
    const epochRoot = join(this.#epochsPath, record.epoch.id);
    return this.#leaseTransitions.withPermit(Effect.suspend(() => {
      const activeMetadata: AtomicWriteProgress = { renamed: false };
      let publication: EpochPublicationReceipt | undefined;
      let moved = false;
      const attempt = Effect.gen({ self: this }, function* (this: EpochStore) {
        if (yield* liftPromise(() => pathExists(epochRoot))) {
          return yield* Effect.fail(
            new EpochStoreError('EPOCH_ALREADY_EXISTS', `Epoch ${JSON.stringify(record.epoch.id)} already exists.`),
          );
        }
        yield* liftPromise(() => this.#syncTree(record.root));
        yield* liftPromise(() => this.#removeStagingMarker(record));
        yield* liftPromise(() => this.#move(record.root, epochRoot));
        moved = true;
        yield* liftPromise(() => this.#syncPath(this.#epochsPath, true));
        if (beforeActivate !== undefined) {
          publication = (yield* liftPromise(() => beforeActivate(record.epoch))) ?? undefined;
        }
        yield* liftPromise(() => this.#writeEpochMetadata(record.epoch));
        yield* liftPromise(() => this.#writeActiveMetadata(record.epoch, activeMetadata));
      });
      const rollback = (error: unknown): Effect.Effect<never, unknown> => Effect.suspend(() => {
        if (activeMetadata.renamed) {
          return Effect.fail(new EpochPostCommitDurabilityError(record.epoch, error));
        }
        const receipt = publication;
        const compensations: readonly (() => Promise<void>)[] = [
          ...(moved ? [
            () => this.#removePublicationPath(epochRoot, this.#epochsPath, true),
            () => this.#removePublicationPath(this.#metadataPathFor(record.epoch.id), this.#epochMetadataPath),
          ] : []),
          ...(receipt === undefined ? [] : [() => receipt.rollback()]),
        ];
        return Effect.forEach(
          compensations,
          (compensate) => Effect.exit(liftPromise(compensate)),
          { concurrency: 'unbounded' },
        ).pipe(Effect.flatMap((results) => {
          const cleanupFailures = results.flatMap((result) =>
            Exit.isFailure(result) ? [Cause.squash(result.cause)] : []);
          return cleanupFailures.length > 0
            ? Effect.fail(new AggregateError(
              [error, ...cleanupFailures],
              'Epoch publication and rollback both failed.',
              { cause: error },
            ))
            : Effect.fail(error);
        }));
      });
      return Effect.gen({ self: this }, function* (this: EpochStore) {
        yield* attempt.pipe(Effect.catch(rollback));
        yield* this.#cleanupUnderLease().pipe(
          Effect.catch((error) => Effect.fail(new EpochPostCommitCleanupError(record.epoch, error))),
        );
        return record.epoch;
      });
    }));
  }

  async #removeStagingMarker(record: StagingRecord): Promise<void> {
    const markerPath = join(record.root, stagingMarkerFileName);
    await this.#syncPath(markerPath);
    await this.#durabilityStorage.remove(markerPath);
    await this.#syncPath(record.root, true);
  }

  async #removePublicationPath(path: string, parent: string, recursive = false): Promise<void> {
    await rm(path, recursive ? { force: true, recursive: true } : { force: true });
    try {
      await this.#syncPath(parent, true);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async #syncPath(path: string, directory = false): Promise<void> {
    const handle = await this.#durabilityStorage.open(path, 'r');
    try {
      await handle.sync();
    } catch (error) {
      if (directory && process.platform === 'win32' && (isErrno(error, 'EACCES') || isErrno(error, 'EINVAL'))) return;
      throw error;
    }
    finally { await handle.close(); }
  }

  async #syncTree(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new EpochStoreError('EPOCH_STAGING_INVALID', 'Staged epoch contents must not contain symbolic links.');
    }
    if (metadata.isFile()) {
      await this.#syncPath(path);
      return;
    }
    if (!metadata.isDirectory()) {
      throw new EpochStoreError('EPOCH_STAGING_INVALID', 'Staged epoch contents must be regular files or directories.');
    }
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await this.#syncTree(join(path, entry.name));
    }
    await this.#syncPath(path, true);
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
    await this.#writeJsonAtomically(this.#metadataPathFor(epoch.id), { epoch });
  }

  async #writeActiveMetadata(epoch: ArtifactEpoch, progress?: AtomicWriteProgress): Promise<void> {
    await this.#writeJsonAtomically(this.#activeEpochPath, { epoch }, progress);
  }

  async #writeJsonAtomically(path: string, value: EpochMetadata, progress?: AtomicWriteProgress): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    await this.#syncPath(dirname(directory), true);
    const temporaryPath = join(
      directory,
      `.${basename(path)}.stage-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await writeFile(temporaryPath, `${stableJson(value)}\n`, 'utf8');
      await this.#syncPath(temporaryPath);
      await rename(temporaryPath, path);
      if (progress !== undefined) progress.renamed = true;
      await this.#syncPath(directory, true);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  #parseMetadata(value: unknown): EpochMetadata | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    if (!hasExactOwnKeys(value, ['epoch'])) return undefined;
    const metadata = value as Partial<EpochMetadata>;
    const epoch = normalizeEpoch(metadata.epoch);
    return epoch === undefined ? undefined : Object.freeze({ epoch });
  }

  async #readEpochMetadata(epochId: string): Promise<EpochMetadata> {
    let metadata: EpochMetadata | undefined;
    try {
      metadata = this.#parseMetadata(
        parseJsonWithoutDuplicateKeys(await readFile(this.#metadataPathFor(epochId), 'utf8')),
      );
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
