import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import {
  AgentStateError,
  createMemoryStateDriver,
  defineState,
  type AgentStateDriver,
} from '../src/state/index.js';
import { createGeneratedNoticeRuntime, createGeneratedRuntimeState } from '../src/mount/index.js';
import { agentNoticeStateDefinition } from '../src/notices/index.js';
import { agent, available, runAgentRequest } from '../src/index.js';

const definition = (lifetime: 'process' | 'request' = 'process') => defineState({
  events: { incremented: z.object({ by: z.number() }).strict() },
  id: `mount-test/${lifetime}`,
  initial: { count: 0 },
  lifetime,
  reduce: (state, event) => ({ count: state.count + event.payload.by }),
  schema: z.object({ count: z.number() }).strict(),
});

describe('createGeneratedRuntimeState', () => {
  it('lazily opens one process store and one notice store', async () => {
    const inner = createMemoryStateDriver({ lifetime: 'process' });
    let opens = 0;
    const driver: AgentStateDriver = {
      ...inner,
      open: async (stateDefinition) => {
        opens += 1;
        return inner.open(stateDefinition);
      },
    };
    const runtimeState = createGeneratedRuntimeState({ definition: definition(), driver });

    expect(opens).toBe(0);
    const first = await runtimeState.requestBindings();
    const second = await runtimeState.requestBindings();
    expect(opens).toBe(2);

    await first.state.dispatch('incremented', { by: 2 }, { idempotencyKey: 'increment-1' });
    await expect(second.state.read()).resolves.toMatchObject({ state: { count: 2 } });
    await runtimeState.close();
  });

  it('opens and closes fresh stores for each request lifetime binding', async () => {
    const runtimeState = createGeneratedRuntimeState({
      definition: definition('request'),
      driver: createMemoryStateDriver({ lifetime: 'request' }),
    });
    const first = await runtimeState.requestBindings();
    await first.state.dispatch('incremented', { by: 3 }, { idempotencyKey: 'increment-1' });
    await first.close();

    const second = await runtimeState.requestBindings();
    await expect(second.state.read()).resolves.toMatchObject({ state: { count: 0 } });
    await second.close();
    await runtimeState.close();
  });

  it('keeps bindings present but typed-failing when opening is unavailable', async () => {
    const failure = new AgentStateError('unavailable', 'storage is offline');
    let opens = 0;
    let closes = 0;
    const driver: AgentStateDriver = {
      durable: false,
      kind: 'unavailable-test',
      lifetime: 'process',
      close: async () => {
        closes += 1;
      },
      open: async () => {
        opens += 1;
        throw failure;
      },
    };
    const runtimeState = createGeneratedRuntimeState({ definition: definition(), driver });

    const bindings = await runtimeState.requestBindings();
    await expect(bindings.state.read()).rejects.toBe(failure);
    await expect(bindings.noticeLedger.read()).rejects.toBe(failure);
    await runAgentRequest({
      invocation: { kind: 'tool' },
      noticeLedger: bindings.noticeLedger,
      state: bindings.state,
    }, async () => {
      const context = await agent();
      expect(context.state).toBeDefined();
      expect(context.notices).toBeDefined();
      await expect(context.state!.read()).rejects.toBe(failure);
      await expect(context.notices!.read()).rejects.toBe(failure);
    });
    await runtimeState.requestBindings();
    expect(opens).toBe(2);

    await runtimeState.close();
    expect(closes).toBe(1);
  });

  it('closes both stores before closing the driver', async () => {
    const order: string[] = [];
    const inner = createMemoryStateDriver({ lifetime: 'process' });
    const driver: AgentStateDriver = {
      ...inner,
      close: async () => {
        order.push('driver');
        await inner.close();
      },
      open: async (stateDefinition) => {
        const store = await inner.open(stateDefinition);
        return {
          ...store,
          close: async () => {
            order.push(`store:${stateDefinition.id}`);
            await store.close();
          },
        };
      },
    };
    const runtimeState = createGeneratedRuntimeState({ definition: definition(), driver });
    await runtimeState.requestBindings();
    await runtimeState.close();

    expect(order).toEqual([
      'store:mount-test/process',
      'store:@agent-bundle/runtime/agent-notice-ledger/v1',
      'driver',
    ]);
  });

  it('hands out a process-lifetime notice ledger over the same store request scopes mount', async () => {
    const runtimeState = createGeneratedRuntimeState({
      definition: definition(),
      driver: createMemoryStateDriver({ lifetime: 'process' }),
    });
    const bindings = await runtimeState.requestBindings();
    await runAgentRequest({
      actor: available({ id: 'publisher' }, 'native'),
      invocation: { id: 'publish-1', kind: 'tool', startedAt: '2026-09-02T10:00:00.000Z' },
      noticeLedger: bindings.noticeLedger,
    }, async () => (await agent()).notices!.publish({
      content: { root: { kind: 'text', text: 'hello' }, status: 'success', version: 1 },
      priority: 'normal',
      recipient: { session: { sessionId: 's1' } },
    }, { idempotencyKey: 'publish:1' }));

    const ledger = await runtimeState.noticeLedger();
    await expect(ledger.read()).resolves.toMatchObject({ notices: [expect.objectContaining({ state: 'pending' })], revision: 1 });
    await runtimeState.close();
  });

  it('fails the process-lifetime ledger typed for request-lifetime state', async () => {
    const runtimeState = createGeneratedRuntimeState({
      definition: definition('request'),
      driver: createMemoryStateDriver({ lifetime: 'request' }),
    });
    const ledger = await runtimeState.noticeLedger();
    await expect(ledger.read()).rejects.toMatchObject({ code: 'lifetime-mismatch' });
    await runtimeState.close();
  });
});

describe('createGeneratedNoticeRuntime', () => {
  it('opens only the notice store, once, and closes it before the driver', async () => {
    const order: string[] = [];
    const inner = createMemoryStateDriver({ lifetime: 'process' });
    const driver: AgentStateDriver = {
      ...inner,
      close: async () => {
        order.push('driver');
        await inner.close();
      },
      open: async (stateDefinition) => {
        order.push(`open:${stateDefinition.id}`);
        const store = await inner.open(stateDefinition);
        return {
          ...store,
          close: async () => {
            order.push(`close:${stateDefinition.id}`);
            await store.close();
          },
        };
      },
    };
    const runtime = createGeneratedNoticeRuntime({ driver, lifetime: 'process' });
    expect(order).toEqual([]);
    const first = await runtime.noticeLedger();
    const second = await runtime.noticeLedger();
    await expect(first.read()).resolves.toMatchObject({ notices: [], revision: 0 });
    await expect(second.read()).resolves.toMatchObject({ notices: [], revision: 0 });
    await runtime.close();
    expect(order).toEqual([
      `open:${agentNoticeStateDefinition('process').id}`,
      `close:${agentNoticeStateDefinition('process').id}`,
      'driver',
    ]);
  });

  it('shares one durable-style store between a request-scope owner and the server-side runtime', async () => {
    // The memory driver stands in for SQLite here: two owners over one driver
    // instance model the worker and the server process opening the same files.
    const shared = createMemoryStateDriver({ lifetime: 'process' });
    const driver: AgentStateDriver = { ...shared, close: async () => undefined };
    const worker = createGeneratedRuntimeState({ definition: definition(), driver });
    const server = createGeneratedNoticeRuntime({ driver, lifetime: 'process' });
    const bindings = await worker.requestBindings();
    await runAgentRequest({
      actor: available({ id: 'publisher' }, 'native'),
      invocation: { id: 'publish-1', kind: 'tool', startedAt: '2026-09-02T10:00:00.000Z' },
      noticeLedger: bindings.noticeLedger,
    }, async () => (await agent()).notices!.publish({
      content: { root: { kind: 'text', text: 'hello' }, status: 'success', version: 1 },
      priority: 'normal',
      recipient: { session: { sessionId: 's1' } },
    }, { idempotencyKey: 'publish:1' }));

    const ledger = await server.noticeLedger();
    await expect(ledger.read()).resolves.toMatchObject({ revision: 1 });
    await server.close();
    await worker.close();
    await shared.close();
  });

  it('keeps the ledger present but typed-failing when the driver cannot open', async () => {
    const failure = new AgentStateError('unavailable', 'storage is offline');
    let closes = 0;
    const driver: AgentStateDriver = {
      durable: false,
      kind: 'unavailable-test',
      lifetime: 'process',
      close: async () => {
        closes += 1;
      },
      open: async () => {
        throw failure;
      },
    };
    const runtime = createGeneratedNoticeRuntime({ driver, lifetime: 'process' });
    const ledger = await runtime.noticeLedger();
    await expect(ledger.read()).rejects.toBe(failure);
    await expect(ledger.signalAvailability({ at: '2026-09-02T10:00:00.000Z', idempotencyKey: 'a', noticeIds: ['x'] })).rejects.toBe(failure);
    await runtime.close();
    expect(closes).toBe(1);
  });
});
