import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import { stateRootFor } from '../coordination.js';
import {
  topologyStateDefinition,
  type TopologyState,
} from '../state.js';
import gitWorktreeProvider from './git-worktree.js';

interface ProviderContext {
  readonly invocation: {
    readonly kind: string;
    readonly props: Readonly<Record<string, unknown>>;
  };
  readonly signal: AbortSignal;
}

export type AgentTopologyProviderValue =
  | {
      readonly snapshot: TopologyState;
      readonly state: 'available';
      readonly stateRoot: string;
    }
  | {
      readonly reason: string;
      readonly state: 'unavailable';
    };

export default async function agentTopologyProvider(
  context: ProviderContext,
): Promise<AgentTopologyProviderValue> {
  const worktree = await gitWorktreeProvider(context);
  if (worktree.state === 'unavailable') {
    return {
      reason: worktree.reason,
      state: 'unavailable',
    };
  }

  const stateRoot = stateRootFor(worktree);
  const driver = createSqliteStateDriver({ root: stateRoot });
  try {
    const store = await driver.open(topologyStateDefinition);
    const snapshot = await store.read({ signal: context.signal });
    return {
      snapshot: snapshot.state,
      state: 'available',
      stateRoot,
    };
  } catch (error) {
    return {
      reason:
        `Topology state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
    };
  } finally {
    await driver.close();
  }
}
