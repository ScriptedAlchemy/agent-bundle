import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// node:sqlite emits an ExperimentalWarning on load (documented in the README):
// the module is Node's built-in SQLite binding, stable enough for Node >= 22.13
// without flags, and G3 chose it precisely because it adds zero dependencies.
// This import lives behind the dedicated `./state/sqlite` subpath so volatile
// state users and stateless projects never load it or see the warning.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  Context,
  Effect,
  Exit,
  Layer,
} from 'effect';

import {
  makeScopedEffectRuntime,
  runPromise,
  type ScopedEffectRuntime,
} from '../effect/boundary.js';
import type {
  AgentStateChangeBatch,
  AgentStateChangesOptions,
  AgentStateCommitResult,
  AgentStateCompactOptions,
  AgentStateCompactResult,
  AgentStateDefinition,
  AgentStateDispatchOptions,
  AgentStateDriver,
  AgentStateEventSchemas,
  AgentStateInspectOptions,
  AgentStateJournalInspection,
  AgentStateJournalRecord,
  AgentStateReadOptions,
  AgentStateResetOptions,
  AgentStateSnapshot,
  AgentStateStore,
} from './index.js';
import {
  AgentStateError,
  canonicalCommitInput,
  canonicalJson,
  changeFromJournalRecord,
  compactionIdempotencyKey,
  deepFreezeJson,
  describeSchemaIssues,
  expectCommitWithinBudgets,
  expectConsistentJournal,
  expectIdempotencyKey,
  expectMigrationWithinStateBudget,
  inspectJournalRecords,
  isCompactionIdempotencyKey,
  journalIsCompactable,
  migrationIdempotencyKey,
  parseEventPayload,
  reduceStateEvent,
  replayJournal,
  resolveResetState,
  runStateMigrations,
} from './index.js';
import { expectOperable, expectRevisionShape } from './contract.js';
import { createPendingOpenTracker } from './pending-opens.js';

/**
 * Workspace-durable state driver on `node:sqlite` (#98, G3).
 *
 * One SQLite database file per state instance holds the journal (monotonic
 * revisions, unique idempotency keys), the materialized head, and the
 * persisted definition identity/version. Durability discipline:
 *
 * - WAL journal mode with `synchronous = FULL`, so a killed writer can lose
 *   at most an uncommitted transaction — never a committed one, and never
 *   leave a half-applied commit (the cross-process kill test pins this).
 * - Every mutation runs inside one `BEGIN IMMEDIATE` transaction: the
 *   idempotency lookup, compare-and-swap, reducer, journal append, and head
 *   update commit atomically; cross-process writers serialize on SQLite's
 *   file lock with a bounded busy timeout.
 * - Corruption fails closed: SQLite-level corruption, journal/head revision
 *   mismatches, unreadable rows, or a head state that no longer satisfies
 *   the schema surface as typed `corrupt` errors, never repaired silently.
 * - Explicit migrations run on open inside the same transactional discipline
 *   and rebase history (older exact revisions become `revision-unavailable`).
 *
 * Subscriptions are polling change cursors only; nothing stronger is
 * promised from short-lived processes.
 *
 * Kernel formats: format 1 stores are never compacted; the first compaction
 * moves a store to format 2, whose journal may start at a `compact` baseline
 * and whose `agent_state_pruned_keys` table remembers the idempotency keys of
 * deleted records. A format-1 kernel therefore refuses a compacted store with
 * a typed `corrupt` error instead of misreading its truncated journal.
 */

const KERNEL_FORMAT = 1;
const COMPACTED_KERNEL_FORMAT = 2;
const READABLE_KERNEL_FORMATS: readonly number[] = Object.freeze([KERNEL_FORMAT, COMPACTED_KERNEL_FORMAT]);

export interface SqliteStateDriverOptions {
  /**
   * SQLite lock wait budget per operation in milliseconds (default 5000).
   * Contending cross-process writers queue on the database lock for at most
   * this long before the operation fails typed `unavailable`.
   */
  readonly busyTimeoutMs?: number;
  /**
   * Exact database file for a single state instance (the store's isolated
   * root). Mutually exclusive with `root`; opening a second definition id on
   * the same file is a typed `corrupt` mismatch.
   */
  readonly file?: string;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /**
   * Directory that isolates one state root: each definition id gets its own
   * database file inside it. Mutually exclusive with `file`.
   */
  readonly root?: string;
}

interface SqliteErrorShape {
  readonly code?: string;
  readonly errcode?: number;
  readonly errstr?: string;
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_BUSY = 5;

const mapSqliteError = (
  definitionId: string,
  action: string,
  error: unknown,
  mapSystemError: boolean,
): AgentStateError | undefined => {
  if (error instanceof AgentStateError) return error;
  const shape = error as SqliteErrorShape;
  const sqliteError =
    typeof shape?.errcode === 'number'
    || (typeof shape?.code === 'string' && shape.code.startsWith('ERR_SQLITE'));
  if (!sqliteError && !(mapSystemError && typeof shape?.code === 'string')) {
    return undefined;
  }
  const detail = typeof shape.errstr === 'string' ? `: ${shape.errstr}` : '';
  if (shape.errcode === SQLITE_CORRUPT || shape.errcode === SQLITE_NOTADB) {
    return new AgentStateError(
      'corrupt',
      `State '${definitionId}' storage is corrupt (${action}${detail})`,
      { cause: error },
    );
  }
  if (shape.errcode === SQLITE_BUSY) {
    return new AgentStateError(
      'unavailable',
      `State '${definitionId}' storage stayed locked beyond the busy timeout (${action})`,
      { cause: error },
    );
  }
  return new AgentStateError(
    'unavailable',
    `State '${definitionId}' storage failed (${action}${detail})`,
    { cause: error },
  );
};

const sqliteEffect = <A>(
  definitionId: string,
  action: string,
  evaluate: () => A,
  mapSystemError = false,
): Effect.Effect<A, AgentStateError> =>
  Effect.try({
    catch: (error) => error,
    try: evaluate,
  }).pipe(
    Effect.catch((error) => {
      const mapped = mapSqliteError(definitionId, action, error, mapSystemError);
      return mapped === undefined
        ? Effect.die(error)
        : Effect.fail(mapped);
    }),
  );

const parseStoredJson = (definitionId: string, column: string, revision: number, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AgentStateError(
      'corrupt',
      `State '${definitionId}' journal ${column} at revision ${String(revision)} is not valid JSON`,
      { cause: error },
    );
  }
};

interface JournalRow {
  readonly committed_at: string;
  readonly idempotency_key: string;
  readonly kind: string;
  readonly name: string | null;
  readonly payload: string | null;
  readonly result_state: string | null;
  readonly revision: number;
  readonly state: string | null;
  readonly to_version: number | null;
}

/**
 * Compaction baselines are stored under the `reset` row kind (the journal
 * table's kind constraint predates them) and told apart by their kernel-owned
 * idempotency key, which no caller can mint.
 */
const storedKind = (record: AgentStateJournalRecord): 'event' | 'migrate' | 'reset' =>
  record.kind === 'compact' ? 'reset' : record.kind;

const recordFromRow = (definitionId: string, row: JournalRow): AgentStateJournalRecord => {
  const base = { committedAt: row.committed_at, idempotencyKey: row.idempotency_key, revision: row.revision };
  if (row.kind === 'event' && row.name !== null && row.payload !== null) {
    return { ...base, kind: 'event', name: row.name, payload: parseStoredJson(definitionId, 'payload', row.revision, row.payload) };
  }
  if (row.kind === 'reset' && row.state !== null) {
    const state = parseStoredJson(definitionId, 'state', row.revision, row.state);
    return isCompactionIdempotencyKey(row.idempotency_key)
      ? { ...base, kind: 'compact', state }
      : { ...base, kind: 'reset', state };
  }
  if (row.kind === 'migrate' && row.state !== null && row.to_version !== null) {
    return {
      ...base,
      kind: 'migrate',
      state: parseStoredJson(definitionId, 'state', row.revision, row.state),
      toVersion: row.to_version,
    };
  }
  throw new AgentStateError(
    'corrupt',
    `State '${definitionId}' journal row at revision ${String(row.revision)} has an invalid shape`,
  );
};

// The readable prefix is lossy (distinct ids can sanitize identically), so a
// hash of the complete id disambiguates; truncating an encoding of only the
// leading bytes would collide for ids sharing a prefix.
const sanitizedFileName = (definitionId: string): string =>
  `${definitionId.replace(/[^a-zA-Z0-9._-]+/gu, '-')}-${createHash('sha256').update(definitionId, 'utf8').digest('hex').slice(0, 16)}.sqlite`;

const legacySanitizedFileName = (definitionId: string): string =>
  `${definitionId.replace(/[^a-zA-Z0-9._-]+/gu, '-')}-${Buffer.from(definitionId, 'utf8').toString('hex').slice(0, 12)}.sqlite`;

class SqliteConnection extends Context.Service<SqliteConnection, DatabaseSync>()(
  '@agent-bundle/runtime/state/SqliteConnection',
) {}

class SqliteStore<TState, TEvents extends AgentStateEventSchemas> implements AgentStateStore<TState, TEvents> {
  readonly location: string;
  #closed = false;
  #definition: AgentStateDefinition<TState, TEvents>;
  readonly #now: () => Date;
  readonly #onClose: () => void;
  readonly #runtime: ScopedEffectRuntime<SqliteConnection>;
  /** Statement cache: the schema is fixed after open, so entries never go stale. */
  readonly #statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

  constructor(
    definition: AgentStateDefinition<TState, TEvents>,
    file: string,
    now: () => Date,
    onClose: () => void,
    runtime: ScopedEffectRuntime<SqliteConnection>,
  ) {
    this.#definition = definition;
    this.location = file;
    this.#now = now;
    this.#onClose = onClose;
    this.#runtime = runtime;
  }

  get definition(): AgentStateDefinition<TState, TEvents> {
    return this.#definition;
  }

  /**
   * Runs `work` inside one transaction, mapping storage failures to typed
   * errors. Writes take BEGIN IMMEDIATE (cross-process serialization on the
   * database lock); reads take a deferred snapshot transaction, which WAL
   * never blocks on writers.
   */
  #transaction<T>(
    mode: 'read' | 'write',
    action: string,
    work: (db: DatabaseSync) => T,
  ): Effect.Effect<T, AgentStateError, SqliteConnection> {
    const id = this.#definition.id;
    return Effect.gen(function*() {
      const db = yield* SqliteConnection;
      return yield* Effect.acquireUseRelease(
        sqliteEffect(id, `${action}: begin`, () => {
          db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
          return db;
        }),
        () => sqliteEffect(id, action, () => work(db)),
        (connection, exit) => {
          const rollback = sqliteEffect(id, `${action}: rollback`, () => {
            connection.exec('ROLLBACK');
          });
          if (Exit.isFailure(exit)) return rollback;
          return sqliteEffect(id, `${action}: commit`, () => {
            connection.exec('COMMIT');
          }).pipe(
            Effect.catch((commitError) =>
              rollback.pipe(
                Effect.andThen(Effect.fail(commitError)),
              ),
            ),
          );
        },
      );
    });
  }

  #prepare(db: DatabaseSync, sql: string): StatementSync {
    let cache = this.#statements.get(db);
    if (cache === undefined) {
      cache = new Map();
      this.#statements.set(db, cache);
    }
    let statement = cache.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  }

  #headRow(db: DatabaseSync, action: string): { revision: number; state: string } {
    const row = this.#prepare(db, 'SELECT revision, state FROM agent_state_head WHERE id = 1').get() as
      | { revision: number; state: string }
      | undefined;
    if (row === undefined || !Number.isInteger(row.revision) || row.revision < 0) {
      throw new AgentStateError('corrupt', `State '${this.#definition.id}' head row is missing or invalid (${action})`);
    }
    return row;
  }

  #headState(db: DatabaseSync, action: string): AgentStateSnapshot<TState> {
    const row = this.#headRow(db, action);
    const raw = parseStoredJson(this.#definition.id, 'head state', row.revision, row.state);
    const parsed = this.#definition.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentStateError(
        'corrupt',
        `State '${this.#definition.id}' head state no longer satisfies the schema: ${describeSchemaIssues(parsed.error)}`,
      );
    }
    return Object.freeze({ revision: row.revision, state: deepFreezeJson(parsed.data) });
  }

  #journalRecords(db: DatabaseSync, upTo?: number): AgentStateJournalRecord[] {
    const rows = (
      upTo === undefined
        ? this.#prepare(db, 'SELECT * FROM agent_state_journal ORDER BY revision').all()
        : this.#prepare(db, 'SELECT * FROM agent_state_journal WHERE revision <= ? ORDER BY revision').all(upTo)
    ) as unknown as JournalRow[];
    return rows.map((row) => recordFromRow(this.#definition.id, row));
  }

  #latestMigrationRevision(db: DatabaseSync): number {
    const row = this
      .#prepare(db, "SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_state_journal WHERE kind = 'migrate'")
      .get() as { revision: number };
    return row.revision;
  }

  #committedByKey(
    db: DatabaseSync,
    key: string,
  ):
    | { readonly kind: 'committed'; readonly record: AgentStateJournalRecord; readonly resultStateText: string | null }
    | { readonly canonicalInput: string; readonly kind: 'pruned'; readonly revision: number }
    | undefined {
    const row = this.#prepare(db, 'SELECT * FROM agent_state_journal WHERE idempotency_key = ?').get(key) as
      | JournalRow
      | undefined;
    if (row !== undefined) {
      return { kind: 'committed', record: recordFromRow(this.#definition.id, row), resultStateText: row.result_state ?? row.state };
    }
    const pruned = this
      .#prepare(db, 'SELECT revision, canonical_input FROM agent_state_pruned_keys WHERE idempotency_key = ?')
      .get(key) as { canonical_input: string; revision: number } | undefined;
    return pruned === undefined
      ? undefined
      : { canonicalInput: pruned.canonical_input, kind: 'pruned', revision: pruned.revision };
  }

  /**
   * Recovers the state a committed record produced. Every record stores its
   * post-commit state (migrated forward on schema migrations), so replay
   * does not depend on exact-revision history; rows written before post-
   * commit states were stored fall back to journal replay.
   */
  #committedState(
    db: DatabaseSync,
    committed: { readonly kind: 'committed'; readonly record: AgentStateJournalRecord; readonly resultStateText: string | null },
  ): TState {
    const raw =
      committed.resultStateText !== null
        ? parseStoredJson(this.#definition.id, 'result state', committed.record.revision, committed.resultStateText)
        : this.#replayTo(db, committed.record.revision);
    const parsed = this.#definition.schema.safeParse(raw);
    if (!parsed.success) {
      throw new AgentStateError(
        'corrupt',
        `State '${this.#definition.id}' committed result at revision ${String(committed.record.revision)} no longer satisfies the schema: ${describeSchemaIssues(parsed.error)}`,
      );
    }
    return deepFreezeJson(parsed.data);
  }

  #replayTo(db: DatabaseSync, revision: number): TState {
    const latestMigration = this.#latestMigrationRevision(db);
    if (latestMigration > revision) {
      throw new AgentStateError(
        'revision-unavailable',
        `State '${this.#definition.id}' revision ${String(revision)} predates the migration at revision ${String(latestMigration)}`,
      );
    }
    // The records below a compaction baseline no longer exist, so the filtered
    // read below would otherwise replay the initial state for them.
    const first = this
      .#prepare(db, 'SELECT revision, idempotency_key FROM agent_state_journal ORDER BY revision LIMIT 1')
      .get() as { idempotency_key: string; revision: number } | undefined;
    if (first !== undefined && isCompactionIdempotencyKey(first.idempotency_key) && revision < first.revision) {
      throw new AgentStateError(
        'revision-unavailable',
        `State '${this.#definition.id}' revision ${String(revision)} predates the compaction at revision ${String(first.revision)}`,
      );
    }
    return replayJournal(this.#definition, this.#journalRecords(db, revision), revision);
  }

  #appendRecord(
    db: DatabaseSync,
    record: AgentStateJournalRecord,
    state: TState,
    stateText: string,
  ): AgentStateCommitResult<TState> {
    this
      .#prepare(
        db,
        'INSERT INTO agent_state_journal (revision, kind, name, payload, state, result_state, to_version, idempotency_key, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.revision,
        storedKind(record),
        record.kind === 'event' ? record.name : null,
        record.kind === 'event' ? canonicalJson(record.payload) : null,
        // Event rows store their post-commit state too, so idempotent replay
        // survives migrations without exact-revision replay.
        stateText,
        stateText,
        record.kind === 'migrate' ? record.toVersion : null,
        record.idempotencyKey,
        record.committedAt,
      );
    this.#prepare(db, 'UPDATE agent_state_head SET revision = ?, state = ? WHERE id = 1').run(record.revision, stateText);
    return Object.freeze({ replayed: false, revision: record.revision, state });
  }

  #commit(
    input:
      | { readonly kind: 'event'; readonly name: string; readonly rawPayload: unknown }
      | { readonly kind: 'reset'; readonly seed: TState | undefined },
    options: AgentStateDispatchOptions | AgentStateResetOptions<TState>,
  ): Effect.Effect<AgentStateCommitResult<TState>, AgentStateError, SqliteConnection> {
    const definition = this.#definition;
    const now = this.#now;
    // Validation and canonicalization happen before the reducer and before
    // any storage access: a committed key must replay its stored result even
    // when the reducer would fail against the current head.
    type PreparedCommit =
      | { readonly canonicalInput: string; readonly kind: 'event'; readonly name: string; readonly payload: unknown }
      | { readonly canonicalInput: string; readonly kind: 'reset'; readonly state: TState };
    const validate = sqliteEffect(
      definition.id,
      'validate commit',
      (): { key: string; prepared: PreparedCommit; startedAtMs: number } => {
        expectOperable(this.#closed, definition.id, options.signal);
        const startedAtMs = now().getTime();
        expectRevisionShape(options.expectedRevision, `State '${definition.id}' expectedRevision`);
        const key = expectIdempotencyKey(options.idempotencyKey);
        if (input.kind === 'event') {
          const payload = parseEventPayload(definition, input.name, input.rawPayload);
          const canonicalInput = canonicalCommitInput({
            committedAt: '',
            idempotencyKey: key,
            kind: 'event',
            name: input.name,
            payload,
            revision: 0,
          });
          return { key, prepared: { canonicalInput, kind: 'event', name: input.name, payload }, startedAtMs };
        }
        const state = resolveResetState(definition, input.seed);
        const canonicalInput = canonicalCommitInput({
          committedAt: '',
          idempotencyKey: key,
          kind: 'reset',
          revision: 0,
          state,
        });
        return { key, prepared: { canonicalInput, kind: 'reset', state }, startedAtMs };
      },
    );
    return Effect.gen({ self: this }, function* (this: SqliteStore<TState, TEvents>) {
      const { key, prepared, startedAtMs } = yield* validate;
      return yield* this.#transaction('write', input.kind === 'event' ? `dispatch '${input.name}'` : 'reset', (db) => {
        const committed = this.#committedByKey(db, key);
        if (committed !== undefined) {
          const committedInput = committed.kind === 'committed'
            ? canonicalCommitInput(committed.record)
            : committed.canonicalInput;
          if (committedInput !== prepared.canonicalInput) {
            throw new AgentStateError(
              'idempotency-conflict',
              `State '${definition.id}' idempotency key was reused with a conflicting input`,
            );
          }
          if (committed.kind === 'pruned') {
            throw new AgentStateError(
              'revision-unavailable',
              `State '${definition.id}' idempotency key committed at revision ${String(committed.revision)}, which compaction pruned; its result is no longer available`,
            );
          }
          return Object.freeze({
            replayed: true,
            revision: committed.record.revision,
            state: this.#committedState(db, committed),
          });
        }
        const head = this.#headState(db, 'commit');
        if (options.expectedRevision !== undefined && options.expectedRevision !== head.revision) {
          throw new AgentStateError(
            'revision-conflict',
            `State '${definition.id}' expected revision ${String(options.expectedRevision)} but the head is ${String(head.revision)}`,
          );
        }
        switch (prepared.kind) {
          case 'event': {
            const state = reduceStateEvent(definition, head.state, prepared.name, prepared.payload);
            const stateText = canonicalJson(state);
            const committedAt = now();
            expectCommitWithinBudgets(definition, {
              headRevision: head.revision,
              kind: 'event',
              nowMs: committedAt.getTime(),
              startedAtMs,
              stateText,
            });
            return this.#appendRecord(
              db,
              {
                committedAt: committedAt.toISOString(),
                idempotencyKey: key,
                kind: 'event',
                name: prepared.name,
                payload: prepared.payload,
                revision: head.revision + 1,
              },
              state,
              stateText,
            );
          }
          case 'reset': {
            const stateText = canonicalJson(prepared.state);
            const committedAt = now();
            expectCommitWithinBudgets(definition, {
              headRevision: head.revision,
              kind: 'reset',
              nowMs: committedAt.getTime(),
              startedAtMs,
              stateText,
            });
            return this.#appendRecord(
              db,
              {
                committedAt: committedAt.toISOString(),
                idempotencyKey: key,
                kind: 'reset',
                revision: head.revision + 1,
                state: prepared.state,
              },
              prepared.state,
              stateText,
            );
          }
          default: {
            const unreachable: never = prepared;
            throw new AgentStateError('invalid-input', `Unknown commit kind ${String(unreachable)}`);
          }
        }
      });
    });
  }

  #run<A>(effect: Effect.Effect<A, AgentStateError, SqliteConnection>): Promise<A> {
    return this.#closed
      ? Promise.reject(new AgentStateError('store-closed', `State '${this.#definition.id}' store is closed`))
      : this.#runtime.run(effect);
  }

  dispatch<TName extends Extract<keyof TEvents, string>>(
    name: TName,
    payload: unknown,
    options: AgentStateDispatchOptions,
  ): Promise<AgentStateCommitResult<TState>> {
    return this.#run(this.#commit({ kind: 'event', name, rawPayload: payload }, options));
  }

  reset(options: AgentStateResetOptions<TState>): Promise<AgentStateCommitResult<TState>> {
    return this.#run(this.#commit({ kind: 'reset', seed: options.seed }, options));
  }

  /**
   * Compaction runs inside one `BEGIN IMMEDIATE` transaction like every other
   * mutation: the baseline insert, the pruned-key bookkeeping, the delete, the
   * head update, and the kernel-format bump commit together or not at all, so
   * a process killed mid-compaction leaves either the full journal or the
   * compacted one — never a journal missing records its head still needs.
   * Concurrent writers in other processes serialize on the database lock and
   * observe the compacted journal on their next transaction.
   */
  compact(options: AgentStateCompactOptions = {}): Promise<AgentStateCompactResult<TState>> {
    const definition = this.#definition;
    const now = this.#now;
    return this.#run(
      sqliteEffect(definition.id, 'validate compact', () => {
        expectOperable(this.#closed, definition.id, options.signal);
        expectRevisionShape(options.expectedRevision, `State '${definition.id}' expectedRevision`);
      }).pipe(
        Effect.andThen(
          this.#transaction('write', 'compact', (db) => {
            const head = this.#headState(db, 'compact');
            if (options.expectedRevision !== undefined && options.expectedRevision !== head.revision) {
              throw new AgentStateError(
                'revision-conflict',
                `State '${definition.id}' expected revision ${String(options.expectedRevision)} but the head is ${String(head.revision)}`,
              );
            }
            const records = this.#journalRecords(db);
            if (!journalIsCompactable(records)) {
              return Object.freeze({
                baselineRevision: records[0]?.revision ?? head.revision,
                prunedRecords: 0,
                revision: head.revision,
                state: head.state,
              });
            }
            const remember = this.#prepare(
              db,
              'INSERT OR REPLACE INTO agent_state_pruned_keys (idempotency_key, revision, canonical_input) VALUES (?, ?, ?)',
            );
            for (const record of records) {
              remember.run(record.idempotencyKey, record.revision, canonicalCommitInput(record));
            }
            this.#prepare(db, 'DELETE FROM agent_state_journal WHERE revision <= ?').run(head.revision);
            const stateText = canonicalJson(head.state);
            const baseline: AgentStateJournalRecord = {
              committedAt: now().toISOString(),
              idempotencyKey: compactionIdempotencyKey(head.revision + 1),
              kind: 'compact',
              revision: head.revision + 1,
              state: head.state,
            };
            const committed = this.#appendRecord(db, baseline, head.state, stateText);
            this.#prepare(db, 'UPDATE agent_state_meta SET kernel_format = ? WHERE id = 1').run(COMPACTED_KERNEL_FORMAT);
            return Object.freeze({
              baselineRevision: baseline.revision,
              prunedRecords: records.length,
              revision: committed.revision,
              state: committed.state,
            });
          }),
        ),
      ),
    );
  }

  inspect(options: AgentStateInspectOptions = {}): Promise<AgentStateJournalInspection> {
    const definition = this.#definition;
    return this.#run(
      sqliteEffect(definition.id, 'validate inspect', () => {
        expectOperable(this.#closed, definition.id, options.signal);
      }).pipe(
        Effect.andThen(
          this.#transaction('read', 'inspect', (db) => {
            const head = this.#headRow(db, 'inspect');
            const size = this
              .#prepare(
                db,
                'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(CAST(COALESCE(payload, \'\') AS BLOB)) + LENGTH(CAST(COALESCE(state, \'\') AS BLOB)) + LENGTH(CAST(COALESCE(result_state, \'\') AS BLOB))), 0) AS bytes FROM agent_state_journal',
              )
              .get() as { bytes: number; records: number };
            const first = this
              .#prepare(db, 'SELECT * FROM agent_state_journal ORDER BY revision LIMIT 1')
              .get() as JournalRow | undefined;
            // Only the first record decides the baseline and last compaction;
            // the count and bytes come from SQL so a large journal is never
            // materialized to inspect it.
            const summary = inspectJournalRecords(
              first === undefined ? [] : [recordFromRow(definition.id, first)],
              head.revision,
              size.bytes,
            );
            return Object.freeze({ ...summary, records: size.records });
          }),
        ),
      ),
    );
  }

  read(options: AgentStateReadOptions = {}): Promise<AgentStateSnapshot<TState>> {
    return this.#run(
      sqliteEffect(this.#definition.id, 'validate read', () => {
        expectOperable(this.#closed, this.#definition.id, options.signal);
        expectRevisionShape(options.revision, `State '${this.#definition.id}' revision`);
      }).pipe(
        Effect.andThen(
          this.#transaction('read', 'read', (db) => {
            const head = this.#headState(db, 'read');
            if (options.revision === undefined || options.revision === head.revision) return head;
            if (options.revision > head.revision) {
              throw new AgentStateError(
                'revision-unavailable',
                `State '${this.#definition.id}' revision ${String(options.revision)} is beyond the head ${String(head.revision)}`,
              );
            }
            return Object.freeze({ revision: options.revision, state: this.#replayTo(db, options.revision) });
          }),
        ),
      ),
    );
  }

  changes(options: AgentStateChangesOptions): Promise<AgentStateChangeBatch> {
    return this.#run(
      sqliteEffect(this.#definition.id, 'validate changes', () => {
        expectOperable(this.#closed, this.#definition.id, options.signal);
        if (options.afterRevision === undefined) {
          throw new AgentStateError('invalid-input', `State '${this.#definition.id}' changes require afterRevision`);
        }
        expectRevisionShape(options.afterRevision, `State '${this.#definition.id}' afterRevision`);
        if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
          throw new AgentStateError('invalid-input', `State '${this.#definition.id}' changes limit must be an integer >= 1`);
        }
      }).pipe(
        Effect.andThen(
          this.#transaction('read', 'changes', (db) => {
            const head = this.#headRow(db, 'changes');
            const rows = this
              .#prepare(db, 'SELECT * FROM agent_state_journal WHERE revision > ? ORDER BY revision LIMIT ?')
              .all(options.afterRevision, options.limit ?? -1) as unknown as JournalRow[];
            const changes = rows.map((row) => changeFromJournalRecord(recordFromRow(this.#definition.id, row)));
            return Object.freeze({ changes: Object.freeze(changes), headRevision: head.revision });
          }),
        ),
      ),
    );
  }

  close(): Promise<void> {
    if (this.#closed) return this.#runtime.close();
    this.#closed = true;
    this.#onClose();
    return this.#runtime.close();
  }

  /** Opens the database schema, verifies identity, and runs due migrations. */
  initialize(busyTimeoutMs: number): Promise<void> {
    const definitionId = this.#definition.id;
    const initializeStorage = this.#transaction('write', 'open', (transactionDb) => {
      transactionDb.exec(`
        CREATE TABLE IF NOT EXISTS agent_state_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          definition_id TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          kernel_format INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_state_journal (
          revision INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('event', 'reset', 'migrate')),
          name TEXT,
          payload TEXT,
          state TEXT,
          result_state TEXT,
          to_version INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          committed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_state_head (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL,
          state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_state_pruned_keys (
          idempotency_key TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          canonical_input TEXT NOT NULL
        );
      `);
      const journalColumns = transactionDb.prepare('PRAGMA table_info(agent_state_journal)').all() as unknown as {
        readonly name: string;
      }[];
      if (!journalColumns.some((column) => column.name === 'result_state')) {
        transactionDb.exec('ALTER TABLE agent_state_journal ADD COLUMN result_state TEXT');
      }
      const definition = this.#definition;
      const meta = transactionDb
        .prepare('SELECT definition_id, schema_version, kernel_format FROM agent_state_meta WHERE id = 1')
        .get() as { definition_id: string; kernel_format: number; schema_version: number } | undefined;
      if (meta === undefined) {
        transactionDb
          .prepare('INSERT INTO agent_state_meta (id, definition_id, schema_version, kernel_format) VALUES (1, ?, ?, ?)')
          .run(definition.id, definition.version, KERNEL_FORMAT);
        transactionDb
          .prepare('INSERT INTO agent_state_head (id, revision, state) VALUES (1, 0, ?)')
          .run(canonicalJson(definition.initial));
        return;
      }
      if (meta.definition_id !== definition.id) {
        throw new AgentStateError(
          'corrupt',
          `State '${definition.id}' storage at '${this.location}' belongs to definition '${meta.definition_id}'`,
        );
      }
      if (!READABLE_KERNEL_FORMATS.includes(meta.kernel_format)) {
        throw new AgentStateError(
          'corrupt',
          `State '${definition.id}' storage uses kernel format ${String(meta.kernel_format)}; this kernel reads formats ${READABLE_KERNEL_FORMATS.map(String).join(', ')}`,
        );
      }
      const head = this.#headRow(transactionDb, 'open');
      const rows = transactionDb
        .prepare('SELECT * FROM agent_state_journal ORDER BY revision')
        .all() as unknown as JournalRow[];
      const records = rows.map((row) => recordFromRow(definition.id, row));
      // Continuity first: a hand-deleted intermediate row must fail closed
      // even when the final revision is still present.
      expectConsistentJournal(definition.id, records);
      const journalHead = records.length === 0 ? 0 : (records[records.length - 1] as AgentStateJournalRecord).revision;
      if (head.revision !== journalHead) {
        throw new AgentStateError(
          'corrupt',
          `State '${definition.id}' head revision ${String(head.revision)} does not match the journal head ${String(journalHead)}`,
        );
      }
      const rawHead = parseStoredJson(definition.id, 'head state', head.revision, head.state);
      if (meta.schema_version === definition.version) {
        // The materialized head must agree with journal replay: a corrupt or
        // hand-edited head that still parses is otherwise served silently.
        const replayed = replayJournal(definition, records, head.revision);
        if (canonicalJson(replayed) !== canonicalJson(rawHead)) {
          throw new AgentStateError(
            'corrupt',
            `State '${definition.id}' head state at revision ${String(head.revision)} disagrees with journal replay`,
          );
        }
        return;
      }
      // A pending migration cannot replay records written under the older
      // definition; verify the head against the last stored post-commit
      // state instead (rows predating stored event states leave it null).
      const lastStateText = rows.length === 0 ? null : (rows[rows.length - 1] as JournalRow).state;
      if (lastStateText !== null) {
        const lastState = parseStoredJson(definition.id, 'state', journalHead, lastStateText);
        if (canonicalJson(lastState) !== canonicalJson(rawHead)) {
          throw new AgentStateError(
            'corrupt',
            `State '${definition.id}' head state at revision ${String(head.revision)} disagrees with the journal`,
          );
        }
      }
      const migrated = runStateMigrations(definition, meta.schema_version, rawHead);
      const migratedStateText = canonicalJson(migrated);
      expectMigrationWithinStateBudget(definition, migratedStateText);
      // Journal records retain the original commit input for dedupe. Their
      // committed results migrate separately, matching the memory driver's
      // `{ record, state }` split. A legacy journal-head result can be
      // recovered from the authoritative materialized head. Earlier missing
      // results cannot be reconstructed with the current-version reducer.
      const updateResult = transactionDb.prepare(
        'UPDATE agent_state_journal SET result_state = ? WHERE revision = ?',
      );
      for (const row of rows) {
        const storedResultText = row.result_state ?? row.state;
        let migratedResult: TState;
        if (storedResultText !== null) {
          const storedResult = parseStoredJson(definition.id, 'result state', row.revision, storedResultText);
          migratedResult = runStateMigrations(definition, meta.schema_version, storedResult);
        } else if (row.revision === journalHead) {
          migratedResult = migrated;
        } else {
          throw new AgentStateError(
            'migration-failure',
            `State '${definition.id}' legacy journal row at revision ${String(row.revision)} has no recoverable committed result; restore a compatible backup or materialize the result with the version ${String(meta.schema_version)} definition before migrating to version ${String(definition.version)}`,
          );
        }
        updateResult.run(canonicalJson(migratedResult), row.revision);
      }
      const record: AgentStateJournalRecord = {
        committedAt: this.#now().toISOString(),
        idempotencyKey: migrationIdempotencyKey(definition.version),
        kind: 'migrate',
        revision: head.revision + 1,
        state: migrated,
        toVersion: definition.version,
      };
      this.#appendRecord(transactionDb, record, migrated, migratedStateText);
      transactionDb.prepare('UPDATE agent_state_meta SET schema_version = ? WHERE id = 1').run(definition.version);
    });
    return this.#runtime.run(
      Effect.gen(function*() {
        const db = yield* SqliteConnection;
        yield* sqliteEffect(definitionId, 'configure storage', () => {
          // busy_timeout first: switching journal modes takes the database
          // lock, and two processes racing the very first open would otherwise
          // fail SQLITE_BUSY with a zero retry budget.
          db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
          db.exec('PRAGMA journal_mode = WAL');
          db.exec('PRAGMA synchronous = FULL');
        });
        yield* initializeStorage;
      }),
    );
  }
}

/** Generics-erased store type for the driver-wide open-store collection. */
type AnySqliteStore = SqliteStore<unknown, AgentStateEventSchemas>;

export const createSqliteStateDriver = (options: SqliteStateDriverOptions): AgentStateDriver => {
  if ((options.root === undefined) === (options.file === undefined)) {
    throw new AgentStateError('invalid-input', 'Sqlite state drivers require exactly one of root or file');
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1) {
    throw new AgentStateError('invalid-input', 'busyTimeoutMs must be an integer >= 1');
  }
  const now = options.now ?? ((): Date => new Date());
  const openStores = new Set<AnySqliteStore>();
  const pendingOpens = createPendingOpenTracker();
  let closed = false;
  let closing: Promise<void> | undefined;

  return Object.freeze({
    durable: true,
    kind: 'sqlite',
    lifetime: 'workspace-durable' as const,

    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        await pendingOpens.settle();
        const closeErrors: unknown[] = [];
        for (const store of [...openStores]) {
          try {
            await store.close();
          } catch (error) {
            closeErrors.push(error);
          }
        }
        openStores.clear();
        if (closeErrors.length > 0) throw closeErrors[0];
      })();
      return closing;
    },

    open<TState, TEvents extends AgentStateEventSchemas>(
      definition: AgentStateDefinition<TState, TEvents>,
    ): Promise<AgentStateStore<TState, TEvents>> {
      return pendingOpens.track(
        (async () => {
          const file = await runPromise(
            sqliteEffect(definition.id, 'resolve storage', () => {
              if (closed) {
                throw new AgentStateError('store-closed', `State '${definition.id}' cannot open on a closed driver`);
              }
              if (definition.lifetime !== 'workspace-durable') {
                throw new AgentStateError(
                  'lifetime-mismatch',
                  `State '${definition.id}' declares lifetime '${definition.lifetime}' but this driver provides 'workspace-durable'`,
                );
              }
              if (options.file !== undefined) return resolve(options.file);
              const root = options.root as string;
              const currentFile = resolve(join(root, sanitizedFileName(definition.id)));
              const legacyFile = resolve(join(root, legacySanitizedFileName(definition.id)));
              mkdirSync(dirname(currentFile), { recursive: true });
              if (!existsSync(currentFile) && existsSync(legacyFile)) {
                for (const suffix of ['-wal', '-shm']) {
                  const legacySidecar = `${legacyFile}${suffix}`;
                  if (!existsSync(legacySidecar)) continue;
                  try {
                    renameSync(legacySidecar, `${currentFile}${suffix}`);
                  } catch (error) {
                    // A concurrent adopter may have moved this sidecar after
                    // the existence check. Other failures must remain visible.
                    if ((error as SqliteErrorShape).code !== 'ENOENT') throw error;
                  }
                }
                try {
                  renameSync(legacyFile, currentFile);
                } catch (error) {
                  // Another opener may have atomically adopted the same
                  // legacy file after both observed it. The winner's current
                  // path is authoritative; otherwise preserve the failure.
                  if (!existsSync(currentFile)) throw error;
                }
              }
              return currentFile;
            }, true),
          );
          const connection = Effect.acquireRelease(
            sqliteEffect(definition.id, 'open database', () => {
              mkdirSync(dirname(file), { recursive: true });
              return new DatabaseSync(file);
            }, true),
            (db, exit) => {
              const close = sqliteEffect(definition.id, 'close database', () => {
                db.close();
              }, true);
              // Release finalizers are infallible by contract: a close failure
              // on the success path surfaces as a defect instead of being
              // silently swallowed, while a failing path keeps the original
              // failure as the cause.
              return Exit.isFailure(exit)
                ? close.pipe(Effect.catch(() => Effect.void))
                : close.pipe(Effect.orDie);
            },
          );
          const runtime = makeScopedEffectRuntime(
            Layer.effect(SqliteConnection, connection),
          );
          let store: SqliteStore<TState, TEvents>;
          try {
            store = new SqliteStore(definition, file, now, () =>
              openStores.delete(store as unknown as AnySqliteStore),
              runtime,
            );
            await store.initialize(busyTimeoutMs);
          } catch (error) {
            try {
              await runtime.close();
            } catch {
              // Initialization is the caller-visible failure. The scoped
              // finalizer still attempts close, but must not replace it.
            }
            throw error;
          }
          if (closed) {
            await store.close();
            throw new AgentStateError('store-closed', `State '${definition.id}' cannot open on a closed driver`);
          }
          openStores.add(store as unknown as AnySqliteStore);
          return store;
        })(),
      );
    },
  });
};
