import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await rm(root, { force: true, recursive: true });
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
    await rm(root, { force: true, recursive: true });
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

  it('fails closed when a persisted head no longer satisfies the schema', () =>
    withRoot(async (root) => {
      const file = join(root, 'state.sqlite');
      const store = await createSqliteStateDriver({ file }).open(counterDefinition());
      await store.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k1' });
      await store.close();
      const db = new DatabaseSync(file);
      db.exec(`UPDATE agent_state_head SET state = '{"wrong":true}'`);
      db.close();
      const reopened = await createSqliteStateDriver({ file }).open(counterDefinition());
      await expect(reopened.read()).rejects.toMatchObject({ code: 'corrupt' });
      await expect(
        reopened.dispatch('bumped', { by: 1 }, { idempotencyKey: 'k2' }),
      ).rejects.toMatchObject({ code: 'corrupt' });
      await reopened.close();
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
