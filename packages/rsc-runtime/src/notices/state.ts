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
import type {
  AgentNotice,
  AgentNoticePrincipal,
  AgentRecipient,
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

const noticeSchema = z.object({
  attempts: z.array(attemptSchema).readonly(),
  content: documentSchema,
  createdAt: z.string().min(1),
  dedupeKey: z.string().min(1).optional(),
  expiredAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1).optional(),
  id: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high']),
  recipient: recipientSchema,
  state: z.enum(['pending', 'attempted', 'expired', 'unavailable', 'withdrawn']),
  unavailableAt: z.string().min(1).optional(),
  unavailableReason: z.literal('delivery-authorization-unavailable').optional(),
  withdrawnAt: z.string().min(1).optional(),
}).strict().readonly();

export interface AgentNoticeLedgerState {
  readonly notices: readonly AgentNotice[];
}

export const agentNoticeEventSchemas = {
  admitted: z.object({
    at: z.string().min(1),
    authorizedIds: z.array(z.string().min(1)),
    invocationId: z.string().min(1),
    principal: principalSchema,
    unavailableIds: z.array(z.string().min(1)),
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
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
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
    case 'pending': {
      if (!recipientMatchesPrincipal(current.recipient, input.principal)) return current;
      if (input.unavailableIds.has(current.id)) {
        return Object.freeze({
          ...current,
          state: 'unavailable',
          unavailableAt: input.at,
          unavailableReason: 'delivery-authorization-unavailable',
        });
      }
      if (!input.authorizedIds.has(current.id)) return current;
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
    case 'attempted':
    case 'expired':
    case 'unavailable':
    case 'withdrawn':
      return current;
    default: {
      const exhaustive: never = current.state;
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
