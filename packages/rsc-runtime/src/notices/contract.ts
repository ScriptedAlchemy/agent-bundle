import type { AgentDocumentSnapshot } from '../agent-document.js';
import type {
  AgentActorIdentity,
  AgentHostIdentity,
  AgentInvocation,
  AgentSessionIdentity,
  AgentWorkspaceIdentity,
  Observed,
} from '../agent-request.js';

export const AGENT_NOTICE_STATES = Object.freeze([
  'pending',
  'attempted',
  'expired',
  'unavailable',
  'withdrawn',
  'acknowledged',
] as const);

/**
 * V1 contains only states the framework can evidence without host claims.
 * Channel evidence that does not transfer ownership (inbox exposure, wire-level
 * resource-updated signals) is recorded as receipts on the notice instead of a
 * state: `available` and `read` from the #99 taxonomy map onto the
 * `availability` and `exposure` receipts, and `delivered` is deliberately
 * absent because no pinned host supplies cross-actor delivery evidence
 * (2026-09-02 survey on #99).
 */
export type AgentNoticeState = (typeof AGENT_NOTICE_STATES)[number];

export type AgentNoticePriority = 'low' | 'normal' | 'high';

/** A recipient is the conjunction of the observed identity axes it specifies. */
export interface AgentRecipient {
  readonly actor?: AgentActorIdentity;
  readonly host?: AgentHostIdentity;
  readonly session?: AgentSessionIdentity;
  readonly workspace?: AgentWorkspaceIdentity;
}

export interface AgentNoticePrincipal {
  readonly actor: Observed<AgentActorIdentity>;
  readonly host: Observed<AgentHostIdentity>;
  readonly session: Observed<AgentSessionIdentity>;
  readonly workspace: Observed<AgentWorkspaceIdentity>;
}

export interface AgentNoticeAttemptReceipt {
  readonly attemptedAt: string;
  readonly channel: 'next-event';
  readonly invocationId: string;
}

export interface AgentNoticeExposure {
  readonly channel: 'mcp-inbox';
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly lastInvocationId: string;
}

/**
 * Wire-level availability evidence: a `notifications/resources/updated` signal
 * was sent for the inbox resource on a live session. Protocol write success is
 * only availability, never delivery (#99).
 */
export interface AgentNoticeAvailability {
  readonly channel: 'mcp-resource-updated';
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

export interface AgentNoticeAcknowledgement {
  readonly acknowledgedAt: string;
  readonly invocationId: string;
}

export type AgentNoticeUnavailableReason = 'delivery-authorization-unavailable';

export interface AgentNotice {
  readonly acknowledgement?: AgentNoticeAcknowledgement;
  readonly attempts: readonly AgentNoticeAttemptReceipt[];
  readonly availability?: AgentNoticeAvailability;
  readonly content: AgentDocumentSnapshot;
  readonly createdAt: string;
  readonly dedupeKey?: string;
  readonly expiredAt?: string;
  readonly expiresAt?: string;
  readonly exposure?: AgentNoticeExposure;
  readonly id: string;
  /** Admissions before this instant leave the notice pending (V1: evaluated only on admitted events, never by an implied timer). */
  readonly nextAttemptAt?: string;
  readonly priority: AgentNoticePriority;
  readonly recipient: AgentRecipient;
  /** Maximum next-event attempt receipts before admission stops re-attempting; absent means 1. */
  readonly retryBudget?: number;
  readonly state: AgentNoticeState;
  readonly unavailableAt?: string;
  readonly unavailableReason?: AgentNoticeUnavailableReason;
  readonly withdrawnAt?: string;
}

export interface AgentNoticeLedgerSnapshot {
  readonly notices: readonly AgentNotice[];
  readonly revision: number;
}

export interface AgentNoticePublishInput {
  readonly content: AgentDocumentSnapshot;
  readonly dedupeKey?: string;
  readonly expiresAt?: string;
  readonly nextAttemptAt?: string;
  readonly priority: AgentNoticePriority;
  readonly recipient: AgentRecipient;
  /** Defaults to 1 (single next-event attempt). */
  readonly retryBudget?: number;
}

export interface AgentNoticePublishOptions {
  readonly idempotencyKey: string;
}

export interface AgentNoticePublishResult {
  readonly deduped: boolean;
  readonly notice: AgentNotice;
  readonly replayed: boolean;
  readonly revision: number;
}

export interface AgentNoticeExpiryOptions {
  readonly at: string;
  readonly idempotencyKey: string;
}

export interface AgentNoticeWithdrawOptions {
  readonly at: string;
  readonly idempotencyKey: string;
}

export type AgentNoticeAuthorizationDecision =
  | { readonly state: 'authorized' }
  | { readonly state: 'unavailable' };

export interface AgentNoticeAuthorizationRequest {
  readonly noticeId?: string;
  readonly phase: 'acknowledge' | 'deliver' | 'publish' | 'read';
  readonly principal: AgentNoticePrincipal;
  readonly recipient: AgentRecipient;
}

export type AgentNoticeAuthorizer = (
  request: AgentNoticeAuthorizationRequest,
) => AgentNoticeAuthorizationDecision | Promise<AgentNoticeAuthorizationDecision>;

export interface AgentNoticeDelivery {
  readonly notice: AgentNotice;
  readonly receipt: AgentNoticeAttemptReceipt;
}

export interface AgentNoticesHandle {
  /** Recipient-scoped explicit acknowledgement; the strongest evidenced state. */
  acknowledge(id: string): Promise<AgentNotice>;
  inbox(): Promise<readonly AgentNotice[]>;
  publish(input: AgentNoticePublishInput, options: AgentNoticePublishOptions): Promise<AgentNoticePublishResult>;
  read(): Promise<readonly AgentNoticeDelivery[]>;
}

export interface AgentNoticeRequest {
  readonly invocation: AgentInvocation;
  readonly principal: AgentNoticePrincipal;
  readonly signal: AbortSignal;
}

export interface AgentNoticeRequestLease {
  readonly handle: AgentNoticesHandle;
  close(): void;
}

export interface AgentNoticeAvailabilitySignalOptions {
  readonly at: string;
  readonly idempotencyKey: string;
  readonly noticeIds: readonly string[];
}

export interface AgentNoticeLedger {
  expire(options: AgentNoticeExpiryOptions): Promise<AgentNoticeLedgerSnapshot>;
  openRequest(request: AgentNoticeRequest): Promise<AgentNoticeRequestLease>;
  read(): Promise<AgentNoticeLedgerSnapshot>;
  /** Records a wire-level resources/updated signal; availability, never delivery. */
  signalAvailability(options: AgentNoticeAvailabilitySignalOptions): Promise<AgentNoticeLedgerSnapshot>;
  withdraw(id: string, options: AgentNoticeWithdrawOptions): Promise<AgentNoticeLedgerSnapshot>;
}

export type AgentNoticeErrorCode =
  | 'aborted'
  | 'invalid-input'
  | 'request-closed'
  | 'unauthorized';

export class AgentNoticeError extends Error {
  readonly code: AgentNoticeErrorCode;

  constructor(code: AgentNoticeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'AgentNoticeError';
  }
}
