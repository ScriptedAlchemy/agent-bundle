import { readTornTailJsonl } from '../core/durable-fs.ts';
import { hasExactOwnKeys, isRecord, parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import {
  PlaygroundServiceError,
  playgroundServiceError as serviceError,
  type PlaygroundCleanupFailure,
  type PlaygroundDurableOutcome,
  type PlaygroundJsonValue,
  type PlaygroundSession,
  type PlaygroundSessionIdentity,
  type PlaygroundTraceEvent,
} from './playground-protocol.ts';
import {
  assertNoProviderCredentials,
  normalizeEventInput,
  normalizeIdentity,
  normalizeOutcome,
  safeSessionId,
} from './playground-values.ts';

/**
 * Codecs for the playground store's persisted documents (session metadata,
 * the session index, the event journal, and the owner lock), following the
 * run-store / run-store-codec sibling convention: everything here is pure
 * decoding and validation over already-read bytes, while the service owns
 * every filesystem interaction.
 */

export const sessionDocumentName = 'session.json';
export const eventDocumentName = 'events.jsonl';
export const ownerLockName = '.owner.lock';

export interface OwnerLock {
  readonly pid: number;
  readonly token: string;
}

export interface PersistedSessionBase {
  readonly cleanupFailures: readonly PlaygroundCleanupFailure[];
  readonly createdAt: string;
  readonly identity: PlaygroundSessionIdentity;
  readonly kind: 'agent-bundle-playground-session';
  readonly outcome?: PlaygroundDurableOutcome;
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: PlaygroundSession['state'];
}

export interface PersistedSession extends PersistedSessionBase {
  readonly storageObjectId: string;
}

export interface PersistedSessionIndex {
  readonly kind: 'agent-bundle-playground-session-index';
  readonly objectId: string;
  readonly projectId: string;
  readonly sessionId: string;
}

export interface PersistedSessionContext {
  readonly expectedId: string;
  readonly expectedObjectId: string;
  readonly projectId: string;
}

export interface SessionIndexContext {
  readonly projectId: string;
  readonly sessionId: string;
}

const canonicalOwnerToken = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

export const parseOwnerLockDocument = (document: string): OwnerLock => {
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

export const sameOwner = (left: OwnerLock, right: OwnerLock): boolean =>
  left.pid === right.pid && left.token === right.token;

export const decodeSessionIndexDocument = (
  contents: string,
  context: SessionIndexContext,
): PersistedSessionIndex => {
  const { projectId, sessionId } = context;
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(contents);
  } catch {
    throw serviceError('PLAYGROUND_STORE_CORRUPT', `Playground session ${JSON.stringify(sessionId)} has malformed index metadata.`);
  }
  if (!isRecord(parsed)
    || !hasExactOwnKeys(parsed, ['kind', 'objectId', 'projectId', 'sessionId'])
    || parsed.kind !== 'agent-bundle-playground-session-index'
    || parsed.projectId !== projectId
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
    projectId,
    sessionId,
  });
};

export const decodePersistedSession = (
  document: string,
  context: PersistedSessionContext,
): PersistedSession => {
  const { expectedId, expectedObjectId, projectId } = context;
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(document);
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
  if (parsed.projectId !== projectId) {
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
    projectId,
    sessionId: expectedId,
    state: parsed.state,
  } as const;
  return Object.freeze({
    ...documentBase,
    storageObjectId: expectedObjectId,
  });
};

export const decodeEventLog = (contents: string): readonly PlaygroundTraceEvent[] =>
  readTornTailJsonl<PlaygroundTraceEvent>(contents, {
    decode: (parsed, index) => {
      if (!isRecord(parsed) || !hasExactOwnKeys(parsed, ['kind', 'raw', 'rawEventRef', 'sequence', 'source', 'summary', 'timestamp'])) {
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an invalid record envelope.');
      }
      try {
        assertNoProviderCredentials(parsed as PlaygroundJsonValue);
        const input = normalizeEventInput(parsed);
        const sequence = parsed.sequence;
        if (!Number.isSafeInteger(sequence) || sequence !== index + 1 || typeof parsed.timestamp !== 'string'
          || parsed.rawEventRef !== `${eventDocumentName}#${sequence}`) {
          throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an invalid sequence record.');
        }
        return Object.freeze({ ...input, rawEventRef: parsed.rawEventRef, sequence, timestamp: parsed.timestamp });
      } catch (error) {
        if (error instanceof PlaygroundServiceError && error.code === 'PLAYGROUND_STORE_CORRUPT') throw error;
        throw serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains invalid persisted values.');
      }
    },
    emptyRecord: () => serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an empty completed record.'),
    malformedRecord: () => serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains a malformed completed record.'),
    sequenceViolation: () => serviceError('PLAYGROUND_STORE_CORRUPT', 'Playground event log contains an invalid sequence record.'),
  }).records;
