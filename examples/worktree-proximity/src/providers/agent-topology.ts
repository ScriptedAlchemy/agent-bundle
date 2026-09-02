export interface AgentTopologyProviderValue {
  readonly reason: string;
  readonly state: 'unavailable';
}

export default function agentTopologyProvider(): AgentTopologyProviderValue {
  return {
    reason:
      'Topology snapshots are available only from the mounted request state handle; providers execute before that handle is mounted.',
    state: 'unavailable',
  };
}
