import assert from 'node:assert/strict';

import { z } from 'zod';

import type {
  AgentStateBudgetsInput,
  AgentStateDefinition,
  AgentStateErrorCode,
  AgentStateEventSchemas,
  AgentStateLifetime,
  AgentStateStore,
} from './contract.js';
import {
  AGENT_STATE_DEFAULT_BUDGETS,
  AGENT_STATE_LIFETIMES,
  AGENT_STATE_RESERVED_KEY_PREFIX,
  AgentStateError,
  defineState,
} from './contract.js';

/**
 * Driver conformance suite (#98).
 *
 * One shared, test-runner-agnostic suite that every state driver must pass —
 * the in-memory driver and the `node:sqlite` workspace-durable driver run it
 * in this repository, and an external driver (Postgres, Redis, a daemon) is
 * only a completed integration once it passes the same cases. Each case
 * receives a fresh, isolated context from the harness and asserts with
 * `node:assert`, so any test framework can host it.
 */

export interface StateConformanceContext {
  /** Whether commits survive re-opening the storage from a fresh driver instance. */
  readonly durable: boolean;
  /** The lifetime the harness driver provides; cases declare definitions with it. */
  readonly lifetime: AgentStateLifetime;
  /** Opens a store over this context's isolated storage. */
  open<TState, TEvents extends AgentStateEventSchemas>(
    definition: AgentStateDefinition<TState, TEvents>,
  ): Promise<AgentStateStore<TState, TEvents>>;
  /**
   * Opens an independent second view over the same storage: another
   * connection for durable drivers, the shared in-process store for
   * volatile ones.
   */
  reopen<TState, TEvents extends AgentStateEventSchemas>(
    definition: AgentStateDefinition<TState, TEvents>,
  ): Promise<AgentStateStore<TState, TEvents>>;
}

export interface StateConformanceCase {
  /** Skip unless the harness declares durable storage. */
  readonly durableOnly?: boolean;
  readonly name: string;
  readonly run: (context: StateConformanceContext) => Promise<void>;
}

const rejectsWith = (code: AgentStateErrorCode) => (error: unknown): boolean => {
  assert.ok(error instanceof AgentStateError, `expected AgentStateError, received ${String(error)}`);
  assert.equal(error.code, code);
  return true;
};

interface TaskState {
  readonly tasks: readonly { readonly id: string; readonly title: string }[];
  readonly total: number;
}

const taskSchema = z
  .object({
    tasks: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) }).strict()),
    total: z.number().int().min(0),
  })
  .strict();

const taskEvents = {
  taskAdded: z.object({ id: z.string().min(1), title: z.string().min(1) }).strict(),
  taskRemoved: z.object({ id: z.string().min(1) }).strict(),
  totalForced: z.object({ total: z.number().int() }).strict(),
} as const;

/** Standard fixture: a task list whose reducer exercises success, throw, and invalid-output paths. */
const taskDefinition = (
  lifetime: AgentStateLifetime,
  id = 'agent-state-conformance/tasks',
  budgets?: AgentStateBudgetsInput,
): AgentStateDefinition<TaskState, typeof taskEvents> =>
  defineState({
    budgets,
    events: taskEvents,
    id,
    initial: { tasks: [], total: 0 },
    lifetime,
    reduce: (state, event): TaskState => {
      switch (event.name) {
        case 'taskAdded':
          return {
            tasks: [...state.tasks, { id: event.payload.id, title: event.payload.title }],
            total: state.total + 1,
          };
        case 'taskRemoved': {
          const remaining = state.tasks.filter((task) => task.id !== event.payload.id);
          if (remaining.length === state.tasks.length) {
            throw new Error(`no task ${event.payload.id}`);
          }
          return { tasks: remaining, total: state.total };
        }
        case 'totalForced':
          // Deliberately unvalidated: negative payloads produce schema-invalid state.
          return { tasks: state.tasks, total: event.payload.total };
        default: {
          const unreachable: never = event;
          throw new Error(`unhandled event ${String(unreachable)}`);
        }
      }
    },
    schema: taskSchema,
  });

interface TaskStateV2 extends TaskState {
  readonly labels: readonly string[];
}

const taskSchemaV2 = z
  .object({
    labels: z.array(z.string()),
    tasks: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) }).strict()),
    total: z.number().int().min(0),
  })
  .strict();

const taskDefinitionV2 = (
  lifetime: AgentStateLifetime,
  id = 'agent-state-conformance/tasks',
  budgets?: AgentStateBudgetsInput,
): AgentStateDefinition<TaskStateV2, typeof taskEvents> =>
  defineState({
    budgets,
    events: taskEvents,
    id,
    initial: { labels: [], tasks: [], total: 0 },
    lifetime,
    migrations: {
      2: (persisted) => ({ ...(persisted as TaskState), labels: [] }),
    },
    reduce: (state, event): TaskStateV2 => {
      switch (event.name) {
        case 'taskAdded':
          return {
            labels: state.labels,
            tasks: [...state.tasks, { id: event.payload.id, title: event.payload.title }],
            total: state.total + 1,
          };
        case 'taskRemoved':
          return { labels: state.labels, tasks: state.tasks.filter((task) => task.id !== event.payload.id), total: state.total };
        case 'totalForced':
          return { labels: state.labels, tasks: state.tasks, total: event.payload.total };
        default: {
          const unreachable: never = event;
          throw new Error(`unhandled event ${String(unreachable)}`);
        }
      }
    },
    schema: taskSchemaV2,
    version: 2,
  });

const addTask = (
  store: AgentStateStore<TaskState, typeof taskEvents>,
  id: string,
  key = `add:${id}`,
): ReturnType<typeof store.dispatch> =>
  store.dispatch('taskAdded', { id, title: `Task ${id}` }, { idempotencyKey: key });

export const stateDriverConformanceCases: readonly StateConformanceCase[] = Object.freeze([
  {
    name: 'an unwritten store reads the initial state at revision 0',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      assert.deepEqual(await store.read(), { revision: 0, state: { tasks: [], total: 0 } });
      assert.deepEqual(await store.changes({ afterRevision: 0 }), { changes: [], headRevision: 0 });
    },
  },
  {
    name: 'dispatch validates payloads, applies the reducer, and commits monotonic revisions',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const first = await addTask(store, 'a');
      assert.equal(first.revision, 1);
      assert.equal(first.replayed, false);
      assert.deepEqual(first.state, { tasks: [{ id: 'a', title: 'Task a' }], total: 1 });
      const second = await addTask(store, 'b');
      assert.equal(second.revision, 2);
      assert.equal((await store.read()).revision, 2);
      assert.deepEqual((await store.read()).state, {
        tasks: [
          { id: 'a', title: 'Task a' },
          { id: 'b', title: 'Task b' },
        ],
        total: 2,
      });
    },
  },
  {
    name: 'definitions without budgets use defaults and preserve ordinary commits',
    run: async (context) => {
      const definition = taskDefinition(context.lifetime);
      assert.deepEqual(definition.budgets, AGENT_STATE_DEFAULT_BUDGETS);
      const store = await context.open(definition);
      assert.equal((await addTask(store, 'a')).revision, 1);
    },
  },
  {
    name: 'an over-budget event payload fails without committing',
    run: async (context) => {
      const store = await context.open(
        taskDefinition(context.lifetime, 'agent-state-conformance/event-budget', { maxEventBytes: 10 }),
      );
      await assert.rejects(addTask(store, 'a'), rejectsWith('budget-exceeded'));
      assert.equal((await store.read()).revision, 0);
    },
  },
  {
    name: 'an over-budget reducer output fails without committing',
    run: async (context) => {
      const store = await context.open(
        taskDefinition(context.lifetime, 'agent-state-conformance/state-budget', { maxStateBytes: 30 }),
      );
      await assert.rejects(addTask(store, 'a'), rejectsWith('budget-exceeded'));
      assert.deepEqual(await store.read(), { revision: 0, state: { tasks: [], total: 0 } });
    },
  },
  {
    name: 'an over-budget reset seed fails without committing',
    run: async (context) => {
      const store = await context.open(
        taskDefinition(context.lifetime, 'agent-state-conformance/reset-budget', { maxStateBytes: 30 }),
      );
      await assert.rejects(
        store.reset({
          idempotencyKey: 'reset:large',
          seed: { tasks: [{ id: 'seed', title: 'Seeded task' }], total: 1 },
        }),
        rejectsWith('budget-exceeded'),
      );
      assert.deepEqual(await store.read(), { revision: 0, state: { tasks: [], total: 0 } });
    },
  },
  {
    name: 'maxRevisions blocks new commits but permits replay and a raised runtime policy',
    run: async (context) => {
      const id = 'agent-state-conformance/revision-budget';
      const capped = await context.open(taskDefinition(context.lifetime, id, { maxRevisions: 2 }));
      const first = await addTask(capped, 'a');
      await addTask(capped, 'b');
      await assert.rejects(addTask(capped, 'c'), rejectsWith('budget-exceeded'));
      assert.equal((await capped.read()).revision, 2);

      const replayed = await addTask(capped, 'a');
      assert.deepEqual(replayed, { ...first, replayed: true });
      assert.equal((await capped.read()).revision, 2);

      const raised = await context.reopen(taskDefinition(context.lifetime, id, { maxRevisions: 3 }));
      assert.equal((await addTask(raised, 'c')).revision, 3);
    },
  },
  {
    name: 'lowered budgets preserve exact reads and committed replay',
    run: async (context) => {
      const id = 'agent-state-conformance/lowered-budget-replay';
      const original = await context.open(taskDefinition(context.lifetime, id));
      const first = await addTask(original, 'a');
      await addTask(original, 'b');

      const loweredEvent = await context.reopen(
        taskDefinition(context.lifetime, id, { maxEventBytes: 10, maxStateBytes: 30 }),
      );
      assert.deepEqual(await loweredEvent.read({ revision: 1 }), {
        revision: 1,
        state: first.state,
      });

      const loweredCommit = await context.reopen(
        taskDefinition(context.lifetime, id, { maxCommitMs: 1, maxRevisions: 1, maxStateBytes: 30 }),
      );
      const replayed = await addTask(loweredCommit, 'a');
      assert.deepEqual(replayed, { ...first, replayed: true });
      assert.equal((await loweredCommit.read()).revision, 2);
    },
  },
  {
    name: 'unknown events and invalid payloads fail typed without committing',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await assert.rejects(
        store.dispatch('taskrenamed' as never, { id: 'a' } as never, { idempotencyKey: 'bad:event' }),
        rejectsWith('invalid-event'),
      );
      await assert.rejects(
        store.dispatch('taskAdded', { id: '', title: '' }, { idempotencyKey: 'bad:payload' }),
        rejectsWith('invalid-event'),
      );
      assert.equal((await store.read()).revision, 0);
    },
  },
  {
    name: 'replaying an idempotency key returns the committed result',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const original = await addTask(store, 'a');
      await addTask(store, 'b');
      const replayed = await addTask(store, 'a');
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, original.revision);
      assert.deepEqual(replayed.state, original.state);
      assert.equal((await store.read()).revision, 2);
    },
  },
  {
    name: 'a committed key replays without re-running the reducer',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      const removed = await store.dispatch('taskRemoved', { id: 'a' }, { idempotencyKey: 'remove:a' });
      assert.equal(removed.revision, 2);
      // Task 'a' is gone, so the reducer would now throw; the key must be
      // consulted before the reducer runs for the retry to replay.
      const replayed = await store.dispatch('taskRemoved', { id: 'a' }, { idempotencyKey: 'remove:a' });
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, removed.revision);
      assert.deepEqual(replayed.state, removed.state);
      assert.equal((await store.read()).revision, 2);
    },
  },
  {
    name: 'reusing an idempotency key with a different payload is an idempotency-conflict',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a', 'shared:key');
      await assert.rejects(
        store.dispatch('taskAdded', { id: 'z', title: 'Task z' }, { idempotencyKey: 'shared:key' }),
        rejectsWith('idempotency-conflict'),
      );
      await assert.rejects(
        store.reset({ idempotencyKey: 'shared:key' }),
        rejectsWith('idempotency-conflict'),
      );
      assert.equal((await store.read()).revision, 1);
    },
  },
  {
    name: 'expectedRevision mismatches are revision-conflicts and commit nothing',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await assert.rejects(
        store.dispatch('taskAdded', { id: 'b', title: 'Task b' }, { expectedRevision: 0, idempotencyKey: 'cas:miss' }),
        rejectsWith('revision-conflict'),
      );
      assert.equal((await store.read()).revision, 1);
      const committed = await store.dispatch(
        'taskAdded',
        { id: 'b', title: 'Task b' },
        { expectedRevision: 1, idempotencyKey: 'cas:hit' },
      );
      assert.equal(committed.revision, 2);
    },
  },
  {
    name: 'a replayed key wins over a stale expectedRevision',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const original = await addTask(store, 'a');
      await addTask(store, 'b');
      const replayed = await store.dispatch(
        'taskAdded',
        { id: 'a', title: 'Task a' },
        { expectedRevision: 0, idempotencyKey: 'add:a' },
      );
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, original.revision);
    },
  },
  {
    name: 'exact-revision reads reconstruct every retained revision',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await addTask(store, 'b');
      await store.dispatch('taskRemoved', { id: 'a' }, { idempotencyKey: 'remove:a' });
      assert.deepEqual((await store.read({ revision: 0 })).state, { tasks: [], total: 0 });
      assert.deepEqual((await store.read({ revision: 1 })).state, { tasks: [{ id: 'a', title: 'Task a' }], total: 1 });
      assert.equal((await store.read({ revision: 2 })).state.tasks.length, 2);
      assert.deepEqual((await store.read({ revision: 3 })).state, {
        tasks: [{ id: 'b', title: 'Task b' }],
        total: 2,
      });
      await assert.rejects(store.read({ revision: 4 }), rejectsWith('revision-unavailable'));
      await assert.rejects(store.read({ revision: -1 }), rejectsWith('invalid-input'));
      await assert.rejects(store.read({ revision: 1.5 }), rejectsWith('invalid-input'));
    },
  },
  {
    name: 'reset returns to the initial state while revisions stay monotonic',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await addTask(store, 'b');
      const reset = await store.reset({ idempotencyKey: 'reset:1' });
      assert.equal(reset.revision, 3);
      assert.deepEqual(reset.state, { tasks: [], total: 0 });
      const replayedReset = await store.reset({ idempotencyKey: 'reset:1' });
      assert.equal(replayedReset.replayed, true);
      assert.equal(replayedReset.revision, 3);
      assert.deepEqual((await store.read({ revision: 2 })).state.tasks.length, 2);
      const after = await addTask(store, 'c');
      assert.equal(after.revision, 4);
      assert.deepEqual(after.state, { tasks: [{ id: 'c', title: 'Task c' }], total: 1 });
    },
  },
  {
    name: 'reset seeds are validated and preserved',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const seeded = await store.reset({
        idempotencyKey: 'reset:seeded',
        seed: { tasks: [{ id: 'seed', title: 'Seeded' }], total: 9 },
      });
      assert.deepEqual(seeded.state, { tasks: [{ id: 'seed', title: 'Seeded' }], total: 9 });
      await assert.rejects(
        store.reset({ idempotencyKey: 'reset:bad', seed: { tasks: [], total: -1 } }),
        rejectsWith('invalid-state'),
      );
      assert.equal((await store.read()).revision, 1);
    },
  },
  {
    name: 'reducer failures and invalid reducer output commit nothing',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await assert.rejects(
        store.dispatch('taskRemoved', { id: 'missing' }, { idempotencyKey: 'remove:missing' }),
        rejectsWith('reducer-failure'),
      );
      await assert.rejects(
        store.dispatch('totalForced', { total: -5 }, { idempotencyKey: 'force:negative' }),
        rejectsWith('invalid-state'),
      );
      assert.equal((await store.read()).revision, 1);
    },
  },
  {
    name: 'the change cursor returns committed changes after a revision',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await addTask(store, 'b');
      await store.reset({ idempotencyKey: 'reset:1' });
      const all = await store.changes({ afterRevision: 0 });
      assert.equal(all.headRevision, 3);
      assert.deepEqual(
        all.changes.map((change) => ({ kind: change.kind, revision: change.revision })),
        [
          { kind: 'event', revision: 1 },
          { kind: 'event', revision: 2 },
          { kind: 'reset', revision: 3 },
        ],
      );
      const firstEvent = all.changes[0];
      assert.ok(firstEvent !== undefined && firstEvent.kind === 'event');
      assert.equal(firstEvent.name, 'taskAdded');
      assert.deepEqual(firstEvent.payload, { id: 'a', title: 'Task a' });
      assert.equal(typeof firstEvent.committedAt, 'string');
      const tail = await store.changes({ afterRevision: 2 });
      assert.deepEqual(
        tail.changes.map((change) => change.revision),
        [3],
      );
      const limited = await store.changes({ afterRevision: 0, limit: 1 });
      assert.equal(limited.changes.length, 1);
      assert.equal(limited.headRevision, 3);
      assert.deepEqual((await store.changes({ afterRevision: 3 })).changes, []);
      await assert.rejects(store.changes({ afterRevision: -1 }), rejectsWith('invalid-input'));
      await assert.rejects(store.changes({ afterRevision: 0, limit: 0 }), rejectsWith('invalid-input'));
    },
  },
  {
    name: 'a second open over the same storage observes committed state',
    run: async (context) => {
      const writer = await context.open(taskDefinition(context.lifetime));
      const reader = await context.reopen(taskDefinition(context.lifetime));
      await addTask(writer, 'a');
      const observed = await reader.read();
      assert.equal(observed.revision, 1);
      assert.deepEqual(observed.state, { tasks: [{ id: 'a', title: 'Task a' }], total: 1 });
      const cursor = await reader.changes({ afterRevision: 0 });
      assert.equal(cursor.headRevision, 1);
      assert.equal(cursor.changes.length, 1);
    },
  },
  {
    name: 'independent definition ids stay isolated',
    run: async (context) => {
      const first = await context.open(taskDefinition(context.lifetime, 'agent-state-conformance/first'));
      const second = await context.open(taskDefinition(context.lifetime, 'agent-state-conformance/second'));
      await addTask(first, 'a');
      assert.equal((await second.read()).revision, 0);
      assert.deepEqual((await second.read()).state, { tasks: [], total: 0 });
    },
  },
  {
    name: 'explicit migrations run on open, rebase history, and fail closed when missing',
    run: async (context) => {
      const storeV1 = await context.open(taskDefinition(context.lifetime));
      await addTask(storeV1, 'a');
      await addTask(storeV1, 'b');
      const storeV2 = await context.reopen(taskDefinitionV2(context.lifetime));
      const migrated = await storeV2.read();
      assert.equal(migrated.revision, 3);
      assert.deepEqual(migrated.state, {
        labels: [],
        tasks: [
          { id: 'a', title: 'Task a' },
          { id: 'b', title: 'Task b' },
        ],
        total: 2,
      });
      const changes = await storeV2.changes({ afterRevision: 0 });
      assert.deepEqual(
        changes.changes.map((change) => change.kind),
        ['event', 'event', 'migrate'],
      );
      await assert.rejects(storeV2.read({ revision: 2 }), rejectsWith('revision-unavailable'));
      assert.equal((await storeV2.read({ revision: 3 })).revision, 3);
      const after = await storeV2.dispatch(
        'taskAdded',
        { id: 'c', title: 'Task c' },
        { idempotencyKey: 'add:c' },
      );
      assert.equal(after.revision, 4);
      await assert.rejects(context.reopen(taskDefinition(context.lifetime)), rejectsWith('migration-missing'));
    },
  },
  {
    name: 'an over-budget migrated state fails open without committing',
    run: async (context) => {
      const id = 'agent-state-conformance/migration-state-budget';
      const storeV1 = await context.open(taskDefinition(context.lifetime, id));
      await addTask(storeV1, 'a');
      await assert.rejects(
        context.reopen(taskDefinitionV2(context.lifetime, id, { maxStateBytes: 40 })),
        rejectsWith('budget-exceeded'),
      );
      assert.equal((await storeV1.read()).revision, 1);
    },
  },
  {
    name: 'replaying a key committed before a migration returns its committed result',
    run: async (context) => {
      const storeV1 = await context.open(taskDefinition(context.lifetime));
      const original = await addTask(storeV1, 'a');
      await addTask(storeV1, 'b');
      const storeV2 = await context.reopen(taskDefinitionV2(context.lifetime));
      assert.equal((await storeV2.read()).revision, 3);
      // The migration rebases exact-revision history, but a pre-deployment
      // retry must still replay: the committed result rides the migration
      // chain instead of depending on exact-revision replay.
      const replayed = await storeV2.dispatch('taskAdded', { id: 'a', title: 'Task a' }, { idempotencyKey: 'add:a' });
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, original.revision);
      assert.deepEqual(replayed.state, { labels: [], tasks: [{ id: 'a', title: 'Task a' }], total: 1 });
      assert.equal((await storeV2.read()).revision, 3);
    },
  },
  {
    name: 'definition ids sharing a sanitized prefix stay isolated',
    run: async (context) => {
      // These two ids sanitize identically and share their leading bytes, so
      // storage naming must derive from the complete id, never a truncation.
      const first = await context.open(taskDefinition(context.lifetime, 'abcdef/a'));
      const second = await context.open(taskDefinition(context.lifetime, 'abcdef-a'));
      await addTask(first, 'a');
      assert.equal((await second.read()).revision, 0);
      assert.deepEqual((await second.read()).state, { tasks: [], total: 0 });
    },
  },
  {
    name: 'closed stores fail typed',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await store.close();
      await assert.rejects(addTask(store, 'a'), rejectsWith('store-closed'));
      await assert.rejects(store.read(), rejectsWith('store-closed'));
      await assert.rejects(store.changes({ afterRevision: 0 }), rejectsWith('store-closed'));
    },
  },
  {
    name: 'aborted signals stop operations before they touch state',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const controller = new AbortController();
      controller.abort(new Error('caller cancelled'));
      await assert.rejects(
        store.dispatch('taskAdded', { id: 'a', title: 'Task a' }, { idempotencyKey: 'abort:1', signal: controller.signal }),
        rejectsWith('aborted'),
      );
      await assert.rejects(store.read({ signal: controller.signal }), rejectsWith('aborted'));
      assert.equal((await store.read()).revision, 0);
    },
  },
  {
    name: 'empty and reserved idempotency keys are invalid-input',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await assert.rejects(
        store.dispatch('taskAdded', { id: 'a', title: 'Task a' }, { idempotencyKey: '  ' }),
        rejectsWith('invalid-input'),
      );
      await assert.rejects(
        store.dispatch(
          'taskAdded',
          { id: 'a', title: 'Task a' },
          { idempotencyKey: `${AGENT_STATE_RESERVED_KEY_PREFIX}migrate:2` },
        ),
        rejectsWith('invalid-input'),
      );
      assert.equal((await store.read()).revision, 0);
    },
  },
  {
    name: 'lifetime mismatches fail closed',
    run: async (context) => {
      const other = AGENT_STATE_LIFETIMES.find((candidate) => candidate !== context.lifetime);
      assert.ok(other !== undefined);
      await assert.rejects(context.open(taskDefinition(other)), rejectsWith('lifetime-mismatch'));
    },
  },
  {
    durableOnly: true,
    name: 'commits survive closing every store and reopening the storage',
    run: async (context) => {
      const writer = await context.open(taskDefinition(context.lifetime));
      await addTask(writer, 'a');
      await addTask(writer, 'b');
      await writer.close();
      const reopened = await context.reopen(taskDefinition(context.lifetime));
      const snapshot = await reopened.read();
      assert.equal(snapshot.revision, 2);
      assert.deepEqual(snapshot.state.tasks.map((task) => task.id), ['a', 'b']);
      const replayed = await addTask(reopened, 'a');
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, 1);
    },
  },
  {
    name: 'compaction folds the journal onto the head, keeps revisions monotonic, and is idempotent',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      const untouched = await store.inspect();
      assert.deepEqual(untouched, { baselineRevision: 0, headRevision: 0, journalBytes: 0, records: 0 });
      // Nothing to fold: an empty journal is already compact and no revision is spent.
      const empty = await store.compact();
      assert.deepEqual(empty, { baselineRevision: 0, prunedRecords: 0, revision: 0, state: { tasks: [], total: 0 } });
      await addTask(store, 'a');
      await addTask(store, 'b');
      const before = await store.inspect();
      assert.equal(before.records, 2);
      assert.ok(before.journalBytes > 0);

      const compacted = await store.compact();
      assert.equal(compacted.prunedRecords, 2);
      assert.equal(compacted.baselineRevision, 3);
      assert.equal(compacted.revision, 3);
      assert.deepEqual(compacted.state.tasks.map((task) => task.id), ['a', 'b']);
      const head = await store.read();
      assert.equal(head.revision, 3);
      assert.deepEqual(head.state, compacted.state);
      const after = await store.inspect();
      assert.equal(after.records, 1);
      assert.equal(after.baselineRevision, 3);
      assert.equal(after.headRevision, 3);
      assert.ok(after.journalBytes > 0);
      assert.equal(after.lastCompaction?.revision, 3);
      assert.ok(typeof after.lastCompaction?.at === 'string');

      // A second compaction over a lone baseline is a no-op with no new revision.
      const again = await store.compact();
      assert.deepEqual(again, { baselineRevision: 3, prunedRecords: 0, revision: 3, state: head.state });
      assert.equal((await store.read()).revision, 3);

      // History before the baseline is gone, honestly: exact reads fail typed,
      // the change cursor delivers the baseline as a discontinuity, and the
      // head keeps its exact revision.
      await assert.rejects(store.read({ revision: 1 }), rejectsWith('revision-unavailable'));
      assert.deepEqual((await store.read({ revision: 3 })).state, head.state);
      const changes = await store.changes({ afterRevision: 0 });
      assert.equal(changes.headRevision, 3);
      assert.deepEqual(changes.changes.map((change) => [change.kind, change.revision]), [['compact', 3]]);

      // Commits continue past the baseline and replay from it.
      const next = await addTask(store, 'c');
      assert.equal(next.revision, 4);
      assert.deepEqual((await store.read({ revision: 4 })).state.tasks.map((task) => task.id), ['a', 'b', 'c']);
      assert.deepEqual((await store.read({ revision: 3 })).state.tasks.map((task) => task.id), ['a', 'b']);
      const later = await store.compact({ expectedRevision: 4 });
      assert.equal(later.prunedRecords, 2);
      assert.equal(later.revision, 5);
      await assert.rejects(store.compact({ expectedRevision: 4 }), rejectsWith('revision-conflict'));
    },
  },
  {
    name: 'compaction remembers pruned idempotency keys without their results',
    run: async (context) => {
      const store = await context.open(taskDefinition(context.lifetime));
      await addTask(store, 'a');
      await store.compact();
      // The commit happened but compaction dropped its result: a retry cannot
      // be answered with a fabricated replay, and must not run the reducer again.
      await assert.rejects(addTask(store, 'a'), rejectsWith('revision-unavailable'));
      assert.equal((await store.read()).revision, 2);
      // Reusing the key with a different input is still a conflict.
      await assert.rejects(
        store.dispatch('taskAdded', { id: 'z', title: 'Task z' }, { idempotencyKey: 'add:a' }),
        rejectsWith('idempotency-conflict'),
      );
      assert.equal((await store.read()).revision, 2);
    },
  },
  {
    durableOnly: true,
    name: 'a compacted store reopens with its head agreeing with journal replay',
    run: async (context) => {
      const writer = await context.open(taskDefinition(context.lifetime));
      await addTask(writer, 'a');
      await addTask(writer, 'b');
      await writer.compact();
      await addTask(writer, 'c');
      await writer.close();
      const reopened = await context.reopen(taskDefinition(context.lifetime));
      const snapshot = await reopened.read();
      assert.equal(snapshot.revision, 4);
      assert.deepEqual(snapshot.state.tasks.map((task) => task.id), ['a', 'b', 'c']);
      const inspection = await reopened.inspect();
      assert.equal(inspection.baselineRevision, 3);
      assert.equal(inspection.records, 2);
      assert.equal(inspection.lastCompaction?.revision, 3);
      await assert.rejects(addTask(reopened, 'a'), rejectsWith('revision-unavailable'));
      const replayed = await addTask(reopened, 'c');
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.revision, 4);
    },
  },
]);
