import { AGENT_STATE_DEFAULT_BUDGETS } from '@agent-bundle/runtime/state';

import { deepFreeze } from './freeze.ts';
import type { NormalizedStateDefinition } from './types.ts';

export type StateProjectionDriver = 'memory' | 'sqlite';

export interface StateProjectionBudgets {
  readonly maxCommitMs: number;
  readonly maxEventBytes: number;
  readonly maxRevisions: number;
  readonly maxStateBytes: number;
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
  readonly notices: readonly string[];
  readonly source: string;
}

const durableStateLocation =
  '$AGENT_BUNDLE_PLUGIN_ROOT/state (falls back to the artifact root or ./.agent-bundle/state for CLI bins)';

const noticeLedgerInspection =
  'Generated runtimes co-mount the notice ledger store at the same lifetime under reserved id @agent-bundle/runtime/agent-notice-ledger/v1.';

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
): StateDefinitionProjection => {
  const budgets: StateDefinitionProjection['budgets'] = definition.budgets === 'dynamic'
    ? Object.freeze({ source: 'dynamic' })
    : Object.freeze({
      resolved: Object.freeze({
        ...AGENT_STATE_DEFAULT_BUDGETS,
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
    notices: [noticeLedgerInspection],
    source,
  });
};
