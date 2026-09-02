import { Agent, agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';

export default async function AfterTool({ canonical }: AgentEventRouteProps) {
  const context = await agent();
  const deliveries = await context.notices?.read() ?? [];
  const notices = deliveries.map(({ notice }) => ({
    id: notice.id,
    message: notice.content.root.kind === 'text' ? notice.content.root.text : '',
  }));
  const actorContext = context.actor.state === 'available'
    ? `actor available:${context.actor.source}:${context.actor.value.id}`
    : `actor unavailable:${context.actor.reason}`;
  return (
    <Agent.Result>
      <Agent.Markdown>{`Observed ${canonical.event} from ${canonical.provenance.host}.`}</Agent.Markdown>
      <Agent.Context>{actorContext}</Agent.Context>
      {notices.map((notice) => (
        <Agent.Context key={notice.id}>{`notice ${notice.id}: ${notice.message}`}</Agent.Context>
      ))}
    </Agent.Result>
  );
}
