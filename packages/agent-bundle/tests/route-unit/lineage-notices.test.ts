import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Agent, agent, type AgentLineage, type Observed } from '@agent-bundle/runtime';
import { createAgentLineageRegistry, type AgentLineageRegistry, type LineageHost } from '@agent-bundle/runtime/lineage';
import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeLedger,
  type AgentRecipient,
} from '@agent-bundle/runtime/notices';
import { createMemoryStateDriver } from '@agent-bundle/runtime/state';
import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute } from '../../src/test/render.ts';

interface FixtureRecord {
  readonly event?: {
    readonly canonical: { readonly event: string; readonly idempotencyKey: string; readonly observedAt: string };
    readonly native: Readonly<Record<string, unknown>>;
  };
  readonly kind: 'event' | 'mcp' | 'cli';
}

const fixture = (name: string): FixtureRecord[] => readFileSync(
  resolve(import.meta.dirname, '../../../../fixtures/host-lineage', name),
  'utf8',
).trim().split('\n').map((line) => JSON.parse(line) as FixtureRecord);

/**
 * Replays a redacted live capture through the runtime's lineage registry the
 * way the warm runtime does, and keeps the lineage each hook payload resolved
 * to. Notices are then addressed with exactly those lineages: the root's own
 * (`depth` 0) and each `agent/start`'s child conversation.
 */
const replay = async (host: LineageHost, records: readonly FixtureRecord[]): Promise<{
  readonly children: readonly Observed<AgentLineage>[];
  readonly registry: AgentLineageRegistry;
  readonly root: Observed<AgentLineage>;
}> => {
  const registry = createAgentLineageRegistry();
  let root: Observed<AgentLineage> | undefined;
  // Distinct depth-1 conversations, as the first hook payload each one
  // resolved with: Claude and Codex name the child on its `agent/start`,
  // Cursor binds the fresh `conversation_id` only on the child's first hook.
  const children = new Map<string, Observed<AgentLineage>>();
  for (const record of records) {
    if (record.event === undefined) continue;
    const lineage = await registry.observe({
      event: record.event.canonical.event,
      host,
      idempotencyKey: record.event.canonical.idempotencyKey,
      native: record.event.native,
      observedAt: record.event.canonical.observedAt,
    });
    if (lineage.state !== 'available') continue;
    if (lineage.value.depth === 0) root ??= lineage;
    if (lineage.value.depth === 1 && !children.has(lineage.value.conversation)) {
      children.set(lineage.value.conversation, lineage);
    }
  }
  if (root === undefined) throw new Error(`${host} capture resolved no root lineage`);
  return { children: [...children.values()], registry, root };
};

const conversationOf = (lineage: Observed<AgentLineage>): string => {
  if (lineage.state !== 'available') throw new Error('fixture lineage is unavailable');
  return lineage.value.conversation;
};

const openLedger = async (): Promise<{ readonly close: () => Promise<void>; readonly ledger: AgentNoticeLedger }> => {
  const driver = createMemoryStateDriver({ lifetime: 'process' });
  const store = await driver.open(agentNoticeStateDefinition('process'));
  return {
    close: () => driver.close(),
    ledger: createAgentNoticeLedger(store, { authorize: () => ({ state: 'authorized' }) }),
  };
};

/** An event route that publishes one notice to `recipient`. */
const Publish = (recipient: AgentRecipient, text: string, retryBudget = 1) => async (): Promise<unknown> => {
  const { notices } = await agent();
  const published = await notices!.publish({
    content: { root: { kind: 'text', text }, status: 'success', version: 1 },
    priority: 'high',
    recipient,
    retryBudget,
  }, { idempotencyKey: `publish:${text}` });
  return createElement(Agent.Result, { value: { noticeId: published.notice.id, state: published.notice.state } });
};

/** An event route that only reads what admission delivered to this event. */
const Receive = async (): Promise<unknown> => {
  const { notices } = await agent();
  const deliveries = await notices!.read();
  return createElement(
    Agent.Result,
    { value: { delivered: deliveries.map((delivery) => delivery.notice.id) } },
    ...deliveries.map((delivery) => createElement(Agent.Context, {
      children: `notice: ${
        delivery.notice.content.root.kind === 'text' ? delivery.notice.content.root.text : delivery.notice.content.root.kind
      }`,
      key: delivery.notice.id,
    })),
  );
};

let sequence = 0;
const eventInput = (host: string) => {
  sequence += 1;
  return {
    canonical: {
      event: 'tool/after',
      idempotencyKey: `lineage-notices:${String(sequence)}`,
      observedAt: `2026-09-03T12:00:${String(sequence).padStart(2, '0')}.000Z`,
      provenance: { host, hostContractRevision: 'route-unit', nativeEvent: 'PostToolUse', source: 'native' },
      sequence,
    },
    native: { hook_event_name: 'PostToolUse' },
  };
};

const renderEvent = (
  module: () => Promise<unknown>,
  host: string,
  ledger: AgentNoticeLedger,
  lineage: Observed<AgentLineage>,
) => renderRoute({ default: module as never }, {
  context: {
    host: { source: 'native', state: 'available', value: { name: host } },
    lineage,
    noticeLedger: ledger,
    // Claude and Codex put the root `session_id` on every subagent hook, so
    // the session axis is deliberately identical for every principal here.
    session: { source: 'native', state: 'available', value: { sessionId: 'shared-root-session' } },
    workspace: { source: 'native', state: 'available', value: { root: '/workspace' } },
  },
  input: eventInput(host),
  kind: 'event-route',
  routeId: 'event:tool/after',
});

const delivered = (rendered: Awaited<ReturnType<typeof renderRoute>>): readonly string[] =>
  (rendered.document.value as { delivered: readonly string[] }).delivered;

/**
 * Lineage-addressed notices (#458) over the 2026-09-03 live host captures:
 * the same principals the generated runtime mounts, with `request.lineage`
 * resolved by the registry from the recorded hook payloads.
 */
describe.each([
  ['claude', 'claude-2.1.259-orchestration.ndjson', 3],
  ['codex', 'codex-0.147.0.ndjson', 1],
  ['cursor', 'cursor-3.18.25.ndjson', 2],
] as const)('%s capture (%s)', (host, file, expectedChildren) => {
  it('lets the parent address one child conversation and no sibling, while the root subtree reaches every conversation under it', async () => {
    const { children, root } = await replay(host, fixture(file));
    expect(children.length).toBeGreaterThanOrEqual(expectedChildren);
    const [target, sibling] = children;
    const { close, ledger } = await openLedger();
    try {
      // Parent → child: `recipient.conversation` names exactly one thread.
      const published = await renderEvent(
        Publish({ conversation: conversationOf(target!) }, `for ${conversationOf(target!)}`),
        host,
        ledger,
        root,
      );
      expectDocument(published).toHaveStatus('success');
      const noticeId = (published.document.value as { noticeId: string }).noticeId;

      if (sibling !== undefined) {
        // A sibling shares the root session and workspace; only its conversation differs.
        expect(delivered(await renderEvent(Receive, host, ledger, sibling))).toEqual([]);
      }
      // The root itself is not the child either.
      expect(delivered(await renderEvent(Receive, host, ledger, root))).toEqual([]);
      const admitted = await renderEvent(Receive, host, ledger, target!);
      expect(delivered(admitted)).toEqual([noticeId]);
      expectDocument(admitted).toContainContext(`notice: for ${conversationOf(target!)}`);
      expect((await ledger.read()).notices.find((notice) => notice.id === noticeId)).toMatchObject({
        attempts: [expect.objectContaining({ channel: 'next-event' })],
        recipient: { conversation: conversationOf(target!) },
        state: 'attempted',
      });

      // Child → siblings: `recipient.root` is the whole tree under the root.
      // One attempt per member: each admitting event spends one budget slot.
      const members = [...children, root];
      const broadcast = await renderEvent(
        Publish({ root: conversationOf(root) }, 'to the whole tree', members.length),
        host,
        ledger,
        target!,
      );
      const broadcastId = (broadcast.document.value as { noticeId: string }).noticeId;
      // A conversation from another tree never matches, and spends nothing.
      const elsewhere: Observed<AgentLineage> = {
        source: 'native',
        state: 'available',
        value: { conversation: 'other-conversation', depth: 0, resolution: 'native', root: 'other-root' },
      };
      expect(delivered(await renderEvent(Receive, host, ledger, elsewhere))).toEqual([]);
      for (const member of members) {
        expect(delivered(await renderEvent(Receive, host, ledger, member))).toEqual([broadcastId]);
      }
      expect((await ledger.read()).notices.find((notice) => notice.id === broadcastId)).toMatchObject({
        attempts: members.map(() => expect.objectContaining({ channel: 'next-event' })),
        recipient: { root: conversationOf(root) },
        state: 'attempted',
      });
    } finally {
      await close();
    }
  });

  it('never admits a lineage-addressed notice on a request whose lineage the runtime could not resolve', async () => {
    const { children, root } = await replay(host, fixture(file));
    const target = children[0]!;
    const { close, ledger } = await openLedger();
    try {
      await renderEvent(Publish({ conversation: conversationOf(target) }, 'unresolved'), host, ledger, root);
      const unresolved: Observed<AgentLineage> = { reason: 'no-shared-runtime', state: 'unavailable' };
      expect(delivered(await renderEvent(Receive, host, ledger, unresolved))).toEqual([]);
      expect((await ledger.read()).notices[0]).toMatchObject({ attempts: [], state: 'pending' });
    } finally {
      await close();
    }
  });
});
