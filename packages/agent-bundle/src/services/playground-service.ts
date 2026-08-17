import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';

export type PlaygroundJsonPrimitive = boolean | null | number | string;
export type PlaygroundJsonArray = readonly PlaygroundJsonValue[];
export interface PlaygroundJsonObject {
  readonly [key: string]: PlaygroundJsonValue;
}
export type PlaygroundJsonValue = PlaygroundJsonPrimitive | PlaygroundJsonArray | PlaygroundJsonObject;

export type PlaygroundTraceSource =
  | 'build'
  | 'diagnostics'
  | 'hook'
  | 'host-preflight'
  | 'mcp'
  | 'project'
  | 'response'
  | 'script'
  | 'skill-evidence'
  | 'workspace-change';

export interface PlaygroundEpochIdentity {
  readonly digest: string;
  readonly id: string;
}

export interface PlaygroundFixtureIdentity {
  readonly digest: string;
  readonly id: string;
}

export interface PlaygroundTask {
  readonly id: string;
  readonly text: string;
}

export interface PlaygroundTarget {
  readonly digest?: string;
  readonly name: string;
}

export interface PlaygroundInvocation {
  readonly intent: PlaygroundJsonObject;
  readonly kind: string;
}

export interface PlaygroundSessionIdentity {
  readonly epoch: PlaygroundEpochIdentity;
  readonly fixture: PlaygroundFixtureIdentity;
  readonly invocation: PlaygroundInvocation;
  readonly target: PlaygroundTarget;
  readonly task: PlaygroundTask;
}

export interface PlaygroundSessionInput extends PlaygroundSessionIdentity {
  readonly sessionId?: string;
}

export interface PlaygroundDurableOutcome {
  readonly response?: string;
  readonly status: string;
  readonly workspace?: PlaygroundJsonObject;
}

export interface PlaygroundEventInput {
  readonly kind: string;
  readonly raw: PlaygroundJsonValue;
  readonly source: PlaygroundTraceSource;
  readonly summary: string;
}

export interface PlaygroundTraceEvent extends PlaygroundEventInput {
  readonly rawEventRef: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export interface PlaygroundCleanupFailure {
  readonly message: string;
  readonly operation: 'admission' | 'subscriber';
}

export interface PlaygroundSession {
  readonly cleanupFailures: readonly PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly id: string;
  readonly identity: PlaygroundSessionIdentity;
  readonly outcome?: PlaygroundDurableOutcome;
  readonly state: 'closed' | 'finalized' | 'open';
}

export interface PlaygroundReplayCursor {
  readonly afterSequence: number;
}

export interface PlaygroundReplay {
  readonly cursor: PlaygroundReplayCursor;
  readonly events: readonly PlaygroundTraceEvent[];
  readonly session: PlaygroundSession;
}

export interface PlaygroundExport {
  readonly events: readonly PlaygroundTraceEvent[];
  readonly schemaVersion: 1;
  readonly session: PlaygroundSession;
}

export interface PlaygroundSelectedAssertion {
  readonly evidence: PlaygroundJsonValue;
  readonly expectation: PlaygroundJsonValue;
  readonly id: string;
  readonly kind: string;
}

/** A deliberately narrow W17 payload. W18 converts this unchanged into authored eval DSL. */
export interface DraftEvalCase {
  readonly assertions: readonly PlaygroundSelectedAssertion[];
  readonly epoch: PlaygroundEpochIdentity;
  readonly fixture: PlaygroundFixtureIdentity;
  readonly invocation: PlaygroundInvocation;
  readonly outcome: PlaygroundDurableOutcome;
  readonly schemaVersion: 1;
  readonly target: PlaygroundTarget;
  readonly task: PlaygroundTask;
}

export interface PlaygroundSubscription {
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface PlaygroundSubscribeOptions {
  readonly afterSequence?: number;
  readonly onEvent: (event: PlaygroundTraceEvent) => void | Promise<void>;
}

export interface PlaygroundServiceOptions {
  readonly maxSubscriberQueue?: number;
  readonly now?: () => Date;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly storageRoot: string;
}

export type PlaygroundServiceErrorCode =
  | 'PLAYGROUND_CURSOR_AHEAD'
  | 'PLAYGROUND_CURSOR_INVALID'
  | 'PLAYGROUND_CREDENTIAL_REJECTED'
  | 'PLAYGROUND_OUTCOME_REQUIRED'
  | 'PLAYGROUND_PROJECT_MISMATCH'
  | 'PLAYGROUND_ROOT_INVALID'
  | 'PLAYGROUND_SERVICE_CLOSED'
  | 'PLAYGROUND_SESSION_CONFLICT'
  | 'PLAYGROUND_SESSION_FINALIZED'
  | 'PLAYGROUND_SESSION_ID_INVALID'
  | 'PLAYGROUND_SESSION_NOT_FOUND'
  | 'PLAYGROUND_SESSION_OWNED'
  | 'PLAYGROUND_STORE_CORRUPT'
  | 'PLAYGROUND_VALUE_INVALID';

export class PlaygroundServiceError extends Error {
  readonly code: PlaygroundServiceErrorCode;

  constructor(code: PlaygroundServiceErrorCode, message: string) {
    super(message);
    this.name = 'PlaygroundServiceError';
    this.code = code;
  }
}

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

interface SubscriptionRecord {
  active: boolean;
  closed: boolean;
  delivery: Promise<void>;
  draining: boolean;
  readonly onEvent: PlaygroundSubscribeOptions['onEvent'];
  readonly queue: PlaygroundTraceEvent[];
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
  readonly storage: 'v1' | 'v2';
  readonly storageObjectId: string | undefined;
  state: PlaygroundSession['state'];
  readonly subscribers: Set<SubscriptionRecord>;
  tail: Promise<void>;
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

interface PersistedV1Session extends PersistedSessionBase {
  readonly schemaVersion: 1;
}

interface PersistedV2Session extends PersistedSessionBase {
  readonly schemaVersion: 2;
  readonly storageObjectId: string;
}

type PersistedSession = PersistedV1Session | PersistedV2Session;

interface PersistedSessionIndex {
  readonly kind: 'agent-bundle-playground-session-index';
  readonly objectId: string;
  readonly projectId: string;
  readonly schemaVersion: 2;
  readonly sessionId: string;
}

interface OwnerLock {
  readonly pid: number;
  readonly token: string;
  readonly version: 1;
}

interface SessionPersistenceProgress {
  metadataRenamed: boolean;
}

interface ColdAdmission {
  cleanupAttempt: Promise<void> | undefined;
  cleanupFailure: unknown | undefined;
  readonly objectId: string;
  ownerToken: string | undefined;
  published: boolean;
  readonly root: string;
  readonly rootDevice: number;
  readonly rootInode: number;
  rootRemoved: boolean;
  readonly sessionId: string;
}

const draftSchemaVersion = 1 as const;
const legacySessionSchemaVersion = 1 as const;
const objectSessionSchemaVersion = 2 as const;
const sessionDirectoryName = 'sessions';
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
  | 'layout-sessions-entry'
  | 'layout-storage-entry'
  | 'new-file'
  | 'object-admission-cleanup'
  | 'object-created'
  | 'owner-lock-create'
  | 'owner-lock-create-recovery'
  | 'owner-lock-recovery'
  | 'owner-lock-release'
  | 'pending-index-publication'
  | 'session-metadata-rename';
type DurableFilePhase = 'event' | 'owner' | 'pending-index' | 'session-metadata';
type DurabilityTestPhase =
  | 'after-final-index-link'
  | 'before-object-admission-cleanup'
  | 'before-final-index-link'
  | `before-directory-fsync:${DirectorySyncReason}`
  | `before-directory-open:${DirectorySyncReason}`
  | `before-directory-sync:${DirectorySyncReason}`
  | `before-file-fsync:${DurableFilePhase}`
  | `before-file-write:${DurableFilePhase}`;
type DurabilityTestHook = (phase: DurabilityTestPhase, path: string) => void;
/** Non-API test seam, unavailable unless the process explicitly runs in test mode. */
const durabilityTestHookKey = Symbol.for('agent-bundle.playground-service.durability-test-hook');
const durabilityTestPlatformKey = Symbol.for('agent-bundle.playground-service.durability-test-platform');
const pathSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
const traceSources: ReadonlySet<string> = new Set<PlaygroundTraceSource>([
  'build',
  'diagnostics',
  'hook',
  'host-preflight',
  'mcp',
  'project',
  'response',
  'script',
  'skill-evidence',
  'workspace-change',
]);

const isTraceSource = (value: unknown): value is PlaygroundTraceSource =>
  typeof value === 'string' && traceSources.has(value);
const providerCredentialPatterns = Object.freeze([
  /\bsk-(?:proj-|ant-|live-)?[a-z0-9_-]{16,}\b/iu,
  /\b(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|akia[a-z0-9]{16})\b/iu,
  /\bbearer[ \t]+[a-z0-9._~+/=-]{20,}\b/iu,
]);

const sensitiveKey = (key: string): boolean => {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9]+/u)
    .filter((segment) => segment.length > 0);
  const compact = segments.join('');
  return segments.some((segment) => ['authorization', 'credential', 'credentials', 'password', 'secret', 'token'].includes(segment))
    || /(?:apikey|apitoken|authtoken|accesstoken)$/u.test(compact);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
};

const serviceError = (code: PlaygroundServiceErrorCode, message: string): PlaygroundServiceError =>
  new PlaygroundServiceError(code, message);

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const runDurabilityTestHook = (phase: DurabilityTestPhase, path: string): void => {
  if (process.env.NODE_ENV !== 'test') return;
  const hooks = globalThis as typeof globalThis & Record<symbol, DurabilityTestHook | undefined>;
  hooks[durabilityTestHookKey]?.(phase, path);
};

const durabilityPlatform = (): NodeJS.Platform => {
  if (process.env.NODE_ENV !== 'test') return process.platform;
  const platforms = globalThis as typeof globalThis & Record<symbol, NodeJS.Platform | undefined>;
  return platforms[durabilityTestPlatformKey] ?? process.platform;
};

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be a nonempty string.`);
  }
  return value;
};

const traceSource = (value: unknown): PlaygroundTraceSource => {
  if (isTraceSource(value)) return value;
  throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground event source must be supported.');
};

const safeSessionId = (value: string): string => {
  if (!pathSegment.test(value) || value === '.' || value === '..') {
    throw serviceError('PLAYGROUND_SESSION_ID_INVALID', 'Playground session id must be a path-safe identifier.');
  }
  return value;
};

const json = (value: unknown, label: string, seen = new WeakSet<object>()): PlaygroundJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
    return value;
  }
  if (typeof value !== 'object') throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  if (seen.has(value)) throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    const names = Object.getOwnPropertyNames(value);
    const symbols = Object.getOwnPropertySymbols(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (prototype !== Array.prototype
      || symbols.length !== 0
      || lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || names.length !== lengthDescriptor.value + 1) {
      seen.delete(value);
      throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
    }
    const copied = new Array<PlaygroundJsonValue>(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        seen.delete(value);
        throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain accessors.`);
      }
      if (!descriptor.enumerable) {
        seen.delete(value);
        throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
      }
      copied[index] = json(descriptor.value, label, seen);
    }
    seen.delete(value);
    return Object.freeze(copied);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  }
  const copied = Object.create(null) as Record<string, PlaygroundJsonValue>;
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    seen.delete(value);
    throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  }
  for (const key of names.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      seen.delete(value);
      throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain accessors.`);
    }
    if (!descriptor.enumerable) {
      seen.delete(value);
      throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
    }
    copied[key] = json(descriptor.value, label, seen);
  }
  seen.delete(value);
  return Object.freeze(copied);
};

const jsonObject = (value: unknown, label: string): PlaygroundJsonObject => {
  const copied = json(value, label);
  if (!isRecord(copied)) throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be a JSON object.`);
  return copied;
};

const clone = <T>(value: T, label = 'Playground value'): T => json(value, label) as T;

const assertNoProviderCredentials = (value: PlaygroundJsonValue): void => {
  if (typeof value === 'string') {
    if (providerCredentialPatterns.some((pattern) => pattern.test(value))) {
      throw serviceError('PLAYGROUND_CREDENTIAL_REJECTED', 'Playground records must not contain provider credential material.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoProviderCredentials(item);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveKey(key)) {
        throw serviceError('PLAYGROUND_CREDENTIAL_REJECTED', 'Playground records must not contain provider credential material.');
      }
      assertNoProviderCredentials(item);
    }
  }
};

const normalizeIdentity = (value: PlaygroundSessionIdentity): PlaygroundSessionIdentity => {
  const identity = Object.freeze({
    epoch: Object.freeze({
      digest: nonempty(value?.epoch?.digest, 'Playground epoch digest'),
      id: nonempty(value?.epoch?.id, 'Playground epoch id'),
    }),
    fixture: Object.freeze({
      digest: nonempty(value?.fixture?.digest, 'Playground fixture digest'),
      id: nonempty(value?.fixture?.id, 'Playground fixture id'),
    }),
    invocation: Object.freeze({
      intent: jsonObject(value?.invocation?.intent, 'Playground invocation intent'),
      kind: nonempty(value?.invocation?.kind, 'Playground invocation kind'),
    }),
    target: Object.freeze({
      ...(value?.target?.digest === undefined ? {} : { digest: nonempty(value.target.digest, 'Playground target digest') }),
      name: nonempty(value?.target?.name, 'Playground target name'),
    }),
    task: Object.freeze({
      id: nonempty(value?.task?.id, 'Playground task id'),
      text: nonempty(value?.task?.text, 'Playground task text'),
    }),
  });
  assertNoProviderCredentials(json(identity, 'Playground identity'));
  return identity;
};

const normalizeOutcome = (value: unknown): PlaygroundDurableOutcome => {
  if (!isRecord(value)) throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground outcome must be an object.');
  const outcome = Object.freeze({
    ...(value.response === undefined ? {} : { response: nonempty(value.response, 'Playground outcome response') }),
    status: nonempty(value.status, 'Playground outcome status'),
    ...(value.workspace === undefined ? {} : { workspace: jsonObject(value.workspace, 'Playground outcome workspace') }),
  });
  assertNoProviderCredentials(json(outcome, 'Playground outcome'));
  return outcome;
};

const sameOutcome = (left: PlaygroundDurableOutcome, right: PlaygroundDurableOutcome): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const normalizeEventInput = (value: unknown): PlaygroundEventInput => {
  if (!isRecord(value)) throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground event must be an object.');
  const event = Object.freeze({
    kind: nonempty(value.kind, 'Playground event kind'),
    raw: json(value.raw, 'Playground event raw value'),
    source: traceSource(value.source),
    summary: nonempty(value.summary, 'Playground event summary'),
  });
  assertNoProviderCredentials(json(event, 'Playground event'));
  return event;
};

const snapshotEvent = (value: PlaygroundTraceEvent): PlaygroundTraceEvent => Object.freeze({
  kind: value.kind,
  raw: clone(value.raw, 'Playground event raw value'),
  rawEventRef: value.rawEventRef,
  sequence: value.sequence,
  source: value.source,
  summary: value.summary,
  timestamp: value.timestamp,
});

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

const normalizeCursor = (value: PlaygroundReplayCursor | undefined): number => {
  const sequence = value?.afterSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw serviceError('PLAYGROUND_CURSOR_INVALID', 'Playground replay cursor must be a non-negative safe integer.');
  }
  return sequence;
};

const asErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const normalizeAssertion = (value: PlaygroundSelectedAssertion): PlaygroundSelectedAssertion => {
  const assertion = Object.freeze({
    evidence: json(value?.evidence, 'Playground assertion evidence'),
    expectation: json(value?.expectation, 'Playground assertion expectation'),
    id: nonempty(value?.id, 'Playground assertion id'),
    kind: nonempty(value?.kind, 'Playground assertion kind'),
  });
  assertNoProviderCredentials(assertion as PlaygroundJsonValue);
  return assertion;
};

export class PlaygroundService {
  readonly #admissions = new Set<Promise<void>>();
  readonly #coldAdmissions = new Set<ColdAdmission>();
  readonly #maxSubscriberQueue: number;
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
  #resolvedSessionsRoot: string | undefined;

  constructor(options: PlaygroundServiceOptions) {
    const projectId = nonempty(options.projectId, 'Playground project id');
    assertNoProviderCredentials(projectId);
    this.#projectId = projectId;
    this.#projectRoot = options.projectRoot;
    this.#storageRoot = options.storageRoot;
    this.#now = options.now ?? (() => new Date());
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
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object must be a real contained directory.');
      }
      const admission = this.#beginColdAdmission(root, storageObjectId, id, stat.dev, stat.ino);
      let record: SessionRecord | undefined;
      try {
        this.#syncDirectory(this.#requireObjectRoot(), 'object-created');
        await this.#assertObjectDirectory(root, storageObjectId);
        this.#assertAvailable();
        const ownerToken = await this.#acquireOwner(root, id);
        admission.ownerToken = ownerToken;
        record = {
          admissionFailed: false,
          cleanupFailures: [],
          createdAt: this.#timestamp(),
          durability: undefined,
          events: [],
          id,
          identity,
          nextSequence: 1,
          outcome: undefined,
          root,
          state: 'open',
          storage: 'v2',
          storageObjectId,
          subscribers: new Set(),
          tail: Promise.resolve(),
          ownerToken,
        };
        await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
        await this.#writeNewFile(join(root, eventDocumentName), '', 'event');
        await this.#persistSession(record);
        await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
        await this.#readPersistedSession(root, id, 'v2', storageObjectId);
        await this.#readEvents(root);
        await this.#assertOwnedObject(root, storageObjectId, id, ownerToken);
        this.#assertAvailable();
        this.#publishV2(record);
        admission.published = true;
        this.#coldAdmissions.delete(admission);
      } catch (error) {
        if (record !== undefined && this.#sessions.get(id) === record) {
          record.admissionFailed = true;
          admission.published = true;
          this.#coldAdmissions.delete(admission);
          throw error;
        }
        try {
          await this.#rollbackColdAdmission(admission);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Playground session admission and cleanup both failed.',
            { cause: cleanupError },
          );
        }
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
      const index = await this.#readV2Index(id);
      const storage = index === undefined ? 'v1' : 'v2';
      const storageObjectId = index?.objectId;
      const root = storage === 'v1' ? this.#legacySessionRoot(id) : this.#objectRoot(storageObjectId!);
      try {
        if (storage === 'v1') await this.#assertSessionDirectory(root, id);
        else await this.#assertObjectDirectory(root, storageObjectId!);
      } catch (error) {
        if (storage === 'v1' && isErrno(error, 'ENOENT')) {
          throw serviceError('PLAYGROUND_SESSION_NOT_FOUND', `Playground session ${JSON.stringify(id)} was not found.`);
        }
        if (storage === 'v2' && isErrno(error, 'ENOENT')) {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(id)} has a v2 index without a complete object.`);
        }
        throw error;
      }
      const document = await this.#readPersistedSession(root, id, storage, storageObjectId);
      const ownerToken = document.state === 'open' ? await this.#acquireOwner(root, id) : undefined;
      let events: readonly PlaygroundTraceEvent[];
      try {
        events = await this.#readEvents(root);
      } catch (error) {
        if (ownerToken !== undefined) await this.#releaseOwner(root, ownerToken).catch(() => undefined);
        throw error;
      }
      const record: SessionRecord = {
        admissionFailed: false,
        cleanupFailures: [...document.cleanupFailures],
        createdAt: document.createdAt,
        durability: undefined,
        events: [...events],
        id,
        identity: document.identity,
        nextSequence: events.length + 1,
        outcome: document.outcome,
        root,
        state: document.state,
        storage,
        storageObjectId,
        subscribers: new Set(),
        tail: Promise.resolve(),
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
    return this.#enqueue(record, async () => {
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
      this.#publish(record, stored);
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
    await this.#enqueue(record, async () => {
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
    return this.#enqueue(record, async () => {
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
    return this.#enqueue(record, async () => {
      const latest = record.nextSequence - 1;
      if (afterSequence > latest) {
        throw serviceError('PLAYGROUND_CURSOR_AHEAD', 'Playground subscription cursor is ahead of persisted history.');
      }
      const backlog = record.events.filter((event) => event.sequence > afterSequence);
      const subscription: SubscriptionRecord = {
        active: backlog.length <= this.#maxSubscriberQueue,
        closed: backlog.length > this.#maxSubscriberQueue,
        delivery: Promise.resolve(),
        draining: false,
        onEvent: options.onEvent,
        queue: backlog.length > this.#maxSubscriberQueue ? [] : backlog,
      };
      if (subscription.active) {
        record.subscribers.add(subscription);
        this.#drainSubscription(record, subscription);
      }
      const view: PlaygroundSubscription = Object.freeze({
        close: async () => this.#closeSubscription(record, subscription),
        get closed(): boolean { return subscription.closed; },
      });
      return view;
    });
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    this.#assertAvailable();
    const replay = await this.replay(sessionId);
    return Object.freeze({ events: replay.events, schemaVersion: draftSchemaVersion, session: replay.session });
  }

  async promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase> {
    this.#assertAvailable();
    const record = this.#requireUsableSession(sessionId);
    return this.#enqueue(record, async () => {
      if ((record.state !== 'finalized' && record.state !== 'closed') || record.outcome === undefined) {
        throw serviceError('PLAYGROUND_OUTCOME_REQUIRED', 'A durable playground outcome is required before promotion.');
      }
      const draft = Object.freeze({
        assertions: Object.freeze(selectedAssertions.map(normalizeAssertion)),
        epoch: clone(record.identity.epoch, 'Playground epoch') as PlaygroundEpochIdentity,
        fixture: clone(record.identity.fixture, 'Playground fixture') as PlaygroundFixtureIdentity,
        invocation: clone(record.identity.invocation, 'Playground invocation') as PlaygroundInvocation,
        outcome: clone(record.outcome, 'Playground durable outcome') as PlaygroundDurableOutcome,
        schemaVersion: draftSchemaVersion,
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
      const coldAdmissions = [...this.#coldAdmissions];
      const coldSettled = await Promise.allSettled(coldAdmissions.map(async (admission) => {
        await this.#rollbackColdAdmission(admission);
      }));
      const sessions = [...this.#sessions.entries()];
      const settled = await Promise.allSettled(sessions.map(async ([, record]) => {
        await this.#closeRecord(record);
      }));
      const failures = [
        ...coldSettled.flatMap((result, index): PlaygroundServiceCloseFailure[] =>
          result.status === 'rejected'
            ? [Object.freeze({ error: result.reason, sessionId: coldAdmissions[index]!.sessionId })]
            : []),
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
    const subscriptions = await this.#enqueue(record, async () => {
      if (record.state === 'open') {
        await this.#commitState(record, 'closed', Object.freeze({ status: 'aborted' }));
      } else if (record.state === 'finalized') {
        if (record.outcome === undefined) {
          throw serviceError('PLAYGROUND_OUTCOME_REQUIRED', 'A finalized playground session is missing its durable outcome.');
        }
        await this.#commitState(record, 'closed', record.outcome);
      }
      return [...record.subscribers];
    });
    await this.#drainSubscriptions(record, subscriptions);
    await this.#enqueue(record, async () => {
      for (const subscription of subscriptions) this.#deactivateSubscription(record, subscription);
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
    let resolveAdmission!: () => void;
    const admission = new Promise<void>((resolveAdmissionPromise) => { resolveAdmission = resolveAdmissionPromise; });
    this.#admissions.add(admission);
    try {
      return await operation();
    } finally {
      this.#admissions.delete(admission);
      resolveAdmission();
    }
  }

  #beginColdAdmission(
    root: string,
    objectId: string,
    sessionId: string,
    rootDevice: number,
    rootInode: number,
  ): ColdAdmission {
    const admission: ColdAdmission = {
      cleanupAttempt: undefined,
      cleanupFailure: undefined,
      objectId,
      ownerToken: undefined,
      published: false,
      root,
      rootDevice,
      rootInode,
      rootRemoved: false,
      sessionId,
    };
    this.#coldAdmissions.add(admission);
    return admission;
  }

  async #rollbackColdAdmission(admission: ColdAdmission): Promise<void> {
    if (admission.published) return;
    if (admission.cleanupAttempt !== undefined) return admission.cleanupAttempt;
    if (admission.rootRemoved) {
      if (admission.cleanupFailure !== undefined) throw admission.cleanupFailure;
      return;
    }
    const attempt = (async () => {
      runDurabilityTestHook('before-object-admission-cleanup', admission.root);
      await this.#assertColdAdmissionOwnership(admission);
      await rm(admission.root, { force: false, recursive: true });
      admission.rootRemoved = true;
      try {
        this.#syncDirectory(this.#requireObjectRoot(), 'object-admission-cleanup');
      } catch (error) {
        admission.cleanupFailure = error;
        throw error;
      }
      this.#coldAdmissions.delete(admission);
    })();
    admission.cleanupAttempt = attempt;
    try {
      await attempt;
    } finally {
      if (admission.cleanupAttempt === attempt) admission.cleanupAttempt = undefined;
    }
  }

  async #assertColdAdmissionOwnership(admission: ColdAdmission): Promise<void> {
    const stat = await lstat(admission.root);
    if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.dev !== admission.rootDevice
      || stat.ino !== admission.rootInode) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground admission object identity changed before cleanup.');
    }
    await this.#assertObjectDirectory(admission.root, admission.objectId);
    if (admission.ownerToken === undefined) return;
    const owner = await this.#readOwnerLock(admission.root);
    if (owner.token !== admission.ownerToken) {
      throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(admission.sessionId)} object ownership changed before cleanup.`);
    }
  }

  #publishV2(record: SessionRecord): void {
    const objectId = record.storageObjectId;
    if (objectId === undefined) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground v2 session is missing its immutable object id.');
    }
    const document: PersistedSessionIndex = Object.freeze({
      kind: 'agent-bundle-playground-session-index',
      objectId,
      projectId: this.#projectId,
      schemaVersion: objectSessionSchemaVersion,
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
      const legacyRoot = this.#legacySessionRoot(record.id);
      try {
        lstatSync(legacyRoot);
        throw serviceError('PLAYGROUND_SESSION_CONFLICT', `Playground session ${JSON.stringify(record.id)} already exists.`);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
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
    await this.#enqueue(record, async () => {
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
    await this.#drainSubscriptions(record);
    return this.#enqueue(record, async () => {
      await this.#persistSession(record);
      return snapshotSession(record);
    });
  }

  #enqueue<T>(record: SessionRecord, operation: () => Promise<T>): Promise<T> {
    const run = record.tail.then(operation, operation);
    record.tail = run.then(() => undefined, () => undefined);
    return run;
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
    if (!contained(requestedProjectRoot, requestedStorageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must be contained by the configured project root.');
    }
    const resolvedProjectRoot = await realpath(requestedProjectRoot);
    await this.#createStorageRoot(requestedProjectRoot, requestedStorageRoot);
    const storageStat = await lstat(requestedStorageRoot);
    if (storageStat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must not be a symbolic link.');
    }
    const resolvedStorageRoot = await realpath(requestedStorageRoot);
    if (!contained(resolvedProjectRoot, resolvedStorageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root resolves outside the configured project root.');
    }
    const sessionsRoot = join(requestedStorageRoot, sessionDirectoryName);
    await this.#createLayoutDirectory(sessionsRoot, requestedStorageRoot, 'layout-sessions-entry');
    const resolvedSessionsRoot = await realpath(sessionsRoot);
    if (!contained(resolvedStorageRoot, resolvedSessionsRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session root resolves outside configured storage.');
    }
    const objectRoot = join(requestedStorageRoot, objectDirectoryName);
    await this.#createLayoutDirectory(objectRoot, requestedStorageRoot, 'layout-object-entry');
    const resolvedObjectRoot = await realpath(objectRoot);
    if (!contained(resolvedStorageRoot, resolvedObjectRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object root resolves outside configured storage.');
    }
    const indexRoot = join(requestedStorageRoot, indexDirectoryName);
    const pendingIndexRoot = join(indexRoot, pendingIndexDirectoryName);
    await this.#createLayoutDirectory(indexRoot, requestedStorageRoot, 'layout-index-entry');
    await this.#createLayoutDirectory(pendingIndexRoot, indexRoot, 'layout-pending-index-entry');
    const resolvedIndexRoot = await realpath(indexRoot);
    const resolvedPendingIndexRoot = await realpath(pendingIndexRoot);
    if (!contained(resolvedStorageRoot, resolvedIndexRoot) || !contained(resolvedIndexRoot, resolvedPendingIndexRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session index root resolves outside configured storage.');
    }
    this.#resolvedIndexRoot = resolvedIndexRoot;
    this.#resolvedObjectRoot = resolvedObjectRoot;
    this.#resolvedPendingIndexRoot = resolvedPendingIndexRoot;
    this.#resolvedSessionsRoot = resolvedSessionsRoot;
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
      if (durabilityPlatform() === 'win32' && (isErrno(error, 'EACCES') || isErrno(error, 'EINVAL'))) return;
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

  #legacySessionRoot(sessionId: string): string {
    const sessionsRoot = this.#resolvedSessionsRoot;
    if (sessionsRoot === undefined) throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage has not initialized.');
    return join(sessionsRoot, safeSessionId(sessionId));
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

  async #assertSessionDirectory(root: string, sessionId: string): Promise<void> {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', `Playground session ${JSON.stringify(sessionId)} must be a real contained directory.`);
    }
    const resolved = await realpath(root);
    const sessionsRoot = this.#resolvedSessionsRoot;
    if (sessionsRoot === undefined || !contained(sessionsRoot, resolved) || basename(resolved) !== sessionId) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', `Playground session ${JSON.stringify(sessionId)} resolves outside configured storage.`);
    }
  }

  async #assertObjectDirectory(root: string, objectId: string): Promise<void> {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object must be a real contained directory.');
    }
    const resolved = await realpath(root);
    const objectRoot = this.#resolvedObjectRoot;
    if (objectRoot === undefined || !contained(objectRoot, resolved) || basename(resolved) !== objectId) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session object resolves outside configured storage.');
    }
  }

  async #assertOwnedObject(root: string, objectId: string, sessionId: string, token: string): Promise<void> {
    try {
      await this.#assertObjectDirectory(root, objectId);
      const owner = await this.#readOwnerLock(root);
      if (owner.token !== token) {
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

  async #readV2Index(sessionId: string): Promise<PersistedSessionIndex | undefined> {
    const path = this.#finalIndexPath(sessionId);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has an invalid v2 index.`);
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
        || !contained(indexRoot, resolved)
        || basename(resolved) !== `${sessionId}.json`) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has an invalid v2 index.`);
      }
      let parsed: unknown;
      try {
        parsed = parseJsonWithoutDuplicateKeys(contents.toString('utf8'));
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has malformed v2 index metadata.`);
      }
      if (!isRecord(parsed)
        || !hasExactOwnKeys(parsed, ['kind', 'objectId', 'projectId', 'schemaVersion', 'sessionId'])
        || parsed.kind !== 'agent-bundle-playground-session-index'
        || parsed.schemaVersion !== objectSessionSchemaVersion
        || parsed.projectId !== this.#projectId
        || parsed.sessionId !== sessionId
        || typeof parsed.objectId !== 'string') {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has invalid v2 index metadata.`);
      }
      try {
        safeSessionId(parsed.objectId);
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has invalid v2 index metadata.`);
      }
      return Object.freeze({
        kind: 'agent-bundle-playground-session-index',
        objectId: parsed.objectId,
        projectId: this.#projectId,
        schemaVersion: objectSessionSchemaVersion,
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
        || !contained(root, resolved)
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
    const document = Object.freeze({ pid: process.pid, token, version: 1 as const });
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
      const owner = await this.#readOwnerLock(root);
      if (!this.#ownerIsStale(owner)) {
        throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} is owned by another foreground service.`);
      }
      try {
        await this.#assertMutableFile(root, ownerLockName);
        await unlink(path);
        this.#syncDirectory(root, 'owner-lock-recovery');
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} ownership could not be acquired.`);
  }

  async #releaseOwner(root: string, token: string): Promise<void> {
    const path = join(root, ownerLockName);
    try {
      const owner = await this.#readOwnerLock(root);
      if (owner.token === token) {
        await this.#assertMutableFile(root, ownerLockName);
        await unlink(path);
        this.#syncDirectory(root, 'owner-lock-release');
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async #readOwnerLock(root: string): Promise<OwnerLock> {
    let parsed: unknown;
    try {
      parsed = parseJsonWithoutDuplicateKeys(await this.#readMutableFile(root, ownerLockName));
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is malformed.');
    }
    if (!isRecord(parsed) || !hasExactOwnKeys(parsed, ['pid', 'token', 'version']) || parsed.version !== 1 || typeof parsed.pid !== 'number'
      || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1 || typeof parsed.token !== 'string') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is invalid.');
    }
    return Object.freeze({ pid: parsed.pid, token: parsed.token, version: 1 });
  }

  async #removeJustCreatedOwnerLock(root: string, token: string): Promise<void> {
    const path = join(root, ownerLockName);
    const owner = await this.#readOwnerLock(root);
    if (owner.token !== token) {
      throw serviceError('PLAYGROUND_SESSION_OWNED', 'Playground owner lock changed before durability cleanup.');
    }
    await this.#assertMutableFile(root, ownerLockName);
    const currentOwner = await this.#readOwnerLock(root);
    if (currentOwner.token !== token) {
      throw serviceError('PLAYGROUND_SESSION_OWNED', 'Playground owner lock changed during durability cleanup.');
    }
    await unlink(path);
    this.#syncDirectory(root, 'owner-lock-create-recovery');
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
      const document: PersistedSession = record.storage === 'v1'
        ? Object.freeze({ ...documentBase, schemaVersion: legacySessionSchemaVersion })
        : Object.freeze({
          ...documentBase,
          schemaVersion: objectSessionSchemaVersion,
          storageObjectId: record.storageObjectId!,
        });
      assertNoProviderCredentials(json(document, 'Playground persisted session'));
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
    storage: 'v1' | 'v2',
    expectedObjectId?: string,
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
    const expectedSchemaVersion = storage === 'v1' ? legacySessionSchemaVersion : objectSessionSchemaVersion;
    const expectedKeys = storage === 'v1'
      ? ['cleanupFailures', 'createdAt', 'identity', 'kind', 'outcome', 'projectId', 'schemaVersion', 'sessionId', 'state']
      : ['cleanupFailures', 'createdAt', 'identity', 'kind', 'outcome', 'projectId', 'schemaVersion', 'sessionId', 'state', 'storageObjectId'];
    const optionalOutcomeKeys = expectedKeys.filter((key) => key !== 'outcome');
    if ((!hasExactOwnKeys(parsed, expectedKeys) && !hasExactOwnKeys(parsed, optionalOutcomeKeys))
      || parsed.kind !== 'agent-bundle-playground-session' || parsed.schemaVersion !== expectedSchemaVersion) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has unsupported metadata.`);
    }
    if (parsed.projectId !== this.#projectId) {
      throw serviceError('PLAYGROUND_PROJECT_MISMATCH', `Playground session ${JSON.stringify(expectedId)} belongs to a different project.`);
    }
    if (parsed.sessionId !== expectedId || typeof parsed.createdAt !== 'string') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid identity metadata.`);
    }
    if (storage === 'v2' && (typeof parsed.storageObjectId !== 'string' || parsed.storageObjectId !== expectedObjectId)) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid v2 object metadata.`);
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
    return storage === 'v1'
      ? Object.freeze({ ...documentBase, schemaVersion: legacySessionSchemaVersion })
      : Object.freeze({
        ...documentBase,
        schemaVersion: objectSessionSchemaVersion,
        storageObjectId: expectedObjectId!,
      });
  }

  async #readEvents(root: string): Promise<readonly PlaygroundTraceEvent[]> {
    const contents = await this.#readMutableFile(root, eventDocumentName);
    const lines = contents.split('\n');
    const completeLines = contents.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1);
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
        assertNoProviderCredentials(json(parsed, 'Playground persisted event record'));
        const input = normalizeEventInput({
          kind: parsed.kind,
          raw: parsed.raw,
          source: parsed.source,
          summary: parsed.summary,
        });
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

  #publish(record: SessionRecord, event: PlaygroundTraceEvent): void {
    for (const subscription of [...record.subscribers]) {
      if (!subscription.active) continue;
      if (subscription.queue.length >= this.#maxSubscriberQueue) {
        this.#deactivateSubscription(record, subscription);
        continue;
      }
      subscription.queue.push(event);
      this.#drainSubscription(record, subscription);
    }
  }

  #drainSubscription(record: SessionRecord, subscription: SubscriptionRecord): void {
    if (!subscription.active || subscription.draining) return;
    subscription.draining = true;
    subscription.delivery = (async () => {
      try {
        while (subscription.active && subscription.queue.length > 0) {
          const event = subscription.queue.shift()!;
          try {
            await subscription.onEvent(snapshotEvent(event));
          } catch (error) {
            this.#recordCleanupFailure(record, error);
            this.#deactivateSubscription(record, subscription);
          }
        }
      } finally {
        subscription.draining = false;
        if (subscription.active && subscription.queue.length > 0) this.#drainSubscription(record, subscription);
      }
    })();
    void subscription.delivery.catch((error: unknown) => {
      this.#recordCleanupFailure(record, error);
      this.#deactivateSubscription(record, subscription);
    });
  }

  async #drainSubscriptions(record: SessionRecord, subscriptions = [...record.subscribers]): Promise<void> {
    for (const subscription of subscriptions) this.#drainSubscription(record, subscription);
    const settled = await Promise.allSettled(subscriptions.map(async (subscription) => {
      await subscription.delivery;
    }));
    for (const result of settled) {
      if (result.status === 'rejected') this.#recordCleanupFailure(record, result.reason);
    }
  }

  async #closeSubscription(record: SessionRecord, subscription: SubscriptionRecord): Promise<void> {
    await this.#enqueue(record, async () => {
      this.#deactivateSubscription(record, subscription);
    });
    await subscription.delivery;
  }

  #deactivateSubscription(record: SessionRecord, subscription: SubscriptionRecord): void {
    subscription.active = false;
    subscription.closed = true;
    subscription.queue.length = 0;
    record.subscribers.delete(subscription);
  }

  #recordCleanupFailure(record: SessionRecord, error: unknown): void {
    record.cleanupFailures.push(Object.freeze({ message: asErrorMessage(error), operation: 'subscriber' }));
  }
}
