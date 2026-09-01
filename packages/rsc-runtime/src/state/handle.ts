import type {
  AgentStateEventSchemas,
  AgentStateHandle,
  AgentStateStore,
} from './contract.js';

export interface AgentStateHandleOptions {
  /**
   * Request signal folded into every operation that does not carry its own,
   * so an aborted invocation stops touching state.
   */
  readonly signal?: AbortSignal;
}

/**
 * Binds one open store to a request as the reserved `state` slot of the
 * Agent request context (#98 over #95): host wiring passes the result to
 * `runAgentRequest({ state, ... })` and routes reach it via
 * `(await agent()).state.dispatch(event, payload, { idempotencyKey })`.
 *
 * The handle deliberately narrows the store: no `reset` and no `close`.
 * Deterministic resets and store lifecycle belong to the host wiring and
 * test harnesses, not to request-scoped application code.
 */
export const createAgentStateHandle = <TState, TEvents extends AgentStateEventSchemas>(
  store: AgentStateStore<TState, TEvents>,
  options: AgentStateHandleOptions = {},
): AgentStateHandle<TState, TEvents> => {
  const handle: AgentStateHandle<TState, TEvents> = {
    lifetime: store.definition.lifetime,
    changes: (changesOptions) => store.changes({ signal: options.signal, ...changesOptions }),
    dispatch: (name, payload, dispatchOptions) =>
      store.dispatch(name, payload, { signal: options.signal, ...dispatchOptions }),
    read: (readOptions = {}) => store.read({ signal: options.signal, ...readOptions }),
  };
  return Object.freeze(handle);
};
