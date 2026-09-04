import type { AgentProviderContext } from 'agent-bundle';

import type { CapabilityResult } from '../coordination.js';
import { agentTreeOf, type AgentTreeView } from '../event-support.js';
import { IntentStateSchema, type IntentState } from '../state.js';

/**
 * The whole-tree view the coordinator reports, assembled once per request
 * from what the framework hands a provider (agent-bundle#459): the agent tree
 * the runtime's lineage registry resolved for this request — own chain plus
 * the live siblings, children, and other roots (agent-bundle#457) — and a
 * read of the mounted intent state (worktree bindings, activities, refusals).
 * Each half carries its own availability; nothing here is guessed, and the
 * provider can only read: `state.dispatch` and `notices.publish` are not on
 * the provider context.
 */
export interface AgentTopologyProviderValue {
  readonly agents: AgentTreeView;
  readonly intent: CapabilityResult<{ readonly revision: number; readonly value: IntentState }>;
}

export default async function agentTopologyProvider(
  context: AgentProviderContext,
): Promise<AgentTopologyProviderValue> {
  const agents = agentTreeOf(context.lineage);
  if (context.state === undefined) {
    return {
      agents,
      intent: { reason: 'Intent state unavailable: this surface mounts no state handle.', state: 'unavailable' },
    };
  }
  try {
    const snapshot = await context.state.read({ signal: context.signal });
    const parsed = IntentStateSchema.safeParse(snapshot.state);
    return {
      agents,
      intent: parsed.success
        ? { state: 'available', value: { revision: snapshot.revision, value: parsed.data } }
        : { reason: 'Intent state unavailable: the mounted state is not the worktree-proximity intent definition.', state: 'unavailable' },
    };
  } catch (error) {
    return {
      agents,
      intent: {
        reason: `Intent state unavailable: ${error instanceof Error ? error.message : String(error)}`,
        state: 'unavailable',
      },
    };
  }
}
