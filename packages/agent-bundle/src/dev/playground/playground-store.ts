import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { serialQueue, type SerialQueue } from '../../core/async.ts';
import { openPinnedContainedFile, syncDirectorySync, writeNewPinnedFile } from '../../core/durable-fs.ts';
import { isErrno } from '../../core/errors.ts';
import { acquireOwnerLockFile, isProcessAlive, sharedOwnerMutationSerializer } from '../../core/owner-lock.ts';
import { isInsideOrEqual } from '../../core/paths.ts';
import type { DevLogSink } from '../logs/dev-log-service.ts';
import {
  PlaygroundServiceError,
  playgroundServiceError as serviceError,
  type DraftEvalCase,
  type PlaygroundCleanupFailure,
  type PlaygroundDurableOutcome,
  type PlaygroundEpochIdentity,
  type PlaygroundEventInput,
  type PlaygroundExport,
  type PlaygroundFixtureIdentity,
  type PlaygroundInvocation,
  type PlaygroundJsonValue,
  type PlaygroundReplay,
  type PlaygroundReplayCursor,
  type PlaygroundSelectedAssertion,
  type PlaygroundServiceOptions,
  type PlaygroundSession,
  type PlaygroundSessionIdentity,
  type PlaygroundSessionInput,
  type PlaygroundSubscribeOptions,
  type PlaygroundSubscription,
  type PlaygroundTarget,
  type PlaygroundTask,
  type PlaygroundTraceEvent,
} from './playground-protocol.ts';
import { PlaygroundServiceCloseError, PlaygroundSessionCloseError, type PlaygroundServiceCloseFailure } from './playground-close-errors.ts';
import {
  durabilityPlatform,
  runAsyncDurabilityTestHook,
  runDurabilityTestHook,
  type DirectorySyncReason,
  type DurableFilePhase,
  type OwnerMutationReason,
} from './playground-durability.ts';
import {
  decodeEventLog,
  decodePersistedSession,
  decodeSessionIndexDocument,
  eventDocumentName,
  ownerLockName,
  parseOwnerLockDocument,
  sameOwner,
  sessionDocumentName,
  type OwnerLock,
  type PersistedSession,
  type PersistedSessionIndex,
} from './playground-store-codec.ts';
import { initializePlaygroundStorageLayout } from './playground-store-layout.ts';
import {
  assertNoProviderCredentials,
  clone,
  nonempty,
  normalizeAssertion,
  normalizeCursor,
  normalizeEventInput,
  normalizeIdentity,
  normalizeOutcome,
  safeSessionId,
  sameOutcome,
  snapshotEvent,
} from './playground-values.ts';
import {
  PlaygroundSubscriptionSet,
} from './playground-subscriptions.ts';

export * from './playground-protocol.ts';
export * from './playground-close-errors.ts';

interface SessionRecord {
  admissionFailed: boolean;
  readonly cleanupFailures: PlaygroundCleanupFailure[];
  readonly createdAt: string;
  durability: 'terminal-uncertain' | undefined;
  readonly events: PlaygroundTraceEvent[];
  readonly id: string;
  readonly identity: PlaygroundSessionIdentity;
  nextSequence: number;
  outcome: PlaygroundDurableOutcome | undefined;
  readonly root: string;
  readonly storageObjectId: string;
  state: PlaygroundSession['state'];
  readonly subscribers: PlaygroundSubscriptionSet;
  readonly queue: SerialQueue;
  ownerToken: string | undefined;
}

interface SessionPersistenceProgress {
  metadataRenamed: boolean;
}

const snapshotCleanupFailures = (value: readonly PlaygroundCleanupFailure[]): readonly PlaygroundCleanupFailure[] =>
  Object.freeze(value.map((failure) => Object.freeze({ message: failure.message, operation: failure.operation })));

const snapshotSession = (record: SessionRecord): PlaygroundSession => Object.freeze({
  cleanupFailures: snapshotCleanupFailures(record.cleanupFailures),
  createdAt: record.createdAt,
  id: record.id,
  identity: clone(record.identity, 'Playground identity') as PlaygroundSessionIdentity,
  ...(record.outcome === undefined ? {} : { outcome: clone(record.outcome, 'Playground durable outcome') as PlaygroundDurableOutcome }),
  state: record.state,
});

export class PlaygroundStore {
  readonly #admissions = new Set<Promise<void>>();
  readonly #maxSubscriberQueue: number;
  readonly #logger: DevLogSink | undefined;
  readonly #now: () => Date;
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #storageRoot: string;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #ready: Promise<void> | undefined;
  #resolvedIndexRoot: string | undefined;
  #resolvedObjectRoot: string | undefined;
  #resolvedPendingIndexRoot: string | undefined;

  constructor(options: PlaygroundServiceOptions) {
    const projectId = nonempty(options.projectId, 'Playground project id');
    assertNoProviderCredentials(projectId);
    this.#projectId = projectId;
    this.#projectRoot = options.projectRoot;
    this.#storageRoot = options.storageRoot;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
    const queue = options.maxSubscriberQueue ?? 64;
    if (!Number.isSafeInteger(queue) || queue < 1) {
      throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground subscriber queue limit must be a positive safe integer.');
    }
    this.#maxSubscriberQueue = queue;
  }

  async openSession(input: PlaygroundSessionInput): Promise<PlaygroundSession> {
    return this.#admit(async () => {
      await this.#ensureStore();
      this.#assertAvailable();
      const identity = normalizeIdentity(input);
      const id = safeSessionId(input.sessionId ?? randomUUID());
      assertNoProviderCredentials(id);
      if (this.#sessions.has(id)) {
        throw serviceError('PLAYGROUND_SESSION_CONFLICT', `Playground session ${JSON.stringify(id)} already exists.`);
      }
      const storageObjectId = safeSessionId(randomUUID());
      const root = this.#objectRoot(storageObjectId);
      mkdirSync(root);
      this.#syncDirectory(this.#requireObjectRoot(), 'object-created');
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object must be a real contained directory.');
      }
      await this.#assertObjectDirectory(root, storageObjectId);
      this.#assertAvailable();
      const ownerToken = await this.#acquireOwner(root, id);
      const cleanupFailures: PlaygroundCleanupFailure[] = [];
      const record: SessionRecord = {
        admissionFailed: false,
        cleanupFailures,
        createdAt: this.#timestamp(),
        durability: undefined,
        events: [],
        id,
        identity,
        nextSequence: 1,
        outcome: undefined,
        root,
        state: 'open',
        storageObjectId,
        subscribers: new PlaygroundSubscriptionSet(this.#maxSubscriberQueue, cleanupFailures),
        queue: serialQueue(),
        ownerToken,
      };
      await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
      await this.#writeNewFile(join(root, eventDocumentName), '', 'event');
      await this.#persistSession(record);
      await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
      await this.#readPersistedSession(root, id, storageObjectId);
      await this.#readEvents(root);
      await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
      this.#assertAvailable();
      try {
        this.#publishSession(record);
      } catch (error) {
        if (this.#sessions.get(id) === record) record.admissionFailed = true;
        throw error;
      }
      return snapshotSession(record);
    });
  }

  async reopen(sessionId: string): Promise<PlaygroundSession> {
    return this.#admit(async () => {
      await this.#ensureStore();
      this.#assertAvailable();
      const id = safeSessionId(sessionId);
      assertNoProviderCredentials(id);
      const existing = this.#sessions.get(id);
      if (existing !== undefined) {
        this.#assertRecordUsable(existing);
        return snapshotSession(existing);
      }
      const index = await this.#readIndex(id);
      if (index === undefined) {
        throw serviceError('PLAYGROUND_SESSION_NOT_FOUND', `Playground session ${JSON.stringify(id)} was not found.`);
      }
      const storageObjectId = index.objectId;
      const root = this.#objectRoot(storageObjectId);
      try {
        await this.#assertObjectDirectory(root, storageObjectId);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(id)} has an index without a complete object.`);
        }
        throw error;
      }
      const document = await this.#readPersistedSession(root, id, storageObjectId);
      const ownerToken = document.state === 'open' ? await this.#acquireOwner(root, id) : undefined;
      let events: readonly PlaygroundTraceEvent[];
      try {
        events = await this.#readEvents(root);
      } catch (error) {
        if (ownerToken !== undefined) await this.#releaseOwner(root, ownerToken).catch(() => undefined);
        throw error;
      }
      const cleanupFailures = [...document.cleanupFailures];
      const record: SessionRecord = {
        admissionFailed: false,
        cleanupFailures,
        createdAt: document.createdAt,
        durability: undefined,
        events: [...events],
        id,
        identity: document.identity,
        nextSequence: events.length + 1,
        outcome: document.outcome,
        root,
        state: document.state,
        storageObjectId,
        subscribers: new PlaygroundSubscriptionSet(this.#maxSubscriberQueue, cleanupFailures),
        queue: serialQueue(),
        ownerToken,
      };
      try {
        this.#assertAvailable();
        this.#sessions.set(id, record);
        return snapshotSession(record);
      } catch (error) {
        await this.#closeRecord(record).catch(() => undefined);
        throw error;
      }
    });
  }

  session(sessionId: string): PlaygroundSession | undefined {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return undefined;
    this.#assertRecordUsable(record);
    return snapshotSession(record);
  }

  async append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent> {
    this.#assertAvailable();
    const record = this.#requireUsableSession(sessionId);
    const event = normalizeEventInput(input);
    return record.queue.run(async () => {
      if (record.state !== 'open') {
        throw serviceError('PLAYGROUND_SESSION_FINALIZED', `Playground session ${JSON.stringify(record.id)} is finalized.`);
      }
      const sequence = record.nextSequence;
      const stored: PlaygroundTraceEvent = Object.freeze({
        ...event,
        rawEventRef: `${eventDocumentName}#${sequence}`,
        sequence,
        timestamp: this.#timestamp(),
      });
      const eventFile = await this.#openPinnedMutableFile(
        record.root,
        eventDocumentName,
        constants.O_WRONLY | constants.O_APPEND,
      );
      try {
        await eventFile.writeFile(`${JSON.stringify(stored)}\n`, 'utf8');
        await eventFile.sync();
      } finally {
        await eventFile.close();
      }
      record.events.push(stored);
      record.nextSequence = sequence + 1;
      record.subscribers.publish(stored);
      this.#logDurableAppend(record, stored);
      return snapshotEvent(stored);
    });
  }

  async finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession> {
    this.#assertAvailable();
    const record = this.#requireSession(sessionId);
    const durable = normalizeOutcome(outcome);
    if (record.admissionFailed) this.#assertRecordUsable(record);
    if (record.durability === 'terminal-uncertain') {
      return this.#retryUncertainFinalization(record, durable);
    }
    this.#assertRecordUsable(record);
    await record.queue.run(async () => {
      if (record.state !== 'open') {
        throw serviceError('PLAYGROUND_SESSION_FINALIZED', `Playground session ${JSON.stringify(record.id)} is finalized.`);
      }
      await this.#commitState(record, 'finalized', durable);
    });
    return this.#completeFinalization(record);
  }

  async replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    this.#assertAvailable();
    const record = this.#requireUsableSession(sessionId);
    const afterSequence = normalizeCursor(cursor);
    return record.queue.run(async () => {
      const latest = record.nextSequence - 1;
      if (afterSequence > latest) {
        throw serviceError('PLAYGROUND_CURSOR_AHEAD', 'Playground replay cursor is ahead of persisted history.');
      }
      return Object.freeze({
        cursor: Object.freeze({ afterSequence: latest }),
        events: Object.freeze(record.events.filter((event) => event.sequence > afterSequence).map(snapshotEvent)),
        session: snapshotSession(record),
      });
    });
  }

  async subscribe(sessionId: string, options: PlaygroundSubscribeOptions): Promise<PlaygroundSubscription> {
    this.#assertAvailable();
    const record = this.#requireUsableSession(sessionId);
    if (typeof options.onEvent !== 'function') {
      throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground subscription requires an event callback.');
    }
    const afterSequence = normalizeCursor(options.afterSequence === undefined ? undefined : { afterSequence: options.afterSequence });
    return record.queue.run(async () => {
      const latest = record.nextSequence - 1;
      if (afterSequence > latest) {
        throw serviceError('PLAYGROUND_CURSOR_AHEAD', 'Playground subscription cursor is ahead of persisted history.');
      }
      const backlog = record.events.filter((event) => event.sequence > afterSequence);
      const subscription = record.subscribers.add(backlog, options.onEvent);
      const view: PlaygroundSubscription = Object.freeze({
        close: async () => {
          await record.queue.run(async () => record.subscribers.deactivate(subscription));
          await record.subscribers.waitFor(subscription);
        },
        get closed(): boolean { return subscription.closed; },
      });
      return view;
    });
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    this.#assertAvailable();
    const replay = await this.replay(sessionId);
    return Object.freeze({ events: replay.events, session: replay.session });
  }

  async promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase> {
    this.#assertAvailable();
    const record = this.#requireUsableSession(sessionId);
    return record.queue.run(async () => {
      if ((record.state !== 'finalized' && record.state !== 'closed') || record.outcome === undefined) {
        throw serviceError('PLAYGROUND_OUTCOME_REQUIRED', 'A durable playground outcome is required before promotion.');
      }
      const draft = Object.freeze({
        assertions: Object.freeze(selectedAssertions.map(normalizeAssertion)),
        epoch: clone(record.identity.epoch, 'Playground epoch') as PlaygroundEpochIdentity,
        fixture: clone(record.identity.fixture, 'Playground fixture') as PlaygroundFixtureIdentity,
        invocation: clone(record.identity.invocation, 'Playground invocation') as PlaygroundInvocation,
        outcome: clone(record.outcome, 'Playground durable outcome') as PlaygroundDurableOutcome,
        target: clone(record.identity.target, 'Playground target') as PlaygroundTarget,
        task: clone(record.identity.task, 'Playground task') as PlaygroundTask,
      });
      assertNoProviderCredentials(draft as unknown as PlaygroundJsonValue);
      return draft;
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const record = this.#requireSession(sessionId);
    await this.#closeRecord(record);
  }

  async close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#admissions]);
      const sessions = [...this.#sessions.entries()];
      const settled = await Promise.allSettled(sessions.map(async ([, record]) => {
        await this.#closeRecord(record);
      }));
      const failures = [
        ...settled.flatMap((result, index): PlaygroundServiceCloseFailure[] =>
          result.status === 'rejected'
            ? [Object.freeze({ error: result.reason, sessionId: sessions[index]![0] })]
            : []),
      ];
      if (failures.length > 0) throw new PlaygroundServiceCloseError(Object.freeze(failures));
    })();
    return this.#closePromise;
  }

  async #closeRecord(record: SessionRecord): Promise<void> {
    const subscriptions = await record.queue.run(async () => {
      if (record.state === 'open') {
        await this.#commitState(record, 'closed', Object.freeze({ status: 'aborted' }));
      } else if (record.state === 'finalized') {
        if (record.outcome === undefined) {
          throw serviceError('PLAYGROUND_OUTCOME_REQUIRED', 'A finalized playground session is missing its durable outcome.');
        }
        await this.#commitState(record, 'closed', record.outcome);
      }
      return record.subscribers.entries();
    });
    await record.subscribers.drain(subscriptions);
    await record.queue.run(async () => {
      for (const subscription of subscriptions) record.subscribers.deactivate(subscription);
      await this.#persistSession(record);
    });
    if (record.ownerToken !== undefined) {
      const token = record.ownerToken;
      await this.#releaseOwner(record.root, token);
      record.ownerToken = undefined;
    }
    if (record.cleanupFailures.length > 0) {
      throw new PlaygroundSessionCloseError(record.id, snapshotCleanupFailures(record.cleanupFailures));
    }
  }

  #assertAvailable(): void {
    if (this.#closing) throw serviceError('PLAYGROUND_SERVICE_CLOSED', 'Playground service is closed.');
  }

  async #admit<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertAvailable();
    const admission = Promise.withResolvers<void>();
    this.#admissions.add(admission.promise);
    try {
      return await operation();
    } finally {
      this.#admissions.delete(admission.promise);
      admission.resolve();
    }
  }

  #publishSession(record: SessionRecord): void {
    const objectId = record.storageObjectId;
    const document: PersistedSessionIndex = Object.freeze({
      kind: 'agent-bundle-playground-session-index',
      objectId,
      projectId: this.#projectId,
      sessionId: record.id,
    });
    const bytes = `${JSON.stringify(document)}\n`;
    const pendingPath = this.#pendingIndexPath(safeSessionId(randomUUID()));
    const pendingDescriptor = openSync(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      runDurabilityTestHook('before-file-write:pending-index', pendingPath);
      writeFileSync(pendingDescriptor, bytes, 'utf8');
      runDurabilityTestHook('before-file-fsync:pending-index', pendingPath);
      fsyncSync(pendingDescriptor);
      const pendingBefore = fstatSync(pendingDescriptor);
      if (!pendingBefore.isFile() || pendingBefore.nlink !== 1) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground pending index could not be pinned safely.');
      }
      this.#syncDirectory(this.#requirePendingIndexRoot(), 'pending-index-publication');
      this.#assertAvailable();
      const finalPath = this.#finalIndexPath(record.id);
      runDurabilityTestHook('before-final-index-link', pendingPath);
      try {
        linkSync(pendingPath, finalPath);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          throw serviceError('PLAYGROUND_SESSION_CONFLICT', `Playground session ${JSON.stringify(record.id)} already exists.`);
        }
        throw error;
      }
      this.#sessions.set(record.id, record);
      runDurabilityTestHook('after-final-index-link', finalPath);
      const finalDescriptor = openSync(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const pendingAfter = fstatSync(pendingDescriptor);
        const finalStat = fstatSync(finalDescriptor);
        const finalBytes = readFileSync(finalDescriptor, 'utf8');
        if (!finalStat.isFile()
          || pendingAfter.dev !== finalStat.dev
          || pendingAfter.ino !== finalStat.ino
          || pendingAfter.nlink !== 2
          || finalStat.nlink !== 2
          || finalBytes !== bytes) {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground final index did not preserve the pinned pending document.');
        }
      } finally {
        closeSync(finalDescriptor);
      }
      this.#syncDirectory(this.#requireIndexRoot(), 'final-index-publication');
    } finally {
      closeSync(pendingDescriptor);
    }
  }

  #requireSession(sessionId: string): SessionRecord {
    const id = safeSessionId(sessionId);
    const record = this.#sessions.get(id);
    if (record === undefined) {
      throw serviceError('PLAYGROUND_SESSION_NOT_FOUND', `Playground session ${JSON.stringify(id)} was not found; reopen it first if needed.`);
    }
    return record;
  }

  #requireUsableSession(sessionId: string): SessionRecord {
    const record = this.#requireSession(sessionId);
    this.#assertRecordUsable(record);
    return record;
  }

  #assertRecordUsable(record: SessionRecord): void {
    if (record.admissionFailed) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(record.id)} failed after publication and is available only for cleanup.`);
    }
    if (record.durability === 'terminal-uncertain') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(record.id)} has an uncertain durable outcome.`);
    }
  }

  async #retryUncertainFinalization(record: SessionRecord, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession> {
    await record.queue.run(async () => {
      if (record.durability !== 'terminal-uncertain'
        || record.state !== 'finalized'
        || record.outcome === undefined
        || !sameOutcome(record.outcome, outcome)) {
        throw serviceError('PLAYGROUND_SESSION_FINALIZED', `Playground session ${JSON.stringify(record.id)} is finalized.`);
      }
      await this.#persistSession(record);
    });
    return this.#completeFinalization(record);
  }

  async #completeFinalization(record: SessionRecord): Promise<PlaygroundSession> {
    await record.subscribers.drain();
    return record.queue.run(async () => {
      await this.#persistSession(record);
      return snapshotSession(record);
    });
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
      throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground clock must return a valid Date.');
    }
    return value.toISOString();
  }

  async #ensureStore(): Promise<void> {
    this.#ready ??= this.#initializeStore();
    return this.#ready;
  }

  async #initializeStore(): Promise<void> {
    const layout = await initializePlaygroundStorageLayout(
      this.#projectRoot,
      this.#storageRoot,
      (path, reason) => { this.#syncDirectory(path, reason); },
    );
    this.#resolvedIndexRoot = layout.indexRoot;
    this.#resolvedObjectRoot = layout.objectRoot;
    this.#resolvedPendingIndexRoot = layout.pendingIndexRoot;
  }

  #syncDirectory(path: string, reason: DirectorySyncReason): void {
    runDurabilityTestHook(`before-directory-sync:${reason}`, path);
    syncDirectorySync(path, {
      beforeFsync: () => { runDurabilityTestHook(`before-directory-fsync:${reason}`, path); },
      beforeOpen: () => { runDurabilityTestHook(`before-directory-open:${reason}`, path); },
      platform: durabilityPlatform(),
    });
  }

  #requireObjectRoot(): string {
    const root = this.#resolvedObjectRoot;
    if (root === undefined) throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage has not initialized.');
    return root;
  }

  #requireIndexRoot(): string {
    const root = this.#resolvedIndexRoot;
    if (root === undefined) throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage has not initialized.');
    return root;
  }

  #requirePendingIndexRoot(): string {
    const root = this.#resolvedPendingIndexRoot;
    if (root === undefined) throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage has not initialized.');
    return root;
  }

  #objectRoot(objectId: string): string {
    return join(this.#requireObjectRoot(), safeSessionId(objectId));
  }

  #finalIndexPath(sessionId: string): string {
    return join(this.#requireIndexRoot(), `${safeSessionId(sessionId)}.json`);
  }

  #pendingIndexPath(publicationId: string): string {
    return join(this.#requirePendingIndexRoot(), `${safeSessionId(publicationId)}.json`);
  }

  async #assertObjectDirectory(root: string, objectId: string): Promise<void> {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object must be a real contained directory.');
    }
    const resolved = await realpath(root);
    const objectRoot = this.#resolvedObjectRoot;
    if (objectRoot === undefined || !isInsideOrEqual(objectRoot, resolved) || basename(resolved) !== objectId) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object resolves outside configured storage.');
    }
  }

  async #assertOwnedObject(root: string, objectId: string, sessionId: string, token: string): Promise<void> {
    try {
      await this.#assertObjectDirectory(root, objectId);
      const owner = await this.#readOwnerLock(root);
      if (!sameOwner(owner, { pid: process.pid, token })) {
        throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} object ownership changed during admission.`);
      }
    } catch (error) {
      if (error instanceof PlaygroundServiceError && error.code === 'PLAYGROUND_SESSION_OWNED') throw error;
      throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} object ownership could not be proven during admission.`);
    }
  }

  async #writeNewFile(path: string, contents: string, phase: Exclude<DurableFilePhase, 'owner' | 'pending-index'>): Promise<void> {
    await writeNewPinnedFile(path, contents, {
      beforeFsync: () => { runDurabilityTestHook(`before-file-fsync:${phase}`, path); },
      beforeWrite: () => { runDurabilityTestHook(`before-file-write:${phase}`, path); },
      invalid: () => serviceError('PLAYGROUND_ROOT_INVALID', 'Playground durable file could not be created safely.'),
    });
    this.#syncDirectory(dirname(path), 'new-file');
  }

  async #readIndex(sessionId: string): Promise<PersistedSessionIndex | undefined> {
    const path = this.#finalIndexPath(sessionId);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has an invalid index.`);
    }
    try {
      const [fileStat, pathStat, contents] = await Promise.all([handle.stat(), lstat(path), handle.readFile()]);
      const indexRoot = this.#resolvedIndexRoot;
      const resolved = await realpath(path);
      if (!fileStat.isFile()
        || !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || fileStat.dev !== pathStat.dev
        || fileStat.ino !== pathStat.ino
        || fileStat.nlink !== 2
        || pathStat.nlink !== 2
        || indexRoot === undefined
        || !isInsideOrEqual(indexRoot, resolved)
        || basename(resolved) !== `${sessionId}.json`) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has an invalid index.`);
      }
      return decodeSessionIndexDocument(contents.toString('utf8'), { projectId: this.#projectId, sessionId });
    } finally {
      await handle.close();
    }
  }

  async #openPinnedMutableFile(
    root: string,
    name: typeof sessionDocumentName | typeof eventDocumentName | typeof ownerLockName,
    flags: number,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    return openPinnedContainedFile({
      flags,
      invalid: () => serviceError('PLAYGROUND_ROOT_INVALID', `Playground ${name} must be a singly linked contained file.`),
      name,
      root,
    });
  }

  async #assertMutableFile(root: string, name: typeof sessionDocumentName | typeof eventDocumentName | typeof ownerLockName, missingAllowed = false): Promise<void> {
    try {
      const handle = await this.#openPinnedMutableFile(root, name, constants.O_RDONLY);
      await handle.close();
    } catch (error) {
      if (missingAllowed && isErrno(error, 'ENOENT')) return;
      throw error;
    }
  }

  async #readMutableFile(
    root: string,
    name: typeof sessionDocumentName | typeof eventDocumentName | typeof ownerLockName,
  ): Promise<string> {
    const handle = await this.#openPinnedMutableFile(root, name, constants.O_RDONLY);
    try {
      return (await handle.readFile()).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async #acquireOwner(root: string, sessionId: string): Promise<string> {
    const token = randomUUID();
    const path = join(root, ownerLockName);
    const document = Object.freeze({ pid: process.pid, token });
    return acquireOwnerLockFile({
      attempts: 3,
      create: async () => {
        let createdAndSynced = false;
        try {
          await writeNewPinnedFile(path, `${JSON.stringify(document)}\n`, {
            afterFsync: () => { createdAndSynced = true; },
            beforeFsync: () => { runDurabilityTestHook('before-file-fsync:owner', path); },
            beforeWrite: () => { runDurabilityTestHook('before-file-write:owner', path); },
            invalid: () => serviceError('PLAYGROUND_ROOT_INVALID', 'Playground owner lock could not be created safely.'),
          });
          this.#syncDirectory(root, 'owner-lock-create');
          return token;
        } catch (error) {
          if (createdAndSynced) {
            try {
              await this.#removeJustCreatedOwnerLock(root, token);
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                'Playground owner-lock durability failure could not be cleaned up.',
                { cause: cleanupError },
              );
            }
          }
          throw error;
        }
      },
      exhausted: () =>
        serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} ownership could not be acquired.`),
      onContention: async () => {
        await sharedOwnerMutationSerializer.run(path, async () => {
          try {
            await runAsyncDurabilityTestHook('before-owner-lock-recovery', path);
            const owner = await this.#readOwnerLock(root);
            if (isProcessAlive(owner.pid)) {
              throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} is owned by another foreground service.`);
            }
            await this.#unlinkExpectedOwner(root, owner, 'recovery');
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) throw error;
          }
        });
        return undefined;
      },
    });
  }

  async #releaseOwner(root: string, token: string): Promise<void> {
    const path = join(root, ownerLockName);
    try {
      await sharedOwnerMutationSerializer.run(path, async () => {
        await this.#unlinkExpectedOwner(root, Object.freeze({ pid: process.pid, token }), 'release');
      });
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async #readOwnerLock(root: string): Promise<OwnerLock> {
    let document: string;
    try {
      document = await this.#readMutableFile(root, ownerLockName);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw error;
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is malformed.');
    }
    return parseOwnerLockDocument(document);
  }

  async #removeJustCreatedOwnerLock(root: string, token: string): Promise<void> {
    const path = join(root, ownerLockName);
    await sharedOwnerMutationSerializer.run(path, async () => {
      await this.#unlinkExpectedOwner(root, Object.freeze({ pid: process.pid, token }), 'create-recovery');
    });
  }

  async #unlinkExpectedOwner(root: string, expected: OwnerLock, reason: OwnerMutationReason): Promise<void> {
    const path = join(root, ownerLockName);
    const handle = await this.#openPinnedMutableFile(root, ownerLockName, constants.O_RDONLY);
    try {
      const pinnedBefore = await handle.stat();
      await runAsyncDurabilityTestHook(`before-owner-lock-unlink:${reason}`, path);
      const [contents, pathStat, pinnedAfter] = await Promise.all([handle.readFile(), lstat(path), handle.stat()]);
      const actual = parseOwnerLockDocument(contents.toString('utf8'));
      if (!pathStat.isFile()
        || pathStat.isSymbolicLink()
        || pathStat.nlink !== 1
        || pinnedBefore.dev !== pathStat.dev
        || pinnedBefore.ino !== pathStat.ino
        || pinnedAfter.dev !== pathStat.dev
        || pinnedAfter.ino !== pathStat.ino
        || pinnedAfter.nlink !== 1
        || !sameOwner(actual, expected)) {
        throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground owner lock changed before ${reason} removal.`);
      }
      await unlink(path);
    } finally {
      await handle.close();
    }
    this.#syncDirectory(root, reason === 'create-recovery' ? 'owner-lock-create-recovery' : `owner-lock-${reason}`);
  }

  async #commitState(
    record: SessionRecord,
    state: PlaygroundSession['state'],
    outcome: PlaygroundDurableOutcome,
  ): Promise<void> {
    const previousOutcome = record.outcome;
    const previousState = record.state;
    const persistence: SessionPersistenceProgress = { metadataRenamed: false };
    record.outcome = outcome;
    record.state = state;
    try {
      await this.#persistSession(record, persistence);
    } catch (error) {
      if (!persistence.metadataRenamed) {
        record.outcome = previousOutcome;
        record.state = previousState;
      }
      throw error;
    }
  }

  async #persistSession(record: SessionRecord, progress?: SessionPersistenceProgress): Promise<void> {
    const persistence = progress ?? { metadataRenamed: false };
    try {
      const documentBase = {
        cleanupFailures: snapshotCleanupFailures(record.cleanupFailures),
        createdAt: record.createdAt,
        identity: record.identity,
        kind: 'agent-bundle-playground-session',
        ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
        projectId: this.#projectId,
        sessionId: record.id,
        state: record.state,
      } as const;
      const document: PersistedSession = Object.freeze({
        ...documentBase,
        storageObjectId: record.storageObjectId,
      });
      assertNoProviderCredentials(document as unknown as PlaygroundJsonValue);
      await this.#assertMutableFile(record.root, sessionDocumentName, true);
      const temporary = join(record.root, `.${sessionDocumentName}.${randomUUID()}.tmp`);
      await this.#writeNewFile(temporary, `${JSON.stringify(document)}\n`, 'session-metadata');
      await rename(temporary, join(record.root, sessionDocumentName));
      persistence.metadataRenamed = true;
      this.#syncDirectory(record.root, 'session-metadata-rename');
      if (record.durability === 'terminal-uncertain') record.durability = undefined;
    } catch (error) {
      if (persistence.metadataRenamed && record.state !== 'open') record.durability = 'terminal-uncertain';
      throw error;
    }
  }

  async #readPersistedSession(
    root: string,
    expectedId: string,
    expectedObjectId: string,
  ): Promise<PersistedSession> {
    let document: string;
    try {
      document = await this.#readMutableFile(root, sessionDocumentName);
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has malformed metadata.`);
    }
    return decodePersistedSession(document, { expectedId, expectedObjectId, projectId: this.#projectId });
  }

  async #readEvents(root: string): Promise<readonly PlaygroundTraceEvent[]> {
    return decodeEventLog(await this.#readMutableFile(root, eventDocumentName));
  }

  /** The event has reached its fsync boundary before this observation is emitted. */
  #logDurableAppend(record: SessionRecord, event: PlaygroundTraceEvent): void {
    try {
      this.#logger?.log({
        context: {
          epochId: record.identity.epoch.id,
          sessionId: record.id,
          target: record.identity.target.name,
        },
        details: { kind: event.kind, sequence: event.sequence, source: event.source },
        kind: 'playground.event.appended',
        level: 'info',
        producer: 'playground',
        summary: 'Durable playground trace event was recorded.',
      });
    } catch { /* Durable playground behavior is independent of Dev Logs. */ }
  }
}
