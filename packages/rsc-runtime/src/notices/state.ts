import { z } from 'zod';

import {
  createAgentDocument,
  type AgentDocument,
  type AgentDocumentSnapshot,
} from '../agent-document.js';
import type {
  AgentStateDefinition,
  AgentStateEventSchemas,
  AgentStateLifetime,
} from '../state/contract.js';
import { canonicalJson, defineState } from '../state/index.js';
import {
  AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS,
  type AgentNotice,
  type AgentNoticePrincipal,
  type AgentNoticeRecordedPrincipal,
  type AgentNoticeRetentionSummary,
  type AgentNoticeWithheldEntry,
  type AgentNoticeWithholding,
  type AgentNoticeWithholdingReason,
  type AgentRecipient,
} from './contract.js';
import { AGENT_NOTICE_SENSITIVITIES } from './redaction.js';
import { AGENT_NOTICE_DELIVERY_ROUTES, type AgentNoticeDeliveryRoute } from './router.js';

const observed = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({
    source: z.enum(['native', 'receipt', 'derived']),
    state: z.literal('available'),
    value,
  }).strict(),
  z.object({
    reason: z.enum([
      'not-provided',
      'unsupported-surface',
      'host-omitted',
      'unauthenticated',
      'no-subagent-events',
      'id-not-resolvable',
      'cloud-agent-no-user-hooks',
      'no-shared-runtime',
    ]),
    state: z.literal('unavailable'),
  }).strict(),
]);

const recipientSchema = z.object({
  actor: z.object({ id: z.string().min(1) }).strict().optional(),
  // Lineage axes (additive, optional): notices journaled before them parse
  // unchanged, and absent means the axis is not part of the conjunction.
  conversation: z.string().min(1).optional(),
  host: z.object({ name: z.string().min(1) }).strict().optional(),
  root: z.string().min(1).optional(),
  session: z.object({ sessionId: z.string().min(1) }).strict().optional(),
  workspace: z.object({ root: z.string().min(1) }).strict().optional(),
}).strict().refine(
  (recipient) => Object.values(recipient).some((value) => value !== undefined),
  'A notice recipient requires at least one identity axis',
);

const lineageScopeSchema = z.object({
  conversation: z.string().min(1),
  root: z.string().min(1),
}).strict();

const principalSchema = z.object({
  actor: observed(z.object({ id: z.string().min(1) }).strict()),
  host: observed(z.object({ name: z.string().min(1) }).strict()),
  // Optional so admissions journaled before the lineage axes replay unchanged;
  // the reducer reads an absent scope as unavailable lineage.
  lineage: observed(lineageScopeSchema).optional(),
  session: observed(z.object({ sessionId: z.string().min(1) }).strict()),
  workspace: observed(z.object({ root: z.string().min(1) }).strict()),
}).strict();

const documentSchema = z.custom<AgentDocumentSnapshot>((value) => {
  try {
    createAgentDocument(value as AgentDocument);
    return true;
  } catch {
    return false;
  }
});

const attemptSchema = z.object({
  attemptedAt: z.string().min(1),
  channel: z.literal('next-event'),
  invocationId: z.string().min(1),
}).strict().readonly();

const exposureSchema = z.object({
  channel: z.literal('mcp-inbox'),
  count: z.number().int().positive(),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
  lastInvocationId: z.string().min(1),
}).strict().readonly();

const availabilitySchema = z.object({
  channel: z.literal('mcp-resource-updated'),
  count: z.number().int().positive(),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
}).strict().readonly();

const availabilityReservationSchema = z.object({
  at: z.string().min(1),
  key: z.string().min(1),
}).strict().readonly();

const acknowledgementSchema = z.object({
  acknowledgedAt: z.string().min(1),
  invocationId: z.string().min(1),
}).strict().readonly();

const withholdingReasonSchema = z.enum(['route-unavailable', 'sensitivity-exceeds-route']);

const withholdingSchema = z.object({
  count: z.number().int().positive(),
  firstAt: z.string().min(1),
  lastAt: z.string().min(1),
  reason: withholdingReasonSchema,
}).strict().readonly();

const withheldEntrySchema = z.object({
  id: z.string().min(1),
  reason: withholdingReasonSchema,
}).strict();

const routeSchema = z.enum(AGENT_NOTICE_DELIVERY_ROUTES);

const noticeSchema = z.object({
  acknowledgement: acknowledgementSchema.optional(),
  attempts: z.array(attemptSchema).readonly(),
  availability: availabilitySchema.optional(),
  availabilityReservation: availabilityReservationSchema.optional(),
  content: documentSchema,
  createdAt: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  expiredAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  exposure: exposureSchema.optional(),
  id: z.string().min(1),
  nextAttemptAt: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high']),
  recipient: recipientSchema,
  // Optional (not defaulted): parse must never materialize fields absent from
  // stored heads or the journal head-vs-replay consistency check would diverge
  // on state persisted before the retry contract. Absent means a budget of 1.
  retryBudget: z.number().int().min(1).optional(),
  // Optional for the same reason: absent on pre-redaction notices and means `internal`.
  sensitivity: z.enum(AGENT_NOTICE_SENSITIVITIES).optional(),
  state: z.enum(['pending', 'attempted', 'expired', 'unavailable', 'withdrawn', 'acknowledged']),
  unavailableAt: z.string().min(1).optional(),
  unavailableReason: z.literal('delivery-authorization-unavailable').optional(),
  withdrawnAt: z.string().min(1).optional(),
  withheld: z.partialRecord(routeSchema, withholdingSchema).readonly().optional(),
}).strict().readonly();

const retentionSummarySchema = z.object({
  lastPrunedAt: z.string().min(1),
  pruneRuns: z.number().int().positive(),
  prunedTotal: z.number().int().positive(),
}).strict().readonly();

export interface AgentNoticeLedgerState {
  readonly notices: readonly AgentNotice[];
  /** Absent until the first prune; never defaulted, so pre-retention heads replay unchanged. */
  readonly retention?: AgentNoticeRetentionSummary;
}

/**
 * Schema version of the notice ledger definition. Bumped whenever the reducer
 * changes what an already-journaled event means, so a durable store written
 * under the previous version is migrated from its materialized head instead
 * of being replayed by a reducer that would disagree with it.
 */
export const AGENT_NOTICE_STATE_VERSION = 2;

export const agentNoticeEventSchemas = {
  acknowledged: z.object({
    at: z.string().min(1),
    id: z.string().min(1),
    invocationId: z.string().min(1),
  }).strict(),
  admitted: z.object({
    at: z.string().min(1),
    authorizedIds: z.array(z.string().min(1)),
    invocationId: z.string().min(1),
    principal: principalSchema,
    unavailableIds: z.array(z.string().min(1)),
    // Optional so journals written before the redaction contract replay unchanged.
    withheld: z.array(withheldEntrySchema).optional(),
  }).strict(),
  'availability-released': z.object({
    noticeIds: z.array(z.string().min(1)),
    reservationKey: z.string().min(1),
  }).strict(),
  'availability-reserved': z.object({
    at: z.string().min(1),
    noticeIds: z.array(z.string().min(1)),
    reservationKey: z.string().min(1),
  }).strict(),
  'availability-signalled': z.object({
    at: z.string().min(1),
    channel: z.literal('mcp-resource-updated'),
    noticeIds: z.array(z.string().min(1)),
    reservationKey: z.string().min(1).optional(),
  }).strict(),
  exposed: z.object({
    at: z.string().min(1),
    channel: z.literal('mcp-inbox'),
    invocationId: z.string().min(1),
    noticeIds: z.array(z.string().min(1)),
    withheld: z.array(withheldEntrySchema).optional(),
  }).strict(),
  expired: z.object({
    at: z.string().min(1),
  }).strict(),
  /** Retention: removes the listed notices from the state when they are terminal. */
  pruned: z.object({
    at: z.string().min(1),
    noticeIds: z.array(z.string().min(1)).min(1),
  }).strict(),
  published: z.object({
    notice: noticeSchema,
  }).strict(),
  withdrawn: z.object({
    at: z.string().min(1),
    id: z.string().min(1),
  }).strict(),
  /** A route refused the listed notices; recorded by the surface that decided (the signaller). */
  withheld: z.object({
    at: z.string().min(1),
    entries: z.array(withheldEntrySchema).min(1),
    route: routeSchema,
  }).strict(),
} as const satisfies AgentStateEventSchemas;

const sameRecipient = (left: AgentRecipient, right: AgentRecipient): boolean =>
  canonicalJson(left) === canonicalJson(right);

/**
 * The principal as an admission journals it: the lineage axis is narrowed to
 * the conversation and root the matcher reads, so the journaled payload never
 * grows with the lineage shape and a replay matches exactly what the live
 * admission matched.
 */
export const recordedNoticePrincipal = (principal: AgentNoticePrincipal): AgentNoticeRecordedPrincipal => Object.freeze({
  actor: principal.actor,
  host: principal.host,
  lineage: principal.lineage.state === 'available'
    ? Object.freeze({
        source: principal.lineage.source,
        state: 'available' as const,
        value: Object.freeze({
          conversation: principal.lineage.value.conversation,
          root: principal.lineage.value.root,
        }),
      })
    : principal.lineage,
  session: principal.session,
  workspace: principal.workspace,
});

/**
 * Every axis the recipient names must match an available axis of the
 * principal; an unavailable axis — including lineage the runtime could not
 * resolve — matches nothing. `conversation` is exact; `root` matches the
 * root conversation itself and every conversation whose lineage root it is.
 */
export const recipientMatchesPrincipal = (
  recipient: AgentRecipient,
  principal: AgentNoticeRecordedPrincipal,
): boolean => {
  if (recipient.actor !== undefined) {
    if (principal.actor.state !== 'available' || principal.actor.value.id !== recipient.actor.id) return false;
  }
  if (recipient.host !== undefined) {
    if (principal.host.state !== 'available' || principal.host.value.name !== recipient.host.name) return false;
  }
  if (recipient.session !== undefined) {
    if (principal.session.state !== 'available' || principal.session.value.sessionId !== recipient.session.sessionId) return false;
  }
  if (recipient.workspace !== undefined) {
    if (principal.workspace.state !== 'available' || principal.workspace.value.root !== recipient.workspace.root) return false;
  }
  if (recipient.conversation !== undefined) {
    if (principal.lineage?.state !== 'available' || principal.lineage.value.conversation !== recipient.conversation) return false;
  }
  if (recipient.root !== undefined) {
    if (principal.lineage?.state !== 'available' || principal.lineage.value.root !== recipient.root) return false;
  }
  return true;
};

const expiredNotice = (notice: AgentNotice, at: string): AgentNotice => Object.freeze({
  ...notice,
  expiredAt: at,
  state: 'expired',
});

const transitionExpiry = (notice: AgentNotice, at: string): AgentNotice => {
  switch (notice.state) {
    case 'pending':
      return notice.expiresAt !== undefined && Date.parse(notice.expiresAt) <= Date.parse(at)
        ? expiredNotice(notice, at)
        : notice;
    case 'attempted':
      // A retriable notice past its deadline must not linger with unused
      // retries; a fully-attempted notice keeps its terminal attempt record.
      return notice.attempts.length < (notice.retryBudget ?? 1)
        && notice.expiresAt !== undefined && Date.parse(notice.expiresAt) <= Date.parse(at)
        ? expiredNotice(notice, at)
        : notice;
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return notice;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

const transitionWithdrawal = (notice: AgentNotice, id: string, at: string): AgentNotice => {
  switch (notice.state) {
    case 'pending':
      return notice.id === id
        ? Object.freeze({ ...notice, state: 'withdrawn', withdrawnAt: at })
        : notice;
    case 'attempted':
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return notice;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

const transitionAcknowledgement = (
  notice: AgentNotice,
  input: { readonly at: string; readonly id: string; readonly invocationId: string },
): AgentNotice => {
  if (notice.id !== input.id) return notice;
  switch (notice.state) {
    case 'pending':
    case 'attempted':
      return Object.freeze({
        ...notice,
        acknowledgement: Object.freeze({
          acknowledgedAt: input.at,
          invocationId: input.invocationId,
        }),
        state: 'acknowledged',
      });
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return notice;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

/** Strips the reservation when `reservationKey` is absent or matches the holder's key. */
const withoutReservation = (notice: AgentNotice, reservationKey: string | undefined): AgentNotice => {
  if (notice.availabilityReservation === undefined) return notice;
  if (reservationKey !== undefined && notice.availabilityReservation.key !== reservationKey) return notice;
  const { availabilityReservation: _released, ...rest } = notice;
  return Object.freeze(rest);
};

/**
 * Records a wire-level availability receipt. The receipt is evidence that a
 * `resources/updated` signal reached the wire, so it is recorded whatever the
 * notice's state became after the hold was taken: an acknowledgement, expiry,
 * or withdrawal that raced the send does not erase the send, and the state
 * itself is never moved by a receipt. A reserved receipt is honoured only by
 * the key that holds the slot: a holder whose hold lapsed and was taken over
 * records nothing, so the takeover's send is the one the budget counts.
 */
const transitionAvailability = (
  notice: AgentNotice,
  input: { readonly at: string; readonly noticeIds: ReadonlySet<string>; readonly reservationKey: string | undefined },
): AgentNotice => {
  if (!input.noticeIds.has(notice.id)) return notice;
  if (input.reservationKey !== undefined && notice.availabilityReservation?.key !== input.reservationKey) {
    return notice;
  }
  return Object.freeze({
    ...withoutReservation(notice, input.reservationKey),
    availability: Object.freeze({
      channel: 'mcp-resource-updated' as const,
      count: (notice.availability?.count ?? 0) + 1,
      firstAt: notice.availability?.firstAt ?? input.at,
      lastAt: input.at,
    }),
  });
};

/**
 * Holds a budget slot without spending it. A live notice carries at most one
 * reservation: the holder renews it by reserving again under the same key,
 * and a different key takes it over only once the current hold is older than
 * the reservation TTL at the event's own `at` — a rule the reducer can apply
 * deterministically on replay, so a slow holder's renewal can never steal a
 * hold back from the process that legitimately took over after it lapsed —
 * nor re-create a hold the takeover already spent.
 */
const transitionAvailabilityReservation = (
  notice: AgentNotice,
  input: { readonly at: string; readonly noticeIds: ReadonlySet<string>; readonly reservationKey: string },
): AgentNotice => {
  if (!input.noticeIds.has(notice.id)) return notice;
  switch (notice.state) {
    case 'pending':
    case 'attempted': {
      const held = notice.availabilityReservation;
      if (
        held !== undefined
        && held.key !== input.reservationKey
        && Date.parse(held.at) + AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS > Date.parse(input.at)
      ) {
        return notice;
      }
      // A slot whose budget is already spent is not free: once a takeover's
      // receipt has cleared the hold, the previous holder's renewal must not
      // re-create it and let its stale receipt push the count past the budget.
      // Only the key that currently holds the slot may still renew.
      if (held?.key !== input.reservationKey && (notice.availability?.count ?? 0) >= (notice.retryBudget ?? 1)) {
        return notice;
      }
      return Object.freeze({
        ...notice,
        availabilityReservation: Object.freeze({ at: input.at, key: input.reservationKey }),
      });
    }
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return notice;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

/**
 * Records that a route withheld the notice from a matching recipient because
 * its sensitivity exceeds the route's ceiling. Evidence only: the notice keeps
 * its state and stays eligible for a route whose row admits it.
 */
const withholding = (
  notice: AgentNotice,
  route: AgentNoticeDeliveryRoute,
  at: string,
  reason: AgentNoticeWithholdingReason,
): AgentNotice => {
  const previous: AgentNoticeWithholding | undefined = notice.withheld?.[route];
  return Object.freeze({
    ...notice,
    withheld: Object.freeze({
      ...notice.withheld,
      [route]: Object.freeze({
        count: (previous?.count ?? 0) + 1,
        firstAt: previous?.firstAt ?? at,
        lastAt: at,
        reason,
      }),
    }),
  });
};

/** Withheld entries keyed by id for the reducer's per-notice pass. */
const withheldById = (
  entries: readonly AgentNoticeWithheldEntry[] | undefined,
): ReadonlyMap<string, AgentNoticeWithholdingReason> =>
  new Map((entries ?? []).map((entry) => [entry.id, entry.reason]));

/** Settled terminal notices the retention policy may prune; exhausted attempts count as settled. */
export const noticeSettledAt = (notice: AgentNotice): string | undefined => {
  switch (notice.state) {
    case 'pending':
      return undefined;
    case 'attempted': {
      if (notice.attempts.length < (notice.retryBudget ?? 1)) return undefined;
      const last = notice.attempts[notice.attempts.length - 1];
      return last?.attemptedAt;
    }
    case 'expired':
      return notice.expiredAt;
    case 'unavailable':
      return notice.unavailableAt;
    case 'withdrawn':
      return notice.withdrawnAt;
    case 'acknowledged':
      return notice.acknowledgement?.acknowledgedAt;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

const transitionAdmission = (
  notice: AgentNotice,
  input: {
    readonly at: string;
    readonly authorizedIds: ReadonlySet<string>;
    readonly invocationId: string;
    readonly principal: AgentNoticeRecordedPrincipal;
    readonly unavailableIds: ReadonlySet<string>;
    readonly withheld: ReadonlyMap<string, AgentNoticeWithholdingReason>;
  },
): AgentNotice => {
  const current = transitionExpiry(notice, input.at);
  switch (current.state) {
    case 'pending':
    case 'attempted': {
      if (!recipientMatchesPrincipal(current.recipient, input.principal)) return current;
      // Not due yet: only admitted events evaluate this; V1 never implies a timer.
      if (current.nextAttemptAt !== undefined && Date.parse(input.at) < Date.parse(current.nextAttemptAt)) {
        return current;
      }
      if (current.attempts.length >= (current.retryBudget ?? 1)) return current;
      // The route refused the content: nothing is attempted and no budget is
      // spent, only the refusal is remembered.
      const refused = input.withheld.get(current.id);
      if (refused !== undefined) return withholding(current, 'next-event', input.at, refused);
      if (input.unavailableIds.has(current.id)) {
        return current.state === 'pending'
          ? Object.freeze({
              ...current,
              state: 'unavailable',
              unavailableAt: input.at,
              unavailableReason: 'delivery-authorization-unavailable',
            })
          : current;
      }
      if (!input.authorizedIds.has(current.id)) return current;
      if (current.attempts.some((attempt) => attempt.invocationId === input.invocationId)) return current;
      const receipt = Object.freeze({
        attemptedAt: input.at,
        channel: 'next-event' as const,
        invocationId: input.invocationId,
      });
      return Object.freeze({
        ...current,
        attempts: Object.freeze([...current.attempts, receipt]),
        state: 'attempted',
      });
    }
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return current;
    default: {
      const exhaustive: never = current.state;
      return exhaustive;
    }
  }
};

const transitionExposure = (
  notice: AgentNotice,
  input: {
    readonly at: string;
    readonly invocationId: string;
    readonly noticeIds: ReadonlySet<string>;
    readonly withheld: ReadonlyMap<string, AgentNoticeWithholdingReason>;
  },
): AgentNotice => {
  switch (notice.state) {
    case 'pending': {
      const refused = input.withheld.get(notice.id);
      if (refused !== undefined) return withholding(notice, 'mcp-inbox', input.at, refused);
      if (!input.noticeIds.has(notice.id)) return notice;
      return Object.freeze({
        ...notice,
        exposure: Object.freeze({
          channel: 'mcp-inbox' as const,
          count: (notice.exposure?.count ?? 0) + 1,
          firstAt: notice.exposure?.firstAt ?? input.at,
          lastAt: input.at,
          lastInvocationId: input.invocationId,
        }),
      });
    }
    case 'attempted':
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
    case 'acknowledged':
      return notice;
    default: {
      const exhaustive: never = notice.state;
      return exhaustive;
    }
  }
};

export const agentNoticeStateDefinition = (
  lifetime: AgentStateLifetime = 'workspace-durable',
): AgentStateDefinition<AgentNoticeLedgerState, typeof agentNoticeEventSchemas> =>
  defineState({
    events: agentNoticeEventSchemas,
    id: '@agent-bundle/runtime/agent-notice-ledger/v1',
    initial: { notices: [] },
    lifetime,
    // Version 2 changes replay semantics, not shape: `availability-signalled`
    // now records a receipt on a notice in any state (version 1 ignored
    // terminal notices) and reservations carry keys, TTLs, and budget checks.
    // Journals written under version 1 therefore cannot be replayed by this
    // reducer; the migration rebases them on their materialized head, which
    // already satisfies the version 2 schema unchanged.
    //
    // The lineage recipient axes (`recipient.conversation` / `recipient.root`,
    // `principal.lineage` on admissions) are additive optional fields, not a
    // version: a journal without them replays to the same state, because an
    // admission that recorded no lineage matches exactly the recipients it
    // matched when it was written, and no persisted notice names an axis it
    // did not have.
    migrations: { 2: (persisted) => persisted },
    reduce: (state, event) => {
      switch (event.name) {
        case 'published': {
          const candidate = event.payload.notice;
          const duplicate = candidate.dedupeKey === undefined
            ? state.notices.some((notice) => notice.id === candidate.id)
            : state.notices.some((notice) =>
              notice.dedupeKey === candidate.dedupeKey
              && sameRecipient(notice.recipient, candidate.recipient));
          return duplicate ? state : { ...state, notices: [...state.notices, candidate] };
        }
        case 'expired':
          return {
            ...state,
            notices: state.notices.map((notice) => transitionExpiry(notice, event.payload.at)),
          };
        case 'withdrawn':
          return {
            ...state,
            notices: state.notices.map((notice) =>
              transitionWithdrawal(notice, event.payload.id, event.payload.at)),
          };
        case 'admitted': {
          const authorizedIds = new Set(event.payload.authorizedIds);
          const unavailableIds = new Set(event.payload.unavailableIds);
          const withheld = withheldById(event.payload.withheld);
          return {
            ...state,
            notices: state.notices.map((notice) => transitionAdmission(notice, {
              at: event.payload.at,
              authorizedIds,
              invocationId: event.payload.invocationId,
              principal: event.payload.principal,
              unavailableIds,
              withheld,
            })),
          };
        }
        case 'exposed': {
          const noticeIds = new Set(event.payload.noticeIds);
          const withheld = withheldById(event.payload.withheld);
          return {
            ...state,
            notices: state.notices.map((notice) => transitionExposure(notice, {
              at: event.payload.at,
              invocationId: event.payload.invocationId,
              noticeIds,
              withheld,
            })),
          };
        }
        case 'acknowledged':
          return {
            ...state,
            notices: state.notices.map((notice) => transitionAcknowledgement(notice, event.payload)),
          };
        case 'availability-signalled': {
          const noticeIds = new Set(event.payload.noticeIds);
          return {
            ...state,
            notices: state.notices.map((notice) => transitionAvailability(notice, {
              at: event.payload.at,
              noticeIds,
              reservationKey: event.payload.reservationKey,
            })),
          };
        }
        case 'availability-reserved': {
          const noticeIds = new Set(event.payload.noticeIds);
          return {
            ...state,
            notices: state.notices.map((notice) => transitionAvailabilityReservation(notice, {
              at: event.payload.at,
              noticeIds,
              reservationKey: event.payload.reservationKey,
            })),
          };
        }
        case 'availability-released': {
          const noticeIds = new Set(event.payload.noticeIds);
          return {
            ...state,
            notices: state.notices.map((notice) => noticeIds.has(notice.id)
              ? withoutReservation(notice, event.payload.reservationKey)
              : notice),
          };
        }
        case 'withheld': {
          const refused = withheldById(event.payload.entries);
          return {
            ...state,
            notices: state.notices.map((notice) => {
              const reason = refused.get(notice.id);
              return reason === undefined ? notice : withholding(notice, event.payload.route, event.payload.at, reason);
            }),
          };
        }
        case 'pruned': {
          // Only settled notices leave; an id that is live again (or unknown)
          // is skipped, so a stale prune decision can never drop a pending
          // notice. The summary counts what was actually removed.
          const noticeIds = new Set(event.payload.noticeIds);
          const remaining = state.notices.filter((notice) =>
            !(noticeIds.has(notice.id) && noticeSettledAt(notice) !== undefined));
          const removed = state.notices.length - remaining.length;
          if (removed === 0) return state;
          return {
            notices: remaining,
            retention: {
              lastPrunedAt: event.payload.at,
              pruneRuns: (state.retention?.pruneRuns ?? 0) + 1,
              prunedTotal: (state.retention?.prunedTotal ?? 0) + removed,
            },
          };
        }
        default: {
          const exhaustive: never = event;
          return exhaustive;
        }
      }
    },
    schema: z.object({
      notices: z.array(noticeSchema).readonly(),
      retention: retentionSummarySchema.optional(),
    }).strict().readonly(),
    version: AGENT_NOTICE_STATE_VERSION,
  });
