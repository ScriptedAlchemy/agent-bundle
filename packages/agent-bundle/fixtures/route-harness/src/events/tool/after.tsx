import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';

export default async function AfterTool({ canonical }: AgentEventRouteProps) {
  const context = await agent();
  const deliveries = await context.notices?.read() ?? [];
  const notices = deliveries.map(({ notice }) => ({
    id: notice.id,
    message: notice.content.root.kind === 'text' ? notice.content.root.text : '',
  }));
  const actor: JsonValue = context.actor.state === 'available'
    ? { source: context.actor.source, state: context.actor.state, value: { id: context.actor.value.id } }
    : { reason: context.actor.reason, state: context.actor.state };
  return (
    <Agent.Result value={{ actor }}>
      <Agent.Markdown>{`Observed ${canonical.event} from ${canonical.provenance.host}.`}</Agent.Markdown>
      {notices.map((notice) => (
        <Agent.Context key={notice.id}>{`notice ${notice.id}: ${notice.message}`}</Agent.Context>
      ))}
    </Agent.Result>
  );
}
