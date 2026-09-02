import { createElement } from 'react';
import { z } from 'zod';

import { Agent, agent, type JsonValue } from '../index.js';
import { AgentNoticeError, type AgentNotice } from './index.js';

export const AGENT_NOTICE_INBOX_ROUTE_ID = 'agent-bundle:notice-inbox';
export const AGENT_NOTICE_INBOX_ROUTE_NAME = 'notice-inbox';
export const AGENT_NOTICE_INBOX_URI = 'agent-bundle://notices/inbox';

export const config = Object.freeze({
  description: 'Read recipient-scoped pending notices without acknowledging them or marking delivery attempted.',
  mimeType: 'application/json',
  uri: AGENT_NOTICE_INBOX_URI,
});

export const inputSchema = z.object({ uri: z.string() }).strict();

export const resultSchema = z.object({
  contents: z.array(z.object({
    mimeType: z.literal('application/json'),
    text: z.string(),
    uri: z.string(),
  }).strict()),
}).strict();

const projectNotice = (notice: AgentNotice) => Object.freeze({
  content: notice.content,
  createdAt: notice.createdAt,
  ...(notice.expiresAt === undefined ? {} : { expiresAt: notice.expiresAt }),
  exposure: notice.exposure,
  id: notice.id,
  priority: notice.priority,
  state: notice.state,
});

export function noticeInboxRouteRecord<TModule>(module: TModule) {
  return Object.freeze({
    config,
    id: AGENT_NOTICE_INBOX_ROUTE_ID,
    kind: 'resource' as const,
    module,
    name: AGENT_NOTICE_INBOX_ROUTE_NAME,
  });
}

export default async function NoticeInboxRoute({
  input,
}: {
  readonly input: z.infer<typeof inputSchema>;
}) {
  const context = await agent();
  if (context.notices === undefined) {
    throw new AgentNoticeError(
      'unauthorized',
      'Notice inbox is unavailable without a generated state-backed request scope',
    );
  }
  const notices = await context.notices.inbox();
  const projection = Object.freeze({
    notices: Object.freeze(notices.map(projectNotice)),
  });
  const result = Object.freeze({
    contents: Object.freeze([Object.freeze({
      mimeType: 'application/json' as const,
      text: JSON.stringify(projection),
      uri: input.uri,
    })]),
  });
  return createElement(
    Agent.Result,
    { value: result as JsonValue },
    createElement(Agent.Text, null, 'Recipient notice inbox read without acknowledgement.'),
  );
}
