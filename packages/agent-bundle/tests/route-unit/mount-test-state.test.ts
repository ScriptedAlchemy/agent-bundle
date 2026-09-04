import { createMemoryStateDriver, defineState } from '@agent-bundle/runtime/state';
import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

import journalStateDefinition from '../../fixtures/route-harness/src/state.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { mountTestState, renderRoute, withTestState } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

type JournalState = typeof journalStateDefinition extends { readonly initial: infer S } ? S : never;

const rejection = async (attempt: Promise<unknown>): Promise<AgentTestError> => {
  try {
    await attempt;
  } catch (thrown: unknown) {
    return thrown as AgentTestError;
  }
  throw new Error('The call resolved, so no harness diagnostic was produced.');
};

/**
 * `mountTestState` (#484) keeps one state owner — project state plus notice
 * ledger — alive across several renders, where `renderRoute` on its own
 * mounts and closes a fresh owner per render.
 */
describe('mountTestState', () => {
  it('carries the manifest state and its notice ledger across renders, then reads both back', async () => {
    const mounted = await mountTestState<JournalState>();
    try {
      await renderRoute('tool:harness/journal', { context: mounted.context(), input: { note: 'first' } });
      const second = await renderRoute('tool:harness/journal', { context: mounted.context(), input: { note: 'second' } });
      expectDocument(second).toHaveValue({ entries: [{ note: 'first' }, { note: 'second' }], revision: 2 });

      const published = await renderRoute('tool:harness/publish-notice', {
        context: { ...mounted.context(), session: { source: 'native', state: 'available', value: { sessionId: 'sess-a' } } },
        input: { message: 'shared ledger', recipientSession: 'sess-b' },
      });
      expectDocument(published).toHaveStatus('success');

      // The typed snapshot is the owner's, not a per-render copy.
      const snapshot = await mounted.read();
      expect(snapshot.revision).toBe(2);
      expect(snapshot.state.entries).toEqual([{ note: 'first' }, { note: 'second' }]);
      const notices = await mounted.notices();
      expect(notices.notices).toEqual([expect.objectContaining({
        id: (published.result as { noticeId: string }).noticeId,
        state: 'pending',
      })]);

      // A render that omits the mounted handles still gets its own isolated owner.
      const isolated = await renderRoute('tool:harness/journal');
      expectDocument(isolated).toHaveValue({ entries: [], revision: 0 });
    } finally {
      await mounted.close();
    }
  });

  it('closes idempotently, after which the handles are closed too', async () => {
    const mounted = await mountTestState();
    const rendered = await renderRoute('tool:harness/journal', { context: mounted.context(), input: { note: 'x' } });
    expectDocument(rendered).toHaveStatus('success');
    await mounted.close();
    await mounted.close();
    await expect(mounted.read()).rejects.toThrow();
    await expect(mounted.notices()).rejects.toThrow();
  });

  it('mounts an explicit definition over the driver its lifetime selects, typing read() from it', async () => {
    const definition = defineState({
      events: { bumped: z.object({ by: z.number() }).strict() },
      id: 'route-harness/counter',
      initial: { count: 0 },
      lifetime: 'process',
      reduce: (state, event) => ({ count: state.count + event.payload.by }),
      schema: z.object({ count: z.number() }).strict(),
    });
    await withTestState(async (counter) => {
      await counter.state.dispatch('bumped', { by: 2 }, { idempotencyKey: 'bump:1' });
      await counter.state.dispatch('bumped', { by: 3 }, { idempotencyKey: 'bump:2' });
      const snapshot = await counter.read();
      const count: number = snapshot.state.count;
      expect(count).toBe(5);
      expect(counter.state.lifetime).toBe('process');
    }, { definition });
  });

  it('uses and closes a caller-supplied driver', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const definition = defineState({ ...journalStateDefinition, lifetime: 'process' });
    const mounted = await mountTestState({ definition, driver });
    await mounted.state.dispatch('recorded', { note: 'own driver' }, { idempotencyKey: 'own:1' });
    expect((await mounted.read()).state.entries).toEqual([{ note: 'own driver' }]);
    await mounted.close();
    await expect(driver.open(definition)).rejects.toThrow();
  });

  it('closes the mounted state when the scoped callback throws', async () => {
    let seen: Awaited<ReturnType<typeof mountTestState>> | undefined;
    await expect(withTestState(async (state) => {
      seen = state;
      throw new Error('journey failed');
    })).rejects.toThrow('journey failed');
    await expect(seen!.read()).rejects.toThrow();
  });

  it('refuses a manifest that declares no state, naming the recovery', async () => {
    const manifest = { ...testManifest(), state: undefined };
    const error = await rejection(mountTestState({ manifest }));
    expect(error).toBeInstanceOf(AgentTestError);
    expect(error.code).toBe('manifest-unavailable');
    expect(error.message).toContain('declares no state');
    expect(error.message).toContain('options.definition');
  });

  it('refuses an external-lifetime definition without a driver', async () => {
    const definition = defineState({ ...journalStateDefinition, lifetime: 'external' });
    const error = await rejection(mountTestState({ definition }));
    expect(error.code).toBe('invalid-input');
    expect(error.message).toContain('options.driver');
  });
});
