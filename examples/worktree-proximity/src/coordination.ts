import { resolve, join } from 'node:path';

import {
  agent,
  available,
  type AgentStateHandle,
  type ObservedSource,
} from '@agent-bundle/runtime';
import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeLedgerSnapshot,
  type AgentNoticesHandle,
} from '@agent-bundle/runtime/notices';
import type { AgentStateStore } from '@agent-bundle/runtime/state';
import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';

import type { AvailableWorktree } from './api.js';
import {
  topologyStateDefinition,
  type TopologyEvents,
  type TopologyState,
} from './state.js';

export type TopologyAccess =
  Pick<AgentStateStore<TopologyState, TopologyEvents>, 'dispatch' | 'read'>;

export const stateRootFor = (worktree: AvailableWorktree): string => {
  const configured = process.env.WORKTREE_PROXIMITY_STATE_DIR;
  return configured === undefined || configured.trim() === ''
    ? join(worktree.commonDir, 'agent-bundle-proximity')
    : resolve(configured);
};

export const withTopology = async <T>(
  worktree: AvailableWorktree,
  operation: (topology: TopologyAccess) => Promise<T>,
): Promise<T> => {
  const context = await agent();
  // Generated bundles do not mount these reserved handles yet (#233). Prefer
  // the framework handle when present; otherwise compose the same primitives
  // here and keep their lifecycle scoped to this application request.
  if (context.state !== undefined) {
    return operation(context.state as AgentStateHandle<TopologyState, TopologyEvents>);
  }

  const driver = createSqliteStateDriver({ root: stateRootFor(worktree) });
  try {
    return await operation(await driver.open(topologyStateDefinition));
  } finally {
    await driver.close();
  }
};

export const withNotices = async <T>(
  worktree: AvailableWorktree,
  actorId: string | undefined,
  actorSource: ObservedSource,
  operation: (notices: AgentNoticesHandle) => Promise<T>,
): Promise<T> => {
  const context = await agent();
  if (context.notices !== undefined) {
    return operation(context.notices);
  }

  const driver = createSqliteStateDriver({ root: stateRootFor(worktree) });
  let lease: Awaited<ReturnType<ReturnType<typeof createAgentNoticeLedger>['openRequest']>> | undefined;
  try {
    const store = await driver.open(agentNoticeStateDefinition());
    const ledger = createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
    });
    lease = await ledger.openRequest({
      invocation: context.invocation,
      principal: {
        actor: actorId === undefined ? context.actor : available({ id: actorId }, actorSource),
        host: context.host,
        session: context.session,
        workspace: context.workspace,
      },
      signal: context.signal,
    });
    return await operation(lease.handle);
  } finally {
    lease?.close();
    await driver.close();
  }
};

export const readNoticeLedger = async (
  worktree: AvailableWorktree,
): Promise<AgentNoticeLedgerSnapshot> => {
  const driver = createSqliteStateDriver({ root: stateRootFor(worktree) });
  try {
    const store = await driver.open(agentNoticeStateDefinition());
    return await createAgentNoticeLedger(store, {
      authorize: () => ({ state: 'authorized' }),
    }).read();
  } finally {
    await driver.close();
  }
};
