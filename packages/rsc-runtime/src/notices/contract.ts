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
] as const);

/** V1 contains only states the framework can evidence without host claims. */
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

export type AgentNoticeUnavailableReason = 'delivery-authorization-unavailable';

export interface AgentNotice {
  readonly attempts: readonly AgentNoticeAttemptReceipt[];
  readonly content: AgentDocumentSnapshot;
  readonly createdAt: string;
  readonly dedupeKey?: string;
  readonly expiredAt?: string;
  readonly expiresAt?: string;
  readonly id: string;
  readonly priority: AgentNoticePriority;
  readonly recipient: AgentRecipient;
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
  readonly priority: AgentNoticePriority;
  readonly recipient: AgentRecipient;
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
  readonly phase: 'deliver' | 'publish';
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

export interface AgentNoticeLedger {
  expire(options: AgentNoticeExpiryOptions): Promise<AgentNoticeLedgerSnapshot>;
  openRequest(request: AgentNoticeRequest): Promise<AgentNoticeRequestLease>;
  read(): Promise<AgentNoticeLedgerSnapshot>;
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
