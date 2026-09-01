import type {
  AgentStateChange,
  AgentStateDefinition,
  AgentStateEvent,
  AgentStateEventSchemas,
} from './contract.js';
import { AGENT_STATE_RESERVED_KEY_PREFIX, AgentStateError, describeSchemaIssues } from './contract.js';
import { canonicalJson, deepFreezeJson, isJsonSafe } from './json.js';

/**
 * Shared journal semantics for state drivers (#98).
 *
 * Every driver persists the same logical journal: monotonic revisions
 * starting at 1, `event` records carrying validated payloads, and `reset` /
 * `migrate` baseline records carrying the full replacement state. Exact
 * revision reads replay events from the nearest baseline at or below the
 * target through the definition's pure reducer. Drivers store these records
 * however their storage works, but the semantics here are the contract the
 * conformance suite enforces.
 */

export type AgentStateJournalRecord =
  | {
      readonly committedAt: string;
      readonly idempotencyKey: string;
      readonly kind: 'event';
      readonly name: string;
      readonly payload: unknown;
      readonly revision: number;
    }
  | {
      readonly committedAt: string;
      readonly idempotencyKey: string;
      readonly kind: 'migrate';
      readonly revision: number;
      /** Migrated state validated against the current schema. */
      readonly state: unknown;
      readonly toVersion: number;
    }
  | {
      readonly committedAt: string;
      readonly idempotencyKey: string;
      readonly kind: 'reset';
      readonly revision: number;
      /** Resolved post-reset state (the validated seed or the initial state). */
      readonly state: unknown;
    };

/** Canonical dedupe identity for idempotency-key comparison. */
export const canonicalCommitInput = (record: AgentStateJournalRecord): string => {
  switch (record.kind) {
    case 'event':
      return canonicalJson({ kind: 'event', name: record.name, payload: record.payload });
    case 'reset':
      return canonicalJson({ kind: 'reset', state: record.state });
    case 'migrate':
      return canonicalJson({ kind: 'migrate', toVersion: record.toVersion });
    default: {
      const unreachable: never = record;
      throw new AgentStateError('corrupt', `Unknown journal record kind ${String(unreachable)}`);
    }
  }
};

export const migrationIdempotencyKey = (toVersion: number): string =>
  `${AGENT_STATE_RESERVED_KEY_PREFIX}migrate:${String(toVersion)}`;

/**
 * Validates one event payload against its declared schema without running
 * the reducer. Idempotency-key replay must be decided from the validated
 * payload alone: a committed key retried after the state changed replays
 * the committed result, so the reducer must not run first.
 */
export const parseEventPayload = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  name: string,
  payload: unknown,
): unknown => {
  const schema = definition.events[name];
  if (schema === undefined) {
    throw new AgentStateError('invalid-event', `State '${definition.id}' has no event '${name}'`);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new AgentStateError(
      'invalid-event',
      `State '${definition.id}' event '${name}' payload failed its schema: ${describeSchemaIssues(parsed.error)}`,
    );
  }
  if (!isJsonSafe(parsed.data)) {
    throw new AgentStateError('invalid-event', `State '${definition.id}' event '${name}' payload must be JSON-safe`);
  }
  return deepFreezeJson(parsed.data);
};

/**
 * Runs the reducer over an already-validated payload (see
 * {@link parseEventPayload}) and validates its output. Throws typed
 * `reducer-failure` or `invalid-state`; never exposes state contents.
 */
export const reduceStateEvent = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  state: TState,
  name: string,
  payload: unknown,
): TState => {
  let next: TState;
  try {
    next = definition.reduce(state, { name, payload } as AgentStateEvent<TEvents>);
  } catch (error) {
    throw new AgentStateError(
      'reducer-failure',
      `State '${definition.id}' reducer threw for event '${name}'`,
      { cause: error },
    );
  }
  const validated = definition.schema.safeParse(next);
  if (!validated.success) {
    throw new AgentStateError(
      'invalid-state',
      `State '${definition.id}' reducer output for event '${name}' failed the schema: ${describeSchemaIssues(validated.error)}`,
    );
  }
  if (!isJsonSafe(validated.data)) {
    throw new AgentStateError('invalid-state', `State '${definition.id}' reducer output for event '${name}' must be JSON-safe`);
  }
  return deepFreezeJson(validated.data);
};

/**
 * Validates one event payload, runs the reducer, and validates its output.
 * Throws typed `invalid-event`, `reducer-failure`, or `invalid-state`
 * errors; never exposes payload or state contents in messages.
 */
export const applyStateEvent = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  state: TState,
  name: string,
  payload: unknown,
): { readonly payload: unknown; readonly state: TState } => {
  const parsed = parseEventPayload(definition, name, payload);
  return { payload: parsed, state: reduceStateEvent(definition, state, name, parsed) };
};

/** Validates a reset seed (or resolves the initial state) against the schema. */
export const resolveResetState = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  seed: TState | undefined,
): TState => {
  if (seed === undefined) return definition.initial;
  const parsed = definition.schema.safeParse(seed);
  if (!parsed.success) {
    throw new AgentStateError(
      'invalid-state',
      `State '${definition.id}' reset seed failed the schema: ${describeSchemaIssues(parsed.error)}`,
    );
  }
  if (!isJsonSafe(parsed.data)) {
    throw new AgentStateError('invalid-state', `State '${definition.id}' reset seed must be JSON-safe`);
  }
  return deepFreezeJson(parsed.data);
};

const parseBaselineState = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  record: Extract<AgentStateJournalRecord, { kind: 'migrate' | 'reset' }>,
): TState => {
  const parsed = definition.schema.safeParse(record.state);
  if (!parsed.success) {
    throw new AgentStateError(
      'corrupt',
      `State '${definition.id}' ${record.kind} record at revision ${String(record.revision)} no longer satisfies the schema: ${describeSchemaIssues(parsed.error)}`,
    );
  }
  return deepFreezeJson(parsed.data);
};

/**
 * Reconstructs the exact state at `targetRevision` from ordered journal
 * records. Revisions below the latest migration are `revision-unavailable`:
 * migration rebases history because older records were written under an
 * earlier definition version. Replay failures are `corrupt` (fail closed).
 */
export const replayJournal = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  records: readonly AgentStateJournalRecord[],
  targetRevision: number,
): TState => {
  const latestMigration = [...records].reverse().find((record) => record.kind === 'migrate');
  if (latestMigration !== undefined && targetRevision < latestMigration.revision) {
    throw new AgentStateError(
      'revision-unavailable',
      `State '${definition.id}' revision ${String(targetRevision)} predates the migration at revision ${String(latestMigration.revision)}`,
    );
  }
  let state = definition.initial;
  let baselineRevision = 0;
  for (const record of records) {
    if (record.revision > targetRevision) break;
    if (record.kind === 'reset' || record.kind === 'migrate') {
      state = parseBaselineState(definition, record);
      baselineRevision = record.revision;
    }
  }
  for (const record of records) {
    if (record.revision <= baselineRevision || record.revision > targetRevision) continue;
    if (record.kind !== 'event') {
      throw new AgentStateError(
        'corrupt',
        `State '${definition.id}' journal has an out-of-order baseline at revision ${String(record.revision)}`,
      );
    }
    try {
      state = applyStateEvent(definition, state, record.name, record.payload).state;
    } catch (error) {
      throw new AgentStateError(
        'corrupt',
        `State '${definition.id}' could not replay revision ${String(record.revision)}`,
        { cause: error },
      );
    }
  }
  return state;
};

/** Asserts revisions run 1..n without gaps and idempotency keys never repeat. */
export const expectConsistentJournal = (
  definitionId: string,
  records: readonly AgentStateJournalRecord[],
): void => {
  const keys = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.revision !== index + 1) {
      throw new AgentStateError(
        'corrupt',
        `State '${definitionId}' journal expected revision ${String(index + 1)} but found ${String(record.revision)}`,
      );
    }
    if (keys.has(record.idempotencyKey)) {
      throw new AgentStateError('corrupt', `State '${definitionId}' journal repeats an idempotency key`);
    }
    keys.add(record.idempotencyKey);
  }
};

/**
 * Runs the explicit migration chain from `persistedVersion` to the
 * definition's version and validates the final result against the current
 * schema. A persisted version newer than the definition fails closed with
 * `migration-missing`.
 */
export const runStateMigrations = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  persistedVersion: number,
  persistedState: unknown,
): TState => {
  if (!Number.isInteger(persistedVersion) || persistedVersion < 1) {
    throw new AgentStateError('corrupt', `State '${definition.id}' persisted an invalid schema version`);
  }
  if (persistedVersion > definition.version) {
    throw new AgentStateError(
      'migration-missing',
      `State '${definition.id}' was persisted at version ${String(persistedVersion)} but this definition is version ${String(definition.version)}`,
    );
  }
  let migrated = persistedState;
  for (let target = persistedVersion + 1; target <= definition.version; target += 1) {
    const step = definition.migrations[target];
    if (step === undefined) {
      throw new AgentStateError(
        'migration-missing',
        `State '${definition.id}' is missing the migration to version ${String(target)}`,
      );
    }
    try {
      migrated = step(migrated);
    } catch (error) {
      throw new AgentStateError(
        'migration-failure',
        `State '${definition.id}' migration to version ${String(target)} threw`,
        { cause: error },
      );
    }
  }
  const parsed = definition.schema.safeParse(migrated);
  if (!parsed.success) {
    throw new AgentStateError(
      'migration-failure',
      `State '${definition.id}' migrated state failed the version ${String(definition.version)} schema: ${describeSchemaIssues(parsed.error)}`,
    );
  }
  if (!isJsonSafe(parsed.data)) {
    throw new AgentStateError('migration-failure', `State '${definition.id}' migrated state must be JSON-safe`);
  }
  return deepFreezeJson(parsed.data);
};

export const changeFromJournalRecord = (record: AgentStateJournalRecord): AgentStateChange => {
  switch (record.kind) {
    case 'event':
      return {
        committedAt: record.committedAt,
        kind: 'event',
        name: record.name,
        payload: record.payload,
        revision: record.revision,
      };
    case 'reset':
      return { committedAt: record.committedAt, kind: 'reset', revision: record.revision };
    case 'migrate':
      return { committedAt: record.committedAt, kind: 'migrate', revision: record.revision };
    default: {
      const unreachable: never = record;
      throw new AgentStateError('corrupt', `Unknown journal record kind ${String(unreachable)}`);
    }
  }
};
