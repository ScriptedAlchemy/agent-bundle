import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// node:sqlite emits an ExperimentalWarning on load (documented in the README):
// the module is Node's built-in SQLite binding, stable enough for Node >= 22.13
// without flags, and G3 chose it precisely because it adds zero dependencies.
// This import lives behind the dedicated `./state/sqlite` subpath so volatile
// state users and stateless projects never load it or see the warning.
import { DatabaseSync } from 'node:sqlite';

import type {
  AgentStateChangeBatch,
  AgentStateChangesOptions,
  AgentStateCommitResult,
  AgentStateDefinition,
  AgentStateDispatchOptions,
  AgentStateDriver,
  AgentStateEventSchemas,
  AgentStateJournalRecord,
  AgentStateReadOptions,
  AgentStateResetOptions,
  AgentStateSnapshot,
  AgentStateStore,
} from './index.js';
import {
  AgentStateError,
  applyStateEvent,
  canonicalCommitInput,
  canonicalJson,
  changeFromJournalRecord,
  deepFreezeJson,
  describeSchemaIssues,
  expectIdempotencyKey,
  migrationIdempotencyKey,
  replayJournal,
  resolveResetState,
  runStateMigrations,
} from './index.js';

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
 */

const KERNEL_FORMAT = 1;

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
  readonly errcode?: number;
  readonly errstr?: string;
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const SQLITE_BUSY = 5;

const mapSqliteError = (definitionId: string, action: string, error: unknown): AgentStateError => {
  if (error instanceof AgentStateError) return error;
  const shape = error as SqliteErrorShape;
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
  readonly revision: number;
  readonly state: string | null;
  readonly to_version: number | null;
}

const recordFromRow = (definitionId: string, row: JournalRow): AgentStateJournalRecord => {
  const base = { committedAt: row.committed_at, idempotencyKey: row.idempotency_key, revision: row.revision };
  if (row.kind === 'event' && row.name !== null && row.payload !== null) {
    return { ...base, kind: 'event', name: row.name, payload: parseStoredJson(definitionId, 'payload', row.revision, row.payload) };
  }
  if (row.kind === 'reset' && row.state !== null) {
    return { ...base, kind: 'reset', state: parseStoredJson(definitionId, 'state', row.revision, row.state) };
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

const sanitizedFileName = (definitionId: string): string =>
  `${definitionId.replace(/[^a-zA-Z0-9._-]+/gu, '-')}-${Buffer.from(definitionId, 'utf8').toString('hex').slice(0, 12)}.sqlite`;

class SqliteStore<TState, TEvents extends AgentStateEventSchemas> implements AgentStateStore<TState, TEvents> {
  readonly location: string;
  #closed = false;
  readonly #db: DatabaseSync;
  #definition: AgentStateDefinition<TState, TEvents>;
  readonly #now: () => Date;
  readonly #onClose: () => void;

  constructor(
    definition: AgentStateDefinition<TState, TEvents>,
    db: DatabaseSync,
    file: string,
    now: () => Date,
    onClose: () => void,
  ) {
    this.#definition = definition;
    this.#db = db;
    this.location = file;
    this.#now = now;
    this.#onClose = onClose;
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
  #transaction<T>(mode: 'read' | 'write', action: string, work: () => T): T {
    const id = this.#definition.id;
    try {
      this.#db.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
    } catch (error) {
      throw mapSqliteError(id, `${action}: begin`, error);
    }
    let result: T;
    try {
      result = work();
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // The connection is unusable; the original error carries the cause.
      }
      throw mapSqliteError(id, action, error);
    }
    try {
      this.#db.exec('COMMIT');
    } catch (error) {
      throw mapSqliteError(id, `${action}: commit`, error);
    }
    return result;
  }

  #headRow(action: string): { revision: number; state: string } {
    const row = this.#db.prepare('SELECT revision, state FROM agent_state_head WHERE id = 1').get() as
      | { revision: number; state: string }
      | undefined;
    if (row === undefined || !Number.isInteger(row.revision) || row.revision < 0) {
      throw new AgentStateError('corrupt', `State '${this.#definition.id}' head row is missing or invalid (${action})`);
    }
    return row;
  }

  #headState(action: string): AgentStateSnapshot<TState> {
    const row = this.#headRow(action);
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

  #journalRecords(upTo?: number): AgentStateJournalRecord[] {
    const rows = (
      upTo === undefined
        ? this.#db.prepare('SELECT * FROM agent_state_journal ORDER BY revision').all()
        : this.#db.prepare('SELECT * FROM agent_state_journal WHERE revision <= ? ORDER BY revision').all(upTo)
    ) as unknown as JournalRow[];
    return rows.map((row) => recordFromRow(this.#definition.id, row));
  }

  #latestMigrationRevision(): number {
    const row = this.#db
      .prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_state_journal WHERE kind = 'migrate'")
      .get() as { revision: number };
    return row.revision;
  }

  #committedByKey(key: string): AgentStateJournalRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM agent_state_journal WHERE idempotency_key = ?').get(key) as
      | JournalRow
      | undefined;
    return row === undefined ? undefined : recordFromRow(this.#definition.id, row);
  }

  #replayTo(revision: number): TState {
    const latestMigration = this.#latestMigrationRevision();
    if (latestMigration > revision) {
      throw new AgentStateError(
        'revision-unavailable',
        `State '${this.#definition.id}' revision ${String(revision)} predates the migration at revision ${String(latestMigration)}`,
      );
    }
    return replayJournal(this.#definition, this.#journalRecords(revision), revision);
  }

  #appendRecord(record: AgentStateJournalRecord, state: TState): AgentStateCommitResult<TState> {
    const stateText = canonicalJson(state);
    this.#db
      .prepare(
        'INSERT INTO agent_state_journal (revision, kind, name, payload, state, to_version, idempotency_key, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.revision,
        record.kind,
        record.kind === 'event' ? record.name : null,
        record.kind === 'event' ? canonicalJson(record.payload) : null,
        record.kind === 'event' ? null : stateText,
        record.kind === 'migrate' ? record.toVersion : null,
        record.idempotencyKey,
        record.committedAt,
      );
    this.#db.prepare('UPDATE agent_state_head SET revision = ?, state = ? WHERE id = 1').run(record.revision, stateText);
    return Object.freeze({ replayed: false, revision: record.revision, state });
  }

  #commit(
    input:
      | { readonly kind: 'event'; readonly name: string; readonly rawPayload: unknown }
      | { readonly kind: 'reset'; readonly seed: TState | undefined },
    options: AgentStateDispatchOptions | AgentStateResetOptions<TState>,
  ): AgentStateCommitResult<TState> {
    expectOperable(this.#closed, this.#definition.id, options.signal);
    const key = expectIdempotencyKey(options.idempotencyKey);
    expectRevisionShape(options.expectedRevision, `State '${this.#definition.id}' expectedRevision`);
    return this.#transaction('write', input.kind === 'event' ? `dispatch '${input.name}'` : 'reset', () => {
      const head = this.#headState('commit');
      const prepared =
        input.kind === 'event'
          ? ((): { canonicalInput: string; record: AgentStateJournalRecord; state: TState } => {
              const applied = applyStateEvent(this.#definition, head.state, input.name, input.rawPayload);
              const record: AgentStateJournalRecord = {
                committedAt: this.#now().toISOString(),
                idempotencyKey: key,
                kind: 'event',
                name: input.name,
                payload: applied.payload,
                revision: head.revision + 1,
              };
              return { canonicalInput: canonicalCommitInput(record), record, state: applied.state };
            })()
          : ((): { canonicalInput: string; record: AgentStateJournalRecord; state: TState } => {
              const state = resolveResetState(this.#definition, input.seed);
              const record: AgentStateJournalRecord = {
                committedAt: this.#now().toISOString(),
                idempotencyKey: key,
                kind: 'reset',
                revision: head.revision + 1,
                state,
              };
              return { canonicalInput: canonicalCommitInput(record), record, state };
            })();
      const committed = this.#committedByKey(key);
      if (committed !== undefined) {
        if (canonicalCommitInput(committed) !== prepared.canonicalInput) {
          throw new AgentStateError(
            'idempotency-conflict',
            `State '${this.#definition.id}' idempotency key was reused with a conflicting input`,
          );
        }
        return Object.freeze({ replayed: true, revision: committed.revision, state: this.#replayTo(committed.revision) });
      }
      if (options.expectedRevision !== undefined && options.expectedRevision !== head.revision) {
        throw new AgentStateError(
          'revision-conflict',
          `State '${this.#definition.id}' expected revision ${String(options.expectedRevision)} but the head is ${String(head.revision)}`,
        );
      }
      return this.#appendRecord(prepared.record, prepared.state);
    });
  }

  async dispatch<TName extends Extract<keyof TEvents, string>>(
    name: TName,
    payload: unknown,
    options: AgentStateDispatchOptions,
  ): Promise<AgentStateCommitResult<TState>> {
    return this.#commit({ kind: 'event', name, rawPayload: payload }, options);
  }

  async reset(options: AgentStateResetOptions<TState>): Promise<AgentStateCommitResult<TState>> {
    return this.#commit({ kind: 'reset', seed: options.seed }, options);
  }

  async read(options: AgentStateReadOptions = {}): Promise<AgentStateSnapshot<TState>> {
    expectOperable(this.#closed, this.#definition.id, options.signal);
    expectRevisionShape(options.revision, `State '${this.#definition.id}' revision`);
    return this.#transaction('read', 'read', () => {
      const head = this.#headState('read');
      if (options.revision === undefined || options.revision === head.revision) return head;
      if (options.revision > head.revision) {
        throw new AgentStateError(
          'revision-unavailable',
          `State '${this.#definition.id}' revision ${String(options.revision)} is beyond the head ${String(head.revision)}`,
        );
      }
      return Object.freeze({ revision: options.revision, state: this.#replayTo(options.revision) });
    });
  }

  async changes(options: AgentStateChangesOptions): Promise<AgentStateChangeBatch> {
    expectOperable(this.#closed, this.#definition.id, options.signal);
    if (options.afterRevision === undefined) {
      throw new AgentStateError('invalid-input', `State '${this.#definition.id}' changes require afterRevision`);
    }
    expectRevisionShape(options.afterRevision, `State '${this.#definition.id}' afterRevision`);
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new AgentStateError('invalid-input', `State '${this.#definition.id}' changes limit must be an integer >= 1`);
    }
    return this.#transaction('read', 'changes', () => {
      const head = this.#headRow('changes');
      const rows = this.#db
        .prepare('SELECT * FROM agent_state_journal WHERE revision > ? ORDER BY revision LIMIT ?')
        .all(options.afterRevision, options.limit ?? -1) as unknown as JournalRow[];
      const changes = rows.map((row) => changeFromJournalRecord(recordFromRow(this.#definition.id, row)));
      return Object.freeze({ changes: Object.freeze(changes), headRevision: head.revision });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch {
      // Closing an already-broken connection must not mask the caller's path.
    }
    this.#onClose();
  }

  /** Opens the database schema, verifies identity, and runs due migrations. */
  initialize(): void {
    this.#transaction('write', 'open', () => {
      this.#db.exec(`
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
          to_version INTEGER,
          idempotency_key TEXT NOT NULL UNIQUE,
          committed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_state_head (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL,
          state TEXT NOT NULL
        );
      `);
      const definition = this.#definition;
      const meta = this.#db
        .prepare('SELECT definition_id, schema_version, kernel_format FROM agent_state_meta WHERE id = 1')
        .get() as { definition_id: string; kernel_format: number; schema_version: number } | undefined;
      if (meta === undefined) {
        this.#db
          .prepare('INSERT INTO agent_state_meta (id, definition_id, schema_version, kernel_format) VALUES (1, ?, ?, ?)')
          .run(definition.id, definition.version, KERNEL_FORMAT);
        this.#db
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
      if (meta.kernel_format !== KERNEL_FORMAT) {
        throw new AgentStateError(
          'corrupt',
          `State '${definition.id}' storage uses kernel format ${String(meta.kernel_format)}; this kernel reads format ${String(KERNEL_FORMAT)}`,
        );
      }
      const head = this.#headRow('open');
      const journalHead = (
        this.#db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_state_journal').get() as {
          revision: number;
        }
      ).revision;
      if (head.revision !== journalHead) {
        throw new AgentStateError(
          'corrupt',
          `State '${definition.id}' head revision ${String(head.revision)} does not match the journal head ${String(journalHead)}`,
        );
      }
      if (meta.schema_version === definition.version) return;
      const rawHead = parseStoredJson(definition.id, 'head state', head.revision, head.state);
      const migrated = runStateMigrations(definition, meta.schema_version, rawHead);
      const record: AgentStateJournalRecord = {
        committedAt: this.#now().toISOString(),
        idempotencyKey: migrationIdempotencyKey(definition.version),
        kind: 'migrate',
        revision: head.revision + 1,
        state: migrated,
        toVersion: definition.version,
      };
      this.#appendRecord(record, migrated);
      this.#db.prepare('UPDATE agent_state_meta SET schema_version = ? WHERE id = 1').run(definition.version);
    });
  }
}

export const createSqliteStateDriver = (options: SqliteStateDriverOptions): AgentStateDriver => {
  if ((options.root === undefined) === (options.file === undefined)) {
    throw new AgentStateError('invalid-input', 'Sqlite state drivers require exactly one of root or file');
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1) {
    throw new AgentStateError('invalid-input', 'busyTimeoutMs must be an integer >= 1');
  }
  const now = options.now ?? ((): Date => new Date());
  const openStores = new Set<SqliteStore<unknown, AgentStateEventSchemas>>();
  let closed = false;

  return Object.freeze({
    durable: true,
    kind: 'sqlite',
    lifetime: 'workspace-durable' as const,

    async close(): Promise<void> {
      closed = true;
      for (const store of [...openStores]) {
        await store.close();
      }
      openStores.clear();
    },

    async open<TState, TEvents extends AgentStateEventSchemas>(
      definition: AgentStateDefinition<TState, TEvents>,
    ): Promise<AgentStateStore<TState, TEvents>> {
      if (closed) {
        throw new AgentStateError('store-closed', `State '${definition.id}' cannot open on a closed driver`);
      }
      if (definition.lifetime !== 'workspace-durable') {
        throw new AgentStateError(
          'lifetime-mismatch',
          `State '${definition.id}' declares lifetime '${definition.lifetime}' but this driver provides 'workspace-durable'`,
        );
      }
      const file = resolve(
        options.file !== undefined ? options.file : join(options.root as string, sanitizedFileName(definition.id)),
      );
      let db: DatabaseSync;
      try {
        mkdirSync(dirname(file), { recursive: true });
        db = new DatabaseSync(file);
      } catch (error) {
        throw mapSqliteError(definition.id, 'open database', error);
      }
      let store: SqliteStore<TState, TEvents>;
      try {
        // busy_timeout first: switching journal modes takes the database
        // lock, and two processes racing the very first open would otherwise
        // fail SQLITE_BUSY with a zero retry budget.
        db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
        db.exec('PRAGMA journal_mode = WAL');
        db.exec('PRAGMA synchronous = FULL');
        store = new SqliteStore(definition, db, file, now, () =>
          openStores.delete(store as unknown as SqliteStore<unknown, AgentStateEventSchemas>),
        );
        store.initialize();
      } catch (error) {
        try {
          db.close();
        } catch {
          // Preserve the initialization failure.
        }
        throw mapSqliteError(definition.id, 'initialize storage', error);
      }
      openStores.add(store as unknown as SqliteStore<unknown, AgentStateEventSchemas>);
      return store;
    },
  });
};
