import { describe, expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_STATES,
  AgentNoticeError,
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeAuthorizationRequest,
  type AgentNoticeState,
} from '../src/notices/index.js';
import {
  agent,
  available,
  runAgentRequest,
} from '../src/index.js';
import { createMemoryStateDriver } from '../src/state/index.js';

const document = (text: string) => ({
  root: { kind: 'text' as const, text },
  status: 'success' as const,
  version: 1 as const,
});

const actor = (id: string) => available({ id }, 'native');
const host = available({ name: 'claude' }, 'native');
const session = available({ sessionId: 'session-1' }, 'native');
const workspace = available({ root: '/workspace' }, 'native');

const openLedger = async (
  authorize: (request: AgentNoticeAuthorizationRequest) =>
    | { readonly state: 'authorized' | 'unavailable' }
    | Promise<{ readonly state: 'authorized' | 'unavailable' }> =
    () => ({ state: 'authorized' }),
) => {
  const driver = createMemoryStateDriver({ lifetime: 'process' });
  const store = await driver.open(agentNoticeStateDefinition('process'));
  const ledger = createAgentNoticeLedger(store, { authorize });
  return { driver, ledger };
};

const run = async <T>(
  ledger: Awaited<ReturnType<typeof openLedger>>['ledger'],
  input: {
    readonly actorId: string;
    readonly id: string;
    readonly kind: 'event' | 'tool';
    readonly startedAt: string;
  },
  operation: () => Promise<T>,
): Promise<T> => runAgentRequest({
  actor: actor(input.actorId),
  host,
  invocation: {
    id: input.id,
    kind: input.kind,
    startedAt: input.startedAt,
  },
  noticeLedger: ledger,
  session,
  workspace,
}, operation);

describe('notice state taxonomy', () => {
  it('declares only framework-evidenced v1 states', () => {
    expect(AGENT_NOTICE_STATES).toEqual([
      'pending',
      'attempted',
      'expired',
      'unavailable',
      'withdrawn',
    ]);
    expect(AGENT_NOTICE_STATES).not.toContain('delivered');
    expect(AGENT_NOTICE_STATES).not.toContain('read');
    expect(AGENT_NOTICE_STATES).not.toContain('acknowledged');

    const label = (state: AgentNoticeState): string => {
      switch (state) {
        case 'pending':
        case 'attempted':
        case 'expired':
        case 'unavailable':
        case 'withdrawn':
          return state;
        default: {
          const exhaustive: never = state;
          return exhaustive;
        }
      }
    };
    expect(AGENT_NOTICE_STATES.map(label)).toEqual(AGENT_NOTICE_STATES);
  });
});

describe('durable notice ledger', () => {
  it('publishes a detached finite snapshot and dedupes atomically by recipient key', async () => {
    const { driver, ledger } = await openLedger();
    const source = document('original');
    const first = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-1',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: source,
      dedupeKey: 'conflict:file-a',
      priority: 'high',
      recipient: {
        actor: { id: 'recipient' },
        workspace: { root: '/workspace' },
      },
    }, { idempotencyKey: 'publish:1' }));

    (source.root as { text: string }).text = 'mutated';
    const second = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-2',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('duplicate content is not persisted'),
      dedupeKey: 'conflict:file-a',
      priority: 'low',
      recipient: {
        actor: { id: 'recipient' },
        workspace: { root: '/workspace' },
      },
    }, { idempotencyKey: 'publish:2' }));

    expect(first).toMatchObject({ deduped: false, replayed: false });
    expect(second).toMatchObject({ deduped: true, notice: { id: first.notice.id } });
    expect((await ledger.read()).notices).toHaveLength(1);
    expect(first.notice.content.root).toEqual({ kind: 'text', text: 'original' });
    expect(Object.isFrozen(first.notice)).toBe(true);
    expect(Object.isFrozen(first.notice.content)).toBe(true);
    expect(Object.isFrozen(first.notice.content.root)).toBe(true);
    await driver.close();
  });

  it('expires and withdraws pending notices without inventing stronger states', async () => {
    const { driver, ledger } = await openLedger();
    const expiring = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-expiring',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('expires'),
      expiresAt: '2026-09-01T19:05:00.000Z',
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:expiring' }));
    const withdrawn = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-withdrawn',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:01.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('withdrawn'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:withdrawn' }));

    await ledger.withdraw(withdrawn.notice.id, {
      at: '2026-09-01T19:03:00.000Z',
      idempotencyKey: 'withdraw:1',
    });
    await ledger.expire({
      at: '2026-09-01T19:06:00.000Z',
      idempotencyKey: 'expire:1',
    });

    const snapshot = await ledger.read();
    expect(snapshot.notices.find((notice) => notice.id === expiring.notice.id)?.state).toBe('expired');
    expect(snapshot.notices.find((notice) => notice.id === withdrawn.notice.id)?.state).toBe('withdrawn');
    await driver.close();
  });

  it('fails publish authorization before persistence', async () => {
    const phases: string[] = [];
    const { driver, ledger } = await openLedger((request) => {
      phases.push(request.phase);
      return { state: 'unavailable' };
    });

    await expect(run(ledger, {
      actorId: 'publisher',
      id: 'publish-denied',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('denied'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:denied' }))).rejects.toBeInstanceOf(AgentNoticeError);
    expect(phases).toEqual(['publish']);
    expect((await ledger.read()).notices).toEqual([]);
    await driver.close();
  });
});

describe('next-event delivery', () => {
  it('exposes only matching pending notices and records an attempted receipt', async () => {
    const phases: string[] = [];
    const { driver, ledger } = await openLedger((request) => {
      phases.push(request.phase);
      return { state: 'authorized' };
    });
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('next event'),
      priority: 'high',
      recipient: {
        actor: { id: 'recipient' },
        host: { name: 'claude' },
        session: { sessionId: 'session-1' },
        workspace: { root: '/workspace' },
      },
    }, { idempotencyKey: 'publish:next' }));

    const wrongActor = await run(ledger, {
      actorId: 'other',
      id: 'event-other',
      kind: 'event',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(wrongActor).toEqual([]);
    expect(await ledger.read()).toMatchObject({
      notices: [expect.objectContaining({ state: 'pending' })],
      revision: 1,
    });

    const observed = await run(ledger, {
      actorId: 'recipient',
      id: 'event-recipient',
      kind: 'event',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(observed).toEqual([expect.objectContaining({
      notice: expect.objectContaining({
        id: published.notice.id,
        state: 'attempted',
      }),
      receipt: {
        attemptedAt: '2026-09-01T19:02:00.000Z',
        channel: 'next-event',
        invocationId: 'event-recipient',
      },
    })]);
    expect(phases).toEqual(['publish', 'deliver']);
    expect((await ledger.read()).notices[0]).toMatchObject({
      attempts: [{ invocationId: 'event-recipient' }],
      state: 'attempted',
    });
    await driver.close();
  });

  it('replays the same admitted notice set for the same invocation id', async () => {
    const { driver, ledger } = await openLedger();
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-replay',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('replay'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:replay' }));
    const invocation = {
      actorId: 'recipient',
      id: 'event-replay',
      kind: 'event' as const,
      startedAt: '2026-09-01T19:02:00.000Z',
    };

    const first = await run(ledger, invocation, async () => (await agent()).notices!.read());
    const replay = await run(ledger, invocation, async () => (await agent()).notices!.read());

    expect(first.map(({ notice }) => notice.id)).toEqual([published.notice.id]);
    expect(replay.map(({ notice }) => notice.id)).toEqual(
      first.map(({ notice }) => notice.id),
    );
    await driver.close();
  });

  it('does not admit notices created after the event started', async () => {
    const { driver, ledger } = await openLedger();
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-future',
      kind: 'tool',
      startedAt: '2026-09-01T19:10:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('future'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:future' }));

    const observed = await run(ledger, {
      actorId: 'recipient',
      id: 'event-before-publish',
      kind: 'event',
      startedAt: '2026-09-01T19:05:00.000Z',
    }, async () => (await agent()).notices!.read());

    expect(observed).toEqual([]);
    expect((await ledger.read()).notices[0]?.state).toBe('pending');
    await driver.close();
  });

  it('interrupts delivery authorization when the request is aborted', { timeout: 5_000 }, async () => {
    let authorizationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authorizationStarted = resolve;
    });
    const { driver, ledger } = await openLedger((request) => {
      if (request.phase === 'publish') return { state: 'authorized' };
      authorizationStarted();
      return new Promise(() => undefined);
    });
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-abort',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('abort'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:abort' }));
    const controller = new AbortController();
    const opening = runAgentRequest({
      actor: actor('recipient'),
      host,
      invocation: {
        id: 'event-abort',
        kind: 'event',
        startedAt: '2026-09-01T19:02:00.000Z',
      },
      noticeLedger: ledger,
      session,
      signal: controller.signal,
      workspace,
    }, async () => (await agent()).notices!.read());

    await started;
    controller.abort('test abort');
    const guarded = Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        AbortSignal.timeout(1_000).addEventListener('abort', () => {
          reject(new Error('Timed out waiting for authorization interruption'));
        }, { once: true });
      }),
    ]);

    await expect(guarded).rejects.toMatchObject({ name: 'AbortError' });
    await driver.close();
  });

  it('marks a matched notice unavailable when delivery-time authorization is unavailable', async () => {
    const { driver, ledger } = await openLedger((request) => ({
      state: request.phase === 'publish' ? 'authorized' : 'unavailable',
    }));
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('not authorized later'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:unavailable' }));

    const observed = await run(ledger, {
      actorId: 'recipient',
      id: 'event-recipient',
      kind: 'event',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(observed).toEqual([]);
    expect((await ledger.read()).notices[0]).toMatchObject({
      state: 'unavailable',
      unavailableAt: '2026-09-01T19:02:00.000Z',
      unavailableReason: 'delivery-authorization-unavailable',
    });
    await driver.close();
  });

  it('does not attempt delivery during non-event invocations', async () => {
    const { driver, ledger } = await openLedger();
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('wait'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:wait' }));

    expect(await run(ledger, {
      actorId: 'recipient',
      id: 'tool-recipient',
      kind: 'tool',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.read())).toEqual([]);
    expect((await ledger.read()).notices[0]?.state).toBe('pending');
    await driver.close();
  });
});
