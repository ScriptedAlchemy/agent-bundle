import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import { agent, runAgentRequest } from '../src/index.js';
import {
  AGENT_STATE_LIFETIMES,
  AgentStateError,
  agentStateLifetimeIsVolatile,
  canonicalJson,
  createAgentStateHandle,
  createMemoryStateDriver,
  defineState,
  isJsonSafe,
  type AgentStateDefinition,
  type AgentStateHandle,
  type AgentStateLifetime,
} from '../src/state/index.js';

const counterEvents = {
  incremented: z.object({ by: z.number().int().min(1) }).strict(),
} as const;

interface CounterState {
  readonly count: number;
}

const counterDefinition = (
  lifetime: AgentStateLifetime = 'process',
  id = 'state-kernel-test/counter',
): AgentStateDefinition<CounterState, typeof counterEvents> =>
  defineState({
    events: counterEvents,
    id,
    initial: { count: 0 },
    lifetime,
    reduce: (state, event) => ({ count: state.count + event.payload.by }),
    schema: z.object({ count: z.number().int() }).strict(),
  });

describe('JSON boundary', () => {
  it('rejects sparse arrays as not JSON-safe', () => {
    expect(isJsonSafe([1, 2, 3])).toBe(true);
    expect(isJsonSafe([])).toBe(true);
    // `every` skips holes, so a naive check would declare these safe and
    // canonicalization would collapse `[<1 hole>]` to the same text as `[]`.
    expect(isJsonSafe(new Array(1))).toBe(false);
    expect(isJsonSafe(Object.assign([1, 3], { length: 3 }))).toBe(false);
    expect(isJsonSafe({ nested: new Array(2) })).toBe(false);
    expect(canonicalJson([])).toBe('[]');
  });

  it('a sparse array payload is a typed invalid-event, never silently canonicalized', async () => {
    const definition = defineState({
      events: { itemsSet: z.any() },
      id: 'state-kernel-test/sparse',
      initial: { items: [] as readonly unknown[] },
      lifetime: 'process',
      reduce: (_state, event) => ({ items: [event.payload] }),
      schema: z.object({ items: z.array(z.unknown()) }).strict(),
    });
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(definition);
    await expect(
      store.dispatch('itemsSet', new Array(1), { idempotencyKey: 'sparse:1' }),
    ).rejects.toMatchObject({ code: 'invalid-event', name: 'AgentStateError' });
    expect((await store.read()).revision).toBe(0);
    await driver.close();
  });
});

describe('defineState', () => {
  it('rejects invalid definitions with typed invalid-definition errors', () => {
    const base = {
      events: counterEvents,
      id: 'state-kernel-test/invalid',
      initial: { count: 0 },
      lifetime: 'process' as const,
      reduce: (state: CounterState) => state,
      schema: z.object({ count: z.number().int() }).strict(),
    };
    const failures: readonly (() => unknown)[] = [
      () => defineState({ ...base, id: '  ' }),
      () => defineState({ ...base, lifetime: 'session' as never }),
      () => defineState({ ...base, events: {} as never }),
      () => defineState({ ...base, events: { incremented: 42 } as never }),
      () => defineState({ ...base, version: 0 }),
      () => defineState({ ...base, version: 1.5 }),
      // Version 2 without the migration step to 2.
      () => defineState({ ...base, version: 2 }),
      // Migration step outside 2..version.
      () => defineState({ ...base, migrations: { 3: (value: unknown) => value }, version: 2 }),
      // Migrations without a version bump.
      () => defineState({ ...base, migrations: { 2: (value: unknown) => value } }),
      // Initial state fails the schema.
      () => defineState({ ...base, initial: { count: 0.5 } }),
      // Initial state is not JSON-safe.
      () =>
        defineState({
          ...base,
          initial: { count: Number.POSITIVE_INFINITY },
          schema: z.object({ count: z.number() }).strict(),
        }),
      () => defineState({ ...base, reduce: undefined as never }),
    ];
    for (const failure of failures) {
      expect(failure).toThrow(AgentStateError);
      try {
        failure();
      } catch (error) {
        expect((error as AgentStateError).code).toBe('invalid-definition');
      }
    }
  });

  it('freezes the definition and its parsed initial state', () => {
    const definition = counterDefinition();
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.initial)).toBe(true);
    expect(definition.version).toBe(1);
    expect(definition.migrations).toEqual({});
  });

  it('schema issues in errors name paths and codes, never rejected values', () => {
    const definition = defineState({
      events: { noted: z.object({ secret: z.string().max(3) }).strict() },
      id: 'state-kernel-test/error-hygiene',
      initial: { notes: [] as readonly string[] },
      lifetime: 'process',
      reduce: (state, event) => ({ notes: [...state.notes, event.payload.secret] }),
      schema: z.object({ notes: z.array(z.string()) }).strict(),
    });
    const driver = createMemoryStateDriver();
    const confidential = 'hunter2-super-secret';
    return driver
      .open(definition)
      .then((store) => store.dispatch('noted', { secret: confidential }, { idempotencyKey: 'n1' }))
      .then(
        () => {
          throw new Error('expected dispatch to reject');
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(AgentStateError);
          expect((error as AgentStateError).code).toBe('invalid-event');
          expect((error as AgentStateError).message).not.toContain(confidential);
          expect((error as AgentStateError).message).toContain('secret');
        },
      );
  });
});

describe('agentStateLifetimeIsVolatile', () => {
  it('classifies every lifetime in the taxonomy', () => {
    expect(AGENT_STATE_LIFETIMES).toEqual(['request', 'process', 'workspace-durable', 'external']);
    expect(agentStateLifetimeIsVolatile('request')).toBe(true);
    expect(agentStateLifetimeIsVolatile('process')).toBe(true);
    expect(agentStateLifetimeIsVolatile('workspace-durable')).toBe(false);
    expect(agentStateLifetimeIsVolatile('external')).toBe(false);
    expect(() => agentStateLifetimeIsVolatile('daemon' as never)).toThrow(AgentStateError);
  });
});

describe('createMemoryStateDriver', () => {
  it('is labeled test-only volatile storage and never durable', () => {
    const driver = createMemoryStateDriver();
    expect(driver.durable).toBe(false);
    expect(driver.kind).toBe('memory');
    expect(driver.lifetime).toBe('process');
    expect(() => createMemoryStateDriver({ lifetime: 'workspace-durable' as never })).toThrow(
      AgentStateError,
    );
  });

  it('shares one process store per definition id and isolates request stores', async () => {
    const processDriver = createMemoryStateDriver({ lifetime: 'process' });
    const processDefinition = counterDefinition('process');
    const first = await processDriver.open(processDefinition);
    const second = await processDriver.open(processDefinition);
    await first.dispatch('incremented', { by: 2 }, { idempotencyKey: 'i1' });
    expect((await second.read()).state).toEqual({ count: 2 });

    const requestDriver = createMemoryStateDriver({ lifetime: 'request' });
    const requestDefinition = counterDefinition('request');
    const a = await requestDriver.open(requestDefinition);
    const b = await requestDriver.open(requestDefinition);
    await a.dispatch('incremented', { by: 5 }, { idempotencyKey: 'i1' });
    expect((await b.read()).revision).toBe(0);
  });

  it('reducers receive frozen state, so accidental mutation fails the dispatch', async () => {
    const definition = defineState({
      events: { pushed: z.object({ value: z.string() }).strict() },
      id: 'state-kernel-test/mutating-reducer',
      initial: { values: [] as string[] },
      lifetime: 'process',
      reduce: (state, event) => {
        state.values.push(event.payload.value); // mutation of frozen state throws
        return state;
      },
      schema: z.object({ values: z.array(z.string()) }).strict(),
    });
    const store = await createMemoryStateDriver().open(definition);
    await expect(store.dispatch('pushed', { value: 'x' }, { idempotencyKey: 'p1' })).rejects.toMatchObject({
      code: 'reducer-failure',
      name: 'AgentStateError',
    });
    expect((await store.read()).revision).toBe(0);
  });

  it('driver close closes every registered store', async () => {
    const driver = createMemoryStateDriver();
    const store = await driver.open(counterDefinition());
    await driver.close();
    await expect(store.read()).rejects.toMatchObject({ code: 'store-closed' });
    await expect(driver.open(counterDefinition())).rejects.toMatchObject({ code: 'store-closed' });
  });

  it('driver close finalizes request-scoped stores exactly once', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'request' });
    const store = await driver.open(counterDefinition('request'));
    const closing = driver.close();
    const repeatedClose = driver.close();
    await Promise.all([closing, repeatedClose]);
    await driver.close();
    await store.close();
    await expect(store.read()).rejects.toMatchObject({ code: 'store-closed' });
  });

  it('settles a pending open with store-closed before driver close resolves', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'request' });
    const pendingOpen = driver.open(counterDefinition('request'));
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

    await driver.close();
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
  });
});

describe('request context state slot', () => {
  it('installs a request-bound handle on (await agent()).state', async () => {
    const definition = counterDefinition();
    const store = await createMemoryStateDriver().open(definition);
    const handle = createAgentStateHandle(store);
    await runAgentRequest({ invocation: { kind: 'tool' }, state: handle }, async () => {
      const context = await agent();
      expect(context.state).toBe(handle);
      const committed = await context.state!.dispatch(
        'incremented',
        { by: 3 },
        { idempotencyKey: 'evt-1' },
      );
      expect(committed).toMatchObject({ replayed: false, revision: 1, state: { count: 3 } });
      expect(await context.state!.read()).toEqual({ revision: 1, state: { count: 3 } });
      const batch = await context.state!.changes({ afterRevision: 0 });
      expect(batch.headRevision).toBe(1);
      expect(batch.changes).toHaveLength(1);
    });
    // The slot stays undefined for stateless requests.
    await runAgentRequest({ invocation: { kind: 'tool' } }, async () => {
      expect((await agent()).state).toBeUndefined();
    });
  });

  it('exposes the declared lifetime and folds the request signal into operations', async () => {
    const store = await createMemoryStateDriver().open(counterDefinition());
    const controller = new AbortController();
    const handle = createAgentStateHandle(store, { signal: controller.signal });
    expect(handle.lifetime).toBe('process');
    await handle.dispatch('incremented', { by: 1 }, { idempotencyKey: 'live' });
    controller.abort(new Error('request settled'));
    await expect(handle.read()).rejects.toMatchObject({ code: 'aborted' });
    await expect(
      handle.dispatch('incremented', { by: 1 }, { idempotencyKey: 'dead' }),
    ).rejects.toMatchObject({ code: 'aborted' });
    // A per-call signal still wins over the request signal.
    await expect(
      handle.read({ signal: new AbortController().signal }),
    ).resolves.toEqual({ revision: 1, state: { count: 1 } });
  });

  it('a typed handle satisfies the loosely typed context slot', async () => {
    const store = await createMemoryStateDriver().open(counterDefinition());
    const typed: AgentStateHandle<CounterState, typeof counterEvents> = createAgentStateHandle(store);
    const slot: AgentStateHandle = typed;
    expect(slot.lifetime).toBe('process');
  });
});

describe('explicit migrations', () => {
  const v1 = (): AgentStateDefinition<CounterState, typeof counterEvents> =>
    counterDefinition('process', 'state-kernel-test/migrating');

  const v2Schema = z.object({ count: z.number().int(), unit: z.string() }).strict();

  const v2 = (
    migrate: (persisted: unknown) => unknown = (persisted) => ({
      ...(persisted as CounterState),
      unit: 'edits',
    }),
  ) =>
    defineState({
      events: counterEvents,
      id: 'state-kernel-test/migrating',
      initial: { count: 0, unit: 'edits' },
      lifetime: 'process',
      migrations: { 2: migrate },
      reduce: (state, event) => ({ count: state.count + event.payload.by, unit: state.unit }),
      schema: v2Schema,
      version: 2,
    });

  it('runs the chain on open, records a migrate change, and rebases exact reads', async () => {
    const driver = createMemoryStateDriver();
    const storeV1 = await driver.open(v1());
    await storeV1.dispatch('incremented', { by: 4 }, { idempotencyKey: 'i1' });
    const storeV2 = await driver.open(v2());
    expect(await storeV2.read()).toEqual({ revision: 2, state: { count: 4, unit: 'edits' } });
    const changes = await storeV2.changes({ afterRevision: 0 });
    expect(changes.changes.map((change) => change.kind)).toEqual(['event', 'migrate']);
    await expect(storeV2.read({ revision: 1 })).rejects.toMatchObject({ code: 'revision-unavailable' });
    // Reopening at the same version does not migrate again.
    const again = await driver.open(v2());
    expect((await again.read()).revision).toBe(2);
  });

  it('fails closed when a migration step throws or produces invalid state', async () => {
    const throwingDriver = createMemoryStateDriver();
    await throwingDriver.open(v1());
    await expect(
      throwingDriver.open(
        v2(() => {
          throw new Error('cannot migrate');
        }),
      ),
    ).rejects.toMatchObject({ code: 'migration-failure' });

    const invalidDriver = createMemoryStateDriver();
    await invalidDriver.open(v1());
    await expect(invalidDriver.open(v2(() => ({ wrong: true })))).rejects.toMatchObject({
      code: 'migration-failure',
    });
  });

  it('leaves the process store unchanged when a historical result migration throws', async () => {
    const driver = createMemoryStateDriver();
    const storeV1 = await driver.open(v1());
    await storeV1.dispatch('incremented', { by: 1 }, { idempotencyKey: 'i1' });
    await storeV1.dispatch('incremented', { by: 2 }, { idempotencyKey: 'i2' });
    await storeV1.dispatch('incremented', { by: 3 }, { idempotencyKey: 'i3' });

    await expect(
      driver.open(
        v2((persisted) => {
          const state = persisted as CounterState;
          if (state.count === 3) throw new Error('cannot migrate historical result');
          return { ...state, unit: 'edits' };
        }),
      ),
    ).rejects.toMatchObject({ code: 'migration-failure' });

    expect(await storeV1.read()).toEqual({ revision: 3, state: { count: 6 } });
    expect((await storeV1.changes({ afterRevision: 0 })).changes.map((change) => change.kind)).toEqual([
      'event',
      'event',
      'event',
    ]);
    await expect(
      storeV1.dispatch('incremented', { by: 1 }, { idempotencyKey: 'i1' }),
    ).resolves.toEqual({ replayed: true, revision: 1, state: { count: 1 } });

    const storeV2 = await driver.open(v2());
    expect(await storeV2.read()).toEqual({ revision: 4, state: { count: 6, unit: 'edits' } });
    expect((await storeV2.changes({ afterRevision: 0 })).changes.map((change) => change.kind)).toEqual([
      'event',
      'event',
      'event',
      'migrate',
    ]);
  });

  it('rejects opening a persisted-newer store with an older definition', async () => {
    const driver = createMemoryStateDriver();
    await driver.open(v2());
    await expect(driver.open(v1())).rejects.toMatchObject({ code: 'migration-missing' });
  });
});
