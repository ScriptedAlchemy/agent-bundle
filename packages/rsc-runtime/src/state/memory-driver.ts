import type {
  AgentStateChangeBatch,
  AgentStateChangesOptions,
  AgentStateCommitResult,
  AgentStateDefinition,
  AgentStateDispatchOptions,
  AgentStateDriver,
  AgentStateEventSchemas,
  AgentStateLifetime,
  AgentStateReadOptions,
  AgentStateResetOptions,
  AgentStateSnapshot,
  AgentStateStore,
} from './contract.js';
import { AgentStateError, expectIdempotencyKey } from './contract.js';
import type { AgentStateJournalRecord } from './journal.js';
import {
  applyStateEvent,
  canonicalCommitInput,
  changeFromJournalRecord,
  migrationIdempotencyKey,
  replayJournal,
  resolveResetState,
  runStateMigrations,
} from './journal.js';

/**
 * In-memory state driver (#98).
 *
 * TEST-ONLY as a durability stand-in: storage lives in this process's heap,
 * is never written anywhere, and must never be labeled durable. Its two
 * honest production uses are exactly the volatile lifetimes it can provide:
 * `request` (a fresh store per open, discarded with the request) and
 * `process` (one store per definition id for the life of this driver inside
 * a warm runtime process — lost on restart by definition). The conformance
 * suite runs against this driver to pin the shared kernel semantics.
 */

export interface MemoryStateDriverOptions {
  /** Volatile lifetime this driver provides; defaults to `process`. */
  readonly lifetime?: 'process' | 'request';
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
}

type MemoryLifetime = 'process' | 'request';

const expectVolatileLifetime = (lifetime: AgentStateLifetime): MemoryLifetime => {
  switch (lifetime) {
    case 'request':
    case 'process':
      return lifetime;
    case 'workspace-durable':
    case 'external':
      throw new AgentStateError(
        'lifetime-mismatch',
        `In-memory state storage is never '${lifetime}': it provides only volatile lifetimes and must never be labeled durable`,
      );
    default: {
      const unreachable: never = lifetime;
      throw new AgentStateError('invalid-definition', `Unknown state lifetime ${String(unreachable)}`);
    }
  }
};

interface MemoryStoreInternals<TState, TEvents extends AgentStateEventSchemas> {
  closed: boolean;
  definition: AgentStateDefinition<TState, TEvents>;
  head: AgentStateSnapshot<TState>;
  readonly journal: AgentStateJournalRecord[];
  readonly keys: Map<string, AgentStateJournalRecord>;
}

interface MemoryStoreEntry<TState, TEvents extends AgentStateEventSchemas> {
  readonly internals: MemoryStoreInternals<TState, TEvents>;
  readonly store: AgentStateStore<TState, TEvents>;
}

const expectRevisionShape = (revision: number | undefined, label: string): void => {
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
    throw new AgentStateError('invalid-input', `${label} must be an integer >= 0`);
  }
};

const expectOperable = (closed: boolean, definitionId: string, signal: AbortSignal | undefined): void => {
  if (closed) {
    throw new AgentStateError('store-closed', `State '${definitionId}' store is closed`);
  }
  if (signal?.aborted === true) {
    throw new AgentStateError('aborted', `State '${definitionId}' operation was aborted`, { cause: signal.reason });
  }
};

const createMemoryStore = <TState, TEvents extends AgentStateEventSchemas>(
  definition: AgentStateDefinition<TState, TEvents>,
  lifetime: MemoryLifetime,
  now: () => Date,
  onClose: () => void,
): MemoryStoreEntry<TState, TEvents> => {
  const internals: MemoryStoreInternals<TState, TEvents> = {
    closed: false,
    definition,
    head: Object.freeze({ revision: 0, state: definition.initial }),
    journal: [],
    keys: new Map(),
  };

  /**
   * Commits share one shape: validate inputs, then honor a committed
   * idempotency key (replay/conflict), then compare-and-swap, then append.
   * The interior is fully synchronous, so a commit is atomic per store
   * within this process.
   */
  const commit = (
    record: Readonly<{ canonicalInput: string; key: string }> &
      (
        | { readonly kind: 'event'; readonly name: string; readonly payload: unknown; readonly state: TState }
        | { readonly kind: 'reset'; readonly state: TState }
      ),
    expectedRevision: number | undefined,
  ): AgentStateCommitResult<TState> => {
    const committed = internals.keys.get(record.key);
    if (committed !== undefined) {
      if (canonicalCommitInput(committed) !== record.canonicalInput) {
        throw new AgentStateError(
          'idempotency-conflict',
          `State '${internals.definition.id}' idempotency key was reused with a conflicting input`,
        );
      }
      return Object.freeze({
        replayed: true,
        revision: committed.revision,
        state: replayJournal(internals.definition, internals.journal, committed.revision),
      });
    }
    if (expectedRevision !== undefined && expectedRevision !== internals.head.revision) {
      throw new AgentStateError(
        'revision-conflict',
        `State '${internals.definition.id}' expected revision ${String(expectedRevision)} but the head is ${String(internals.head.revision)}`,
      );
    }
    const journalRecord: AgentStateJournalRecord =
      record.kind === 'event'
        ? {
            committedAt: now().toISOString(),
            idempotencyKey: record.key,
            kind: 'event',
            name: record.name,
            payload: record.payload,
            revision: internals.head.revision + 1,
          }
        : {
            committedAt: now().toISOString(),
            idempotencyKey: record.key,
            kind: 'reset',
            revision: internals.head.revision + 1,
            state: record.state,
          };
    internals.journal.push(journalRecord);
    internals.keys.set(journalRecord.idempotencyKey, journalRecord);
    internals.head = Object.freeze({ revision: journalRecord.revision, state: record.state });
    return Object.freeze({ replayed: false, revision: journalRecord.revision, state: record.state });
  };

  const store: AgentStateStore<TState, TEvents> = {
    get definition() {
      return internals.definition;
    },
    location: `memory:${lifetime}:${definition.id}`,

    async changes(options: AgentStateChangesOptions): Promise<AgentStateChangeBatch> {
      expectOperable(internals.closed, internals.definition.id, options.signal);
      if (options.afterRevision === undefined) {
        throw new AgentStateError('invalid-input', `State '${internals.definition.id}' changes require afterRevision`);
      }
      expectRevisionShape(options.afterRevision, `State '${internals.definition.id}' afterRevision`);
      if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
        throw new AgentStateError(
          'invalid-input',
          `State '${internals.definition.id}' changes limit must be an integer >= 1`,
        );
      }
      const selected = internals.journal
        .filter((record) => record.revision > options.afterRevision)
        .slice(0, options.limit)
        .map((record) => changeFromJournalRecord(record));
      return Object.freeze({ changes: Object.freeze(selected), headRevision: internals.head.revision });
    },

    async close(): Promise<void> {
      if (!internals.closed) {
        internals.closed = true;
        onClose();
      }
    },

    async dispatch(name, payload, options: AgentStateDispatchOptions): Promise<AgentStateCommitResult<TState>> {
      expectOperable(internals.closed, internals.definition.id, options.signal);
      const key = expectIdempotencyKey(options.idempotencyKey);
      expectRevisionShape(options.expectedRevision, `State '${internals.definition.id}' expectedRevision`);
      const applied = applyStateEvent(internals.definition, internals.head.state, name, payload);
      const canonicalInput = canonicalCommitInput({
        committedAt: '',
        idempotencyKey: key,
        kind: 'event',
        name,
        payload: applied.payload,
        revision: 0,
      });
      return commit(
        { canonicalInput, key, kind: 'event', name, payload: applied.payload, state: applied.state },
        options.expectedRevision,
      );
    },

    async read(options: AgentStateReadOptions = {}): Promise<AgentStateSnapshot<TState>> {
      expectOperable(internals.closed, internals.definition.id, options.signal);
      expectRevisionShape(options.revision, `State '${internals.definition.id}' revision`);
      if (options.revision === undefined || options.revision === internals.head.revision) {
        return internals.head;
      }
      if (options.revision > internals.head.revision) {
        throw new AgentStateError(
          'revision-unavailable',
          `State '${internals.definition.id}' revision ${String(options.revision)} is beyond the head ${String(internals.head.revision)}`,
        );
      }
      return Object.freeze({
        revision: options.revision,
        state: replayJournal(internals.definition, internals.journal, options.revision),
      });
    },

    async reset(options: AgentStateResetOptions<TState>): Promise<AgentStateCommitResult<TState>> {
      expectOperable(internals.closed, internals.definition.id, options.signal);
      const key = expectIdempotencyKey(options.idempotencyKey);
      expectRevisionShape(options.expectedRevision, `State '${internals.definition.id}' expectedRevision`);
      const state = resolveResetState(internals.definition, options.seed);
      const canonicalInput = canonicalCommitInput({
        committedAt: '',
        idempotencyKey: key,
        kind: 'reset',
        revision: 0,
        state,
      });
      return commit({ canonicalInput, key, kind: 'reset', state }, options.expectedRevision);
    },
  };

  return { internals, store: Object.freeze(store) };
};

const migrateOpenStore = <TState, TEvents extends AgentStateEventSchemas>(
  internals: MemoryStoreInternals<TState, TEvents>,
  definition: AgentStateDefinition<TState, TEvents>,
  now: () => Date,
): void => {
  const migrated = runStateMigrations(definition, internals.definition.version, internals.head.state);
  const record: AgentStateJournalRecord = {
    committedAt: now().toISOString(),
    idempotencyKey: migrationIdempotencyKey(definition.version),
    kind: 'migrate',
    revision: internals.head.revision + 1,
    state: migrated,
    toVersion: definition.version,
  };
  internals.journal.push(record);
  internals.keys.set(record.idempotencyKey, record);
  internals.head = Object.freeze({ revision: record.revision, state: migrated });
  internals.definition = definition;
};

export const createMemoryStateDriver = (options: MemoryStateDriverOptions = {}): AgentStateDriver => {
  const lifetime = expectVolatileLifetime(options.lifetime ?? 'process');
  const now = options.now ?? ((): Date => new Date());
  // Heterogeneously typed per definition; entries are cast back at the one
  // retrieval site below, keyed by the definition id they were created for.
  const registry = new Map<string, MemoryStoreEntry<unknown, AgentStateEventSchemas>>();
  let closed = false;

  return Object.freeze({
    durable: false,
    kind: 'memory',
    lifetime,

    async close(): Promise<void> {
      closed = true;
      for (const entry of [...registry.values()]) {
        await entry.store.close();
      }
      registry.clear();
    },

    async open<TState, TEvents extends AgentStateEventSchemas>(
      definition: AgentStateDefinition<TState, TEvents>,
    ): Promise<AgentStateStore<TState, TEvents>> {
      if (closed) {
        throw new AgentStateError('store-closed', `State '${definition.id}' cannot open on a closed driver`);
      }
      if (definition.lifetime !== lifetime) {
        throw new AgentStateError(
          'lifetime-mismatch',
          `State '${definition.id}' declares lifetime '${definition.lifetime}' but this driver provides '${lifetime}'`,
        );
      }
      switch (lifetime) {
        case 'request':
          return createMemoryStore(definition, lifetime, now, () => undefined).store;
        case 'process': {
          const existing = registry.get(definition.id) as unknown as MemoryStoreEntry<TState, TEvents> | undefined;
          if (existing === undefined) {
            const created = createMemoryStore(definition, lifetime, now, () => registry.delete(definition.id));
            registry.set(definition.id, created as unknown as MemoryStoreEntry<unknown, AgentStateEventSchemas>);
            return created.store;
          }
          if (definition.version !== existing.internals.definition.version) {
            migrateOpenStore(existing.internals, definition, now);
          }
          return existing.store;
        }
        default: {
          const unreachable: never = lifetime;
          throw new AgentStateError('invalid-definition', `Unknown volatile lifetime ${String(unreachable)}`);
        }
      }
    },
  });
};
