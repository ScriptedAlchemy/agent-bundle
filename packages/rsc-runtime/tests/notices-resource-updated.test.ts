import { describe, expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_INBOX_URI,
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  createNoticeInboxSignaller,
  type AgentNoticeLedger,
  type AgentNoticePrincipal,
  type AgentNoticePublishInput,
} from '../src/notices/index.js';
import { agent, available, runAgentRequest, unavailable } from '../src/index.js';
import { AgentStateError, createMemoryStateDriver } from '../src/state/index.js';

const document = (text: string) => ({
  root: { kind: 'text' as const, text },
  status: 'success' as const,
  version: 1 as const,
});

const T0 = '2026-09-02T10:00:00.000Z';
const T1 = '2026-09-02T10:01:00.000Z';
const T2 = '2026-09-02T10:02:00.000Z';

const principal = (sessionId: string): AgentNoticePrincipal => Object.freeze({
  actor: unavailable(),
  host: available({ name: 'claude' }, 'native'),
  session: available({ sessionId }, 'native'),
  workspace: available({ root: '/workspace' }, 'native'),
});

const openLedger = async () => {
  const driver = createMemoryStateDriver({ lifetime: 'process' });
  const store = await driver.open(agentNoticeStateDefinition('process'));
  const ledger = createAgentNoticeLedger(store, { authorize: () => ({ state: 'authorized' }) });
  return { driver, ledger, store };
};

let publishes = 0;

const publish = async (
  ledger: AgentNoticeLedger,
  input: Partial<AgentNoticePublishInput> & { readonly sessionId: string },
  startedAt = T0,
) => {
  publishes += 1;
  const { sessionId, ...rest } = input;
  return runAgentRequest({
    actor: available({ id: 'publisher' }, 'native'),
    invocation: { id: `publish-${String(publishes)}`, kind: 'tool', startedAt },
    noticeLedger: ledger,
    workspace: available({ root: '/workspace' }, 'native'),
  }, async () => (await agent()).notices!.publish({
    content: document(`notice ${String(publishes)}`),
    priority: 'normal',
    recipient: { session: { sessionId } },
    ...rest,
  }, { idempotencyKey: `publish:${String(publishes)}` }));
};

const readInbox = async (ledger: AgentNoticeLedger, sessionId: string, startedAt: string) => runAgentRequest({
  host: available({ name: 'claude' }, 'native'),
  invocation: { id: `inbox-${sessionId}-${startedAt}`, kind: 'tool', startedAt },
  noticeLedger: ledger,
  session: available({ sessionId }, 'native'),
  workspace: available({ root: '/workspace' }, 'native'),
}, async () => (await agent()).notices!.inbox());

const sender = () => {
  const sends: string[] = [];
  return {
    send: async (): Promise<void> => {
      sends.push(AGENT_NOTICE_INBOX_URI);
    },
    sends,
  };
};

const signallerOver = (ledger: AgentNoticeLedger, now: () => Date = () => new Date(T1)) =>
  createNoticeInboxSignaller({
    now,
    store: { close: async () => undefined, noticeLedger: async () => ledger },
  });

describe('notice inbox resources/updated signaller', () => {
  it('exposes the reserved inbox URI and starts unsubscribed', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    const { send, sends } = sender();

    expect(signaller.inboxUri).toBe('agent-bundle://notices/inbox');
    expect(signaller.subscribed).toBe(false);
    await publish(ledger, { sessionId: 's1' });
    await expect(signaller.observe(send)).resolves.toEqual({ kind: 'idle', reason: 'no-subscription', revision: undefined });
    expect(sends).toEqual([]);
    await driver.close();
  });

  it('sends exactly one signal per newly eligible notice set and records availability, never delivery', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s1'));
    expect(signaller.subscribed).toBe(true);

    // Nothing pending yet: a subscribed connection with no matching notice is idle.
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });

    const published = await publish(ledger, { sessionId: 's1' });
    const first = await signaller.observe(send);
    expect(first).toEqual({ kind: 'signalled', noticeIds: [published.notice.id], revision: 2 });
    expect(sends).toHaveLength(1);

    const afterSignal = (await ledger.read()).notices.find((notice) => notice.id === published.notice.id);
    expect(afterSignal).toMatchObject({
      availability: { channel: 'mcp-resource-updated', count: 1, firstAt: T1, lastAt: T1 },
      state: 'pending',
    });
    expect(afterSignal?.attempts).toEqual([]);
    expect(afterSignal?.acknowledgement).toBeUndefined();

    // The availability receipt advanced the ledger; that must not re-signal.
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toHaveLength(1);

    // The subscribed client re-reads the inbox (exposure receipt): still no
    // further signal, so the client cannot be driven into a refetch loop.
    const inbox = await readInbox(ledger, 's1', T2);
    expect(inbox).toEqual([expect.objectContaining({ exposure: expect.objectContaining({ count: 1 }), id: published.notice.id })]);
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toHaveLength(1);

    // A second notice yields one more signal carrying only the new id.
    const second = await publish(ledger, { sessionId: 's1' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'signalled', noticeIds: [second.notice.id] });
    expect(sends).toHaveLength(2);
    await driver.close();
  });

  it('never signals a connection whose principal the recipient does not match', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s2'));

    await publish(ledger, { sessionId: 's1' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toEqual([]);
    expect((await ledger.read()).notices[0]?.availability).toBeUndefined();

    // A workspace-only recipient matches any connection observing that workspace.
    await publish(ledger, { recipient: { workspace: { root: '/workspace' } }, sessionId: 'ignored' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'signalled' });
    expect(sends).toHaveLength(1);
    await driver.close();
  });

  it('stops signalling once unsubscribed and resets tracking on re-subscribe', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s1'));
    signaller.unsubscribe();
    expect(signaller.subscribed).toBe(false);

    await publish(ledger, { retryBudget: 2, sessionId: 's1' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'no-subscription' });
    expect(sends).toEqual([]);

    await signaller.subscribe(principal('s1'));
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'signalled' });
    // Same connection re-subscribing is a new subscription: the durable budget
    // (two) still has one signal left, and the in-memory dedupe restarts.
    await signaller.subscribe(principal('s1'));
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'signalled' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toHaveLength(2);
    expect((await ledger.read()).notices[0]?.availability).toMatchObject({ count: 2 });
    await driver.close();
  });

  it('honours retryBudget durably across a restarted server process', async () => {
    const { driver, ledger } = await openLedger();
    const { send, sends } = sender();
    const budgetOne = await publish(ledger, { sessionId: 's1' });
    const budgetTwo = await publish(ledger, { retryBudget: 2, sessionId: 's1' });

    const first = signallerOver(ledger);
    await first.subscribe(principal('s1'));
    await expect(first.observe(send)).resolves.toMatchObject({
      kind: 'signalled',
      noticeIds: [budgetOne.notice.id, budgetTwo.notice.id].toSorted((left, right) => left.localeCompare(right)),
    });

    // A new process: fresh subscription, no in-memory dedupe. Only the notice
    // with budget left is signalled again; the default budget of one is spent.
    const restarted = signallerOver(ledger);
    await restarted.subscribe(principal('s1'));
    await expect(restarted.observe(send)).resolves.toMatchObject({ kind: 'signalled', noticeIds: [budgetTwo.notice.id] });
    const third = signallerOver(ledger);
    await third.subscribe(principal('s1'));
    await expect(third.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toHaveLength(2);

    const notices = (await ledger.read()).notices;
    expect(notices.find((notice) => notice.id === budgetOne.notice.id)?.availability).toMatchObject({ count: 1 });
    expect(notices.find((notice) => notice.id === budgetTwo.notice.id)?.availability).toMatchObject({ count: 2 });
    await driver.close();
  });

  it('defers a notice until nextAttemptAt without implying a timer', async () => {
    const { driver, ledger } = await openLedger();
    let clock = new Date(T1);
    const signaller = signallerOver(ledger, () => clock);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s1'));

    await publish(ledger, { expiresAt: '2026-09-02T11:00:00.000Z', nextAttemptAt: T2, sessionId: 's1' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toEqual([]);

    // The next completed render after the instant is the first evaluation.
    clock = new Date(T2);
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'signalled' });
    expect(sends).toHaveLength(1);
    await driver.close();
  });

  it('skips expired, withdrawn, attempted, acknowledged, and not-yet-created notices', async () => {
    const { driver, ledger } = await openLedger();
    let clock = new Date(T1);
    const signaller = signallerOver(ledger, () => clock);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s1'));

    const expiring = await publish(ledger, { expiresAt: T1, sessionId: 's1' });
    const withdrawn = await publish(ledger, { sessionId: 's1' });
    await ledger.withdraw(withdrawn.notice.id, { at: T1, idempotencyKey: 'withdraw:1' });
    const future = await publish(ledger, { sessionId: 's1' }, T2);
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toEqual([]);
    expect((await ledger.read()).notices.map((notice) => notice.state)).toEqual(['pending', 'withdrawn', 'pending']);
    expect(expiring.notice.state).toBe('pending');

    // Delivered on the recipient's next admitted event: `attempted` leaves the inbox route.
    const admitted = await publish(ledger, { sessionId: 's1' });
    await runAgentRequest({
      host: available({ name: 'claude' }, 'native'),
      invocation: { id: 'event-1', kind: 'event', startedAt: T2 },
      noticeLedger: ledger,
      session: available({ sessionId: 's1' }, 'native'),
      workspace: available({ root: '/workspace' }, 'native'),
    }, async () => {
      const deliveries = await (await agent()).notices!.read();
      expect(deliveries.map((delivery) => delivery.notice.id)).toContain(admitted.notice.id);
      // The future-dated notice is now eligible, so acknowledge it instead.
      await (await agent()).notices!.acknowledge(future.notice.id);
    });
    clock = new Date(T2);
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toEqual([]);
    const states = Object.fromEntries((await ledger.read()).notices.map((notice) => [notice.id, notice.state]));
    expect(states[expiring.notice.id]).toBe('expired');
    expect(states[future.notice.id]).toBe('acknowledged');
    expect(states[admitted.notice.id]).toBe('attempted');
    await driver.close();
  });

  it('serialises concurrent observations so one revision yields one signal', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    const { send, sends } = sender();
    await signaller.subscribe(principal('s1'));
    await publish(ledger, { sessionId: 's1' });

    const outcomes = await Promise.all([signaller.observe(send), signaller.observe(send), signaller.observe(send)]);
    expect(outcomes.filter((outcome) => outcome.kind === 'signalled')).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect((await ledger.read()).notices[0]?.availability).toMatchObject({ count: 1 });
    await driver.close();
  });

  it('claims the durable budget before the wire write, so a failed send never frees a second signal', async () => {
    const { driver, ledger } = await openLedger();
    const signaller = signallerOver(ledger);
    await signaller.subscribe(principal('s1'));
    await publish(ledger, { sessionId: 's1' });

    let sends = 0;
    const send = async (): Promise<void> => {
      sends += 1;
      throw new Error('transport closed');
    };
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'failed', stage: 'send' });
    expect(sends).toBe(1);
    // The receipt records the attempt this connection made; the notice stays
    // pending and readable through the inbox, and the default budget is spent.
    expect((await ledger.read()).notices[0]).toMatchObject({ availability: { count: 1 }, state: 'pending' });
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    const restarted = signallerOver(ledger);
    await restarted.subscribe(principal('s1'));
    await expect(restarted.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toBe(1);
    await driver.close();
  });

  it('lets exactly one of two racing server processes spend a notice budget', async () => {
    const { driver, ledger } = await openLedger();
    await publish(ledger, { sessionId: 's1' });
    const { send, sends } = sender();

    // Process B reads the ledger before process A claims, then stalls until
    // A has committed: its compare-and-swap must lose and its re-read must
    // find the budget already spent.
    let releaseB: () => void = () => undefined;
    const aDone = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let lag = false;
    const laggingLedger: AgentNoticeLedger = Object.freeze({
      ...ledger,
      read: async () => {
        const snapshot = await ledger.read();
        if (lag) {
          lag = false;
          await aDone;
        }
        return snapshot;
      },
    });
    const processA = signallerOver(ledger);
    const processB = signallerOver(laggingLedger);
    await processA.subscribe(principal('s1'));
    await processB.subscribe(principal('s1'));

    lag = true;
    const bObserve = processB.observe(send);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const aOutcome = await processA.observe(send);
    releaseB();
    const bOutcome = await bObserve;

    expect(aOutcome).toMatchObject({ kind: 'signalled' });
    expect(bOutcome).toMatchObject({ kind: 'idle', reason: 'nothing-eligible' });
    expect(sends).toHaveLength(1);
    expect((await ledger.read()).notices[0]?.availability).toMatchObject({ count: 1 });
    await driver.close();
  });

  it('gives up a claim after repeated revision races instead of spinning', async () => {
    const { driver, ledger } = await openLedger();
    await publish(ledger, { sessionId: 's1' });
    let interference = 0;
    // Every read is followed by an unrelated commit before the claim lands.
    const contended: AgentNoticeLedger = Object.freeze({
      ...ledger,
      read: async () => {
        const snapshot = await ledger.read();
        interference += 1;
        await publish(ledger, { sessionId: 'someone-else' });
        return snapshot;
      },
    });
    const signaller = signallerOver(contended);
    await signaller.subscribe(principal('s1'));
    const { send, sends } = sender();
    const outcome = await signaller.observe(send);
    expect(outcome).toMatchObject({ kind: 'failed', stage: 'record' });
    expect(interference).toBeGreaterThanOrEqual(2);
    expect(sends).toEqual([]);
    expect((await ledger.read()).notices[0]?.availability).toBeUndefined();
    await driver.close();
  });

  it('fails closed when the durable store is unavailable', async () => {
    const failure = new AgentStateError('unavailable', 'storage is offline');
    const reject = async <T>(): Promise<T> => Promise.reject(failure);
    const failedLedger: AgentNoticeLedger = Object.freeze({
      expire: reject,
      openRequest: reject,
      read: reject,
      signalAvailability: reject,
      withdraw: reject,
    });
    let closes = 0;
    const signaller = createNoticeInboxSignaller({
      store: {
        close: async () => {
          closes += 1;
        },
        noticeLedger: async () => failedLedger,
      },
    });
    const { send, sends } = sender();

    await expect(signaller.subscribe(principal('s1'))).rejects.toBe(failure);
    expect(signaller.subscribed).toBe(false);
    await expect(signaller.observe(send)).resolves.toMatchObject({ kind: 'idle', reason: 'no-subscription' });
    expect(sends).toEqual([]);

    // A store that fails after subscribing yields a typed read failure, not a phantom signal.
    let readable = true;
    const flaky: AgentNoticeLedger = Object.freeze({
      ...failedLedger,
      read: async () => {
        if (!readable) throw failure;
        return { notices: [], revision: 0 };
      },
    });
    const flakySignaller = createNoticeInboxSignaller({
      store: { close: async () => undefined, noticeLedger: async () => flaky },
    });
    await flakySignaller.subscribe(principal('s1'));
    readable = false;
    await expect(flakySignaller.observe(send)).resolves.toEqual({ error: failure, kind: 'failed', stage: 'read' });
    expect(sends).toEqual([]);

    await signaller.close();
    expect(closes).toBe(1);
  });
});
