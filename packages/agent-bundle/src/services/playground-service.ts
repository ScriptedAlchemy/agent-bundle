import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { serialQueue, type SerialQueue } from '../core/async.ts';
import { isErrno, isTolerableWin32SyncError } from '../core/errors.ts';
import { isInsideOrEqual } from '../core/paths.ts';
import { isRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import type { DevLogSink } from '../dev/dev-log-service.ts';
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

export class PlaygroundSessionCloseError extends Error {
  readonly failures: readonly PlaygroundCleanupFailure[];
  readonly sessionId: string;

  constructor(sessionId: string, failures: readonly PlaygroundCleanupFailure[]) {
    super(`Playground session ${JSON.stringify(sessionId)} closed with cleanup failures.`);
    this.name = 'PlaygroundSessionCloseError';
    this.sessionId = sessionId;
    this.failures = failures;
  }
}

export interface PlaygroundServiceCloseFailure {
  readonly error: unknown;
  readonly sessionId: string;
}

export class PlaygroundServiceCloseError extends Error {
  readonly failures: readonly PlaygroundServiceCloseFailure[];

  constructor(failures: readonly PlaygroundServiceCloseFailure[]) {
    super('Playground service closed with session cleanup failures.');
    this.name = 'PlaygroundServiceCloseError';
    this.failures = failures;
  }
}

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

interface PersistedSessionBase {
  readonly cleanupFailures: readonly PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly identity: PlaygroundSessionIdentity;
  readonly kind: 'agent-bundle-playground-session';
  readonly outcome?: PlaygroundDurableOutcome;
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: PlaygroundSession['state'];
}

interface PersistedSession extends PersistedSessionBase {
  readonly storageObjectId: string;
}

interface PersistedSessionIndex {
  readonly kind: 'agent-bundle-playground-session-index';
  readonly objectId: string;
  readonly projectId: string;
  readonly sessionId: string;
}

interface OwnerLock {
  readonly pid: number;
  readonly token: string;
}

interface SessionPersistenceProgress {
  metadataRenamed: boolean;
}

const objectDirectoryName = 'session-objects';
const indexDirectoryName = 'session-index';
const pendingIndexDirectoryName = '.pending';
const sessionDocumentName = 'session.json';
const eventDocumentName = 'events.jsonl';
const ownerLockName = '.owner.lock';
type DirectorySyncReason =
  | 'final-index-publication'
  | 'layout-index-entry'
  | 'layout-object-entry'
  | 'layout-pending-index-entry'
  | 'layout-project-entry'
  | 'layout-storage-entry'
  | 'new-file'
  | 'object-created'
  | 'owner-lock-create'
  | 'owner-lock-create-recovery'
  | 'owner-lock-recovery'
  | 'owner-lock-release'
  | 'pending-index-publication'
  | 'session-metadata-rename';
type DurableFilePhase = 'event' | 'owner' | 'pending-index' | 'session-metadata';
type OwnerMutationReason = 'create-recovery' | 'recovery' | 'release';
type DurabilityTestPhase =
  | 'after-final-index-link'
  | 'before-owner-lock-recovery'
  | 'before-final-index-link'
  | `before-directory-fsync:${DirectorySyncReason}`
  | `before-directory-open:${DirectorySyncReason}`
  | `before-directory-sync:${DirectorySyncReason}`
  | `before-file-fsync:${DurableFilePhase}`
  | `before-file-write:${DurableFilePhase}`
  | `before-owner-lock-unlink:${OwnerMutationReason}`;
type DurabilityTestHook = (phase: DurabilityTestPhase, path: string) => Promise<void> | void;
/** Non-API test seam, unavailable unless the process explicitly runs in test mode. */
const durabilityTestHookKey = Symbol.for('agent-bundle.playground-service.durability-test-hook');
const durabilityTestPlatformKey = Symbol.for('agent-bundle.playground-service.durability-test-platform');
const canonicalOwnerToken = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ownerMutationTails = new Map<string, Promise<void>>();

const hasExactOwnKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const hasOptionalOwnKey = (value: Record<string, unknown>, required: readonly string[], optional: string): boolean =>
  hasExactOwnKeys(value, required) || hasExactOwnKeys(value, [...required, optional]);

const hasPersistedIdentitySchema = (value: unknown): boolean => {
  if (!isRecord(value)
    || !hasExactOwnKeys(value, ['epoch', 'fixture', 'invocation', 'target', 'task'])
    || !isRecord(value.epoch)
    || !hasExactOwnKeys(value.epoch, ['digest', 'id'])
    || !isRecord(value.fixture)
    || !hasExactOwnKeys(value.fixture, ['digest', 'id'])
    || !isRecord(value.invocation)
    || !hasExactOwnKeys(value.invocation, ['intent', 'kind'])
    || !isRecord(value.invocation.intent)
    || !isRecord(value.target)
    || !hasOptionalOwnKey(value.target, ['name'], 'digest')
    || !isRecord(value.task)
    || !hasExactOwnKeys(value.task, ['id', 'text'])) {
    return false;
  }
  return true;
};

const hasPersistedOutcomeSchema = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return hasExactOwnKeys(value, ['status'])
    || hasExactOwnKeys(value, ['status', 'response'])
    || hasExactOwnKeys(value, ['status', 'workspace'])
    || hasExactOwnKeys(value, ['status', 'response', 'workspace']);
};

const parseOwnerLockDocument = (document: string): OwnerLock => {
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(document);
  } catch {
    throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is malformed.');
  }
  if (!isRecord(parsed)
    || !hasExactOwnKeys(parsed, ['pid', 'token'])
    || typeof parsed.pid !== 'number'
    || !Number.isSafeInteger(parsed.pid)
    || parsed.pid < 1
    || typeof parsed.token !== 'string'
    || !canonicalOwnerToken.test(parsed.token)) {
    throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is invalid.');
  }
  return Object.freeze({ pid: parsed.pid, token: parsed.token });
};

const sameOwner = (left: OwnerLock, right: OwnerLock): boolean =>
  left.pid === right.pid && left.token === right.token;

const serializeOwnerMutation = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  const previous = ownerMutationTails.get(path) ?? Promise.resolve();
  const boundary = Promise.withResolvers<void>();
  ownerMutationTails.set(path, boundary.promise);
  await previous;
  try {
    return await operation();
  } finally {
    boundary.resolve();
    if (ownerMutationTails.get(path) === boundary.promise) ownerMutationTails.delete(path);
  }
};

const runDurabilityTestHook = (phase: DurabilityTestPhase, path: string): void => {
  if (process.env.NODE_ENV !== 'test') return;
  const hooks = globalThis as typeof globalThis & Record<symbol, DurabilityTestHook | undefined>;
  void hooks[durabilityTestHookKey]?.(phase, path);
};

const runAsyncDurabilityTestHook = async (phase: DurabilityTestPhase, path: string): Promise<void> => {
  if (process.env.NODE_ENV !== 'test') return;
  const hooks = globalThis as typeof globalThis & Record<symbol, DurabilityTestHook | undefined>;
  await hooks[durabilityTestHookKey]?.(phase, path);
};

const durabilityPlatform = (): NodeJS.Platform => {
  if (process.env.NODE_ENV !== 'test') return process.platform;
  const platforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  return platforms[durabilityTestPlatformKey] ?? process.platform;
};

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

export class PlaygroundService {
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
    if (!isAbsolute(this.#projectRoot) || !isAbsolute(this.#storageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be an absolute project-owned path.');
    }
    const requestedProjectRoot = resolve(this.#projectRoot);
    const requestedStorageRoot = resolve(this.#storageRoot);
    if (!isInsideOrEqual(requestedProjectRoot, requestedStorageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be contained by the configured project root.');
    }
    const resolvedProjectRoot = await realpath(requestedProjectRoot);
    await this.#createStorageRoot(requestedProjectRoot, requestedStorageRoot);
    const storageStat = await lstat(requestedStorageRoot);
    if (storageStat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must not be a symbolic link.');
    }
    const resolvedStorageRoot = await realpath(requestedStorageRoot);
    if (!isInsideOrEqual(resolvedProjectRoot, resolvedStorageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root resolves outside the configured project root.');
    }
    const objectRoot = join(requestedStorageRoot, objectDirectoryName);
    await this.#createLayoutDirectory(objectRoot, requestedStorageRoot, 'layout-object-entry');
    const resolvedObjectRoot = await realpath(objectRoot);
    if (!isInsideOrEqual(resolvedStorageRoot, resolvedObjectRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object root resolves outside configured storage.');
    }
    const indexRoot = join(requestedStorageRoot, indexDirectoryName);
    const pendingIndexRoot = join(indexRoot, pendingIndexDirectoryName);
    await this.#createLayoutDirectory(indexRoot, requestedStorageRoot, 'layout-index-entry');
    await this.#createLayoutDirectory(pendingIndexRoot, indexRoot, 'layout-pending-index-entry');
    const resolvedIndexRoot = await realpath(indexRoot);
    const resolvedPendingIndexRoot = await realpath(pendingIndexRoot);
    if (!isInsideOrEqual(resolvedStorageRoot, resolvedIndexRoot) || !isInsideOrEqual(resolvedIndexRoot, resolvedPendingIndexRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session index root resolves outside configured storage.');
    }
    this.#resolvedIndexRoot = resolvedIndexRoot;
    this.#resolvedObjectRoot = resolvedObjectRoot;
    this.#resolvedPendingIndexRoot = resolvedPendingIndexRoot;
  }

  async #createStorageRoot(projectRoot: string, storageRoot: string): Promise<void> {
    const storageRelativePath = relative(projectRoot, storageRoot);
    if (storageRelativePath === '') return;
    const segments = storageRelativePath.split(sep);
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be a contained directory path.');
    }
    let parent = projectRoot;
    for (let index = 0; index < segments.length; index += 1) {
      const path = join(parent, segments[index]!);
      await this.#createLayoutDirectory(
        path,
        parent,
        index === segments.length - 1 ? 'layout-storage-entry' : 'layout-project-entry',
      );
      parent = path;
    }
  }

  async #createLayoutDirectory(path: string, parent: string, reason: DirectorySyncReason): Promise<void> {
    let created = false;
    try {
      await mkdir(path);
      created = true;
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage layout must contain real directories.');
    }
    if (created) this.#syncDirectory(parent, reason);
  }

  #syncDirectory(path: string, reason: DirectorySyncReason): void {
    runDurabilityTestHook(`before-directory-sync:${reason}`, path);
    runDurabilityTestHook(`before-directory-open:${reason}`, path);
    const descriptor = openSync(path, constants.O_RDONLY);
    try {
      runDurabilityTestHook(`before-directory-fsync:${reason}`, path);
      fsyncSync(descriptor);
    } catch (error) {
      // Windows has no public directory-fsync primitive. Only documented
      // directory FlushFileBuffers capability failures are tolerated here;
      // opening a directory and every retained regular-file sync still fail.
      if (isTolerableWin32SyncError(durabilityPlatform(), error)) return;
      throw error;
    } finally {
      closeSync(descriptor);
    }
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
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground durable file could not be created safely.');
      }
      runDurabilityTestHook(`before-file-write:${phase}`, path);
      await handle.writeFile(contents, 'utf8');
      runDurabilityTestHook(`before-file-fsync:${phase}`, path);
      await handle.sync();
    } finally {
      await handle.close();
    }
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
      let parsed: unknown;
      try {
        parsed = parseJsonWithoutDuplicateKeys(contents.toString('utf8'));
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has malformed index metadata.`);
      }
      if (!isRecord(parsed)
        || !hasExactOwnKeys(parsed, ['kind', 'objectId', 'projectId', 'sessionId'])
        || parsed.kind !== 'agent-bundle-playground-session-index'
        || parsed.projectId !== this.#projectId
        || parsed.sessionId !== sessionId
        || typeof parsed.objectId !== 'string') {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has invalid index metadata.`);
      }
      try {
        safeSessionId(parsed.objectId);
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has invalid index metadata.`);
      }
      return Object.freeze({
        kind: 'agent-bundle-playground-session-index',
        objectId: parsed.objectId,
        projectId: this.#projectId,
        sessionId,
      });
    } finally {
      await handle.close();
    }
  }

  async #openPinnedMutableFile(
    root: string,
    name: typeof sessionDocumentName | typeof eventDocumentName | typeof ownerLockName,
    flags: number,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    const path = join(root, name);
    const handle = await open(path, flags | constants.O_NOFOLLOW);
    try {
      const [fileStat, pathStat] = await Promise.all([handle.stat(), lstat(path)]);
      const resolved = await realpath(path);
      if (!fileStat.isFile()
        || !pathStat.isFile()
        || pathStat.isSymbolicLink()
        || fileStat.nlink !== 1
        || pathStat.nlink !== 1
        || fileStat.dev !== pathStat.dev
        || fileStat.ino !== pathStat.ino
        || !isInsideOrEqual(root, resolved)
        || basename(resolved) !== name) {
        throw serviceError('PLAYGROUND_ROOT_INVALID', `Playground ${name} must be a singly linked contained file.`);
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let createdAndSynced = false;
      try {
        const handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1) {
            throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground owner lock could not be created safely.');
          }
          runDurabilityTestHook('before-file-write:owner', path);
          await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
          runDurabilityTestHook('before-file-fsync:owner', path);
          await handle.sync();
          createdAndSynced = true;
        } finally {
          await handle.close();
        }
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
          throw error;
        }
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      await serializeOwnerMutation(path, async () => {
        try {
          await runAsyncDurabilityTestHook('before-owner-lock-recovery', path);
          const owner = await this.#readOwnerLock(root);
          if (!this.#ownerIsStale(owner)) {
            throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} is owned by another foreground service.`);
          }
          await this.#unlinkExpectedOwner(root, owner, 'recovery');
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      });
    }
    throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} ownership could not be acquired.`);
  }

  async #releaseOwner(root: string, token: string): Promise<void> {
    const path = join(root, ownerLockName);
    try {
      await serializeOwnerMutation(path, async () => {
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
    await serializeOwnerMutation(path, async () => {
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

  #ownerIsStale(owner: OwnerLock): boolean {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isErrno(error, 'ESRCH');
    }
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
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(await this.#readMutableFile(root, sessionDocumentName));
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has malformed metadata.`);
    }
    if (!isRecord(parsed)) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has unsupported metadata.`);
    }
    try {
      assertNoProviderCredentials(parsed as PlaygroundJsonValue);
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid persisted values.`);
    }
    const expectedKeys = ['cleanupFailures', 'createdAt', 'identity', 'kind', 'outcome', 'projectId', 'sessionId', 'state', 'storageObjectId'];
    const optionalOutcomeKeys = expectedKeys.filter((key) => key !== 'outcome');
    if ((!hasExactOwnKeys(parsed, expectedKeys) && !hasExactOwnKeys(parsed, optionalOutcomeKeys))
      || parsed.kind !== 'agent-bundle-playground-session') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has unsupported metadata.`);
    }
    if (parsed.projectId !== this.#projectId) {
      throw serviceError('PLAYGROUND_PROJECT_MISMATCH', `Playground session ${JSON.stringify(expectedId)} belongs to a different project.`);
    }
    if (parsed.sessionId !== expectedId || typeof parsed.createdAt !== 'string') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid identity metadata.`);
    }
    if (typeof parsed.storageObjectId !== 'string' || parsed.storageObjectId !== expectedObjectId) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid object metadata.`);
    }
    if (parsed.state !== 'open' && parsed.state !== 'finalized' && parsed.state !== 'closed') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid state metadata.`);
    }
    if (!hasPersistedIdentitySchema(parsed.identity)
      || (parsed.outcome !== undefined && !hasPersistedOutcomeSchema(parsed.outcome))) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid persisted values.`);
    }
    let identity: PlaygroundSessionIdentity;
    let outcome: PlaygroundDurableOutcome | undefined;
    try {
      identity = normalizeIdentity(parsed.identity as PlaygroundSessionIdentity);
      outcome = parsed.outcome === undefined ? undefined : normalizeOutcome(parsed.outcome as PlaygroundDurableOutcome);
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid persisted values.`);
    }
    if ((parsed.state === 'finalized' || parsed.state === 'closed') && outcome === undefined) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} is missing a durable outcome.`);
    }
    const cleanupFailures = Array.isArray(parsed.cleanupFailures)
      ? parsed.cleanupFailures.map((value): PlaygroundCleanupFailure => {
        if (!isRecord(value) || !hasExactOwnKeys(value, ['message', 'operation'])
          || value.operation !== 'subscriber' || typeof value.message !== 'string') {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid cleanup failures.`);
        }
        return Object.freeze({ message: value.message, operation: 'subscriber' });
      })
      : (() => { throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has missing cleanup failures.`); })();
    const documentBase = {
      cleanupFailures: Object.freeze(cleanupFailures),
      createdAt: parsed.createdAt,
      identity,
      kind: 'agent-bundle-playground-session',
      ...(outcome === undefined ? {} : { outcome }),
      projectId: this.#projectId,
      sessionId: expectedId,
      state: parsed.state,
    } as const;
    return Object.freeze({
      ...documentBase,
      storageObjectId: expectedObjectId,
    });
  }

  async #readEvents(root: string): Promise<readonly PlaygroundTraceEvent[]> {
    const contents = await this.#readMutableFile(root, eventDocumentName);
    const lines = contents.split('\n');
    // The final element is the empty string after a trailing newline or a torn tail append; both are dropped.
    const completeLines = lines.slice(0, -1);
    const events: PlaygroundTraceEvent[] = [];
    for (const [index, line] of completeLines.entries()) {
      if (line.length === 0) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an empty completed record.');
      }
      let parsed: unknown;
      try {
        parsed = parseJsonWithoutDuplicateKeys(line);
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains a malformed completed record.');
      }
      if (!isRecord(parsed) || !hasExactOwnKeys(parsed, ['kind', 'raw', 'rawEventRef', 'sequence', 'source', 'summary', 'timestamp'])) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an invalid record envelope.');
      }
      let event: PlaygroundTraceEvent;
      try {
        assertNoProviderCredentials(parsed as PlaygroundJsonValue);
        const input = normalizeEventInput(parsed);
        const sequence = parsed.sequence;
        if (!Number.isSafeInteger(sequence) || sequence !== index + 1 || typeof parsed.timestamp !== 'string'
          || parsed.rawEventRef !== `${eventDocumentName}#${sequence}`) {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an invalid sequence record.');
        }
        event = Object.freeze({ ...input, rawEventRef: parsed.rawEventRef, sequence, timestamp: parsed.timestamp });
      } catch (error) {
        if (error instanceof PlaygroundServiceError && error.code === 'PLAYGROUND_STORE_CORRUPT') throw error;
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains invalid persisted values.');
      }
      events.push(event);
    }
    return Object.freeze(events);
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
