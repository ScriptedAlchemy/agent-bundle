import { Agent, agent } from '@agent-bundle/runtime';
import type { AgentNoticePublishInput } from '@agent-bundle/runtime/notices';
import { z } from 'zod';

export const config = {
  description: 'Publishes a durable notice for a later session event.',
  title: 'Publish notice',
};

export const inputSchema = z.object({
  message: z.string(),
  recipientSession: z.string(),
  /** Author-declared disclosure class; the runtime defaults to `internal`. */
  sensitivity: z.enum(['public', 'internal', 'secret']).optional(),
}).strict();

export const resultSchema = z.object({
  noticeId: z.string(),
  sensitivity: z.enum(['public', 'internal', 'secret']),
  state: z.literal('pending'),
}).strict();

export default async function PublishNotice({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const context = await agent();
  if (context.notices === undefined) throw new TypeError('Notice publishing is unavailable.');
  // `satisfies` pins the publish API surface: a vocabulary change on
  // `sensitivity` (or a renamed field) fails this route's type check.
  const publishInput = {
    content: {
      root: { kind: 'text', text: input.message },
      status: 'success',
      version: 1,
    },
    priority: 'normal',
    recipient: {
      session: { sessionId: input.recipientSession },
    },
    ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
  } satisfies AgentNoticePublishInput;
  const published = await context.notices.publish(publishInput, {
    idempotencyKey: `notice:${input.recipientSession}:${input.message}`,
  });
  const result = {
    noticeId: published.notice.id,
    sensitivity: published.notice.sensitivity ?? 'internal',
    state: published.notice.state,
  };
  return (
    <Agent.Result value={result}>
      <Agent.Text>{`notice ${result.noticeId}: ${result.state} (${result.sensitivity})`}</Agent.Text>
    </Agent.Result>
  );
}
