import { createHash } from 'node:crypto';

import { Effect } from 'effect';

import {
  createAgentDocument,
  type AgentDocument,
} from '../agent-document.js';
import {
  runPromise,
  toRuntimeError,
} from '../effect/boundary.js';
import type { AgentStateStore } from '../state/contract.js';
import { AgentStateError, canonicalJson } from '../state/index.js';
import {
  AgentNoticeError,
  type AgentNotice,
  type AgentNoticeAuthorizationDecision,
  type AgentNoticeAuthorizationRequest,
  type AgentNoticeAuthorizer,
  type AgentNoticeAvailabilityReleaseOptions,
  type AgentNoticeAvailabilityReservationOptions,
  type AgentNoticeAvailabilitySignalOptions,
  type AgentNoticeDelivery,
  type AgentNoticeExpiryOptions,
  type AgentNoticeLedger,
  type AgentNoticeLedgerSnapshot,
  type AgentNoticePrincipal,
  type AgentNoticePublishInput,
  type AgentNoticePublishOptions,
  type AgentNoticePublishResult,
  type AgentNoticeRequest,
  type AgentNoticeRequestLease,
  type AgentNoticesHandle,
  type AgentNoticeWithdrawOptions,
  type AgentRecipient,
} from './contract.js';
import {
  agentNoticeEventSchemas,
  type AgentNoticeLedgerState,
  recipientMatchesPrincipal,
} from './state.js';

export interface CreateAgentNoticeLedgerOptions {
  readonly authorize: AgentNoticeAuthorizer;
}

type NoticeStore = AgentStateStore<AgentNoticeLedgerState, typeof agentNoticeEventSchemas>;

/** Revision races tolerated while committing a reserved receipt over the state it was judged against. */
const MAX_RESERVED_RECEIPT_ATTEMPTS = 8;

const noticeEffect = <A>(evaluate: () => A): Effect.Effect<A, AgentNoticeError> =>
  Effect.try({
    catch: (error) => error,
    try: evaluate,
  }).pipe(
    Effect.catch((error) =>
      error instanceof AgentNoticeError
        ? Effect.fail(error)
        : Effect.die(error),
    ),
  );

const storeEffect = <A>(evaluate: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    catch: toRuntimeError,
    try: evaluate,
  });

const nonEmptyText = (value: string, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentNoticeError('invalid-input', `${label} must be a non-empty string`);
  }
  return value;
};

const timestamp = (value: string, label: string): string => {
  nonEmptyText(value, label);
  if (!Number.isFinite(Date.parse(value))) {
    throw new AgentNoticeError('invalid-input', `${label} must be an ISO-8601 timestamp`);
  }
  return value;
};

const availabilityNoticeIds = (noticeIds: readonly string[]): string[] => {
  if (noticeIds.length === 0) {
    throw new AgentNoticeError('invalid-input', 'Notice availability requires at least one notice id');
  }
  return noticeIds.map((id) => nonEmptyText(id, 'Notice id'));
};

const availabilityExpectedRevision = (expectedRevision: number | undefined): number | undefined => {
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new AgentNoticeError('invalid-input', 'Notice availability expectedRevision must be a non-negative integer');
  }
  return expectedRevision;
};

const priority = (value: AgentNoticePublishInput['priority']): AgentNoticePublishInput['priority'] => {
  switch (value) {
    case 'low':
    case 'normal':
    case 'high':
      return value;
    default: {
      const exhaustive: never = value;
      throw new AgentNoticeError('invalid-input', `Unknown notice priority ${String(exhaustive)}`);
    }
  }
};

const recipient = (input: AgentRecipient): AgentRecipient => {
  const result: AgentRecipient = Object.freeze({
    ...(input.actor === undefined
      ? {}
      : { actor: Object.freeze({ id: nonEmptyText(input.actor.id, 'Notice recipient actor id') }) }),
    ...(input.host === undefined
      ? {}
      : { host: Object.freeze({ name: nonEmptyText(input.host.name, 'Notice recipient host name') }) }),
    ...(input.session === undefined
      ? {}
      : { session: Object.freeze({ sessionId: nonEmptyText(input.session.sessionId, 'Notice recipient session id') }) }),
    ...(input.workspace === undefined
      ? {}
      : { workspace: Object.freeze({ root: nonEmptyText(input.workspace.root, 'Notice recipient workspace root') }) }),
  });
  if (Object.keys(result).length === 0) {
    throw new AgentNoticeError('invalid-input', 'A notice recipient requires at least one observed identity axis');
  }
  return result;
};

const authorizeEffect = (
  authorize: AgentNoticeAuthorizer,
  request: AgentNoticeAuthorizationRequest,
): Effect.Effect<AgentNoticeAuthorizationDecision, AgentNoticeError> =>
  Effect.tryPromise({
    catch: (error) => new AgentNoticeError(
      'unauthorized',
      `Notice ${request.phase} authorization failed closed`,
      { cause: error },
    ),
    try: async () => authorize(request),
  }).pipe(
    Effect.flatMap((decision) => noticeEffect(() => {
      switch (decision.state) {
        case 'authorized':
        case 'unavailable':
          return decision;
        default: {
          const exhaustive: never = decision;
          throw new AgentNoticeError(
            'unauthorized',
            `Notice ${request.phase} authorization returned an invalid decision ${String(exhaustive)}`,
          );
        }
      }
    })),
  );

const findPublishedNotice = (
  notices: readonly AgentNotice[],
  candidateId: string,
  candidateRecipient: AgentRecipient,
  dedupeKey: string | undefined,
): AgentNotice | undefined => notices.find((notice) =>
  notice.id === candidateId
  || dedupeKey !== undefined
    && notice.dedupeKey === dedupeKey
    && canonicalJson(notice.recipient) === canonicalJson(candidateRecipient));

const snapshotFrom = (
  revision: number,
  state: AgentNoticeLedgerState,
): AgentNoticeLedgerSnapshot => Object.freeze({
  notices: state.notices,
  revision,
});

const assertOpen = (closed: boolean, signal: AbortSignal): void => {
  if (closed) {
    throw new AgentNoticeError('request-closed', 'Notice request handle used after the invocation completed');
  }
  if (signal.aborted) {
    throw new AgentNoticeError('aborted', 'Notice request operation was aborted', { cause: signal.reason });
  }
};

const publishProgram = Effect.fnUntraced(function*(
  store: NoticeStore,
  authorize: AgentNoticeAuthorizer,
  request: AgentNoticeRequest,
  input: AgentNoticePublishInput,
  options: AgentNoticePublishOptions,
): Effect.fn.Return<AgentNoticePublishResult, Error> {
  const prepared = yield* noticeEffect(() => {
    const target = recipient(input.recipient);
    const createdAt = timestamp(request.invocation.startedAt, 'Notice createdAt');
    const expiresAt = input.expiresAt === undefined
      ? undefined
      : timestamp(input.expiresAt, 'Notice expiresAt');
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new AgentNoticeError('invalid-input', 'Notice expiresAt must be later than createdAt');
    }
    const idempotencyKey = nonEmptyText(options.idempotencyKey, 'Notice publish idempotency key');
    const dedupeKey = input.dedupeKey === undefined
      ? undefined
      : nonEmptyText(input.dedupeKey, 'Notice dedupe key');
    const retryBudget = input.retryBudget;
    if (retryBudget !== undefined && (!Number.isInteger(retryBudget) || retryBudget < 1)) {
      throw new AgentNoticeError('invalid-input', 'Notice retryBudget must be a positive integer');
    }
    const nextAttemptAt = input.nextAttemptAt === undefined
      ? undefined
      : timestamp(input.nextAttemptAt, 'Notice nextAttemptAt');
    if (nextAttemptAt !== undefined && expiresAt !== undefined
      && Date.parse(nextAttemptAt) >= Date.parse(expiresAt)) {
      throw new AgentNoticeError('invalid-input', 'Notice nextAttemptAt must be earlier than expiresAt');
    }
    const id = `notice_${createHash('sha256')
      .update(canonicalJson({ idempotencyKey, recipient: target }), 'utf8')
      .digest('hex')}`;
    const notice: AgentNotice = Object.freeze({
      attempts: Object.freeze([]),
      content: createAgentDocument(input.content as AgentDocument),
      createdAt,
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      id,
      ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      priority: priority(input.priority),
      recipient: target,
      ...(retryBudget === undefined ? {} : { retryBudget }),
      state: 'pending',
    });
    return { dedupeKey, id, idempotencyKey, notice, target };
  });
  const authorization = yield* authorizeEffect(authorize, {
    phase: 'publish',
    principal: request.principal,
    recipient: prepared.target,
  });
  if (authorization.state === 'unavailable') {
    return yield* Effect.fail(new AgentNoticeError(
      'unauthorized',
      'Notice publish authorization is unavailable',
    ));
  }
  const committed = yield* storeEffect(() => store.dispatch(
    'published',
    { notice: prepared.notice },
    {
      idempotencyKey: prepared.idempotencyKey,
      signal: request.signal,
    },
  ));
  const persisted = findPublishedNotice(
    committed.state.notices,
    prepared.id,
    prepared.target,
    prepared.dedupeKey,
  );
  if (persisted === undefined) {
    return yield* Effect.die(new Error('Notice publish committed without a persisted notice'));
  }
  return Object.freeze({
    deduped: committed.replayed || persisted.id !== prepared.id,
    notice: persisted,
    replayed: committed.replayed,
    revision: committed.revision,
  });
});

const deliveryFor = (
  notice: AgentNotice,
  invocationId: string,
): AgentNoticeDelivery | undefined => {
  if (notice.state !== 'attempted') return undefined;
  const receipt = notice.attempts.find((attempt) => attempt.invocationId === invocationId);
  return receipt === undefined ? undefined : Object.freeze({ notice, receipt });
};

const inboxProgram = Effect.fnUntraced(function*(
  store: NoticeStore,
  authorize: AgentNoticeAuthorizer,
  request: AgentNoticeRequest,
): Effect.fn.Return<readonly AgentNotice[], Error> {
  const before = yield* storeEffect(() => store.read({ signal: request.signal }));
  const readTime = Date.parse(request.invocation.startedAt);
  const candidates = before.state.notices.filter((notice) =>
    notice.state === 'pending'
    && Date.parse(notice.createdAt) <= readTime
    // Inbox reads do not own durable expiry; event admission remains the expiry boundary.
    && (notice.expiresAt === undefined || Date.parse(notice.expiresAt) > readTime)
    && recipientMatchesPrincipal(notice.recipient, request.principal));
  const decisions = yield* Effect.forEach(candidates, (notice) =>
    authorizeEffect(authorize, {
      noticeId: notice.id,
      phase: 'read',
      principal: request.principal,
      recipient: notice.recipient,
    }).pipe(Effect.map((decision) => ({ decision, id: notice.id }))));
  const noticeIds = decisions
    .filter(({ decision }) => decision.state === 'authorized')
    .map(({ id }) => id);
  if (noticeIds.length === 0) return Object.freeze([]);
  const committed = yield* storeEffect(() => store.dispatch(
    'exposed',
    {
      at: request.invocation.startedAt,
      channel: 'mcp-inbox',
      invocationId: request.invocation.id,
      noticeIds,
    },
    {
      idempotencyKey: `agent-notices:expose:${request.invocation.id}`,
      signal: request.signal,
    },
  ));
  const returnedIds = new Set(noticeIds);
  return Object.freeze(committed.state.notices
    .filter((notice) => notice.state === 'pending' && returnedIds.has(notice.id))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
});

export const createAgentNoticeLedger = (
  store: NoticeStore,
  options: CreateAgentNoticeLedgerOptions,
): AgentNoticeLedger => Object.freeze({
  expire(expiry: AgentNoticeExpiryOptions): Promise<AgentNoticeLedgerSnapshot> {
    return runPromise(Effect.gen(function*() {
      const at = yield* noticeEffect(() => timestamp(expiry.at, 'Notice expiry time'));
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(expiry.idempotencyKey, 'Notice expiry idempotency key'));
      const committed = yield* storeEffect(() => store.dispatch(
        'expired',
        { at },
        { idempotencyKey },
      ));
      return snapshotFrom(committed.revision, committed.state);
    }));
  },

  openRequest(request: AgentNoticeRequest): Promise<AgentNoticeRequestLease> {
    return runPromise(Effect.gen(function*() {
      let deliveries: readonly AgentNoticeDelivery[] = Object.freeze([]);
      if (request.invocation.kind === 'event') {
        const before = yield* storeEffect(() => store.read({ signal: request.signal }));
        let admitted = before.state;
        const admissionTime = Date.parse(request.invocation.startedAt);
        const expiring = before.state.notices.filter((notice) =>
          (notice.state === 'pending'
            || notice.state === 'attempted' && notice.attempts.length < (notice.retryBudget ?? 1))
          && notice.expiresAt !== undefined
          && Date.parse(notice.expiresAt) <= admissionTime);
        const candidates = before.state.notices.filter((notice) =>
          (notice.state === 'pending'
            || notice.state === 'attempted' && notice.attempts.length < (notice.retryBudget ?? 1))
          && Date.parse(notice.createdAt) <= admissionTime
          && (notice.nextAttemptAt === undefined || Date.parse(notice.nextAttemptAt) <= admissionTime)
          && (notice.expiresAt === undefined
            || Date.parse(notice.expiresAt) > admissionTime)
          && recipientMatchesPrincipal(notice.recipient, request.principal));
        const decisions = yield* Effect.forEach(candidates, (notice) =>
          authorizeEffect(options.authorize, {
            noticeId: notice.id,
            phase: 'deliver',
            principal: request.principal,
            recipient: notice.recipient,
          }).pipe(Effect.map((decision) => ({ decision, id: notice.id }))));
        if (expiring.length > 0 || decisions.length > 0) {
          const committed = yield* storeEffect(() => store.dispatch(
            'admitted',
            {
              at: request.invocation.startedAt,
              authorizedIds: decisions
                .filter(({ decision }) => decision.state === 'authorized')
                .map(({ id }) => id),
              invocationId: request.invocation.id,
              principal: request.principal,
              unavailableIds: decisions
                .filter(({ decision }) => decision.state === 'unavailable')
                .map(({ id }) => id),
            },
            {
              idempotencyKey: `agent-notices:admit:${request.invocation.id}`,
              signal: request.signal,
            },
          ));
          admitted = committed.state;
        }
        deliveries = Object.freeze(admitted.notices
          .filter((notice) => recipientMatchesPrincipal(notice.recipient, request.principal))
          .map((notice) => deliveryFor(notice, request.invocation.id))
          .filter((delivery): delivery is AgentNoticeDelivery => delivery !== undefined));
      }

      let closed = false;
      const handle: AgentNoticesHandle = Object.freeze({
        acknowledge(id: string) {
          return runPromise(Effect.gen(function*() {
            yield* noticeEffect(() => assertOpen(closed, request.signal));
            const noticeId = yield* noticeEffect(() => nonEmptyText(id, 'Notice id'));
            const before = yield* storeEffect(() => store.read({ signal: request.signal }));
            const target = before.state.notices.find((notice) => notice.id === noticeId);
            if (target === undefined) {
              return yield* Effect.fail(new AgentNoticeError('invalid-input', `Unknown notice ${noticeId}`));
            }
            if (!recipientMatchesPrincipal(target.recipient, request.principal)) {
              return yield* Effect.fail(new AgentNoticeError(
                'unauthorized',
                'Only the notice recipient may acknowledge it',
              ));
            }
            // Same eligibility boundary as inbox/event admission: a request
            // that started before the notice existed cannot produce a durable
            // acknowledgement receipt predating createdAt.
            if (Date.parse(target.createdAt) > Date.parse(request.invocation.startedAt)) {
              return yield* Effect.fail(new AgentNoticeError(
                'invalid-input',
                `Notice ${noticeId} was created after this invocation started`,
              ));
            }
            const authorization = yield* authorizeEffect(options.authorize, {
              noticeId,
              phase: 'acknowledge',
              principal: request.principal,
              recipient: target.recipient,
            });
            if (authorization.state === 'unavailable') {
              return yield* Effect.fail(new AgentNoticeError(
                'unauthorized',
                'Notice acknowledgement authorization is unavailable',
              ));
            }
            const committed = yield* storeEffect(() => store.dispatch(
              'acknowledged',
              {
                at: request.invocation.startedAt,
                id: noticeId,
                invocationId: request.invocation.id,
              },
              {
                idempotencyKey: `agent-notices:ack:${request.invocation.id}:${noticeId}`,
                signal: request.signal,
              },
            ));
            const acknowledged = committed.state.notices.find((notice) => notice.id === noticeId);
            if (acknowledged === undefined || acknowledged.state !== 'acknowledged') {
              return yield* Effect.fail(new AgentNoticeError(
                'invalid-input',
                `Notice ${noticeId} is not acknowledgeable from state ${acknowledged?.state ?? 'missing'}`,
              ));
            }
            return acknowledged;
          }));
        },
        inbox() {
          return runPromise(Effect.gen(function*() {
            yield* noticeEffect(() => assertOpen(closed, request.signal));
            return yield* inboxProgram(store, options.authorize, request);
          }));
        },
        publish(input: AgentNoticePublishInput, publishOptions: AgentNoticePublishOptions) {
          return runPromise(Effect.gen(function*() {
            yield* noticeEffect(() => assertOpen(closed, request.signal));
            return yield* publishProgram(store, options.authorize, request, input, publishOptions);
          }));
        },
        read() {
          return runPromise(noticeEffect(() => {
            assertOpen(closed, request.signal);
            return deliveries;
          }));
        },
      });
      return Object.freeze({
        close() {
          closed = true;
        },
        handle,
      });
    }), { signal: request.signal });
  },

  async read(): Promise<AgentNoticeLedgerSnapshot> {
    const snapshot = await store.read();
    return snapshotFrom(snapshot.revision, snapshot.state);
  },

  releaseAvailability(options: AgentNoticeAvailabilityReleaseOptions): Promise<AgentNoticeLedgerSnapshot> {
    return runPromise(Effect.gen(function*() {
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(options.idempotencyKey, 'Notice availability idempotency key'));
      const noticeIds = yield* noticeEffect(() => availabilityNoticeIds(options.noticeIds));
      const reservationKey = yield* noticeEffect(() =>
        nonEmptyText(options.reservationKey, 'Notice availability reservation key'));
      const committed = yield* storeEffect(() => store.dispatch(
        'availability-released',
        { noticeIds, reservationKey },
        { idempotencyKey },
      ));
      return snapshotFrom(committed.revision, committed.state);
    }));
  },

  reserveAvailability(options: AgentNoticeAvailabilityReservationOptions): Promise<AgentNoticeLedgerSnapshot> {
    return runPromise(Effect.gen(function*() {
      const at = yield* noticeEffect(() => timestamp(options.at, 'Notice availability time'));
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(options.idempotencyKey, 'Notice availability idempotency key'));
      const noticeIds = yield* noticeEffect(() => availabilityNoticeIds(options.noticeIds));
      const reservationKey = yield* noticeEffect(() =>
        nonEmptyText(options.reservationKey, 'Notice availability reservation key'));
      const expectedRevision = yield* noticeEffect(() => availabilityExpectedRevision(options.expectedRevision));
      const committed = yield* storeEffect(() => store.dispatch(
        'availability-reserved',
        { at, noticeIds, reservationKey },
        { ...(expectedRevision === undefined ? {} : { expectedRevision }), idempotencyKey },
      ));
      return snapshotFrom(committed.revision, committed.state);
    }));
  },

  signalAvailability(options: AgentNoticeAvailabilitySignalOptions): Promise<AgentNoticeLedgerSnapshot> {
    return runPromise(Effect.gen(function*() {
      const at = yield* noticeEffect(() => timestamp(options.at, 'Notice availability time'));
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(options.idempotencyKey, 'Notice availability idempotency key'));
      const noticeIds = yield* noticeEffect(() => availabilityNoticeIds(options.noticeIds));
      const reservationKey = yield* noticeEffect(() => options.reservationKey === undefined
        ? undefined
        : nonEmptyText(options.reservationKey, 'Notice availability reservation key'));
      const expectedRevision = yield* noticeEffect(() => availabilityExpectedRevision(options.expectedRevision));
      const payload = {
        at,
        channel: 'mcp-resource-updated' as const,
        noticeIds,
        ...(reservationKey === undefined ? {} : { reservationKey }),
      };
      if (reservationKey === undefined) {
        const committed = yield* storeEffect(() => store.dispatch(
          'availability-signalled',
          payload,
          { ...(expectedRevision === undefined ? {} : { expectedRevision }), idempotencyKey },
        ));
        return snapshotFrom(committed.revision, committed.state);
      }
      // A reserved receipt is judged against the exact state it commits over:
      // the dispatch is guarded by the revision just read, so the ownership
      // check and the reducer see the same holds. Unrelated writers move the
      // revision too, hence the bounded re-read. An idempotent replay of an
      // already-committed receipt short-circuits the guard inside the store
      // and is never mistaken for a lost hold.
      for (let attempt = 0; attempt < MAX_RESERVED_RECEIPT_ATTEMPTS; attempt += 1) {
        const before = yield* storeEffect(() => store.read());
        if (expectedRevision !== undefined && expectedRevision !== before.revision) {
          return yield* storeEffect(() => Promise.reject(new AgentStateError(
            'revision-conflict',
            `Notice availability expected revision ${String(expectedRevision)} but the head is ${String(before.revision)}`,
          )));
        }
        const committed = yield* storeEffect(() => store.dispatch(
          'availability-signalled',
          payload,
          { expectedRevision: before.revision, idempotencyKey },
        )).pipe(Effect.catch((error) =>
          error instanceof AgentStateError && error.code === 'revision-conflict'
            ? Effect.succeed(undefined)
            : Effect.fail(error)));
        if (committed === undefined) continue;
        if (!committed.replayed) {
          const lost = before.state.notices.filter((notice) =>
            noticeIds.includes(notice.id)
            && (notice.state === 'pending' || notice.state === 'attempted')
            && notice.availabilityReservation?.key !== reservationKey);
          if (lost.length > 0) {
            return yield* Effect.fail(new AgentNoticeError(
              'reservation-lost',
              `Notice availability reservation ${JSON.stringify(reservationKey)} no longer holds ${
                lost.map((notice) => notice.id).join(', ')
              }; no receipt was recorded for it`,
            ));
          }
        }
        return snapshotFrom(committed.revision, committed.state);
      }
      return yield* storeEffect(() => Promise.reject(new AgentStateError(
        'revision-conflict',
        `Notice availability receipt lost ${String(MAX_RESERVED_RECEIPT_ATTEMPTS)} consecutive revision races`,
      )));
    }));
  },

  withdraw(id: string, withdrawal: AgentNoticeWithdrawOptions): Promise<AgentNoticeLedgerSnapshot> {
    return runPromise(Effect.gen(function*() {
      const noticeId = yield* noticeEffect(() => nonEmptyText(id, 'Notice id'));
      const at = yield* noticeEffect(() => timestamp(withdrawal.at, 'Notice withdrawal time'));
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(withdrawal.idempotencyKey, 'Notice withdrawal idempotency key'));
      const committed = yield* storeEffect(() => store.dispatch(
        'withdrawn',
        { at, id: noticeId },
        { idempotencyKey },
      ));
      return snapshotFrom(committed.revision, committed.state);
    }));
  },
});
