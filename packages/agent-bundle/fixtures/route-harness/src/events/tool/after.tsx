import { Agent, agent } from '@agent-bundle/runtime';
import type { AgentEventRouteProps } from 'agent-bundle';

export default async function AfterTool({ canonical, native }: AgentEventRouteProps) {
  const context = await agent();
  return (
    <Agent.Result value={{
      event: canonical.event,
      invocationKind: context.invocation.kind,
      tool: typeof native['tool_name'] === 'string' ? native['tool_name'] : 'unknown',
    }}
    >
      <Agent.Markdown>{`Observed ${canonical.event} from ${canonical.provenance.host}.`}</Agent.Markdown>
    </Agent.Result>
  );
}
