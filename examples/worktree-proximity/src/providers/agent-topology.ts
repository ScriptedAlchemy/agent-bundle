export interface AgentTopologyProviderValue {
  readonly reason: string;
  readonly state: 'unavailable';
}

/**
 * The issue sketch places a topology snapshot at
 * `providers.agentTopology.snapshot`. A conventional provider factory still
 * receives only `{ invocation, signal }` — no request identity, no
 * `lineage`, and no mounted `state`/`notices` handles (agent-bundle#459) —
 * so it cannot derive that view. Routes read the topology from
 * `(await agent()).state` and their own place in the conversation tree from
 * `(await agent()).lineage` instead; this provider reports the gap honestly
 * rather than opening a second store.
 */
export default function agentTopologyProvider(): AgentTopologyProviderValue {
  return {
    reason:
      'Topology snapshots are available only from the mounted request state handle; providers receive no request identity, lineage, or state handle (agent-bundle#459).',
    state: 'unavailable',
  };
}
