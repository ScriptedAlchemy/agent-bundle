import { containsProviderCredential, isCredentialKey } from '../../core/credentials.ts';
import { isRecord } from '../../core/strict-json.ts';
import {
  playgroundServiceError,
  type PlaygroundDurableOutcome,
  type PlaygroundEventInput,
  type PlaygroundJsonObject,
  type PlaygroundJsonValue,
  type PlaygroundReplayCursor,
  type PlaygroundSelectedAssertion,
  type PlaygroundSessionIdentity,
  type PlaygroundTraceEvent,
  type PlaygroundTraceSource,
} from './playground-protocol.ts';

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

export const nonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must be a nonempty string.`);
  }
  return value;
};

export const safeSessionId = (value: string): string => {
  if (!pathSegment.test(value) || value === '.' || value === '..') {
    throw playgroundServiceError('PLAYGROUND_SESSION_ID_INVALID', 'Playground session id must be a path-safe identifier.');
  }
  return value;
};

const json = (value: unknown, label: string, seen = new WeakSet<object>()): PlaygroundJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
    return value;
  }
  if (typeof value !== 'object') throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  if (seen.has(value)) throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain cycles.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const copied = Object.freeze(value.map((item) => json(item, label, seen)));
    seen.delete(value);
    return copied;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must be JSON-compatible.`);
  }
  const copied = Object.create(null) as Record<string, PlaygroundJsonValue>;
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      seen.delete(value);
      throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must not contain accessors.`);
    }
    copied[key] = json(descriptor.value, label, seen);
  }
  seen.delete(value);
  return Object.freeze(copied);
};

const jsonObject = (value: unknown, label: string): PlaygroundJsonObject => {
  const copied = json(value, label);
  if (!isRecord(copied)) throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', `${label} must be a JSON object.`);
  return copied;
};

export const clone = <T>(value: T, label = 'Playground value'): T => json(value, label) as T;

export const assertNoProviderCredentials = (value: PlaygroundJsonValue): void => {
  if (typeof value === 'string') {
    if (containsProviderCredential(value)) {
      throw playgroundServiceError('PLAYGROUND_CREDENTIAL_REJECTED', 'Playground records must not contain provider credential material.');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoProviderCredentials(item);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (isCredentialKey(key)) {
        throw playgroundServiceError('PLAYGROUND_CREDENTIAL_REJECTED', 'Playground records must not contain provider credential material.');
      }
      assertNoProviderCredentials(item);
    }
  }
};

export const normalizeIdentity = (value: PlaygroundSessionIdentity): PlaygroundSessionIdentity => {
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
  assertNoProviderCredentials(identity as PlaygroundJsonValue);
  return identity;
};

export const normalizeOutcome = (value: PlaygroundDurableOutcome): PlaygroundDurableOutcome => {
  const outcome = Object.freeze({
    ...(value?.response === undefined ? {} : { response: nonempty(value.response, 'Playground outcome response') }),
    status: nonempty(value?.status, 'Playground outcome status'),
    ...(value?.workspace === undefined ? {} : { workspace: jsonObject(value.workspace, 'Playground outcome workspace') }),
  });
  assertNoProviderCredentials(outcome as PlaygroundJsonValue);
  return outcome;
};

export const sameOutcome = (left: PlaygroundDurableOutcome, right: PlaygroundDurableOutcome): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const normalizeEventInput = (value: unknown): PlaygroundEventInput => {
  if (!isRecord(value)) {
    throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', 'Playground event must be a JSON object.');
  }
  const source = value.source;
  if (!isTraceSource(source)) {
    throw playgroundServiceError('PLAYGROUND_VALUE_INVALID', 'Playground event source is unsupported.');
  }
  const event = Object.freeze({
    kind: nonempty(value.kind, 'Playground event kind'),
    raw: json(value.raw, 'Playground event raw value'),
    source,
    summary: nonempty(value.summary, 'Playground event summary'),
  });
  assertNoProviderCredentials(event as PlaygroundJsonValue);
  return event;
};

export const snapshotEvent = (value: PlaygroundTraceEvent): PlaygroundTraceEvent => Object.freeze({
  kind: value.kind,
  raw: clone(value.raw, 'Playground event raw value'),
  rawEventRef: value.rawEventRef,
  sequence: value.sequence,
  source: value.source,
  summary: value.summary,
  timestamp: value.timestamp,
});

export const normalizeCursor = (value: PlaygroundReplayCursor | undefined): number => {
  const sequence = value?.afterSequence ?? 0;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw playgroundServiceError('PLAYGROUND_CURSOR_INVALID', 'Playground replay cursor must be a non-negative safe integer.');
  }
  return sequence;
};

export const normalizeAssertion = (value: PlaygroundSelectedAssertion): PlaygroundSelectedAssertion => {
  const assertion = Object.freeze({
    evidence: json(value?.evidence, 'Playground assertion evidence'),
    expectation: json(value?.expectation, 'Playground assertion expectation'),
    id: nonempty(value?.id, 'Playground assertion id'),
    kind: nonempty(value?.kind, 'Playground assertion kind'),
  });
  assertNoProviderCredentials(assertion as PlaygroundJsonValue);
  return assertion;
};
