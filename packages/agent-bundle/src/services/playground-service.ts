import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export type PlaygroundJsonPrimitive = boolean | null | number | string;
export type PlaygroundJsonArray = readonly PlaygroundJsonValue[];
export interface PlaygroundJsonObject {
  readonly [key: string]: PlaygroundJsonValue;
}
export type PlaygroundJsonValue = PlaygroundJsonArray | PlaygroundJsonObject | PlaygroundJsonPrimitive;

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
  readonly operation: 'subscriber';
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
  readonly cleanupFailures: PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly events: PlaygroundTraceEvent[];
  readonly id: string;
  readonly identity: PlaygroundSessionIdentity;
  nextSequence: number;
  outcome: PlaygroundDurableOutcome | undefined;
  readonly root: string;
  state: PlaygroundSession['state'];
  readonly subscribers: Set<SubscriptionRecord>;
  tail: Promise<void>;
  ownerToken: string | undefined;
}

interface PersistedSession {
  readonly cleanupFailures: readonly PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly identity: PlaygroundSessionIdentity;
  readonly kind: 'agent-bundle-playground-session';
  readonly outcome?: PlaygroundDurableOutcome;
  readonly projectId: string;
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly state: PlaygroundSession['state'];
}

interface OwnerLock {
  readonly pid: number;
  readonly token: string;
  readonly version: 1;
}

const schemaVersion = 1 as const;
const sessionDirectoryName = 'sessions';
const sessionDocumentName = 'session.json';
const eventDocumentName = 'events.jsonl';
const ownerLockName = '.owner.lock';
const pathSegment = /^[a-z0-9][a-z0-9._-]*$/iu;
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

const contained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..\\') && !path.startsWith('../'));
};

const serviceError = (code: PlaygroundServiceErrorCode, message: string): PlaygroundServiceError =>
  new PlaygroundServiceError(code, message);

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be a nonempty string.`);
  }
  return value;
};

const traceSource = (value: unknown): PlaygroundTraceSource => {
  switch (value) {
    case 'build':
    case 'diagnostics':
    case 'hook':
    case 'host-preflight':
    case 'mcp':
    case 'project':
    case 'response':
    case 'script':
    case 'skill-evidence':
    case 'workspace-change':
      return value;
    default:
      throw serviceError('PLAYGROUND_VALUE_INVALID', 'Playground event source must be supported.');
  }
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
    const copied = Object.freeze(value.map((item) => json(item, label, seen)));
    seen.delete(value);
    return copied;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  }
  const copied: Record<string, PlaygroundJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      seen.delete(value);
      throw serviceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain accessors.`);
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
  readonly #maxSubscriberQueue: number;
  readonly #now: () => Date;
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #storageRoot: string;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #ready: Promise<void> | undefined;
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
      const root = this.#sessionRoot(id);
      let createdRoot = false;
      let record: SessionRecord | undefined;
      try {
        try {
          await mkdir(root);
          createdRoot = true;
        } catch (error) {
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
            throw serviceError('PLAYGROUND_SESSION_CONFLICT', `Playground session ${JSON.stringify(id)} already exists.`);
          }
          throw error;
        }
        await this.#assertSessionDirectory(root, id);
        this.#assertAvailable();
        const ownerToken = await this.#acquireOwner(root, id);
        record = {
          cleanupFailures: [],
          createdAt: this.#timestamp(),
          events: [],
          id,
          identity,
          nextSequence: 1,
          outcome: undefined,
          root,
          state: 'open',
          subscribers: new Set(),
          tail: Promise.resolve(),
          ownerToken,
        };
        await writeFile(join(root, eventDocumentName), '', { encoding: 'utf8', flag: 'wx' });
        await this.#persistSession(record);
        this.#assertAvailable();
        this.#sessions.set(id, record);
        return snapshotSession(record);
      } catch (error) {
        if (record !== undefined) await this.#discardUnadmittedSession(record).catch(() => undefined);
        else if (createdRoot) await this.#removeSessionRoot(root, id).catch(() => undefined);
        throw error;
      }
    });
  }

  async reopen(sessionId: string): Promise<PlaygroundSession> {
    return this.#admit(async () => {
      await this.#ensureStore();
      this.#assertAvailable();
      const id = safeSessionId(sessionId);
      assertNoProviderCredentials(id);
      const existing = this.#sessions.get(id);
      if (existing !== undefined) return snapshotSession(existing);
      const root = this.#sessionRoot(id);
      try {
        await this.#assertSessionDirectory(root, id);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          throw serviceError('PLAYGROUND_SESSION_NOT_FOUND', `Playground session ${JSON.stringify(id)} was not found.`);
        }
        throw error;
      }
      const document = await this.#readPersistedSession(root, id);
      const ownerToken = document.state === 'open' ? await this.#acquireOwner(root, id) : undefined;
      let events: readonly PlaygroundTraceEvent[];
      try {
        events = await this.#readEvents(root);
      } catch (error) {
        if (ownerToken !== undefined) await this.#releaseOwner(root, ownerToken).catch(() => undefined);
        throw error;
      }
      const record: SessionRecord = {
        cleanupFailures: [...document.cleanupFailures],
        createdAt: document.createdAt,
        events: [...events],
        id,
        identity: document.identity,
        nextSequence: events.length + 1,
        outcome: document.outcome,
        root,
        state: document.state,
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
    return record === undefined ? undefined : snapshotSession(record);
  }

  async append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent> {
    this.#assertAvailable();
    const record = this.#requireSession(sessionId);
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
      await this.#assertEventPath(record.root);
      await appendFile(join(record.root, eventDocumentName), `${JSON.stringify(stored)}\n`, 'utf8');
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
    await this.#enqueue(record, async () => {
      if (record.state !== 'open') {
        throw serviceError('PLAYGROUND_SESSION_FINALIZED', `Playground session ${JSON.stringify(record.id)} is finalized.`);
      }
      await this.#commitState(record, 'finalized', durable);
    });
    await this.#drainSubscriptions(record);
    return this.#enqueue(record, async () => {
      await this.#persistSession(record);
      return snapshotSession(record);
    });
  }

  async replay(sessionId: string, cursor?: PlaygroundReplayCursor): Promise<PlaygroundReplay> {
    this.#assertAvailable();
    const record = this.#requireSession(sessionId);
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
    const record = this.#requireSession(sessionId);
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
    return Object.freeze({ events: replay.events, schemaVersion, session: replay.session });
  }

  async promoteToDraftEval(sessionId: string, selectedAssertions: readonly PlaygroundSelectedAssertion[]): Promise<DraftEvalCase> {
    this.#assertAvailable();
    const record = this.#requireSession(sessionId);
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
        schemaVersion,
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
      const failures = settled.flatMap((result, index): PlaygroundServiceCloseFailure[] =>
        result.status === 'rejected'
          ? [Object.freeze({ error: result.reason, sessionId: sessions[index]![0] })]
          : []);
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

  async #discardUnadmittedSession(record: SessionRecord): Promise<void> {
    this.#sessions.delete(record.id);
    try {
      if (record.ownerToken !== undefined) {
        const token = record.ownerToken;
        record.ownerToken = undefined;
        await this.#releaseOwner(record.root, token);
      }
    } finally {
      await this.#removeSessionRoot(record.root, record.id);
    }
  }

  async #removeSessionRoot(root: string, sessionId: string): Promise<void> {
    await this.#assertSessionDirectory(root, sessionId);
    await rm(root, { force: true, recursive: true });
  }

  #requireSession(sessionId: string): SessionRecord {
    const id = safeSessionId(sessionId);
    const record = this.#sessions.get(id);
    if (record === undefined) {
      throw serviceError('PLAYGROUND_SESSION_NOT_FOUND', `Playground session ${JSON.stringify(id)} was not found; reopen it first if needed.`);
    }
    return record;
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
    await mkdir(requestedStorageRoot, { recursive: true });
    const storageStat = await lstat(requestedStorageRoot);
    if (storageStat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root must not be a symbolic link.');
    }
    const resolvedStorageRoot = await realpath(requestedStorageRoot);
    if (!contained(resolvedProjectRoot, resolvedStorageRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage root resolves outside the configured project root.');
    }
    const sessionsRoot = join(requestedStorageRoot, sessionDirectoryName);
    await mkdir(sessionsRoot, { recursive: true });
    const resolvedSessionsRoot = await realpath(sessionsRoot);
    if (!contained(resolvedStorageRoot, resolvedSessionsRoot)) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session root resolves outside configured storage.');
    }
    this.#resolvedSessionsRoot = resolvedSessionsRoot;
  }

  #sessionRoot(sessionId: string): string {
    const sessionsRoot = this.#resolvedSessionsRoot;
    if (sessionsRoot === undefined) throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground storage has not initialized.');
    return join(sessionsRoot, safeSessionId(sessionId));
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

  async #assertSessionDocumentPath(root: string, missingAllowed = false): Promise<void> {
    const path = join(root, sessionDocumentName);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (missingAllowed && isErrno(error, 'ENOENT')) return;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session metadata must be a real contained file.');
    }
    const resolved = await realpath(path);
    if (!contained(root, resolved) || basename(resolved) !== sessionDocumentName) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground session metadata resolves outside its session.');
    }
  }

  async #assertEventPath(root: string): Promise<void> {
    const path = join(root, eventDocumentName);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground event log must be a real contained file.');
    }
    const resolved = await realpath(path);
    if (!contained(root, resolved) || basename(resolved) !== eventDocumentName) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground event log resolves outside its session.');
    }
  }

  async #assertOwnerLockPath(root: string): Promise<void> {
    const path = join(root, ownerLockName);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground owner lock must be a real contained file.');
    }
    const resolved = await realpath(path);
    if (!contained(root, resolved) || basename(resolved) !== ownerLockName) {
      throw serviceError('PLAYGROUND_ROOT_INVALID', 'Playground owner lock resolves outside its session.');
    }
  }

  async #acquireOwner(root: string, sessionId: string): Promise<string> {
    const token = randomUUID();
    const path = join(root, ownerLockName);
    const document = Object.freeze({ pid: process.pid, token, version: 1 as const });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      const owner = await this.#readOwnerLock(root);
      if (!this.#ownerIsStale(owner)) {
        throw serviceError('PLAYGROUND_SESSION_OWNED', `Playground session ${JSON.stringify(sessionId)} is owned by another foreground service.`);
      }
      try {
        await unlink(path);
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
      if (owner.token === token) await unlink(path);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }

  async #readOwnerLock(root: string): Promise<OwnerLock> {
    await this.#assertOwnerLockPath(root);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(root, ownerLockName), 'utf8'));
    } catch {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is malformed.');
    }
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.token !== 'string') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is invalid.');
    }
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isFinite(pid) || !Number.isSafeInteger(pid) || pid < 1) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground owner lock is invalid.');
    }
    return Object.freeze({ pid, token: parsed.token, version: 1 });
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
    record.outcome = outcome;
    record.state = state;
    try {
      await this.#persistSession(record);
    } catch (error) {
      record.outcome = previousOutcome;
      record.state = previousState;
      throw error;
    }
  }

  async #persistSession(record: SessionRecord): Promise<void> {
    const document: PersistedSession = Object.freeze({
      cleanupFailures: snapshotCleanupFailures(record.cleanupFailures),
      createdAt: record.createdAt,
      identity: record.identity,
      kind: 'agent-bundle-playground-session',
      ...(record.outcome === undefined ? {} : { outcome: record.outcome }),
      projectId: this.#projectId,
      schemaVersion,
      sessionId: record.id,
      state: record.state,
    });
    assertNoProviderCredentials(json(document, 'Playground persisted session'));
    await this.#assertSessionDocumentPath(record.root, true);
    const temporary = join(record.root, `.${sessionDocumentName}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(record.root, sessionDocumentName));
  }

  async #readPersistedSession(root: string, expectedId: string): Promise<PersistedSession> {
    await this.#assertSessionDocumentPath(root);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(root, sessionDocumentName), 'utf8'));
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
    if (parsed.kind !== 'agent-bundle-playground-session' || parsed.schemaVersion !== schemaVersion) {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has unsupported metadata.`);
    }
    if (parsed.projectId !== this.#projectId) {
      throw serviceError('PLAYGROUND_PROJECT_MISMATCH', `Playground session ${JSON.stringify(expectedId)} belongs to a different project.`);
    }
    if (parsed.sessionId !== expectedId || typeof parsed.createdAt !== 'string') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid identity metadata.`);
    }
    if (parsed.state !== 'open' && parsed.state !== 'finalized' && parsed.state !== 'closed') {
      throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid state metadata.`);
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
        if (!isRecord(value) || value.operation !== 'subscriber' || typeof value.message !== 'string') {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has invalid cleanup failures.`);
        }
        return Object.freeze({ message: value.message, operation: 'subscriber' });
      })
      : (() => { throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(expectedId)} has missing cleanup failures.`); })();
    return Object.freeze({
      cleanupFailures: Object.freeze(cleanupFailures),
      createdAt: parsed.createdAt,
      identity,
      kind: 'agent-bundle-playground-session',
      ...(outcome === undefined ? {} : { outcome }),
      projectId: this.#projectId,
      schemaVersion,
      sessionId: expectedId,
      state: parsed.state,
    });
  }

  async #readEvents(root: string): Promise<readonly PlaygroundTraceEvent[]> {
    await this.#assertEventPath(root);
    const contents = await readFile(join(root, eventDocumentName), 'utf8');
    const lines = contents.split('\n');
    const completeLines = contents.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1);
    const events: PlaygroundTraceEvent[] = [];
    for (const [index, line] of completeLines.entries()) {
      if (line.length === 0) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an empty completed record.');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains a malformed completed record.');
      }
      if (!isRecord(parsed)) throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains a non-object record.');
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
