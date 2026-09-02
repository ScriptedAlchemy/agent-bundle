import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import {
  AgentStateError,
  createMemoryStateDriver,
  defineState,
  type AgentStateDriver,
} from '../src/state/index.js';
import { createGeneratedRuntimeState } from '../src/mount/index.js';
import { agent, runAgentRequest } from '../src/index.js';

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
});
