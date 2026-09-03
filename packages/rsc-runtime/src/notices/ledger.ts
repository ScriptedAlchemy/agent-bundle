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
  AGENT_NOTICE_STATES,
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
  type AgentNoticeLedgerInspection,
  type AgentNoticeLedgerSnapshot,
  type AgentNoticePrincipal,
  type AgentNoticePublishInput,
  type AgentNoticePublishOptions,
  type AgentNoticePublishResult,
  type AgentNoticeRequest,
  type AgentNoticeRequestLease,
  type AgentNoticeRetainOptions,
  type AgentNoticeRetentionReport,
  type AgentNoticesHandle,
  type AgentNoticeState,
  type AgentNoticeWithdrawOptions,
  type AgentNoticeWithheldEntry,
  type AgentRecipient,
} from './contract.js';
import {
  AGENT_NOTICE_DEFAULT_SENSITIVITY,
  disclosedNoticeContent,
  isNoticeSensitivity,
  type AgentNoticeDisclosure,
  type AgentNoticeSensitivity,
} from './redaction.js';
import {
  noticeIsTerminal,
  resolveNoticeRetentionPolicy,
  selectPrunableNotices,
  type AgentNoticeRetentionInput,
} from './retention.js';
import {
  resolveNoticeDisclosure,
  type AgentNoticeDeliveryAdvertisement,
  type AgentNoticeDeliveryRoute,
} from './router.js';
import {
  agentNoticeEventSchemas,
  type AgentNoticeLedgerState,
  recipientMatchesPrincipal,
} from './state.js';

export interface CreateAgentNoticeLedgerOptions {
  readonly authorize: AgentNoticeAuthorizer;
  /**
   * The host's notice delivery advertisement, whose per-route `sensitivity`
   * ceilings the ledger honours when it discloses content through the inbox
   * and next-event routes. Absent means every route admits `internal` (the
   * pre-sensitivity contract) and `secret` notices are withheld everywhere.
   */
  readonly delivery?: AgentNoticeDeliveryAdvertisement;
  /** Retention overrides; defaults are `AGENT_NOTICE_DEFAULT_RETENTION`. */
  readonly retention?: AgentNoticeRetentionInput;
}

/** A notice persisted before the redaction contract carries no class and is `internal`. */
const sensitivityOf = (notice: AgentNotice): AgentNoticeSensitivity =>
  notice.sensitivity ?? AGENT_NOTICE_DEFAULT_SENSITIVITY;

type Disclosed = Extract<AgentNoticeDisclosure, { readonly kind: 'disclosed' }>;

/** Splits matching notices into what a route discloses and what it withholds, with the reason. */
const discloseFor = (
  route: AgentNoticeDeliveryRoute,
  notices: readonly AgentNotice[],
  advertisement: AgentNoticeDeliveryAdvertisement | undefined,
): {
  readonly disclosed: readonly { readonly disclosure: Disclosed; readonly notice: AgentNotice }[];
  readonly withheld: readonly AgentNoticeWithheldEntry[];
} => {
  const disclosed: { readonly disclosure: Disclosed; readonly notice: AgentNotice }[] = [];
  const withheld: AgentNoticeWithheldEntry[] = [];
  for (const notice of notices) {
    const disclosure = resolveNoticeDisclosure(route, sensitivityOf(notice), advertisement);
    switch (disclosure.kind) {
      case 'disclosed':
        disclosed.push({ disclosure, notice });
        break;
      case 'withheld':
        withheld.push(Object.freeze({ id: notice.id, reason: disclosure.reason }));
        break;
      default: {
        const exhaustive: never = disclosure;
        return exhaustive;
      }
    }
  }
  return { disclosed: Object.freeze(disclosed), withheld: Object.freeze(withheld) };
};

/** The notice as the route hands it out: `content` replaced by the disclosed document. */
const disclosedNotice = (notice: AgentNotice, disclosure: Disclosed): AgentNotice => {
  const content = disclosedNoticeContent(notice.content, disclosure);
  return content === undefined || content === notice.content ? notice : Object.freeze({ ...notice, content });
};

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

const sensitivity = (value: AgentNoticeSensitivity | undefined): AgentNoticeSensitivity => {
  if (value === undefined) return AGENT_NOTICE_DEFAULT_SENSITIVITY;
  if (!isNoticeSensitivity(value)) {
    throw new AgentNoticeError('invalid-input', `Unknown notice sensitivity ${JSON.stringify(value)}`);
  }
  return value;
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
  ...(state.retention === undefined ? {} : { retention: state.retention }),
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
      // Persisted explicitly: only notices from before the redaction contract
      // leave the class absent.
      sensitivity: sensitivity(input.sensitivity),
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
  disclosures: ReadonlyMap<string, Disclosed>,
): AgentNoticeDelivery | undefined => {
  if (notice.state !== 'attempted') return undefined;
  const receipt = notice.attempts.find((attempt) => attempt.invocationId === invocationId);
  if (receipt === undefined) return undefined;
  // Attempted in this invocation means the route disclosed it; a receipt from
  // this invocation without a decision (a replayed admission whose state was
  // read fresh) falls back to the notice's own class.
  const disclosure = disclosures.get(notice.id)
    ?? Object.freeze({ kind: 'disclosed' as const, redacted: sensitivityOf(notice) === 'internal', shape: 'body' as const });
  return Object.freeze({
    disclosure: Object.freeze({ redacted: disclosure.redacted, route: 'next-event' as const }),
    notice: disclosedNotice(notice, disclosure),
    receipt,
  });
};

const inboxProgram = Effect.fnUntraced(function*(
  store: NoticeStore,
  authorize: AgentNoticeAuthorizer,
  request: AgentNoticeRequest,
  advertisement: AgentNoticeDeliveryAdvertisement | undefined,
): Effect.fn.Return<readonly AgentNotice[], Error> {
  const before = yield* storeEffect(() => store.read({ signal: request.signal }));
  const readTime = Date.parse(request.invocation.startedAt);
  const matching = before.state.notices.filter((notice) =>
    notice.state === 'pending'
    && Date.parse(notice.createdAt) <= readTime
    // Inbox reads do not own durable expiry; event admission remains the expiry boundary.
    && (notice.expiresAt === undefined || Date.parse(notice.expiresAt) > readTime)
    && recipientMatchesPrincipal(notice.recipient, request.principal));
  // Redaction policy first: a withheld notice is never authorized for read,
  // exposed, or returned; the refusal itself is the only thing recorded.
  const { disclosed, withheld } = discloseFor('mcp-inbox', matching, advertisement);
  const decisions = yield* Effect.forEach(disclosed, ({ notice }) =>
    authorizeEffect(authorize, {
      noticeId: notice.id,
      phase: 'read',
      principal: request.principal,
      recipient: notice.recipient,
    }).pipe(Effect.map((decision) => ({ decision, id: notice.id }))));
  const noticeIds = decisions
    .filter(({ decision }) => decision.state === 'authorized')
    .map(({ id }) => id);
  if (noticeIds.length === 0 && withheld.length === 0) return Object.freeze([]);
  const committed = yield* storeEffect(() => store.dispatch(
    'exposed',
    {
      at: request.invocation.startedAt,
      channel: 'mcp-inbox',
      invocationId: request.invocation.id,
      noticeIds,
      ...(withheld.length === 0 ? {} : { withheld: [...withheld] }),
    },
    {
      idempotencyKey: `agent-notices:expose:${request.invocation.id}`,
      signal: request.signal,
    },
  ));
  const returnedIds = new Set(noticeIds);
  const disclosures = new Map(disclosed.map(({ disclosure, notice }) => [notice.id, disclosure]));
  return Object.freeze(committed.state.notices
    .filter((notice) => notice.state === 'pending' && returnedIds.has(notice.id))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((notice) => {
      const disclosure = disclosures.get(notice.id);
      return disclosure === undefined ? notice : disclosedNotice(notice, disclosure);
    }));
});

const stateCounts = (notices: readonly AgentNotice[]): AgentNoticeLedgerInspection['counts'] => {
  const byState = Object.fromEntries(AGENT_NOTICE_STATES.map((state) => [state, 0])) as Record<AgentNoticeState, number>;
  let terminal = 0;
  for (const notice of notices) {
    byState[notice.state] += 1;
    if (noticeIsTerminal(notice)) terminal += 1;
  }
  return Object.freeze({ byState: Object.freeze(byState), terminal, total: notices.length });
};

/**
 * Applies the retention policy once: prunes the terminal notices the policy
 * selects at `at`, then compacts the journal when it exceeds the byte bound.
 * Both steps are idempotent (a replayed prune returns its committed result;
 * an already-compact journal is left alone), so a process killed between them
 * simply finishes on the next call.
 */
const retainProgram = Effect.fnUntraced(function*(
  store: NoticeStore,
  policy: ReturnType<typeof resolveNoticeRetentionPolicy>,
  at: string,
  idempotencyKey: string,
  signal: AbortSignal | undefined,
): Effect.fn.Return<AgentNoticeRetentionReport, Error> {
  const before = yield* storeEffect(() => store.read({ signal }));
  const prunedIds = selectPrunableNotices(before.state.notices, policy, at);
  let revision = before.revision;
  if (prunedIds.length > 0) {
    // The key is content-addressed under the caller's key: a retry that
    // selects the same ids replays, one that selects a different set (the
    // ledger moved on) commits its own prune instead of an idempotency
    // conflict against the earlier decision.
    const digest = createHash('sha256').update(canonicalJson(prunedIds), 'utf8').digest('hex').slice(0, 16);
    const committed = yield* storeEffect(() => store.dispatch(
      'pruned',
      { at, noticeIds: [...prunedIds] },
      { idempotencyKey: `${idempotencyKey}:${digest}`, ...(signal === undefined ? {} : { signal }) },
    ));
    revision = committed.revision;
  }
  let journal = yield* storeEffect(() => store.inspect(signal === undefined ? {} : { signal }));
  let compacted = false;
  if (journal.journalBytes > policy.maxJournalBytes) {
    const result = yield* storeEffect(() => store.compact(signal === undefined ? {} : { signal }));
    compacted = result.prunedRecords > 0;
    revision = result.revision;
    journal = yield* storeEffect(() => store.inspect(signal === undefined ? {} : { signal }));
  }
  return Object.freeze({ compacted, journal, prunedIds, revision });
});

export const createAgentNoticeLedger = (
  store: NoticeStore,
  options: CreateAgentNoticeLedgerOptions,
): AgentNoticeLedger => {
  const policy = resolveNoticeRetentionPolicy(options.retention);
  const advertisement = options.delivery;
  return Object.freeze({
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

  inspect(): Promise<AgentNoticeLedgerInspection> {
    return runPromise(Effect.gen(function*() {
      const snapshot = yield* storeEffect(() => store.read());
      const journal = yield* storeEffect(() => store.inspect());
      return Object.freeze({
        counts: stateCounts(snapshot.state.notices),
        journal,
        policy,
        ...(snapshot.state.retention === undefined ? {} : { retention: snapshot.state.retention }),
        revision: snapshot.revision,
      });
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
        const matching = before.state.notices.filter((notice) =>
          (notice.state === 'pending'
            || notice.state === 'attempted' && notice.attempts.length < (notice.retryBudget ?? 1))
          && Date.parse(notice.createdAt) <= admissionTime
          && (notice.nextAttemptAt === undefined || Date.parse(notice.nextAttemptAt) <= admissionTime)
          && (notice.expiresAt === undefined
            || Date.parse(notice.expiresAt) > admissionTime)
          && recipientMatchesPrincipal(notice.recipient, request.principal));
        // Redaction policy before authorization: a notice the next-event route
        // may not carry is neither authorized nor attempted, only refused.
        const { disclosed, withheld } = discloseFor('next-event', matching, advertisement);
        const disclosures = new Map(disclosed.map(({ disclosure, notice }) => [notice.id, disclosure]));
        const decisions = yield* Effect.forEach(disclosed, ({ notice }) =>
          authorizeEffect(options.authorize, {
            noticeId: notice.id,
            phase: 'deliver',
            principal: request.principal,
            recipient: notice.recipient,
          }).pipe(Effect.map((decision) => ({ decision, id: notice.id }))));
        if (expiring.length > 0 || decisions.length > 0 || withheld.length > 0) {
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
              ...(withheld.length === 0 ? {} : { withheld: [...withheld] }),
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
          .map((notice) => deliveryFor(notice, request.invocation.id, disclosures))
          .filter((delivery): delivery is AgentNoticeDelivery => delivery !== undefined));
        // Retention rides admitted events only (V1 implies no timer): settled
        // history past the policy leaves the ledger, then an oversized journal
        // is folded onto its head. Both steps are idempotent per invocation.
        yield* retainProgram(
          store,
          policy,
          request.invocation.startedAt,
          `agent-notices:retain:${request.invocation.id}`,
          request.signal,
        );
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
            return yield* inboxProgram(store, options.authorize, request, advertisement);
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

  retain(retention: AgentNoticeRetainOptions): Promise<AgentNoticeRetentionReport> {
    return runPromise(Effect.gen(function*() {
      const at = yield* noticeEffect(() => timestamp(retention.at, 'Notice retention time'));
      const idempotencyKey = yield* noticeEffect(() =>
        nonEmptyText(retention.idempotencyKey, 'Notice retention idempotency key'));
      return yield* retainProgram(store, policy, at, idempotencyKey, undefined);
    }));
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
      // the dispatch is guarded by the revision just read (or the caller's own
      // pin), so the ownership check and the reducer see the same holds.
      // Unrelated writers move the revision too, hence the bounded re-read
      // when the caller did not pin one. The guard is only ever applied by the
      // store, which resolves the idempotency key first: a retry of a receipt
      // whose commit landed but whose response was lost replays that commit
      // instead of failing a revision precheck it could never satisfy.
      for (let attempt = 0; attempt < MAX_RESERVED_RECEIPT_ATTEMPTS; attempt += 1) {
        const before = yield* storeEffect(() => store.read());
        const committed = yield* storeEffect(() => store.dispatch(
          'availability-signalled',
          payload,
          { expectedRevision: expectedRevision ?? before.revision, idempotencyKey },
        )).pipe(Effect.catch((error) =>
          error instanceof AgentStateError && error.code === 'revision-conflict' && expectedRevision === undefined
            ? Effect.succeed(undefined)
            : Effect.fail(error)));
        if (committed === undefined) continue;
        if (!committed.replayed) {
          // Ownership, not state, decides: a notice acknowledged, expired, or
          // withdrawn after the send still keeps its hold, and the receipt for
          // the send that happened lands on it; only a hold held by another
          // key (or no hold at all) refuses the receipt.
          const lost = before.state.notices.filter((notice) =>
            noticeIds.includes(notice.id)
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
};
