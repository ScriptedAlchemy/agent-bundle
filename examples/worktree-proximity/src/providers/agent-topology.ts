import { AGENT_NOTICE_STATES, type AgentNoticeState } from '@agent-bundle/runtime/notices';
import type { AgentProviderContext } from 'agent-bundle';

import type { CapabilityResult } from '../coordination.js';
import { agentTreeOf, type AgentTreeView } from '../event-support.js';
import { IntentStateSchema, type IntentState } from '../state.js';

/**
 * What became of the notices the calling agent published, counted by ledger
 * state (agent-bundle#460). Scoped by the publisher identity the ledger
 * recorded at publish — the caller's lineage conversation — so it is this
 * agent's own notices, never the whole ledger and never another agent's.
 */
export type PublishedNoticeCounts = Readonly<Record<AgentNoticeState, number>> & {
  readonly reason?: string;
  readonly state: 'available' | 'unavailable';
  readonly total: number;
};

/**
 * The whole-tree view the coordinator reports, assembled once per request
 * from what the framework hands a provider (agent-bundle#459): the agent tree
 * the runtime's lineage registry resolved for this request — own chain plus
 * the live siblings, children, and other roots (agent-bundle#457) — a read of
 * the mounted intent state (worktree bindings, activities, refusals), and the
 * counts of the notices this request's principal published. Each part
 * carries its own availability; nothing here is guessed, and the provider can
 * only read: `state.dispatch` and `notices.publish` are not on the provider
 * context.
 */
export interface AgentTopologyProviderValue {
  readonly agents: AgentTreeView;
  readonly intent: CapabilityResult<{ readonly revision: number; readonly value: IntentState }>;
  readonly notices: PublishedNoticeCounts;
}

const emptyCounts = (): Record<AgentNoticeState, number> =>
  Object.fromEntries(AGENT_NOTICE_STATES.map((state) => [state, 0])) as Record<AgentNoticeState, number>;

const readIntent = async (
  context: AgentProviderContext,
): Promise<AgentTopologyProviderValue['intent']> => {
  if (context.state === undefined) {
    return { reason: 'Intent state unavailable: this surface mounts no state handle.', state: 'unavailable' };
  }
  try {
    const snapshot = await context.state.read({ signal: context.signal });
    const parsed = IntentStateSchema.safeParse(snapshot.state);
    return parsed.success
      ? { state: 'available', value: { revision: snapshot.revision, value: parsed.data } }
      : { reason: 'Intent state unavailable: the mounted state is not the worktree-proximity intent definition.', state: 'unavailable' };
  } catch (error) {
    return {
      reason: `Intent state unavailable: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
    };
  }
};

const readPublishedNotices = async (context: AgentProviderContext): Promise<PublishedNoticeCounts> => {
  if (context.notices === undefined) {
    return { ...emptyCounts(), reason: 'Published notices unavailable: this surface mounts no notice ledger.', state: 'unavailable', total: 0 };
  }
  try {
    const published = await context.notices.published();
    const counts = emptyCounts();
    for (const notice of published) counts[notice.state] += 1;
    return { ...counts, state: 'available', total: published.length };
  } catch (error) {
    return {
      ...emptyCounts(),
      reason: `Published notices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
      total: 0,
    };
  }
};

export default async function agentTopologyProvider(
  context: AgentProviderContext,
): Promise<AgentTopologyProviderValue> {
  const [intent, notices] = await Promise.all([readIntent(context), readPublishedNotices(context)]);
  return {
    agents: agentTreeOf(context.lineage),
    intent,
    notices,
  };
}
