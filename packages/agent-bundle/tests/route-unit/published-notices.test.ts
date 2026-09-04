import { Agent, agent, type AgentLineage, type Observed } from '@agent-bundle/runtime';
import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeLedger,
} from '@agent-bundle/runtime/notices';
import { createMemoryStateDriver } from '@agent-bundle/runtime/state';
import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute } from '../../src/test/render.ts';

/** Claude/Codex-shaped: every subagent under one root shares the root session id. */
const lineageOf = (conversation: string): Observed<AgentLineage> => ({
  source: 'derived',
  state: 'available',
  value: { conversation, depth: 1, parent: 'root', resolution: 'registry', root: 'root', subagent: { id: conversation } },
});

let sequence = 0;
const render = (
  module: () => Promise<unknown>,
  ledger: AgentNoticeLedger,
  lineage: Observed<AgentLineage>,
  kind: 'event' | 'tool',
  identity: { readonly host: string; readonly sessionId: string; readonly workspace: string } = {
    host: 'claude',
    sessionId: 'root',
    workspace: '/workspace',
  },
) => {
  sequence += 1;
  return renderRoute({ default: module as never }, {
    context: {
      host: { source: 'native', state: 'available', value: { name: identity.host } },
      lineage,
      noticeLedger: ledger,
      session: { source: 'native', state: 'available', value: { sessionId: identity.sessionId } },
      workspace: { source: 'native', state: 'available', value: { root: identity.workspace } },
    },
    ...(kind === 'event'
      ? {
        input: {
          canonical: {
            event: 'tool/after',
            idempotencyKey: `published-notices:${String(sequence)}`,
            observedAt: `2026-09-03T13:00:${String(sequence).padStart(2, '0')}.000Z`,
            provenance: { host: 'claude', hostContractRevision: 'route-unit', nativeEvent: 'PostToolUse', source: 'native' },
            sequence,
          },
          native: { hook_event_name: 'PostToolUse' },
        },
        kind: 'event-route' as const,
        routeId: 'event:tool/after',
      }
      : { routeId: 'tool:coordinator/notices' }),
  });
};

const Publish = (conversation: string) => async (): Promise<unknown> => {
  const { notices } = await agent();
  const published = await notices!.publish({
    content: { root: { kind: 'text', text: `for ${conversation}` }, status: 'success', version: 1 },
    priority: 'high',
    recipient: { conversation },
  }, { idempotencyKey: `publish:${conversation}` });
  return createElement(Agent.Result, { value: { noticeId: published.notice.id } });
};

/** What a coordinator tool reads: its own publications by state, and its inbox. */
const Overview = async (): Promise<unknown> => {
  const { notices } = await agent();
  const [published, inbox] = await Promise.all([notices!.published(), notices!.inbox()]);
  return createElement(Agent.Result, {
    value: {
      inbox: inbox.map((notice) => notice.id),
      published: published.map((notice) => ({ id: notice.id, state: notice.state })),
    },
  });
};

const Receive = async (): Promise<unknown> => {
  const { notices } = await agent();
  return createElement(Agent.Result, { value: { delivered: (await notices!.read()).map((delivery) => delivery.notice.id) } });
};

const value = <T,>(rendered: Awaited<ReturnType<typeof renderRoute>>): T => rendered.document.value as T;

describe('publisher-scoped notice visibility (#460)', () => {
  it('shows publisher A its notice as attempted after B admitted it, while B\'s inbox empties and A\'s inbox never showed it', async () => {
    const driver = createMemoryStateDriver({ lifetime: 'process' });
    const store = await driver.open(agentNoticeStateDefinition('process'));
    const phases: string[] = [];
    const ledger = createAgentNoticeLedger(store, {
      authorize: (request) => {
        phases.push(request.phase);
        return { state: 'authorized' };
      },
    });
    try {
      const published = await render(Publish('agent-b'), ledger, lineageOf('agent-a'), 'event');
      expectDocument(published).toHaveStatus('success');
      const { noticeId } = value<{ noticeId: string }>(published);

      // Before admission: A sees its publication pending and nothing in its inbox; B sees it only in its inbox.
      expect(value(await render(Overview, ledger, lineageOf('agent-a'), 'tool'))).toEqual({
        inbox: [],
        published: [{ id: noticeId, state: 'pending' }],
      });
      expect(value(await render(Overview, ledger, lineageOf('agent-b'), 'tool'))).toEqual({
        inbox: [noticeId],
        published: [],
      });
      // A sibling under the same root, sharing host, session, and workspace, sees neither.
      expect(value(await render(Overview, ledger, lineageOf('agent-c'), 'tool'))).toEqual({ inbox: [], published: [] });

      // B's next event admits it.
      expect(value(await render(Receive, ledger, lineageOf('agent-b'), 'event'))).toEqual({ delivered: [noticeId] });

      // After admission: A reads `attempted` — here from a tool call whose host
      // name, session id, and cwd differ from the publishing hook, because the
      // lineage conversation identifies the publisher — and B's inbox is empty.
      expect(value(await render(Overview, ledger, lineageOf('agent-a'), 'tool', {
        host: 'claude-code',
        sessionId: 'mcp-session-1',
        workspace: '/server-cwd',
      }))).toEqual({
        inbox: [],
        published: [{ id: noticeId, state: 'attempted' }],
      });
      expect(value(await render(Overview, ledger, lineageOf('agent-b'), 'tool'))).toEqual({ inbox: [], published: [] });
      // Unresolved lineage is nobody's publication.
      expect(value(await render(Overview, ledger, { reason: 'no-shared-runtime', state: 'unavailable' }, 'tool')))
        .toEqual({ inbox: [], published: [] });

      // `published` is judged per matching notice; publisher-scoped reads recorded no receipts.
      expect(phases.filter((phase) => phase === 'published')).toHaveLength(2);
      expect((await ledger.read()).notices[0]).toMatchObject({
        attempts: [expect.objectContaining({ channel: 'next-event' })],
        publisher: { conversation: 'agent-a', host: { name: 'claude' }, session: { sessionId: 'root' }, workspace: { root: '/workspace' } },
        state: 'attempted',
      });
    } finally {
      await driver.close();
    }
  });
});
