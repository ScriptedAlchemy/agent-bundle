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
import { canonicalJson } from '../state/index.js';
import {
  AgentNoticeError,
  type AgentNotice,
  type AgentNoticeAuthorizationDecision,
  type AgentNoticeAuthorizationRequest,
  type AgentNoticeAuthorizer,
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

const publishProgram = (
  store: NoticeStore,
  authorize: AgentNoticeAuthorizer,
  request: AgentNoticeRequest,
  input: AgentNoticePublishInput,
  options: AgentNoticePublishOptions,
): Effect.Effect<AgentNoticePublishResult, Error> => Effect.gen(function*() {
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
      priority: priority(input.priority),
      recipient: target,
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
        const admissionTime = Date.parse(request.invocation.startedAt);
        const expiring = before.state.notices.filter((notice) =>
          notice.state === 'pending'
          && notice.expiresAt !== undefined
          && Date.parse(notice.expiresAt) <= admissionTime);
        const candidates = before.state.notices.filter((notice) =>
          notice.state === 'pending'
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
          deliveries = Object.freeze(committed.state.notices
            .map((notice) => deliveryFor(notice, request.invocation.id))
            .filter((delivery): delivery is AgentNoticeDelivery => delivery !== undefined));
        }
      }

      let closed = false;
      const handle: AgentNoticesHandle = Object.freeze({
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
    }));
  },

  async read(): Promise<AgentNoticeLedgerSnapshot> {
    const snapshot = await store.read();
    return snapshotFrom(snapshot.revision, snapshot.state);
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
