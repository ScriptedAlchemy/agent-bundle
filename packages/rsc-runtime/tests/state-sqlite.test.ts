import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import {
  AgentStateError,
  defineState,
  stateDriverConformanceCases,
  type AgentStateDefinition,
  type AgentStateDriver,
  type AgentStateEventSchemas,
  type StateConformanceContext,
} from '../src/state/index.js';
import { createSqliteStateDriver } from '../src/state/sqlite.js';
import { removeTree } from '../../agent-bundle/tests/support/remove-tree.ts';

/**
 * The workspace-durable driver must pass the exact same conformance suite as
 * the in-memory driver — including the durable-only case the memory harness
 * skips — plus the storage-level behavior only a real database can express:
 * corruption fail-closed, definition identity pinning, and WAL mode.
 */

const withContext = async (run: (context: StateConformanceContext) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-state-sqlite-conformance-'));
  const drivers: AgentStateDriver[] = [];
  const driver = (): AgentStateDriver => {
    // Every open/reopen uses a fresh driver instance (a fresh connection):
    // "another instance" for a durable driver is a genuinely new client
    // over the same storage root.
    const created = createSqliteStateDriver({ root });
    drivers.push(created);
    return created;
  };
  try {
    await run({
      durable: true,
      lifetime: 'workspace-durable',
      open: (definition) => driver().open(definition),
      reopen: (definition) => driver().open(definition),
    });
  } finally {
    for (const created of drivers) {
      await created.close();
    }
    await removeTree(root);
  }
};

describe('sqlite driver conformance', () => {
  for (const conformanceCase of stateDriverConformanceCases) {
    it(conformanceCase.name, () => withContext((context) => conformanceCase.run(context)));
  }
});

const counterEvents = {
  bumped: z.object({ by: z.number().int() }).strict(),
} as const;

interface CounterState {
  readonly count: number;
}

const counterDefinition = (
  id = 'state-sqlite-test/counter',
): AgentStateDefinition<CounterState, typeof counterEvents> =>
  defineState({
    events: counterEvents,
    id,
    initial: { count: 0 },
    lifetime: 'workspace-durable',
    reduce: (state, event) => ({ count: state.count + event.payload.by }),
    schema: z.object({ count: z.number().int() }).strict(),
  });

const migratingCounterDefinition = (
  id = 'state-sqlite-test/migrating-counter',
): AgentStateDefinition<CounterState, typeof counterEvents> =>
  defineState({
    events: counterEvents,
    id,
    initial: { count: 0 },
    lifetime: 'workspace-durable',
    migrations: {
      2: (persisted) => ({ count: (persisted as CounterState).count * 10 }),
    },
    reduce: (state, event) => ({ count: state.count + event.payload.by }),
    schema: z.object({ count: z.number().int() }).strict(),
    version: 2,
  });

const otherDefinition = (): AgentStateDefinition<CounterState, typeof counterEvents> =>
  defineState({
    events: counterEvents,
    id: 'state-sqlite-test/other',
    initial: { count: 0 },
    lifetime: 'workspace-durable',
    reduce: (state, event) => ({ count: state.count + event.payload.by }),
    schema: z.object({ count: z.number().int() }).strict(),
  });

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-state-sqlite-'));
  try {
    await run(root);
  } finally {
    await removeTree(root);
  }
};

describe('sqlite driver storage behavior', () => {
  it('declares durable workspace-durable storage and validates its options', () => {
    const driver = createSqliteStateDriver({ root: tmpdir() });
    expect(driver).toMatchObject({ durable: true, kind: 'sqlite', lifetime: 'workspace-durable' });
    expect(() => createSqliteStateDriver({} as never)).toThrow(AgentStateError);
    expect(() => createSqliteStateDriver({ file: 'a.sqlite', root: '/tmp' })).toThrow(AgentStateError);
    expect(() => createSqliteStateDriver({ busyTimeoutMs: 0, root: '/tmp' })).toThrow(AgentStateError);
  });

  it('pins one definition id per database file', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const first = await createSqliteStateDriver({ file }).open(counterDefinition());
      await first.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await first.close();
      await expect(createSqliteStateDriver({ file }).open(otherDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        name: 'AgentStateError',
      });
    }));

  it('separates definition ids into isolated database files under one root', () =>
    withRoot(async (root) => {
      const driver = createSqliteStateDriver({ root });
      const first = await driver.open(counterDefinition());
      const second = await driver.open(otherDefinition());
      expect(first.location).not.toBe(second.location);
      await first.dispatch('bumped', { by: 3 }, { idempotencyKey: 'k1' });
      expect((await second.read()).revision).toBe(0);
      await driver.close();
      await expect(first.read()).rejects.toMatchObject({ code: 'store-closed' });
    }));

  it('keeps the original commit input while migrating each committed result', () =>
    withRoot(async (root) => {
      const file = join(root, 'migrating-reset.sqlite');
      const v1 = await createSqliteStateDriver({ file }).open(counterDefinition('state-sqlite-test/migrating-counter'));
      await v1.dispatch('bumped', { by: 2 }, { idempotencyKey: 'v1:event' });
      await v1.reset({ idempotencyKey: 'v1:reset', seed: { count: 5 } });
      await v1.close();

      const store = await createSqliteStateDriver({ file }).open(migratingCounterDefinition());
      await expect(store.read()).resolves.toEqual({ revision: 3, state: { count: 50 } });
      await expect(
        store.dispatch('bumped', { by: 2 }, { idempotencyKey: 'v1:event' }),
      ).resolves.toEqual({ replayed: true, revision: 1, state: { count: 20 } });
      await expect(
        store.reset({ idempotencyKey: 'v1:reset', seed: { count: 5 } }),
      ).resolves.toEqual({ replayed: true, revision: 2, state: { count: 50 } });
      const db = new DatabaseSync(file);
      try {
        expect(db.prepare('SELECT state, result_state FROM agent_state_journal WHERE revision = 2').get()).toEqual({
          result_state: '{"count":50}',
          state: '{"count":5}',
        });
      } finally {
        db.close();
      }
      await store.close();
    }));

  it('fails closed with a typed corrupt error when a table does not match the current schema', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.close();
      const db = new DatabaseSync(file);
      db.exec('ALTER TABLE agent_state_journal DROP COLUMN result_state');
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        message: expect.stringContaining('table agent_state_journal') as string,
        name: 'AgentStateError',
      });
    }));

  it('fails closed with a typed corrupt error when a column that must be NOT NULL is nullable', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.close();
      const db = new DatabaseSync(file);
      // Same column names in the same order, so only the NOT NULL flags tell
      // this journal apart from the one the current kernel writes.
      db.exec(`
        ALTER TABLE agent_state_journal RENAME TO agent_state_journal_old;
        CREATE TABLE agent_state_journal (
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
        INSERT INTO agent_state_journal SELECT * FROM agent_state_journal_old;
        DROP TABLE agent_state_journal_old;
      `);
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        message: expect.stringContaining('table agent_state_journal') as string,
        name: 'AgentStateError',
      });
    }));

  it('rejects a pending open when the driver closes before initialization resumes', () =>
    withRoot(async (root) => {
      const driver = createSqliteStateDriver({ root });
      const pendingOpen = driver.open(counterDefinition());
      let settled = false;
      const observedOpen = pendingOpen.then(
        (store) => {
          settled = true;
          return { status: 'success' as const, store };
        },
        (error: unknown) => {
          settled = true;
          return { error, status: 'failure' as const };
        },
      );

      const closing = driver.close();
      const repeatedClose = driver.close();
      await Promise.all([closing, repeatedClose]);
      const settledBeforeCloseResolved = settled;
      const outcome = await observedOpen;
      if (outcome.status === 'success') await outcome.store.close();

      expect(settledBeforeCloseResolved).toBe(true);
      expect(outcome).toMatchObject({
        status: 'failure',
        error: {
          code: 'store-closed',
          name: 'AgentStateError',
        },
      });
      await expect(driver.open(counterDefinition())).rejects.toMatchObject({
        code: 'store-closed',
        name: 'AgentStateError',
      });
    }));

  it('runs WAL journal mode with full synchronous durability', () =>
    withRoot(async (root) => {
      const store = await createSqliteStateDriver({ root }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      const db = new DatabaseSync(store.location);
      try {
        expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      } finally {
        db.close();
      }
      await store.close();
    }));

  // A connection holding the rollback-mode write lock (RESERVED) on a fresh
  // file stands in for a second process caught mid `PRAGMA journal_mode = WAL`.
  // SQLite answers the driver's own switch SQLITE_BUSY at once, without
  // consulting busy_timeout, so the driver must retry the switch itself.
  it('waits for another process mid-WAL-switch instead of failing the first open', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const keeper = new DatabaseSync(file);
      keeper.exec('BEGIN IMMEDIATE');
      try {
        const opening = createSqliteStateDriver({ file }).open(counterDefinition());
        // Neither outcome is reachable while the lock is held: the switch cannot
        // succeed, and the 5 s default budget cannot run out in 50 ms.
        const outcome = await Promise.race([
          opening.then(() => 'opened', () => 'failed'),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
        ]);
        expect(outcome).toBe('pending');
        keeper.exec('ROLLBACK');
        const store = await opening;
        expect(keeper.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
        await expect(store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' })).resolves.toMatchObject({ revision: 1 });
        await store.close();
      } finally {
        keeper.close();
      }
    }));

  it('fails the first open as unavailable once the WAL switch outlives busyTimeoutMs', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const keeper = new DatabaseSync(file);
      keeper.exec('BEGIN IMMEDIATE');
      try {
        // Budgets both above and below the retry pause fail closed; the
        // shorter one proves the pause is clamped rather than outliving it.
        for (const busyTimeoutMs of [100, 1]) {
          await expect(createSqliteStateDriver({ busyTimeoutMs, file }).open(counterDefinition())).rejects.toMatchObject({
            code: 'unavailable',
            message: expect.stringContaining('storage stayed locked beyond the busy timeout (configure storage)') as string,
            name: 'AgentStateError',
          });
        }
      } finally {
        keeper.close();
      }
    }));

  it('rolls back failed transactions without collapsing unexpected defects', () =>
    withRoot(async (root) => {
      const defect = new Error('clock implementation defect');
      let shouldFail = true;
      const driver = createSqliteStateDriver({
        now: () => {
          if (shouldFail) {
            shouldFail = false;
            throw defect;
          }
          return new Date('2026-01-01T00:00:00.000Z');
        },
        root,
      });
      const store = await driver.open(counterDefinition());

      await expect(
        store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'defect' }),
      ).rejects.toBe(defect);
      await expect(store.read()).resolves.toEqual({ revision: 0, state: { count: 0 } });
      await expect(
        store.dispatch('bumped', { by: 2 }, { idempotencyKey: 'recovered' }),
      ).resolves.toMatchObject({ replayed: false, revision: 1, state: { count: 2 } });

      await driver.close();
    }));

  it('rolls back a commit that exceeds maxCommitMs', () =>
    withRoot(async (root) => {
      let nowMs = 0;
      const driver = createSqliteStateDriver({
        now: () => {
          const current = new Date(nowMs);
          nowMs += 11;
          return current;
        },
        root,
      });
      const definition = defineState({
        events: counterEvents,
        id: 'state-sqlite-test/commit-time-budget',
        initial: { count: 0 },
        lifetime: 'workspace-durable',
        budgets: { maxCommitMs: 10 },
        reduce: (state, event) => ({ count: state.count + event.payload.by }),
        schema: z.object({ count: z.number().int() }).strict(),
      });
      const store = await driver.open(definition);

      await expect(
        store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'slow' }),
      ).rejects.toMatchObject({ code: 'budget-exceeded', name: 'AgentStateError' });
      await expect(store.read()).resolves.toEqual({ revision: 0, state: { count: 0 } });
      await driver.close();
    }));

  it('exempts kernel migration commits from revision and time budgets', () =>
    withRoot(async (root) => {
      const file = join(root, 'migration-budget.sqlite');
      const definitionV1 = defineState({
        ...counterDefinition('state-sqlite-test/migration-budget'),
        budgets: { maxRevisions: 1 },
      });
      const driverV1 = createSqliteStateDriver({ file });
      const storeV1 = await driverV1.open(definitionV1);
      await storeV1.dispatch('bumped', { by: 1 }, { idempotencyKey: 'i1' });
      await driverV1.close();

      let nowMs = 0;
      const definitionV2 = defineState({
        ...migratingCounterDefinition('state-sqlite-test/migration-budget'),
        budgets: { maxCommitMs: 1, maxRevisions: 1 },
      });
      const driverV2 = createSqliteStateDriver({
        file,
        now: () => {
          const current = new Date(nowMs);
          nowMs += 10_000;
          return current;
        },
      });

      const migrated = await driverV2.open(definitionV2);
      await expect(migrated.read()).resolves.toEqual({ revision: 2, state: { count: 10 } });
      await driverV2.close();
    }));

  it('surfaces database close failures when the store scope otherwise succeeds', () =>
    withRoot(async (root) => {
      const closeFailure = new Error('database close failed');
      const originalClose = DatabaseSync.prototype.close;
      let failClose = false;
      DatabaseSync.prototype.close = function close(this: DatabaseSync): void {
        originalClose.call(this);
        if (failClose) throw closeFailure;
      };
      try {
        const store = await createSqliteStateDriver({ root }).open(counterDefinition());
        failClose = true;
        await expect(store.close()).rejects.toBe(closeFailure);
      } finally {
        DatabaseSync.prototype.close = originalClose;
      }
    }));

  it('preserves the initialization error when database close also fails', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const seed = await createSqliteStateDriver({ file }).open(counterDefinition());
      await seed.close();
      const db = new DatabaseSync(file);
      db.exec('UPDATE agent_state_meta SET kernel_format = 99');
      db.close();

      const closeFailure = new Error('database close failed');
      const originalClose = DatabaseSync.prototype.close;
      DatabaseSync.prototype.close = function close(this: DatabaseSync): void {
        originalClose.call(this);
        throw closeFailure;
      };
      try {
        await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
          code: 'corrupt',
          message: expect.stringContaining('kernel format 99'),
          name: 'AgentStateError',
        });
      } finally {
        DatabaseSync.prototype.close = originalClose;
      }
    }));

  it('attempts every store close before propagating the first close failure', () =>
    withRoot(async (root) => {
      const driver = createSqliteStateDriver({ root });
      const first = await driver.open(counterDefinition());
      const second = await driver.open(otherDefinition());
      const closeFailure = new Error('first database close failed');
      const originalClose = DatabaseSync.prototype.close;
      let closeAttempts = 0;
      DatabaseSync.prototype.close = function close(this: DatabaseSync): void {
        originalClose.call(this);
        closeAttempts += 1;
        if (closeAttempts === 1) throw closeFailure;
      };
      try {
        await expect(driver.close()).rejects.toBe(closeFailure);
        expect(closeAttempts).toBe(2);
        await expect(driver.close()).rejects.toBe(closeFailure);
        expect(closeAttempts).toBe(2);
        await expect(first.read()).rejects.toMatchObject({ code: 'store-closed' });
        await expect(second.read()).rejects.toMatchObject({ code: 'store-closed' });
      } finally {
        DatabaseSync.prototype.close = originalClose;
        await first.close().catch(() => undefined);
        await second.close().catch(() => undefined);
      }
    }));

  it('fails closed with a typed corrupt error when the file is not a database', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      await writeFile(file, 'this is not a sqlite database, and it is long enough to hold a header');
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        name: 'AgentStateError',
      });
    }));

  it('fails closed when the journal and head disagree', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.close();
      const db = new DatabaseSync(file);
      db.exec('UPDATE agent_state_head SET revision = 7');
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
      });
    }));

  it('fails closed on open when a persisted head no longer satisfies the schema', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.close();
      const db = new DatabaseSync(file);
      db.exec(`UPDATE agent_state_head SET state = '{"wrong":true}'`);
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        name: 'AgentStateError',
      });
    }));

  it('fails closed when a schema-valid head disagrees with journal replay', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.dispatch('bumped', { by: 2 }, { idempotencyKey: 'k2' });
      await store.close();
      const db = new DatabaseSync(file);
      // Schema-valid and revision-preserving, so only a replay comparison
      // can tell this hand-edited head from the journal's truth.
      db.exec(`UPDATE agent_state_head SET state = '{"count":999}'`);
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        name: 'AgentStateError',
      });
    }));

  it('fails closed when an intermediate journal row is missing', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.dispatch('bumped', { by: 2 }, { idempotencyKey: 'k2' });
      await store.dispatch('bumped', { by: 3 }, { idempotencyKey: 'k3' });
      await store.close();
      const db = new DatabaseSync(file);
      // The final revision still matches the head; only journal continuity
      // catches the deleted row.
      db.exec('DELETE FROM agent_state_journal WHERE revision = 2');
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
        name: 'AgentStateError',
      });
    }));

  it('fails closed on a newer kernel storage format', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.close();
      const db = new DatabaseSync(file);
      db.exec('UPDATE agent_state_meta SET kernel_format = 99');
      db.close();
      await expect(createSqliteStateDriver({ file }).open(counterDefinition())).rejects.toMatchObject({
        code: 'corrupt',
      });
    }));
});
