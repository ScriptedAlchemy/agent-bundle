import {
  agent,
  type AgentStateHandle,
} from '@agent-bundle/runtime';
import type { AgentNoticesHandle } from '@agent-bundle/runtime/notices';

import {
  type TopologyEvents,
  type TopologyState,
} from './state.js';

export type TopologyAccess =
  Pick<AgentStateHandle<TopologyState, TopologyEvents>, 'dispatch' | 'read'>;

export type CapabilityResult<T> =
  | {
      readonly state: 'available';
      readonly value: T;
    }
  | {
      readonly reason: string;
      readonly state: 'unavailable';
    };

export const withTopology = async <T>(
  operation: (topology: TopologyAccess) => Promise<T>,
): Promise<CapabilityResult<T>> => {
  const context = await agent();
  if (context.state === undefined) {
    return {
      reason: 'Topology state unavailable: this request has no mounted state handle.',
      state: 'unavailable',
    };
  }
  try {
    return {
      state: 'available',
      value: await operation(
        context.state as AgentStateHandle<TopologyState, TopologyEvents>,
      ),
    };
  } catch (error) {
    return {
      reason:
        `Topology state unavailable: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
    };
  }
};

export const withNotices = async <T>(
  operation: (notices: AgentNoticesHandle) => Promise<T>,
): Promise<CapabilityResult<T>> => {
  const context = await agent();
  if (context.notices === undefined) {
    return {
      reason: 'Directed notices unavailable: this request has no mounted notice handle.',
      state: 'unavailable',
    };
  }
  try {
    return {
      state: 'available',
      value: await operation(context.notices),
    };
  } catch (error) {
    return {
      reason:
        `Directed notices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      state: 'unavailable',
    };
  }
};
