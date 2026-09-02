import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Publishes a durable notice for a later session event.',
  title: 'Publish notice',
};

export const inputSchema = z.object({
  message: z.string(),
  recipientSession: z.string(),
}).strict();

export const resultSchema = z.object({
  noticeId: z.string(),
  state: z.literal('pending'),
}).strict();

export default async function PublishNotice({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  if (context.notices === undefined) throw new TypeError('Notice publishing is unavailable.');
  const published = await context.notices.publish({
    content: {
      root: { kind: 'text', text: input.message },
      status: 'success',
      version: 1,
    },
    priority: 'normal',
    recipient: {
      session: { sessionId: input.recipientSession },
    },
  }, {
    idempotencyKey: `notice:${input.recipientSession}:${input.message}`,
  });
  const result = { noticeId: published.notice.id, state: published.notice.state };
  return (
    <Agent.Result value={result}>
      <Agent.Text>{`notice ${result.noticeId}: ${result.state}`}</Agent.Text>
    </Agent.Result>
  );
}
