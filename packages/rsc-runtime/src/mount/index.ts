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
  let projectFailure: AgentStateError | undefined;
  let noticeFailure: AgentStateError | undefined;
  let projectOpen: Promise<OpenResult<AgentStateStore<TState, TEvents>>> | undefined;
  let noticeOpen: Promise<OpenResult<NoticeStore>> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;

  const open = async <TState, TEvents extends AgentStateEventSchemas>(
    stateDefinition: AgentStateDefinition<TState, TEvents>,
    cachedFailure: () => AgentStateError | undefined,
    rememberFailure: (failure: AgentStateError) => void,
  ): Promise<OpenResult<AgentStateStore<TState, TEvents>>> => {
    const failure = cachedFailure();
    if (failure !== undefined) return { error: failure, kind: 'failed' };
    if (closed) {
      const closedFailure = new AgentStateError(
        'store-closed',
        `State '${stateDefinition.id}' cannot open on a closed generated runtime`,
      );
      rememberFailure(closedFailure);
      return { error: closedFailure, kind: 'failed' };
    }
    try {
      const store = await driver.open(stateDefinition);
      if (closed) {
        await store.close();
        const closedFailure = new AgentStateError(
          'store-closed',
          `State '${stateDefinition.id}' opened after its generated runtime closed`,
        );
        rememberFailure(closedFailure);
        return { error: closedFailure, kind: 'failed' };
      }
      liveStores.add(store);
      return { kind: 'opened', value: store };
    } catch (error) {
      const typed = asStateError(error, stateDefinition.id);
      rememberFailure(typed);
      return { error: typed, kind: 'failed' };
    }
  };

  const openProject = (): Promise<OpenResult<AgentStateStore<TState, TEvents>>> => {
    if (!shared) {
      return open(definition, () => projectFailure, (failure) => {
        projectFailure = failure;
      });
    }
    projectOpen ??= open(definition, () => projectFailure, (failure) => {
      projectFailure = failure;
    });
    return projectOpen;
  };

  const openNotices = (): Promise<OpenResult<NoticeStore>> => {
    if (!shared) {
      return open(noticeDefinition, () => noticeFailure, (failure) => {
        noticeFailure = failure;
      });
    }
    noticeOpen ??= open(noticeDefinition, () => noticeFailure, (failure) => {
      noticeFailure = failure;
    });
    return noticeOpen;
  };

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
          ...(projectOpen === undefined ? [] : [projectOpen]),
          ...(noticeOpen === undefined ? [] : [noticeOpen]),
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
      const [project, notices] = await Promise.all([openProject(), openNotices()]);
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
