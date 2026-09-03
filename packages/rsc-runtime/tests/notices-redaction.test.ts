import { describe, expect, it } from '@rstest/core';

import {
  AGENT_NOTICE_DEFAULT_SENSITIVITY,
  AGENT_NOTICE_DELIVERY_ROUTES,
  AGENT_NOTICE_ROUTE_SHAPES,
  AGENT_NOTICE_SENSITIVITIES,
  AgentNoticeError,
  NOTICE_REDACTION_MARK,
  agentNoticeStateDefinition,
  containsSecretText,
  createAgentNoticeLedger,
  createNoticeInboxSignaller,
  disclosedNoticeContent,
  noticeTitle,
  redactNoticeDocument,
  redactSecretText,
  resolveNoticeDisclosure,
  routeSensitivityCeiling,
  selectNoticeDeliveryRoutes,
  type AgentNoticeDeliveryAdvertisement,
  type AgentNoticeDeliveryRoute,
  type AgentNoticeSensitivity,
  type AgentNoticePrincipal,
} from '../src/notices/index.js';
import type { AgentDocumentSnapshot } from '../src/index.js';
import {
  agent,
  available,
  runAgentRequest,
  unavailable,
} from '../src/index.js';
import { createMemoryStateDriver } from '../src/state/index.js';

const document = (text: string): AgentDocumentSnapshot => ({
  root: { kind: 'text' as const, text },
  status: 'success' as const,
  version: 1 as const,
});

const actor = (id: string) => available({ id }, 'native');
const host = available({ name: 'claude' }, 'native');
const session = available({ sessionId: 'session-1' }, 'native');
const workspace = available({ root: '/workspace' }, 'native');

/** Every route supported; each names the ceiling given (absent = pre-sensitivity contract). */
const advertisement = (
  ceilings: Partial<Record<AgentNoticeDeliveryRoute, AgentNoticeSensitivity | 'unavailable'>>,
): AgentNoticeDeliveryAdvertisement => Object.fromEntries(AGENT_NOTICE_DELIVERY_ROUTES.map((route) => {
  const ceiling = ceilings[route];
  if (ceiling === 'unavailable') return [route, { reason: '2026-09-03: fixture', state: 'unavailable' }];
  return [route, ceiling === undefined ? { state: 'supported' } : { sensitivity: ceiling, state: 'supported' }];
})) as AgentNoticeDeliveryAdvertisement;

const openLedger = async (delivery?: AgentNoticeDeliveryAdvertisement) => {
  const driver = createMemoryStateDriver({ lifetime: 'process' });
  const store = await driver.open(agentNoticeStateDefinition('process'));
  const ledger = createAgentNoticeLedger(store, {
    authorize: () => ({ state: 'authorized' }),
    ...(delivery === undefined ? {} : { delivery }),
  });
  return { driver, ledger, store };
};

const run = async <T>(
  ledger: Awaited<ReturnType<typeof openLedger>>['ledger'],
  input: { readonly actorId: string; readonly id: string; readonly kind: 'event' | 'tool'; readonly startedAt: string },
  operation: () => Promise<T>,
): Promise<T> => runAgentRequest({
  actor: actor(input.actorId),
  host,
  invocation: { id: input.id, kind: input.kind, startedAt: input.startedAt },
  noticeLedger: ledger,
  session,
  workspace,
}, operation);

const SECRET_TEXT = 'Rotate token=abc123def456 before https://ops:hunter2@vault.example.test/x and sk-ant-0123456789abcdef0123';

const publish = (
  ledger: Awaited<ReturnType<typeof openLedger>>['ledger'],
  input: { readonly id: string; readonly sensitivity?: AgentNoticeSensitivity; readonly text?: string },
) => run(ledger, {
  actorId: 'publisher',
  id: `publish-${input.id}`,
  kind: 'tool',
  startedAt: '2026-09-03T10:00:00.000Z',
}, async () => (await agent()).notices!.publish({
  content: document(input.text ?? SECRET_TEXT),
  dedupeKey: input.id,
  priority: 'normal',
  recipient: { actor: { id: 'recipient' } },
  ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
}, { idempotencyKey: `publish:${input.id}` }));

describe('secret-pattern redaction', () => {
  it('masks credential assignments, provider tokens, and URL userinfo while keeping structure', () => {
    const redacted = redactSecretText(SECRET_TEXT);
    expect(redacted).toBe(
      `Rotate token=${NOTICE_REDACTION_MARK} before https://${NOTICE_REDACTION_MARK}@vault.example.test/x and ${NOTICE_REDACTION_MARK}`,
    );
    expect(containsSecretText(SECRET_TEXT)).toBe(true);
    expect(containsSecretText('Another worktree is editing /repo/src/secrets.ts')).toBe(false);
    // Idempotent: a redacted text is a fixed point.
    expect(redactSecretText(redacted)).toBe(redacted);
    // Quotes are preserved around the mask so JSON-shaped text stays parseable.
    expect(redactSecretText('{"api_key": "xyz", "note": "keep"}')).toBe(`{"api_key": "${NOTICE_REDACTION_MARK}", "note": "keep"}`);
  });

  it('redacts every prose field of a document and nothing else', () => {
    const snapshot: AgentDocumentSnapshot = {
      root: {
        children: [
          { kind: 'markdown', text: 'password: p4ss' },
          { kind: 'context', text: 'clean' },
          { kind: 'json', value: { auth: { password: 'hunter2', user: 'ops' }, nested: ['token: t0k3n', 1, true, null], plain: 'ok', authorization: ['a', 'b'] } },
          { completed: 1, kind: 'progress', message: 'secret=abc', total: 2 },
          { data: 'QUJD', kind: 'image', mimeType: 'image/png' },
          { kind: 'resource', mimeType: 'text/plain', name: 'token: n', uri: 'https://u:p@h.example.test/r' },
          { code: 'E_SECRET', kind: 'error', message: 'authorization: Bearer abcdefghijklmnopqrstuvwxyz' },
        ],
        kind: 'result',
        metadata: { credential: 'x' },
      },
      status: 'success',
      value: { secret: 'v' },
      version: 1,
    };
    const redacted = redactNoticeDocument(snapshot);
    expect(redacted).toEqual({
      root: {
        children: [
          { kind: 'markdown', text: `password: ${NOTICE_REDACTION_MARK}` },
          { kind: 'context', text: 'clean' },
          // A value under a credential-shaped key is a credential by position:
          // masked whole, recursively, whatever its text looks like.
          {
            kind: 'json',
            value: {
              auth: { password: NOTICE_REDACTION_MARK, user: 'ops' },
              nested: [`token: ${NOTICE_REDACTION_MARK}`, 1, true, null],
              plain: 'ok',
              authorization: [NOTICE_REDACTION_MARK, NOTICE_REDACTION_MARK],
            },
          },
          { completed: 1, kind: 'progress', message: `secret=${NOTICE_REDACTION_MARK}`, total: 2 },
          { data: 'QUJD', kind: 'image', mimeType: 'image/png' },
          { kind: 'resource', mimeType: 'text/plain', name: `token: ${NOTICE_REDACTION_MARK}`, uri: `https://${NOTICE_REDACTION_MARK}@h.example.test/r` },
          { code: 'E_SECRET', kind: 'error', message: `authorization: ${NOTICE_REDACTION_MARK}` },
        ],
        kind: 'result',
        metadata: { credential: NOTICE_REDACTION_MARK },
      },
      status: 'success',
      value: { secret: NOTICE_REDACTION_MARK },
      version: 1,
    });
    expect(Object.isFrozen(redacted.root)).toBe(true);
    // The original is untouched: redaction is applied on egress, never in place.
    expect((snapshot.root as { children: readonly { text?: string }[] }).children[0]!.text).toBe('password: p4ss');
  });

  it('projects a bounded single-line title for title-only routes', () => {
    expect(noticeTitle(document('  \n First line here\nsecond'))).toBe('First line here');
    expect(noticeTitle(document('x'.repeat(200))).length).toBe(120);
    expect(noticeTitle({ root: { kind: 'json', value: 1 }, status: 'success', version: 1 })).toBe('');
    const title = disclosedNoticeContent(document(SECRET_TEXT), { kind: 'disclosed', redacted: true, shape: 'title' });
    expect(title).toEqual(document(redactSecretText(SECRET_TEXT)));
    expect(disclosedNoticeContent(document('x'), { kind: 'disclosed', redacted: false, shape: 'signal' })).toBeUndefined();
  });
});

describe('route disclosure decisions', () => {
  it('spells the sensitivity vocabulary and the per-route shapes', () => {
    expect(AGENT_NOTICE_SENSITIVITIES).toEqual(['public', 'internal', 'secret']);
    expect(AGENT_NOTICE_DEFAULT_SENSITIVITY).toBe('internal');
    expect(AGENT_NOTICE_ROUTE_SHAPES).toEqual({
      'current-response': 'body',
      'directed-push': 'body',
      'host-toast': 'title',
      'mcp-inbox': 'body',
      'mcp-resource-updated': 'signal',
      'next-event': 'body',
    });
  });

  it('withholds above the row ceiling, redacts internal, passes public and admitted secret verbatim', () => {
    const rows = advertisement({ 'host-toast': 'public', 'mcp-inbox': 'internal', 'next-event': 'secret' });
    expect(resolveNoticeDisclosure('mcp-inbox', 'secret', rows)).toEqual({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
    expect(resolveNoticeDisclosure('mcp-inbox', 'internal', rows)).toEqual({ kind: 'disclosed', redacted: true, shape: 'body' });
    expect(resolveNoticeDisclosure('mcp-inbox', 'public', rows)).toEqual({ kind: 'disclosed', redacted: false, shape: 'body' });
    expect(resolveNoticeDisclosure('next-event', 'secret', rows)).toEqual({ kind: 'disclosed', redacted: false, shape: 'body' });
    expect(resolveNoticeDisclosure('host-toast', 'internal', rows)).toEqual({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
    expect(resolveNoticeDisclosure('host-toast', 'public', rows)).toEqual({ kind: 'disclosed', redacted: false, shape: 'title' });
    // Absent row field and absent advertisement both mean the pre-sensitivity contract: internal, not secret.
    expect(resolveNoticeDisclosure('mcp-resource-updated', 'internal', rows)).toEqual({ kind: 'disclosed', redacted: true, shape: 'signal' });
    expect(resolveNoticeDisclosure('mcp-resource-updated', 'secret', rows)).toEqual({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
    expect(resolveNoticeDisclosure('directed-push', 'internal', undefined)).toEqual({ kind: 'disclosed', redacted: true, shape: 'body' });
    expect(resolveNoticeDisclosure('directed-push', 'secret', undefined)).toEqual({ kind: 'withheld', reason: 'sensitivity-exceeds-route' });
    // Unsupported routes withhold everything, public included.
    const noToast = advertisement({ 'host-toast': 'unavailable' });
    expect(resolveNoticeDisclosure('host-toast', 'public', noToast)).toEqual({ kind: 'withheld', reason: 'route-unavailable' });
  });

  it('fails closed on an unknown sensitivity in a row', async () => {
    const rows = { ...advertisement({}), 'mcp-inbox': { sensitivity: 'top-secret', state: 'supported' } } as unknown as AgentNoticeDeliveryAdvertisement;
    expect(() => selectNoticeDeliveryRoutes(rows)).toThrow(AgentNoticeError);
    expect(() => selectNoticeDeliveryRoutes(rows)).toThrow(/unknown sensitivity "top-secret"/u);
    // A JavaScript embedder's typo never compares as a ceiling: the row admits
    // nothing, and the ledger and signaller refuse the advertisement outright.
    expect(routeSensitivityCeiling(rows['mcp-inbox'])).toBeUndefined();
    for (const sensitivity of AGENT_NOTICE_SENSITIVITIES) {
      expect(resolveNoticeDisclosure('mcp-inbox', sensitivity, rows)).toEqual({ kind: 'withheld', reason: 'route-unavailable' });
    }
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentNoticeStateDefinition('process'));
    expect(() => createAgentNoticeLedger(store, { authorize: () => ({ state: 'authorized' }), delivery: rows }))
      .toThrow(/unknown sensitivity "top-secret"/u);
    expect(() => createNoticeInboxSignaller({
      delivery: rows,
      store: { close: async () => undefined, noticeLedger: async () => { throw new Error('unused'); } },
    })).toThrow(/unknown sensitivity "top-secret"/u);
    await driver.close();
  });
});

describe('ledger disclosure through the inbox and next-event routes', () => {
  it('rejects an unknown sensitivity at publish before persistence', async () => {
    const { driver, ledger } = await openLedger();
    await expect(publish(ledger, { id: 'bad', sensitivity: 'loud' as AgentNoticeSensitivity }))
      .rejects.toMatchObject({ code: 'invalid-input', name: 'AgentNoticeError' });
    expect((await ledger.read()).notices).toEqual([]);
    await driver.close();
  });

  it('persists the authored content and discloses redacted, full, or nothing per class in the inbox', async () => {
    const { driver, ledger } = await openLedger(advertisement({ 'mcp-inbox': 'internal' }));
    const internal = await publish(ledger, { id: 'internal' });
    const explicit = await publish(ledger, { id: 'public', sensitivity: 'public' });
    const secret = await publish(ledger, { id: 'secret', sensitivity: 'secret' });
    expect(internal.notice.sensitivity).toBe('internal');
    // The store keeps what the author wrote; redaction happens on egress.
    const persisted = await ledger.read();
    expect(persisted.notices.map((notice) => (notice.content.root as { text: string }).text)).toEqual([
      SECRET_TEXT,
      SECRET_TEXT,
      SECRET_TEXT,
    ]);

    const inbox = await run(ledger, {
      actorId: 'recipient',
      id: 'read-1',
      kind: 'tool',
      startedAt: '2026-09-03T10:05:00.000Z',
    }, async () => (await agent()).notices!.inbox());
    expect(inbox.map((notice) => [notice.id, (notice.content.root as { text: string }).text]).toSorted()).toEqual([
      [internal.notice.id, redactSecretText(SECRET_TEXT)],
      [explicit.notice.id, SECRET_TEXT],
    ].toSorted());
    expect(inbox.map((notice) => notice.id)).not.toContain(secret.notice.id);

    const after = await ledger.read();
    const byId = new Map(after.notices.map((notice) => [notice.id, notice]));
    // Disclosed notices carry the exposure receipt; the withheld one carries
    // the refusal instead, still pending, never exposed.
    expect(byId.get(internal.notice.id)?.exposure?.count).toBe(1);
    expect(byId.get(explicit.notice.id)?.exposure?.count).toBe(1);
    expect(byId.get(secret.notice.id)?.exposure).toBeUndefined();
    expect(byId.get(secret.notice.id)).toMatchObject({
      state: 'pending',
      withheld: {
        'mcp-inbox': {
          count: 1,
          firstAt: '2026-09-03T10:05:00.000Z',
          lastAt: '2026-09-03T10:05:00.000Z',
          reason: 'sensitivity-exceeds-route',
        },
      },
    });
    await driver.close();
  });

  it('withholds a secret from next-event admission without spending an attempt, and delivers it where the row admits it', async () => {
    const closedRows = advertisement({ 'next-event': 'internal' });
    const closed = await openLedger(closedRows);
    const secret = await publish(closed.ledger, { id: 'secret', sensitivity: 'secret' });
    const first = await run(closed.ledger, {
      actorId: 'recipient',
      id: 'event-1',
      kind: 'event',
      startedAt: '2026-09-03T10:10:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(first).toEqual([]);
    const held = (await closed.ledger.read()).notices.find((notice) => notice.id === secret.notice.id);
    expect(held).toMatchObject({
      attempts: [],
      state: 'pending',
      withheld: { 'next-event': { count: 1, reason: 'sensitivity-exceeds-route' } },
    });
    await closed.driver.close();

    const open = await openLedger(advertisement({ 'next-event': 'secret' }));
    const admitted = await publish(open.ledger, { id: 'secret', sensitivity: 'secret' });
    const delivered = await run(open.ledger, {
      actorId: 'recipient',
      id: 'event-2',
      kind: 'event',
      startedAt: '2026-09-03T10:10:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(delivered).toEqual([expect.objectContaining({
      disclosure: { redacted: false, route: 'next-event' },
      notice: expect.objectContaining({ content: document(SECRET_TEXT), id: admitted.notice.id, state: 'attempted' }),
    })]);
    await open.driver.close();
  });

  it('discloses a replayed admission against the current ceiling, not the one that held when it was attempted', async () => {
    // One durable store, two ledgers over it: the host first admitted secret
    // on next-event, then a reconfiguration lowered the ceiling to internal.
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentNoticeStateDefinition('process'));
    const permissive = createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
      delivery: advertisement({ 'next-event': 'secret' }),
    });
    const lowered = createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
      delivery: advertisement({ 'next-event': 'internal' }),
    });
    const secret = await publish(permissive, { id: 'secret', sensitivity: 'secret' });
    const event = { actorId: 'recipient', id: 'event-replay', kind: 'event' as const, startedAt: '2026-09-03T10:10:00.000Z' };
    const first = await run(permissive, event, async () => (await agent()).notices!.read());
    expect(first.map((delivery) => [delivery.disclosure.redacted, (delivery.notice.content.root as { text: string }).text]))
      .toEqual([[false, SECRET_TEXT]]);
    // The same invocation replayed under the lowered ceiling: the attempt
    // receipt already exists, so nothing is re-attempted, and the content
    // comes back as the placeholder rather than the authored secret.
    const replayed = await run(lowered, event, async () => (await agent()).notices!.read());
    expect(replayed.map((delivery) => [delivery.disclosure.redacted, delivery.notice.id, delivery.notice.content]))
      .toEqual([[true, secret.notice.id, { root: { kind: 'text', text: NOTICE_REDACTION_MARK }, status: 'success', version: 1 }]]);
    expect((await lowered.read()).notices[0]?.attempts).toHaveLength(1);
    await driver.close();
  });

  it('replays a prior admission when the same invocation is retried under a changed ceiling', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentNoticeStateDefinition('process'));
    const closed = createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
      delivery: advertisement({ 'next-event': 'internal' }),
    });
    const raised = createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
      delivery: advertisement({ 'next-event': 'secret' }),
    });
    const secret = await publish(closed, { id: 'secret', sensitivity: 'secret' });
    const event = { actorId: 'recipient', id: 'event-retry', kind: 'event' as const, startedAt: '2026-09-03T10:10:00.000Z' };
    expect(await run(closed, event, async () => (await agent()).notices!.read())).toEqual([]);
    const afterFirst = await closed.read();
    expect(afterFirst.notices[0]).toMatchObject({ state: 'pending', withheld: { 'next-event': { count: 1 } } });
    // The retry recomputes a different admission (the ceiling now admits the
    // notice); instead of an idempotency conflict it replays the committed
    // one: nothing attempted, nothing re-recorded, the revision unchanged.
    expect(await run(raised, event, async () => (await agent()).notices!.read())).toEqual([]);
    const afterRetry = await raised.read();
    expect(afterRetry.revision).toBe(afterFirst.revision);
    expect(afterRetry.notices[0]).toMatchObject({ attempts: [], id: secret.notice.id, state: 'pending', withheld: { 'next-event': { count: 1 } } });
    // A genuinely new invocation under the raised ceiling attempts it.
    const fresh = await run(raised, { ...event, id: 'event-fresh', startedAt: '2026-09-03T10:11:00.000Z' }, async () => (await agent()).notices!.read());
    expect(fresh.map((delivery) => [delivery.notice.id, delivery.notice.state, (delivery.notice.content.root as { text: string }).text]))
      .toEqual([[secret.notice.id, 'attempted', SECRET_TEXT]]);
    await driver.close();
  });

  it('delivers internal notices redacted on next-event and treats pre-sensitivity notices as internal', async () => {
    const { driver, ledger, store } = await openLedger();
    const internal = await publish(ledger, { id: 'internal' });
    // A notice journaled before the redaction contract has no class at all.
    const legacy = await store.dispatch('published', {
      notice: {
        attempts: [],
        content: document(SECRET_TEXT),
        createdAt: '2026-09-03T10:00:00.000Z',
        id: 'notice_legacy',
        priority: 'normal',
        recipient: { actor: { id: 'recipient' } },
        state: 'pending',
      },
    }, { idempotencyKey: 'legacy' });
    expect(legacy.state.notices.find((notice) => notice.id === 'notice_legacy')?.sensitivity).toBeUndefined();

    const deliveries = await run(ledger, {
      actorId: 'recipient',
      id: 'event-3',
      kind: 'event',
      startedAt: '2026-09-03T10:10:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(deliveries.map((delivery) => [delivery.notice.id, delivery.disclosure.redacted, (delivery.notice.content.root as { text: string }).text])).toEqual([
      [internal.notice.id, true, redactSecretText(SECRET_TEXT)],
      ['notice_legacy', true, redactSecretText(SECRET_TEXT)],
    ]);
    // The persisted content is still the authored one.
    expect((await ledger.read()).notices.every((notice) => (notice.content.root as { text: string }).text === SECRET_TEXT)).toBe(true);
    await driver.close();
  });

  it('records a route-unavailable refusal when an embedder runs admission on a host without the route', async () => {
    const { driver, ledger } = await openLedger(advertisement({ 'next-event': 'unavailable' }));
    const notice = await publish(ledger, { id: 'n', sensitivity: 'public' });
    const deliveries = await run(ledger, {
      actorId: 'recipient',
      id: 'event-4',
      kind: 'event',
      startedAt: '2026-09-03T10:10:00.000Z',
    }, async () => (await agent()).notices!.read());
    expect(deliveries).toEqual([]);
    expect((await ledger.read()).notices.find((candidate) => candidate.id === notice.notice.id)).toMatchObject({
      state: 'pending',
      withheld: { 'next-event': { count: 1, reason: 'route-unavailable' } },
    });
    await driver.close();
  });

  it('returns acknowledged notices only as the acknowledging route may disclose them', async () => {
    const { driver, ledger } = await openLedger(advertisement({ 'mcp-inbox': 'internal', 'next-event': 'secret' }));
    const internal = await publish(ledger, { id: 'internal' });
    const secret = await publish(ledger, { id: 'secret', sensitivity: 'secret' });
    const open = await publish(ledger, { id: 'public', sensitivity: 'public' });
    const ack = (id: string, invocation: string, kind: 'event' | 'tool') => run(ledger, {
      actorId: 'recipient',
      id: invocation,
      kind,
      startedAt: '2026-09-03T10:30:00.000Z',
    }, async () => (await agent()).notices!.acknowledge(id));
    // A tool invocation is held to the inbox ceiling: internal comes back
    // redacted, a secret's id learned from the inbox unlocks only the mark.
    const internalAck = await ack(internal.notice.id, 'ack-1', 'tool');
    expect(internalAck.state).toBe('acknowledged');
    expect((internalAck.content.root as { text: string }).text).toBe(redactSecretText(SECRET_TEXT));
    const secretAck = await ack(secret.notice.id, 'ack-2', 'tool');
    expect(secretAck.state).toBe('acknowledged');
    expect(secretAck.content).toEqual({ root: { kind: 'text', text: NOTICE_REDACTION_MARK }, status: 'success', version: 1 });
    const publicAck = await ack(open.notice.id, 'ack-3', 'tool');
    expect((publicAck.content.root as { text: string }).text).toBe(SECRET_TEXT);
    // The store still holds every notice as authored; only the handle's view was disclosed.
    expect((await ledger.read()).notices.every((notice) => (notice.content.root as { text: string }).text === SECRET_TEXT)).toBe(true);
    // An admitted event is held to the next-event ceiling, which admits secret here.
    const another = await publish(ledger, { id: 'secret-2', sensitivity: 'secret' });
    const eventAck = await ack(another.notice.id, 'ack-4', 'event');
    expect((eventAck.content.root as { text: string }).text).toBe(SECRET_TEXT);
    await driver.close();
  });

  it('never signals resources/updated for a notice the inbox would withhold, and records that refusal once', async () => {
    const { driver, ledger } = await openLedger(advertisement({ 'mcp-inbox': 'internal' }));
    const hidden = await publish(ledger, { id: 'secret', sensitivity: 'secret' });
    const visible = await publish(ledger, { id: 'internal' });
    const principal: AgentNoticePrincipal = {
      actor: actor('recipient'),
      host: unavailable(),
      session: unavailable(),
      workspace: unavailable(),
    };
    const signaller = createNoticeInboxSignaller({
      delivery: advertisement({ 'mcp-inbox': 'internal' }),
      now: () => new Date('2026-09-03T10:20:00.000Z'),
      store: { close: async () => undefined, noticeLedger: async () => ledger },
    });
    await signaller.subscribe(principal);
    const sends: number[] = [];
    const outcome = await signaller.observe(async () => {
      sends.push(1);
    });
    expect(outcome).toEqual({ kind: 'signalled', noticeIds: [visible.notice.id], revision: expect.any(Number) });
    expect(sends).toHaveLength(1);
    const again = await signaller.observe(async () => {
      sends.push(1);
    });
    expect(again).toEqual({ kind: 'idle', reason: 'nothing-eligible', revision: expect.any(Number) });
    expect(sends).toHaveLength(1);
    // The refusal is durable evidence on the withheld notice — recorded by
    // the signaller itself, once for the subscription, never per render.
    const refused = (await ledger.read()).notices.find((notice) => notice.id === hidden.notice.id);
    expect(refused).toMatchObject({
      state: 'pending',
      withheld: {
        'mcp-resource-updated': {
          count: 1,
          firstAt: '2026-09-03T10:20:00.000Z',
          lastAt: '2026-09-03T10:20:00.000Z',
          reason: 'sensitivity-exceeds-route',
        },
      },
    });
    expect(refused?.availability).toBeUndefined();
    expect((await ledger.read()).notices.find((notice) => notice.id === visible.notice.id)?.withheld).toBeUndefined();
    await signaller.close();
    await driver.close();
  });
});
