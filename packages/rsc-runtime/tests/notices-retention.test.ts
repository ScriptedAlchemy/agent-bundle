import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_DEFAULT_RETENTION,
  AgentNoticeError,
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  noticeSettledAt,
  resolveNoticeRetentionPolicy,
  selectPrunableNotices,
  type AgentNotice,
  type AgentNoticeLedger,
  type AgentNoticeRetentionInput,
} from '../src/notices/index.js';
import {
  agent,
  available,
  runAgentRequest,
} from '../src/index.js';
import { createMemoryStateDriver, type AgentStateDriver, type AgentStateStore } from '../src/state/index.js';
import { createSqliteStateDriver } from '../src/state/sqlite.js';

const document = (text: string) => ({
  root: { kind: 'text' as const, text },
  status: 'success' as const,
  version: 1 as const,
});

const host = available({ name: 'claude' }, 'native');
const session = available({ sessionId: 'session-1' }, 'native');
const workspace = available({ root: '/workspace' }, 'native');

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type NoticeStore = Parameters<typeof createAgentNoticeLedger>[0];

const openLedger = async (
  retention?: AgentNoticeRetentionInput,
  driver: AgentStateDriver = createMemoryStateDriver({ lifetime: 'process' }),
  decorate: (store: NoticeStore) => NoticeStore = (store) => store,
) => {
  const store = decorate(await driver.open(agentNoticeStateDefinition(driver.lifetime)));
  const ledger = createAgentNoticeLedger(store, {
    authorize: () => ({ state: 'authorized' }),
    ...(retention === undefined ? {} : { retention }),
  });
  return { driver, ledger, store };
};

const run = async <T>(
  ledger: AgentNoticeLedger,
  input: { readonly actorId: string; readonly id: string; readonly kind: 'event' | 'tool'; readonly startedAt: string },
  operation: () => Promise<T>,
): Promise<T> => runAgentRequest({
  actor: available({ id: input.actorId }, 'native'),
  host,
  invocation: { id: input.id, kind: input.kind, startedAt: input.startedAt },
  noticeLedger: ledger,
  session,
  workspace,
}, operation);

const publish = (ledger: AgentNoticeLedger, id: string, startedAt: string, recipient = 'recipient') => run(ledger, {
  actorId: 'publisher',
  id: `publish-${id}`,
  kind: 'tool',
  startedAt,
}, async () => (await agent()).notices!.publish({
  content: document(`notice ${id}`),
  dedupeKey: id,
  priority: 'normal',
  recipient: { actor: { id: recipient } },
}, { idempotencyKey: `publish:${id}` }));

const ackFor = (ledger: AgentNoticeLedger, noticeId: string, startedAt: string, invocation: string) => run(ledger, {
  actorId: 'recipient',
  id: invocation,
  kind: 'tool',
  startedAt,
}, async () => (await agent()).notices!.acknowledge(noticeId));

const settledNotice = (id: string, settledAt: string): AgentNotice => Object.freeze({
  acknowledgement: { acknowledgedAt: settledAt, invocationId: 'i' },
  attempts: [],
  content: document(id),
  createdAt: at(0),
  id,
  priority: 'normal',
  recipient: { actor: { id: 'r' } },
  state: 'acknowledged',
});

describe('notice retention policy', () => {
  it('resolves defaults and rejects non-positive or fractional values', () => {
    expect(AGENT_NOTICE_DEFAULT_RETENTION).toEqual({
      maxJournalBytes: 16 * 1024 * 1024,
      maxTerminal: 500,
      terminalTtlMs: 7 * DAY,
    });
    expect(resolveNoticeRetentionPolicy(undefined)).toEqual(AGENT_NOTICE_DEFAULT_RETENTION);
    expect(resolveNoticeRetentionPolicy({ maxTerminal: 3 })).toEqual({ ...AGENT_NOTICE_DEFAULT_RETENTION, maxTerminal: 3 });
    for (const bad of [{ maxTerminal: 0 }, { terminalTtlMs: -1 }, { maxJournalBytes: 1.5 }, { terminalTtlMs: Number.NaN }]) {
      expect(() => resolveNoticeRetentionPolicy(bad)).toThrow(AgentNoticeError);
    }
    expect(() => createAgentNoticeLedger({} as NoticeStore, { authorize: () => ({ state: 'authorized' }), retention: { maxTerminal: 0 } }))
      .toThrow(/maxTerminal must be an integer >= 1/u);
  });

  it('treats exhausted attempts as settled and live work as never prunable', () => {
    const pending: AgentNotice = { ...settledNotice('p', at(0)), acknowledgement: undefined, state: 'pending' };
    expect(noticeSettledAt(pending)).toBeUndefined();
    const attempted: AgentNotice = {
      ...pending,
      attempts: [{ attemptedAt: at(HOUR), channel: 'next-event', invocationId: 'e1' }],
      retryBudget: 2,
      state: 'attempted',
    };
    expect(noticeSettledAt(attempted)).toBeUndefined();
    expect(noticeSettledAt({
      ...attempted,
      attempts: [...attempted.attempts, { attemptedAt: at(2 * HOUR), channel: 'next-event', invocationId: 'e2' }],
    })).toBe(at(2 * HOUR));
    expect(noticeSettledAt({ ...pending, expiredAt: at(3 * HOUR), state: 'expired' })).toBe(at(3 * HOUR));
    expect(noticeSettledAt({ ...pending, state: 'withdrawn', withdrawnAt: at(4 * HOUR) })).toBe(at(4 * HOUR));
    expect(noticeSettledAt({ ...pending, state: 'unavailable', unavailableAt: at(5 * HOUR), unavailableReason: 'delivery-authorization-unavailable' })).toBe(at(5 * HOUR));
  });

  it('selects settled notices past the TTL, then the earliest-settled beyond the cap, deterministically', () => {
    const policy = resolveNoticeRetentionPolicy({ maxTerminal: 2, terminalTtlMs: DAY });
    const notices = [
      settledNotice('old-b', at(0)),
      settledNotice('old-a', at(0)),
      settledNotice('recent-1', at(2 * DAY + HOUR / 2)),
      settledNotice('recent-2', at(2 * DAY + HOUR)),
      settledNotice('recent-3', at(2 * DAY + 2 * HOUR)),
      { ...settledNotice('live', at(0)), acknowledgement: undefined, state: 'pending' as const },
    ];
    // Two days later: the two old ones are past the TTL; three recent remain,
    // one over the cap, so the earliest-settled recent one goes too.
    expect(selectPrunableNotices(notices, policy, at(3 * DAY))).toEqual(['old-a', 'old-b', 'recent-1']);
    expect(selectPrunableNotices(notices, resolveNoticeRetentionPolicy({ terminalTtlMs: DAY }), at(3 * DAY))).toEqual(['old-a', 'old-b']);
    // The cap holds regardless of age; a generous cap with nothing past the TTL prunes nothing.
    expect(selectPrunableNotices(notices, policy, at(HOUR))).toEqual(['old-a', 'old-b', 'recent-1']);
    expect(selectPrunableNotices(notices, resolveNoticeRetentionPolicy({ terminalTtlMs: DAY }), at(HOUR))).toEqual([]);
    expect(selectPrunableNotices(notices, resolveNoticeRetentionPolicy({ maxTerminal: 1, terminalTtlMs: 30 * DAY }), at(3 * DAY)))
      .toEqual(['old-a', 'old-b', 'recent-1', 'recent-2']);
  });
});

describe('ledger retention', () => {
  it('prunes settled notices past the TTL on retain(), records the summary, and replays idempotently', async () => {
    const { driver, ledger } = await openLedger({ terminalTtlMs: DAY });
    const first = await publish(ledger, 'a', at(0));
    const second = await publish(ledger, 'b', at(0));
    await ackFor(ledger, first.notice.id, at(HOUR), 'ack-a');
    await ackFor(ledger, second.notice.id, at(2 * DAY), 'ack-b');
    await publish(ledger, 'live', at(2 * DAY));
    const before = await ledger.read();
    expect(before.retention).toBeUndefined();

    const report = await ledger.retain({ at: at(2 * DAY + HOUR), idempotencyKey: 'retain:1' });
    expect(report.prunedIds).toEqual([first.notice.id]);
    expect(report.compacted).toBe(false);
    expect(report.revision).toBe(before.revision + 1);
    const after = await ledger.read();
    expect(after.notices.map((notice) => notice.id).toSorted()).toEqual([second.notice.id, (await publish(ledger, 'live', at(2 * DAY))).notice.id].toSorted());
    expect(after.retention).toEqual({ lastPrunedAt: at(2 * DAY + HOUR), pruneRuns: 1, prunedTotal: 1 });

    // Same key, same decision: replayed, no new revision.
    const replayed = await ledger.retain({ at: at(2 * DAY + HOUR), idempotencyKey: 'retain:1' });
    expect(replayed.prunedIds).toEqual([]);
    expect(replayed.revision).toBe(after.revision);
    expect((await ledger.read()).retention?.pruneRuns).toBe(1);

    const inspection = await ledger.inspect();
    expect(inspection).toMatchObject({
      counts: { byState: { acknowledged: 1, attempted: 0, expired: 0, pending: 1, unavailable: 0, withdrawn: 0 }, terminal: 1, total: 2 },
      policy: { ...AGENT_NOTICE_DEFAULT_RETENTION, terminalTtlMs: DAY },
      retention: { pruneRuns: 1, prunedTotal: 1 },
      revision: after.revision,
    });
    expect(inspection.journal.records).toBeGreaterThan(0);
    await driver.close();
  });

  it('runs retention on admitted events only, never on tool invocations', async () => {
    const { driver, ledger } = await openLedger({ terminalTtlMs: HOUR });
    const stale = await publish(ledger, 'stale', at(0));
    await ackFor(ledger, stale.notice.id, at(1), 'ack-stale');
    const untouched = await run(ledger, { actorId: 'recipient', id: 'tool-1', kind: 'tool', startedAt: at(DAY) }, async () =>
      (await agent()).notices!.inbox());
    expect(untouched).toEqual([]);
    expect((await ledger.read()).notices).toHaveLength(1);

    await run(ledger, { actorId: 'someone-else', id: 'event-1', kind: 'event', startedAt: at(DAY) }, async () =>
      (await agent()).notices!.read());
    const after = await ledger.read();
    expect(after.notices).toEqual([]);
    expect(after.retention).toEqual({ lastPrunedAt: at(DAY), pruneRuns: 1, prunedTotal: 1 });
    // The same admitted event replayed makes no second prune.
    await run(ledger, { actorId: 'someone-else', id: 'event-1', kind: 'event', startedAt: at(DAY) }, async () =>
      (await agent()).notices!.read());
    expect((await ledger.read()).retention?.pruneRuns).toBe(1);
    await driver.close();
  });

  it('never prunes a notice that is still live at reduce time', async () => {
    const { driver, ledger, store } = await openLedger();
    const live = await publish(ledger, 'live', at(0));
    // A prune decision naming a pending notice is a stale decision: the
    // reducer skips it and records nothing.
    const committed = await store.dispatch('pruned', { at: at(DAY), noticeIds: [live.notice.id, 'notice_missing'] }, { idempotencyKey: 'stale-prune' });
    expect(committed.state.notices.map((notice) => notice.id)).toEqual([live.notice.id]);
    expect(committed.state.retention).toBeUndefined();
    await driver.close();
  });

  it('compacts the journal once it exceeds the byte bound and recovers from a crash between prune and compaction', async () => {
    let failCompactOnce = true;
    const decorate = (store: NoticeStore): NoticeStore => Object.freeze({
      ...store,
      get definition() {
        return store.definition;
      },
      compact: async (options) => {
        if (failCompactOnce) {
          failCompactOnce = false;
          throw new Error('killed mid-compaction');
        }
        return store.compact(options);
      },
    } as NoticeStore);
    const { driver, ledger, store } = await openLedger(
      { maxJournalBytes: 1, terminalTtlMs: HOUR },
      createMemoryStateDriver({ lifetime: 'process' }),
      decorate,
    );
    const stale = await publish(ledger, 'stale', at(0));
    await ackFor(ledger, stale.notice.id, at(1), 'ack');
    const live = await publish(ledger, 'live', at(2 * HOUR));

    // The prune commits, then compaction "crashes": the ledger state is already
    // pruned, the journal is not yet folded.
    await expect(ledger.retain({ at: at(3 * HOUR), idempotencyKey: 'retain:1' })).rejects.toThrow(/killed mid-compaction/u);
    const midway = await ledger.read();
    expect(midway.notices.map((notice) => notice.id)).toEqual([live.notice.id]);
    expect(midway.retention?.prunedTotal).toBe(1);
    expect((await store.inspect()).records).toBeGreaterThan(1);

    // The next pass finds nothing left to prune and finishes the compaction.
    const recovered = await ledger.retain({ at: at(3 * HOUR), idempotencyKey: 'retain:2' });
    expect(recovered.prunedIds).toEqual([]);
    expect(recovered.compacted).toBe(true);
    expect(recovered.journal.records).toBe(1);
    expect(recovered.journal.lastCompaction?.revision).toBe(recovered.revision);
    expect(recovered.revision).toBe(midway.revision + 1);
    const settled = await ledger.read();
    expect(settled.revision).toBe(recovered.revision);
    expect(settled.notices).toEqual(midway.notices);
    expect(settled.retention).toEqual(midway.retention);

    // Compacting again is a no-op: idempotent, no new revision.
    const again = await ledger.retain({ at: at(4 * HOUR), idempotencyKey: 'retain:3' });
    expect(again.compacted).toBe(false);
    expect(again.revision).toBe(recovered.revision);
    // The ledger keeps working past the baseline.
    const later = await publish(ledger, 'later', at(5 * HOUR));
    expect(later.revision).toBe(recovered.revision + 1);
    await driver.close();
  });
});

describe('durable retention', () => {
  it('keeps the SQLite head and journal replay in agreement across compaction and reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-notices-retention-'));
    const file = join(root, 'notices.sqlite');
    try {
      const first = await openLedger({ maxJournalBytes: 1, terminalTtlMs: HOUR }, createSqliteStateDriver({ file }));
      const stale = await publish(first.ledger, 'stale', at(0));
      await ackFor(first.ledger, stale.notice.id, at(1), 'ack');
      const live = await publish(first.ledger, 'live', at(2 * HOUR));
      const report = await first.ledger.retain({ at: at(3 * HOUR), idempotencyKey: 'retain:1' });
      expect(report.prunedIds).toEqual([stale.notice.id]);
      expect(report.compacted).toBe(true);
      expect(report.journal).toMatchObject({ baselineRevision: report.revision, records: 1 });
      const beforeClose = await first.ledger.read();
      await first.driver.close();

      // Reopening runs the kernel's head-vs-journal-replay check, which must
      // accept the compacted journal, and exact reads below the baseline are
      // honestly unavailable.
      const second = await openLedger(undefined, createSqliteStateDriver({ file }));
      const reopened = await second.ledger.read();
      expect(reopened).toEqual(beforeClose);
      expect(reopened.notices.map((notice) => notice.id)).toEqual([live.notice.id]);
      expect(reopened.retention).toEqual({ lastPrunedAt: at(3 * HOUR), pruneRuns: 1, prunedTotal: 1 });
      const inspection = await second.ledger.inspect();
      expect(inspection.journal.lastCompaction?.revision).toBe(report.revision);
      await expect((second.store as AgentStateStore).read({ revision: report.revision - 1 }))
        .rejects.toMatchObject({ code: 'revision-unavailable' });
      // Delivery continues over the compacted store.
      const deliveries = await run(second.ledger, { actorId: 'recipient', id: 'event-1', kind: 'event', startedAt: at(4 * HOUR) }, async () =>
        (await agent()).notices!.read());
      expect(deliveries.map((delivery) => delivery.notice.id)).toEqual([live.notice.id]);
      await second.driver.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
