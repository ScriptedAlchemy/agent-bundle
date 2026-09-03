import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeLedger,
} from '../notices/index.js';
import {
  AgentStateError,
  createAgentStateHandle,
  type AgentStateDefinition,
  type AgentStateDriver,
  type AgentStateEventSchemas,
  type AgentStateHandle,
  type AgentStateStore,
} from '../state/index.js';

export interface CreateGeneratedRuntimeStateOptions<
  TState,
  TEvents extends AgentStateEventSchemas,
> {
  readonly definition: AgentStateDefinition<TState, TEvents>;
  readonly driver: AgentStateDriver;
}

export interface GeneratedRuntimeRequestBindings<
  TState,
  TEvents extends AgentStateEventSchemas,
> {
  readonly noticeLedger: AgentNoticeLedger;
  readonly state: AgentStateHandle<TState, TEvents>;
  /** Releases request-lifetime stores; a no-op for process and durable owners. */
  close(): Promise<void>;
}

export interface GeneratedRuntimeState<
  TState,
  TEvents extends AgentStateEventSchemas,
> {
  close(): Promise<void>;
  requestBindings(
    options?: { readonly signal?: AbortSignal },
  ): Promise<GeneratedRuntimeRequestBindings<TState, TEvents>>;
}

type OpenResult<T> =
  | { readonly kind: 'opened'; readonly value: T }
  | { readonly error: AgentStateError; readonly kind: 'failed' };

type NoticeStore = Parameters<typeof createAgentNoticeLedger>[0];
type ClosableStore = { close(): Promise<void> };

const asStateError = (error: unknown, definitionId: string): AgentStateError =>
  error instanceof AgentStateError
    ? error
    : new AgentStateError('unavailable', `State '${definitionId}' store is unavailable`, { cause: error });

const failedHandle = <TState, TEvents extends AgentStateEventSchemas>(
  lifetime: AgentStateDefinition['lifetime'],
  failure: AgentStateError,
): AgentStateHandle<TState, TEvents> => Object.freeze({
  lifetime,
  changes: async () => Promise.reject(failure),
  dispatch: async () => Promise.reject(failure),
  read: async () => Promise.reject(failure),
});

const failedLedger = (failure: AgentStateError): AgentNoticeLedger => {
  const reject = async <T>(): Promise<T> => Promise.reject(failure);
  return Object.freeze({
    expire: reject,
    openRequest: async () => Object.freeze({
      close: () => undefined,
      handle: Object.freeze({
        inbox: reject,
        publish: reject,
        read: reject,
      }),
    }),
    read: reject,
    withdraw: reject,
  });
};

/**
 * Owns the state kernel and notice ledger used by generated request scopes.
 *
 * The v1 authorizer admits every publish and delivery request. Recipient
 * matching remains enforced by the ledger itself; application-specific
 * authorization is future embedder policy.
 */
export const createGeneratedRuntimeState = <
  TState,
  TEvents extends AgentStateEventSchemas,
>(
  options: CreateGeneratedRuntimeStateOptions<TState, TEvents>,
): GeneratedRuntimeState<TState, TEvents> => {
  const { definition, driver } = options;
  const noticeDefinition = agentNoticeStateDefinition(definition.lifetime);
  const shared = definition.lifetime !== 'request';
  const liveStores = new Set<ClosableStore>();
  let closing: Promise<void> | undefined;
  let closed = false;

  /** One lazily-opened store slot owning its cached failure and, when shared, its single open. */
  const createSlot = <TSlotState, TSlotEvents extends AgentStateEventSchemas>(
    slotDefinition: AgentStateDefinition<TSlotState, TSlotEvents>,
  ) => {
    let failure: AgentStateError | undefined;
    let pending: Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>> | undefined;

    const openOnce = async (): Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>> => {
      if (failure !== undefined) return { error: failure, kind: 'failed' };
      if (closed) {
        failure = new AgentStateError(
          'store-closed',
          `State '${slotDefinition.id}' cannot open on a closed generated runtime`,
        );
        return { error: failure, kind: 'failed' };
      }
      try {
        const store = await driver.open(slotDefinition);
        if (closed) {
          await store.close();
          failure = new AgentStateError(
            'store-closed',
            `State '${slotDefinition.id}' opened after its generated runtime closed`,
          );
          return { error: failure, kind: 'failed' };
        }
        liveStores.add(store);
        return { kind: 'opened', value: store };
      } catch (error) {
        failure = asStateError(error, slotDefinition.id);
        return { error: failure, kind: 'failed' };
      }
    };

    return {
      open(): Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>> {
        if (!shared) return openOnce();
        pending ??= openOnce();
        return pending;
      },
      get pending() {
        return pending;
      },
    };
  };

  const projectSlot = createSlot(definition);
  const noticeSlot = createSlot(noticeDefinition);

  const closeStore = async (store: ClosableStore): Promise<void> => {
    if (!liveStores.delete(store)) return;
    await store.close();
  };

  return Object.freeze({
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closed = true;
      closing = (async () => {
        await Promise.allSettled([
          ...(projectSlot.pending === undefined ? [] : [projectSlot.pending]),
          ...(noticeSlot.pending === undefined ? [] : [noticeSlot.pending]),
        ]);
        const storeClosures = await Promise.allSettled([...liveStores].map((store) => closeStore(store)));
        let driverFailure: unknown;
        try {
          await driver.close();
        } catch (error) {
          driverFailure = error;
        }
        const storeFailure = storeClosures.find((result) => result.status === 'rejected');
        if (storeFailure?.status === 'rejected') throw storeFailure.reason;
        if (driverFailure !== undefined) throw driverFailure;
      })();
      return closing;
    },

    async requestBindings(
      bindingOptions: { readonly signal?: AbortSignal } = {},
    ): Promise<GeneratedRuntimeRequestBindings<TState, TEvents>> {
      const [project, notices] = await Promise.all([projectSlot.open(), noticeSlot.open()]);
      const requestStores = shared
        ? []
        : [project, notices]
          .flatMap((result): ClosableStore[] => result.kind === 'opened' ? [result.value] : []);
      const state = project.kind === 'opened'
        ? createAgentStateHandle(project.value, bindingOptions)
        : failedHandle<TState, TEvents>(definition.lifetime, project.error);
      const noticeLedger = notices.kind === 'opened'
        ? createAgentNoticeLedger(notices.value, {
          authorize: () => ({ state: 'authorized' }),
        })
        : failedLedger(notices.error);
      let released = false;
      return Object.freeze({
        noticeLedger,
        state,
        async close() {
          if (released) return;
          released = true;
          for (const store of requestStores) await closeStore(store);
        },
      });
    },
  });
};
