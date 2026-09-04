export interface AgentTopologyProviderValue {
  readonly reason: string;
  readonly state: 'unavailable';
}

/**
 * The issue sketch places the agent tree at `providers.agentTopology`. The
 * tree itself is now on the request — `(await agent()).lineage.value.tree`
 * lists the live siblings, children, and other roots the runtime's registry
 * holds (agent-bundle#457) — but a conventional provider factory still
 * receives only `{ invocation, signal }`, not the request's `lineage`
 * (agent-bundle#459), so this provider cannot derive that view. Routes read
 * `request.lineage` directly (`agentTree()` in `event-support.ts`); this
 * provider reports the gap honestly rather than inventing a tree.
 */
export default function agentTopologyProvider(): AgentTopologyProviderValue {
  return {
    reason:
      'The agent tree is on request.lineage.tree; providers receive no request lineage (agent-bundle#459), so read it from (await agent()).lineage in a route.',
    state: 'unavailable',
  };
}
