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
  type AgentRecipient,
} from './contract.js';

const observed = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({
    source: z.enum(['native', 'receipt', 'derived']),
    state: z.literal('available'),
    value,
  }).strict(),
  z.object({
    reason: z.enum(['not-provided', 'unsupported-surface', 'host-omitted', 'unauthenticated']),
    state: z.literal('unavailable'),
  }).strict(),
]);

const recipientSchema = z.object({
  actor: z.object({ id: z.string().min(1) }).strict().optional(),
  host: z.object({ name: z.string().min(1) }).strict().optional(),
  session: z.object({ sessionId: z.string().min(1) }).strict().optional(),
  workspace: z.object({ root: z.string().min(1) }).strict().optional(),
}).strict().refine(
  (recipient) => Object.values(recipient).some((value) => value !== undefined),
  'A notice recipient requires at least one identity axis',
);

const principalSchema = z.object({
  actor: observed(z.object({ id: z.string().min(1) }).strict()),
  host: observed(z.object({ name: z.string().min(1) }).strict()),
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
  state: z.enum(['pending', 'attempted', 'expired', 'unavailable', 'withdrawn', 'acknowledged']),
  unavailableAt: z.string().min(1).optional(),
  unavailableReason: z.literal('delivery-authorization-unavailable').optional(),
  withdrawnAt: z.string().min(1).optional(),
}).strict().readonly();

export interface AgentNoticeLedgerState {
  readonly notices: readonly AgentNotice[];
}

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
  }).strict(),
  expired: z.object({
    at: z.string().min(1),
  }).strict(),
  published: z.object({
    notice: noticeSchema,
  }).strict(),
  withdrawn: z.object({
    at: z.string().min(1),
    id: z.string().min(1),
  }).strict(),
} as const satisfies AgentStateEventSchemas;

const sameRecipient = (left: AgentRecipient, right: AgentRecipient): boolean =>
  canonicalJson(left) === canonicalJson(right);

export const recipientMatchesPrincipal = (
  recipient: AgentRecipient,
  principal: AgentNoticePrincipal,
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

const transitionAdmission = (
  notice: AgentNotice,
  input: {
    readonly at: string;
    readonly authorizedIds: ReadonlySet<string>;
    readonly invocationId: string;
    readonly principal: AgentNoticePrincipal;
    readonly unavailableIds: ReadonlySet<string>;
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
  },
): AgentNotice => {
  switch (notice.state) {
    case 'pending': {
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
    reduce: (state, event) => {
      switch (event.name) {
        case 'published': {
          const candidate = event.payload.notice;
          const duplicate = candidate.dedupeKey === undefined
            ? state.notices.some((notice) => notice.id === candidate.id)
            : state.notices.some((notice) =>
              notice.dedupeKey === candidate.dedupeKey
              && sameRecipient(notice.recipient, candidate.recipient));
          return duplicate ? state : { notices: [...state.notices, candidate] };
        }
        case 'expired':
          return {
            notices: state.notices.map((notice) => transitionExpiry(notice, event.payload.at)),
          };
        case 'withdrawn':
          return {
            notices: state.notices.map((notice) =>
              transitionWithdrawal(notice, event.payload.id, event.payload.at)),
          };
        case 'admitted': {
          const authorizedIds = new Set(event.payload.authorizedIds);
          const unavailableIds = new Set(event.payload.unavailableIds);
          return {
            notices: state.notices.map((notice) => transitionAdmission(notice, {
              at: event.payload.at,
              authorizedIds,
              invocationId: event.payload.invocationId,
              principal: event.payload.principal,
              unavailableIds,
            })),
          };
        }
        case 'exposed': {
          const noticeIds = new Set(event.payload.noticeIds);
          return {
            notices: state.notices.map((notice) => transitionExposure(notice, {
              at: event.payload.at,
              invocationId: event.payload.invocationId,
              noticeIds,
            })),
          };
        }
        case 'acknowledged':
          return {
            notices: state.notices.map((notice) => transitionAcknowledgement(notice, event.payload)),
          };
        case 'availability-signalled': {
          const noticeIds = new Set(event.payload.noticeIds);
          return {
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
            notices: state.notices.map((notice) => noticeIds.has(notice.id)
              ? withoutReservation(notice, event.payload.reservationKey)
              : notice),
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
    }).strict().readonly(),
  });
