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
  // A hook has no terminal (#511); the route reports what it observed.
  const terminalContext = context.terminal.state === 'available'
    ? `terminal available:${context.terminal.source} ${context.terminal.value.hostSurface}/${context.terminal.value.stdout.kind}/${context.terminal.value.stderr.kind}`
    : `terminal unavailable:${context.terminal.reason}`;
  return (
    <Agent.Result>
      <Agent.Markdown>{`Observed ${canonical.event} from ${canonical.provenance.host}.`}</Agent.Markdown>
      <Agent.Context>{actorContext}</Agent.Context>
      <Agent.Context>{terminalContext}</Agent.Context>
      {notices.map((notice) => (
        <Agent.Context key={notice.id}>{`notice ${notice.id}: ${notice.message}`}</Agent.Context>
      ))}
    </Agent.Result>
  );
}
