import { describe, expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_STATES,
  AgentNoticeError,
  selectNoticeDeliveryRoutes,
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
  return { driver, ledger, store };
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
      'acknowledged',
    ]);
    // 'delivered' stays out until a pinned host supplies cross-actor delivery
    // evidence (2026-09-02 survey on #99); 'read'/'available' remain receipts.
    expect(AGENT_NOTICE_STATES).not.toContain('delivered');
    expect(AGENT_NOTICE_STATES).not.toContain('read');
    expect(AGENT_NOTICE_STATES).not.toContain('available');

    const label = (state: AgentNoticeState): string => {
      switch (state) {
        case 'pending':
        case 'attempted':
        case 'expired':
        case 'unavailable':
        case 'withdrawn':
        case 'acknowledged':
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

describe('recipient inbox', () => {
  it('records bounded exposure evidence for an observed re-read', async () => {
    const phases: string[] = [];
    const { driver, ledger } = await openLedger((request) => {
      phases.push(request.phase);
      return { state: 'authorized' };
    });
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-inbox',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('inbox'),
      priority: 'high',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:inbox' }));

    const first = await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-1',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.inbox());
    const second = await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-2',
      kind: 'tool',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.inbox());

    expect(first).toEqual([expect.objectContaining({
      id: published.notice.id,
      state: 'pending',
      exposure: {
        channel: 'mcp-inbox',
        count: 1,
        firstAt: '2026-09-01T19:01:00.000Z',
        lastAt: '2026-09-01T19:01:00.000Z',
        lastInvocationId: 'inbox-1',
      },
    })]);
    expect(second[0]?.exposure).toEqual({
      channel: 'mcp-inbox',
      count: 2,
      firstAt: '2026-09-01T19:01:00.000Z',
      lastAt: '2026-09-01T19:02:00.000Z',
      lastInvocationId: 'inbox-2',
    });
    expect(phases).toEqual(['publish', 'read', 'read']);
    expect((await ledger.read()).notices[0]).toEqual(second[0]);
    await driver.close();
  });

  it('is honestly empty for a non-matching principal', async () => {
    const { driver, ledger } = await openLedger();
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-private',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('private'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:private' }));

    expect(await run(ledger, {
      actorId: 'other',
      id: 'inbox-other',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.inbox())).toEqual([]);
    expect((await ledger.read()).notices[0]).not.toHaveProperty('exposure');
    await driver.close();
  });

  it('filters notices that are expired at read time without transitioning them', async () => {
    const { driver, ledger } = await openLedger();
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-expired-at-read',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('time bounded'),
      expiresAt: '2026-09-01T19:01:00.000Z',
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:expired-at-read' }));

    expect(await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-after-expiry',
      kind: 'tool',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.inbox())).toEqual([]);
    expect((await ledger.read()).notices).toEqual([
      expect.objectContaining({ id: published.notice.id, state: 'pending' }),
    ]);
    await driver.close();
  });

  it('does not mark a read notice attempted before next-event admission', async () => {
    const { driver, ledger } = await openLedger();
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-read-then-event',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('still deliverable'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:read-then-event' }));

    const inbox = await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-before-event',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.inbox());
    expect(inbox[0]).toMatchObject({ id: published.notice.id, state: 'pending' });

    const delivered = await run(ledger, {
      actorId: 'recipient',
      id: 'event-after-inbox',
      kind: 'event',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(delivered[0]).toMatchObject({
      notice: { id: published.notice.id, state: 'attempted' },
      receipt: { invocationId: 'event-after-inbox' },
    });
    await driver.close();
  });

  it('omits read-authorized unavailable notices without exposure', async () => {
    const { driver, ledger } = await openLedger((request) => ({
      state: request.phase === 'read' ? 'unavailable' : 'authorized',
    }));
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-read-unavailable',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('hidden'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:read-unavailable' }));

    expect(await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-unavailable',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.inbox())).toEqual([]);
    expect((await ledger.read()).notices[0]).toMatchObject({ state: 'pending' });
    expect((await ledger.read()).notices[0]).not.toHaveProperty('exposure');
    await driver.close();
  });

  it('fails a throwing read authorizer closed', async () => {
    const { driver, ledger } = await openLedger((request) => {
      if (request.phase === 'read') throw new Error('policy unavailable');
      return { state: 'authorized' };
    });
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-read-throws',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('fail closed'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:read-throws' }));

    await expect(run(ledger, {
      actorId: 'recipient',
      id: 'inbox-throws',
      kind: 'tool',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.inbox())).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect((await ledger.read()).notices[0]).not.toHaveProperty('exposure');
    await driver.close();
  });

  it('excludes attempted, withdrawn, and durably expired notices', async () => {
    const { driver, ledger } = await openLedger();
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-attempted',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('attempted'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:attempted' }));
    await run(ledger, {
      actorId: 'recipient',
      id: 'event-attempted',
      kind: 'event',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.read());
    const withdrawn = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-inbox-withdrawn',
      kind: 'tool',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('withdrawn'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:inbox-withdrawn' }));
    await ledger.withdraw(withdrawn.notice.id, {
      at: '2026-09-01T19:03:00.000Z',
      idempotencyKey: 'withdraw:inbox',
    });
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-inbox-expired',
      kind: 'tool',
      startedAt: '2026-09-01T19:04:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('expired'),
      expiresAt: '2026-09-01T19:05:00.000Z',
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:inbox-expired' }));
    await ledger.expire({
      at: '2026-09-01T19:06:00.000Z',
      idempotencyKey: 'expire:inbox',
    });

    expect(await run(ledger, {
      actorId: 'recipient',
      id: 'inbox-terminal-states',
      kind: 'tool',
      startedAt: '2026-09-01T19:07:00.000Z',
    }, async () => (await agent()).notices!.inbox())).toEqual([]);
    expect((await ledger.read()).notices.map((notice) => notice.state)).toEqual([
      'attempted',
      'withdrawn',
      'expired',
    ]);
    await driver.close();
  });

  it('replays a published journal event without exposure', async () => {
    const { driver, store } = await openLedger();
    await expect(store.dispatch('published', {
      notice: {
        attempts: [],
        content: document('legacy journal'),
        createdAt: '2026-09-01T19:00:00.000Z',
        id: 'notice_legacy',
        priority: 'normal',
        recipient: { actor: { id: 'recipient' } },
        state: 'pending',
      },
    }, {
      idempotencyKey: 'legacy:published',
    })).resolves.toMatchObject({
      state: {
        notices: [expect.not.objectContaining({ exposure: expect.anything() })],
      },
    });
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

  it('replays the same admitted notice set only for the matching principal', async () => {
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
    const otherPrincipal = await run(ledger, {
      ...invocation,
      actorId: 'other',
    }, async () => (await agent()).notices!.read());
    const replay = await run(ledger, invocation, async () => (await agent()).notices!.read());

    expect(first.map(({ notice }) => notice.id)).toEqual([published.notice.id]);
    expect(otherPrincipal).toEqual([]);
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

describe('notice delivery routing receipts (#99 stage 4)', () => {
  const publishTo = async (
    ledger: Awaited<ReturnType<typeof openLedger>>['ledger'],
    extras: Record<string, unknown> = {},
  ) => run(ledger, {
    actorId: 'publisher',
    id: 'publish-1',
    kind: 'tool',
    startedAt: '2026-09-01T19:00:00.000Z',
  }, async () => (await agent()).notices!.publish({
    content: document('coordinate'),
    priority: 'high',
    recipient: { actor: { id: 'recipient' } },
    ...extras,
  }, { idempotencyKey: 'publish:stage4' }));

  it('acknowledges a notice only for its recipient and records the invocation', async () => {
    const { driver, ledger } = await openLedger();
    const published = await publishTo(ledger);

    await expect(run(ledger, {
      actorId: 'intruder',
      id: 'ack-wrong',
      kind: 'event',
      startedAt: '2026-09-01T19:01:00.000Z',
    }, async () => (await agent()).notices!.acknowledge(published.notice.id)))
      .rejects.toMatchObject({ code: 'unauthorized' });

    const acknowledged = await run(ledger, {
      actorId: 'recipient',
      id: 'ack-1',
      kind: 'event',
      startedAt: '2026-09-01T19:02:00.000Z',
    }, async () => (await agent()).notices!.acknowledge(published.notice.id));
    expect(acknowledged.state).toBe('acknowledged');
    expect(acknowledged.acknowledgement).toEqual({
      acknowledgedAt: '2026-09-01T19:02:00.000Z',
      invocationId: 'ack-1',
    });

    await expect(run(ledger, {
      actorId: 'recipient',
      id: 'ack-unknown',
      kind: 'event',
      startedAt: '2026-09-01T19:03:00.000Z',
    }, async () => (await agent()).notices!.acknowledge('notice_missing')))
      .rejects.toMatchObject({ code: 'invalid-input' });
    await driver.close();
  });

  it('re-attempts on later admitted events until the retry budget is exhausted', async () => {
    const { driver, ledger } = await openLedger();
    await publishTo(ledger, { retryBudget: 2 });

    const admit = (id: string, startedAt: string) => run(ledger, {
      actorId: 'recipient',
      id,
      kind: 'event',
      startedAt,
    }, async () => (await agent()).notices!.read());

    const first = await admit('event-1', '2026-09-01T19:05:00.000Z');
    expect(first).toHaveLength(1);
    const second = await admit('event-2', '2026-09-01T19:06:00.000Z');
    expect(second).toHaveLength(1);
    const third = await admit('event-3', '2026-09-01T19:07:00.000Z');
    expect(third).toHaveLength(0);

    const snapshot = await ledger.read();
    expect(snapshot.notices[0]?.attempts.map((attempt) => attempt.invocationId))
      .toEqual(['event-1', 'event-2']);
    expect(snapshot.notices[0]?.state).toBe('attempted');
    await driver.close();
  });

  it('defaults to a single attempt when no retry budget is published', async () => {
    const { driver, ledger } = await openLedger();
    await publishTo(ledger);
    const admit = (id: string, startedAt: string) => run(ledger, {
      actorId: 'recipient',
      id,
      kind: 'event',
      startedAt,
    }, async () => (await agent()).notices!.read());
    expect(await admit('event-1', '2026-09-01T19:05:00.000Z')).toHaveLength(1);
    expect(await admit('event-2', '2026-09-01T19:06:00.000Z')).toHaveLength(0);
    const persisted = (await ledger.read()).notices[0];
    expect(persisted?.retryBudget).toBeUndefined();
    expect(persisted?.attempts).toHaveLength(1);
    await driver.close();
  });

  it('holds admission until nextAttemptAt without implying a timer', async () => {
    const { driver, ledger } = await openLedger();
    await publishTo(ledger, { nextAttemptAt: '2026-09-01T20:00:00.000Z' });
    const admit = (id: string, startedAt: string) => run(ledger, {
      actorId: 'recipient',
      id,
      kind: 'event',
      startedAt,
    }, async () => (await agent()).notices!.read());
    expect(await admit('early', '2026-09-01T19:30:00.000Z')).toHaveLength(0);
    expect((await ledger.read()).notices[0]?.state).toBe('pending');
    expect(await admit('due', '2026-09-01T20:00:00.000Z')).toHaveLength(1);
    await driver.close();
  });

  it('records wire-level availability as a receipt without claiming delivery', async () => {
    const { driver, ledger } = await openLedger();
    const published = await publishTo(ledger);
    const snapshot = await ledger.signalAvailability({
      at: '2026-09-01T19:04:00.000Z',
      idempotencyKey: 'availability:1',
      noticeIds: [published.notice.id],
    });
    const notice = snapshot.notices[0];
    expect(notice?.state).toBe('pending');
    expect(notice?.availability).toEqual({
      channel: 'mcp-resource-updated',
      count: 1,
      firstAt: '2026-09-01T19:04:00.000Z',
      lastAt: '2026-09-01T19:04:00.000Z',
    });
    await expect(ledger.signalAvailability({
      at: '2026-09-01T19:05:00.000Z',
      idempotencyKey: 'availability:empty',
      noticeIds: [],
    })).rejects.toMatchObject({ code: 'invalid-input' });
    await driver.close();
  });

  it('guards availability receipts with compare-and-swap so racing signallers cannot both spend a budget', async () => {
    const { driver, ledger } = await openLedger();
    const published = await publishTo(ledger);
    const stale = (await ledger.read()).revision;
    await ledger.signalAvailability({
      at: '2026-09-01T19:04:00.000Z',
      expectedRevision: stale,
      idempotencyKey: 'availability:a',
      noticeIds: [published.notice.id],
    });
    await expect(ledger.signalAvailability({
      at: '2026-09-01T19:04:01.000Z',
      expectedRevision: stale,
      idempotencyKey: 'availability:b',
      noticeIds: [published.notice.id],
    })).rejects.toMatchObject({ code: 'revision-conflict' });
    await expect(ledger.signalAvailability({
      at: '2026-09-01T19:04:02.000Z',
      expectedRevision: -1,
      idempotencyKey: 'availability:c',
      noticeIds: [published.notice.id],
    })).rejects.toMatchObject({ code: 'invalid-input' });
    expect((await ledger.read()).notices[0]?.availability).toMatchObject({ count: 1 });
    await driver.close();
  });

  it('holds a budget slot with a reservation that finalizes into a receipt or releases without one', async () => {
    const { driver, ledger } = await openLedger();
    const published = await publishTo(ledger);
    const id = published.notice.id;
    const revision = (await ledger.read()).revision;
    const reserved = await ledger.reserveAvailability({
      at: '2026-09-01T19:04:00.000Z',
      expectedRevision: revision,
      idempotencyKey: 'reserve:a',
      noticeIds: [id],
      reservationKey: 'holder-a:1',
    });
    // Reserving spends nothing and is guarded by the same compare-and-swap.
    expect(reserved.notices[0]).toMatchObject({ availabilityReservation: { at: '2026-09-01T19:04:00.000Z', key: 'holder-a:1' } });
    expect(reserved.notices[0]).not.toHaveProperty('availability');
    await expect(ledger.reserveAvailability({
      at: '2026-09-01T19:04:01.000Z',
      expectedRevision: revision,
      idempotencyKey: 'reserve:b',
      noticeIds: [id],
      reservationKey: 'holder-b:1',
    })).rejects.toMatchObject({ code: 'revision-conflict' });

    // Releasing with another holder's key leaves the hold intact; the owner's key clears it.
    const foreignRelease = await ledger.releaseAvailability({
      idempotencyKey: 'release:b',
      noticeIds: [id],
      reservationKey: 'holder-b:1',
    });
    expect(foreignRelease.notices[0]?.availabilityReservation).toMatchObject({ key: 'holder-a:1' });
    const released = await ledger.releaseAvailability({
      idempotencyKey: 'release:a',
      noticeIds: [id],
      reservationKey: 'holder-a:1',
    });
    expect(released.notices[0]).not.toHaveProperty('availabilityReservation');
    expect(released.notices[0]).not.toHaveProperty('availability');

    // A successful send finalizes: the receipt lands and the hold is cleared together.
    await ledger.reserveAvailability({
      at: '2026-09-01T19:05:00.000Z',
      idempotencyKey: 'reserve:c',
      noticeIds: [id],
      reservationKey: 'holder-c:1',
    });
    const signalled = await ledger.signalAvailability({
      at: '2026-09-01T19:05:00.000Z',
      idempotencyKey: 'signal:c',
      noticeIds: [id],
      reservationKey: 'holder-c:1',
    });
    expect(signalled.notices[0]?.availability).toMatchObject({ count: 1, firstAt: '2026-09-01T19:05:00.000Z' });
    expect(signalled.notices[0]).not.toHaveProperty('availabilityReservation');

    for (const invalid of [
      () => ledger.reserveAvailability({ at: 'never', idempotencyKey: 'x', noticeIds: [id], reservationKey: 'k' }),
      () => ledger.reserveAvailability({ at: '2026-09-01T19:06:00.000Z', idempotencyKey: 'y', noticeIds: [], reservationKey: 'k' }),
      () => ledger.reserveAvailability({ at: '2026-09-01T19:06:00.000Z', idempotencyKey: 'z', noticeIds: [id], reservationKey: ' ' }),
      () => ledger.releaseAvailability({ idempotencyKey: 'w', noticeIds: [id], reservationKey: '' }),
    ]) {
      await expect(invalid()).rejects.toMatchObject({ code: 'invalid-input' });
    }
    await driver.close();
  });
});

describe('notice delivery route selection', () => {
  const advertisement = (overrides: Partial<Record<string, { state: 'supported' } | { reason: string; state: 'unavailable' }>> = {}) => ({
    'current-response': { state: 'supported' as const },
    'directed-push': { reason: '2026-09-02: no pinned host documents a directed cross-actor push API.', state: 'unavailable' as const },
    'host-toast': { reason: '2026-09-02: no pinned host documents a plugin-facing toast API.', state: 'unavailable' as const },
    'mcp-inbox': { state: 'supported' as const },
    'mcp-resource-updated': { state: 'supported' as const },
    'next-event': { state: 'supported' as const },
    ...overrides,
  });

  it('selects every supported cross-request route in stable preference order', () => {
    expect(selectNoticeDeliveryRoutes(advertisement())).toEqual({
      kind: 'selected',
      routes: ['mcp-resource-updated', 'mcp-inbox', 'next-event'],
    });
  });

  it('returns the typed unavailable outcome when no cross-request route is supported', () => {
    const unavailable = { reason: '2026-09-02: unavailable.', state: 'unavailable' as const };
    expect(selectNoticeDeliveryRoutes(advertisement({
      'mcp-inbox': unavailable,
      'mcp-resource-updated': unavailable,
      'next-event': unavailable,
    }))).toEqual({ kind: 'unavailable', reason: 'no-supported-cross-request-route' });
  });

  it('fails closed on incomplete advertisements and reasonless unavailability', () => {
    const missing = advertisement();
    delete (missing as Record<string, unknown>)['host-toast'];
    expect(() => selectNoticeDeliveryRoutes(missing as never)).toThrow(/missing route host-toast/u);
    expect(() => selectNoticeDeliveryRoutes(advertisement({
      'directed-push': { reason: '   ', state: 'unavailable' },
    }))).toThrow(/requires a dated reason/u);
  });
});

describe('stage-4 review findings regressions', () => {
  it('expires a retriable attempted notice past its deadline instead of retaining retries', async () => {
    const { driver, ledger } = await openLedger();
    await run(ledger, {
      actorId: 'publisher',
      id: 'publish-exp',
      kind: 'tool',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('deadline'),
      expiresAt: '2026-09-01T19:10:00.000Z',
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
      retryBudget: 3,
    }, { idempotencyKey: 'publish:expiry' }));
    const admit = (id: string, startedAt: string) => run(ledger, {
      actorId: 'recipient',
      id,
      kind: 'event',
      startedAt,
    }, async () => (await agent()).notices!.read());
    expect(await admit('event-1', '2026-09-01T19:05:00.000Z')).toHaveLength(1);
    expect(await admit('event-2', '2026-09-01T19:11:00.000Z')).toHaveLength(0);
    expect((await ledger.read()).notices[0]).toMatchObject({
      expiredAt: '2026-09-01T19:11:00.000Z',
      state: 'expired',
    });
    await driver.close();
  });

  it('rejects acknowledgements from invocations that started before the notice existed', async () => {
    const { driver, ledger } = await openLedger();
    const published = await run(ledger, {
      actorId: 'publisher',
      id: 'publish-late',
      kind: 'tool',
      startedAt: '2026-09-01T19:05:00.000Z',
    }, async () => (await agent()).notices!.publish({
      content: document('late'),
      priority: 'normal',
      recipient: { actor: { id: 'recipient' } },
    }, { idempotencyKey: 'publish:late' }));
    await expect(run(ledger, {
      actorId: 'recipient',
      id: 'ack-early',
      kind: 'event',
      startedAt: '2026-09-01T19:00:00.000Z',
    }, async () => (await agent()).notices!.acknowledge(published.notice.id)))
      .rejects.toMatchObject({ code: 'invalid-input' });
    await driver.close();
  });
});
