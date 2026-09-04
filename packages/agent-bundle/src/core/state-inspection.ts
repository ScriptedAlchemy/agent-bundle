import { noticeRetentionDefaults } from '../config/notice-retention.ts';
import { deepFreeze } from './freeze.ts';
import type { NormalizedNoticeRetentionPolicy, NormalizedNotices, NormalizedStateDefinition } from './types.ts';

export type StateProjectionDriver = 'memory' | 'sqlite';

export interface StateProjectionBudgets {
  readonly maxCommitMs: number;
  readonly maxEventBytes: number;
  readonly maxRevisions: number;
  readonly maxStateBytes: number;
}

// Keep static inspection independent of the optional runtime peer. The
// cross-package inspection test compares these policy defaults with the
// runtime export so the two package boundaries cannot drift silently.
export const agentStateDefaultBudgets: StateProjectionBudgets = Object.freeze({
  maxCommitMs: 5_000,
  maxEventBytes: 262_144,
  maxRevisions: 100_000,
  maxStateBytes: 1_048_576,
});

/**
 * The notice ledger's retention policy as the generated runtime will mount it:
 * the runtime defaults unless `notices.retention` declared otherwise. Live
 * counts and the last compaction are runtime facts of one installed store
 * (`AgentNoticeLedger.inspect()`); static inspection shows the policy only.
 */
export interface StateNoticeRetentionProjection {
  readonly resolved: NormalizedNoticeRetentionPolicy;
  readonly source: 'declared' | 'defaults';
}

export interface StateDefinitionProjection {
  readonly budgets:
    | {
      readonly resolved: StateProjectionBudgets;
      readonly source: 'declared' | 'defaults';
    }
    | {
      readonly source: 'dynamic';
    };
  readonly driver: StateProjectionDriver;
  readonly durableLocation?: string;
  readonly id: string;
  readonly lifetime: NormalizedStateDefinition['lifetime'];
  /** Retention policy of the co-mounted notice ledger; absent on projections built before it was inspected. */
  readonly noticeRetention?: StateNoticeRetentionProjection;
  readonly notices: readonly string[];
  readonly source: string;
}

const durableStateLocation =
  '$AGENT_BUNDLE_PLUGIN_ROOT/state (falls back to the artifact root or ./.agent-bundle/state for CLI bins)';

const noticeLedgerInspection =
  'Generated runtimes co-mount the notice ledger store at the same lifetime under reserved id @agent-bundle/runtime/agent-notice-ledger/v1.';

const noticeRetentionInspection =
  'Notice retention prunes settled notices on admitted events and compacts the ledger journal past its byte bound; live counts and the last compaction belong to each installed store (AgentNoticeLedger.inspect()).';

const stateDriver = (
  lifetime: NormalizedStateDefinition['lifetime'],
): StateProjectionDriver => {
  switch (lifetime) {
    case 'request':
    case 'process':
      return 'memory';
    case 'workspace-durable':
      return 'sqlite';
    default: {
      const unreachable: never = lifetime;
      throw new TypeError(`Unknown normalized state lifetime ${String(unreachable)}.`);
    }
  }
};

/** Projects the static state declaration into the facts shared by inspection and the Workbench. */
export const stateDefinitionProjection = (
  definition: NormalizedStateDefinition,
  source = definition.source,
  notices?: NormalizedNotices,
): StateDefinitionProjection => {
  const noticeRetention: StateNoticeRetentionProjection = notices === undefined
    ? Object.freeze({ resolved: noticeRetentionDefaults, source: 'defaults' })
    : Object.freeze({ resolved: notices.retention.resolved, source: 'declared' });
  const budgets: StateDefinitionProjection['budgets'] = definition.budgets === 'dynamic'
    ? Object.freeze({ source: 'dynamic' })
    : Object.freeze({
      resolved: Object.freeze({
        ...agentStateDefaultBudgets,
        ...(definition.budgets?.declared ?? {}),
      }),
      source: definition.budgets === undefined ? 'defaults' : 'declared',
    });
  return deepFreeze({
    budgets,
    driver: stateDriver(definition.lifetime),
    ...(definition.lifetime === 'workspace-durable' ? { durableLocation: durableStateLocation } : {}),
    id: definition.id,
    lifetime: definition.lifetime,
    noticeRetention,
    notices: [noticeLedgerInspection, noticeRetentionInspection],
    source,
  });
};
