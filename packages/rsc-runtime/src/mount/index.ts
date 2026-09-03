import {
  agentNoticeStateDefinition,
  createAgentNoticeLedger,
  type AgentNoticeDeliveryAdvertisement,
  type AgentNoticeLedger,
  type AgentNoticeRetentionInput,
  resolveNoticeRetentionPolicy,
} from '../notices/index.js';
import {
  AgentStateError,
  createAgentStateHandle,
  type AgentStateDefinition,
  type AgentStateDriver,
  type AgentStateEventSchemas,
  type AgentStateHandle,
  type AgentStateLifetime,
  type AgentStateStore,
} from '../state/index.js';

/**
 * Notice ledger policy a generated runtime mounts beside the project state:
 * the host's delivery advertisement (whose per-route `sensitivity` ceilings
 * the ledger honours) and the project's retention overrides.
 */
export interface GeneratedNoticePolicyOptions {
  readonly noticeDelivery?: AgentNoticeDeliveryAdvertisement;
  readonly noticeRetention?: AgentNoticeRetentionInput;
}

export interface CreateGeneratedRuntimeStateOptions<
  TState,
  TEvents extends AgentStateEventSchemas,
> extends GeneratedNoticePolicyOptions {
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

/**
 * A process-lifetime handle on the notice ledger, outside any request scope.
 * The generated MCP server process uses it to observe the ledger its render
 * worker mounts (for `resources/updated` delivery); request-lifetime notices
 * have no cross-request ledger, so the handle fails typed for that lifetime.
 */
export interface GeneratedNoticeRuntime {
  close(): Promise<void>;
  noticeLedger(): Promise<AgentNoticeLedger>;
}

export interface GeneratedRuntimeState<
  TState,
  TEvents extends AgentStateEventSchemas,
> extends GeneratedNoticeRuntime {
  requestBindings(
    options?: { readonly signal?: AbortSignal },
  ): Promise<GeneratedRuntimeRequestBindings<TState, TEvents>>;
}

export interface CreateGeneratedNoticeRuntimeOptions extends GeneratedNoticePolicyOptions {
  readonly driver: AgentStateDriver;
  readonly lifetime: AgentStateLifetime;
}

type OpenResult<T> =
  | { readonly kind: 'opened'; readonly value: T }
  | { readonly error: AgentStateError; readonly kind: 'failed' };

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
    inspect: reject,
    openRequest: async () => Object.freeze({
      close: () => undefined,
      handle: Object.freeze({
        acknowledge: reject,
        inbox: reject,
        publish: reject,
        read: reject,
      }),
    }),
    read: reject,
    releaseAvailability: reject,
    reserveAvailability: reject,
    retain: reject,
    signalAvailability: reject,
    withdraw: reject,
  });
};

/**
 * The v1 authorizer admits every publish and delivery request. Recipient
 * matching remains enforced by the ledger itself; application-specific
 * authorization is future embedder policy.
 */
const generatedNoticeAuthorizer = { authorize: () => ({ state: 'authorized' as const }) };

type NoticeStore = Parameters<typeof createAgentNoticeLedger>[0];

const ledgerFrom = (result: OpenResult<NoticeStore>, policy: GeneratedNoticePolicyOptions): AgentNoticeLedger =>
  result.kind === 'opened'
    ? createAgentNoticeLedger(result.value, {
      ...generatedNoticeAuthorizer,
      ...(policy.noticeDelivery === undefined ? {} : { delivery: policy.noticeDelivery }),
      ...(policy.noticeRetention === undefined ? {} : { retention: policy.noticeRetention }),
    })
    : failedLedger(result.error);

interface StoreSlot<TSlotState, TSlotEvents extends AgentStateEventSchemas> {
  open(): Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>>;
  readonly pending: Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>> | undefined;
}

/**
 * Owns one driver, the stores lazily opened from it, and their ordered
 * teardown. Each slot owns its cached failure and, when its lifetime is
 * shared, its single open; request-lifetime slots open per call and hand the
 * store back to the caller to release.
 */
const createStoreOwner = (driver: AgentStateDriver) => {
  const liveStores = new Set<ClosableStore>();
  const slots: { readonly pending: Promise<unknown> | undefined }[] = [];
  let closing: Promise<void> | undefined;
  let closed = false;

  const createSlot = <TSlotState, TSlotEvents extends AgentStateEventSchemas>(
    slotDefinition: AgentStateDefinition<TSlotState, TSlotEvents>,
  ): StoreSlot<TSlotState, TSlotEvents> => {
    const shared = slotDefinition.lifetime !== 'request';
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

    const slot: StoreSlot<TSlotState, TSlotEvents> = {
      open(): Promise<OpenResult<AgentStateStore<TSlotState, TSlotEvents>>> {
        if (!shared) return openOnce();
        pending ??= openOnce();
        return pending;
      },
      get pending() {
        return pending;
      },
    };
    slots.push(slot);
    return slot;
  };

  const closeStore = async (store: ClosableStore): Promise<void> => {
    if (!liveStores.delete(store)) return;
    await store.close();
  };

  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled(slots.flatMap((slot) => (slot.pending === undefined ? [] : [slot.pending])));
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
  };

  return { close, closeStore, createSlot };
};

const requestLifetimeLedger = (): AgentNoticeLedger => failedLedger(new AgentStateError(
  'lifetime-mismatch',
  'Request-lifetime notices have no ledger outside a request scope',
));

/**
 * Owns the state kernel and notice ledger used by generated request scopes.
 */
export const createGeneratedRuntimeState = <
  TState,
  TEvents extends AgentStateEventSchemas,
>(
  options: CreateGeneratedRuntimeStateOptions<TState, TEvents>,
): GeneratedRuntimeState<TState, TEvents> => {
  const { definition, driver } = options;
  const owner = createStoreOwner(driver);
  const shared = definition.lifetime !== 'request';
  const projectSlot = owner.createSlot(definition);
  const noticeSlot = owner.createSlot(agentNoticeStateDefinition(definition.lifetime));
  // The retention policy is validated once, when the runtime is created, so a
  // malformed override fails the process at startup rather than the first request.
  resolveNoticeRetentionPolicy(options.noticeRetention);

  return Object.freeze({
    close: owner.close,

    async noticeLedger(): Promise<AgentNoticeLedger> {
      if (!shared) return requestLifetimeLedger();
      return ledgerFrom(await noticeSlot.open(), options);
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
      const noticeLedger = ledgerFrom(notices, options);
      let released = false;
      return Object.freeze({
        noticeLedger,
        state,
        async close() {
          if (released) return;
          released = true;
          for (const store of requestStores) await owner.closeStore(store);
        },
      });
    },
  });
};

/**
 * Owns only the notice ledger over a driver: the handle a generated MCP
 * server process holds on the durable store its Flight worker mounts, so it
 * can observe ledger revisions and emit `resources/updated` to subscribed
 * connections without evaluating the project's state definition twice.
 */
export const createGeneratedNoticeRuntime = (
  options: CreateGeneratedNoticeRuntimeOptions,
): GeneratedNoticeRuntime => {
  const owner = createStoreOwner(options.driver);
  const shared = options.lifetime !== 'request';
  const noticeSlot = owner.createSlot(agentNoticeStateDefinition(options.lifetime));
  resolveNoticeRetentionPolicy(options.noticeRetention);
  return Object.freeze({
    close: owner.close,
    async noticeLedger(): Promise<AgentNoticeLedger> {
      if (!shared) return requestLifetimeLedger();
      return ledgerFrom(await noticeSlot.open(), options);
    },
  });
};
