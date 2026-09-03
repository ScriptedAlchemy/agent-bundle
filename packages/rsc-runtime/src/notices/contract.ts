import type { AgentDocumentSnapshot } from '../agent-document.js';
import type {
  AgentActorIdentity,
  AgentHostIdentity,
  AgentInvocation,
  AgentSessionIdentity,
  AgentWorkspaceIdentity,
  Observed,
} from '../agent-request.js';
import type { AgentStateJournalInspection } from '../state/contract.js';
import type { AgentNoticeSensitivity } from './redaction.js';
import type { AgentNoticeDeliveryRoute } from './router.js';

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

/**
 * A signaller's durable hold on one `resources/updated` send that has not yet
 * succeeded. It spends no budget: the receipt is recorded only once the
 * protocol write succeeds (`signalAvailability`) and released when it fails
 * (`releaseAvailability`). It exists so two signallers over one store cannot
 * both send for the same budget slot, and it is honoured only for
 * `AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS` so a crashed holder cannot
 * starve the notice.
 */
export interface AgentNoticeAvailabilityReservation {
  readonly at: string;
  readonly key: string;
}

/** How long a reservation blocks other signallers before it is treated as abandoned. */
export const AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS = 30_000;

export interface AgentNoticeAcknowledgement {
  readonly acknowledgedAt: string;
  readonly invocationId: string;
}

export type AgentNoticeUnavailableReason = 'delivery-authorization-unavailable';

/**
 * Evidence that a route refused to disclose the notice: the recipient's route
 * was reached but the redaction policy withheld the content (its sensitivity
 * exceeds the host row's ceiling). Recorded per route so the ledger says why
 * a matching recipient never saw a notice; it moves no state.
 */
export type AgentNoticeWithholdingReason = 'route-unavailable' | 'sensitivity-exceeds-route';

export interface AgentNoticeWithholding {
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  /** The latest reason; a route that became unavailable after a sensitivity refusal reports the newer one. */
  readonly reason: AgentNoticeWithholdingReason;
}

export type AgentNoticeWithholdings = Readonly<Partial<Record<AgentNoticeDeliveryRoute, AgentNoticeWithholding>>>;

/** One withholding decision as an event payload records it. */
export interface AgentNoticeWithheldEntry {
  readonly id: string;
  readonly reason: AgentNoticeWithholdingReason;
}

export interface AgentNotice {
  readonly acknowledgement?: AgentNoticeAcknowledgement;
  readonly attempts: readonly AgentNoticeAttemptReceipt[];
  readonly availability?: AgentNoticeAvailability;
  readonly availabilityReservation?: AgentNoticeAvailabilityReservation;
  /** The persisted snapshot as authored; routes disclose it per {@link AgentNotice.sensitivity}. */
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
  /** Author-declared disclosure class; absent on notices persisted before the redaction contract and means `internal`. */
  readonly sensitivity?: AgentNoticeSensitivity;
  readonly state: AgentNoticeState;
  readonly unavailableAt?: string;
  readonly unavailableReason?: AgentNoticeUnavailableReason;
  readonly withdrawnAt?: string;
  /** Routes that withheld this notice from a matching recipient, with counts. */
  readonly withheld?: AgentNoticeWithholdings;
}

/**
 * Retention policy of one ledger (#99 acceptance item 7). Terminal notices —
 * `expired`, `unavailable`, `withdrawn`, `acknowledged`, and `attempted`
 * with an exhausted retry budget — are pruned from the state once they have
 * been settled for `terminalTtlMs`, or earliest-settled first once more than
 * `maxTerminal` remain; the store's journal is compacted onto its head once
 * it exceeds `maxJournalBytes`. Pruning runs only on admitted events and
 * explicit `retain()` calls: V1 implies no timer.
 */
export interface AgentNoticeRetentionPolicy {
  /** Retained journal bytes above which `retain()` compacts the store's journal. */
  readonly maxJournalBytes: number;
  /** Most terminal notices kept regardless of age. */
  readonly maxTerminal: number;
  /** Milliseconds a terminal notice is kept after it settled. */
  readonly terminalTtlMs: number;
}

/** Sane defaults: a week of terminal history, at most 500 terminal notices, a 16 MiB journal. */
export const AGENT_NOTICE_DEFAULT_RETENTION: AgentNoticeRetentionPolicy = Object.freeze({
  maxJournalBytes: 16 * 1024 * 1024,
  maxTerminal: 500,
  terminalTtlMs: 7 * 24 * 60 * 60 * 1000,
});

/** Durable summary of pruning that has happened; absent until the first prune. */
export interface AgentNoticeRetentionSummary {
  readonly lastPrunedAt: string;
  readonly pruneRuns: number;
  readonly prunedTotal: number;
}

export interface AgentNoticeLedgerSnapshot {
  readonly notices: readonly AgentNotice[];
  readonly retention?: AgentNoticeRetentionSummary;
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
  /** Defaults to `internal`; see `redaction.ts` for what each class means per route. */
  readonly sensitivity?: AgentNoticeSensitivity;
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

/** What the `next-event` route disclosed of a delivered notice. */
export interface AgentNoticeDisclosureReceipt {
  /** True when the secret-pattern pass ran over `notice.content` (every `internal` notice). */
  readonly redacted: boolean;
  readonly route: AgentNoticeDeliveryRoute;
}

export interface AgentNoticeDelivery {
  readonly disclosure: AgentNoticeDisclosureReceipt;
  /** The notice with `content` as the route disclosed it, not necessarily as persisted. */
  readonly notice: AgentNotice;
  readonly receipt: AgentNoticeAttemptReceipt;
}

export interface AgentNoticesHandle {
  /** Recipient-scoped explicit acknowledgement; the strongest evidenced state. */
  acknowledge(id: string): Promise<AgentNotice>;
  /** Pending notices as the `mcp-inbox` route discloses them (`content` redacted per sensitivity; withheld ones omitted). */
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
  /**
   * Compare-and-swap guard: the receipt commits only if the ledger is still at
   * this revision, so concurrent signallers over one durable store cannot both
   * spend a notice's budget (typed `revision-conflict` otherwise).
   */
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
  readonly noticeIds: readonly string[];
  /**
   * The reservation this signal finalizes. The receipt is recorded only on
   * notices this key still holds and the hold is cleared with it; a key that
   * lost the hold (another signaller took over after the TTL) records nothing
   * and the call rejects with `reservation-lost`, so two holders can never
   * both spend one budget slot.
   */
  readonly reservationKey?: string;
}

export interface AgentNoticeAvailabilityReservationOptions {
  readonly at: string;
  /** Compare-and-swap guard against the revision the eligibility was computed from. */
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
  readonly noticeIds: readonly string[];
  readonly reservationKey: string;
}

export interface AgentNoticeAvailabilityReleaseOptions {
  readonly idempotencyKey: string;
  readonly noticeIds: readonly string[];
  /** Only a reservation with this key is released; a newer holder's is left intact. */
  readonly reservationKey: string;
}

export interface AgentNoticeRetainOptions {
  readonly at: string;
  readonly idempotencyKey: string;
}

export interface AgentNoticeRetentionReport {
  /** True when the store's journal was compacted onto its head by this call. */
  readonly compacted: boolean;
  readonly journal: AgentStateJournalInspection;
  /** Ids of terminal notices this call removed from the ledger state. */
  readonly prunedIds: readonly string[];
  readonly revision: number;
}

/** Read-only retention facts of a ledger: policy, live counts, and storage. */
export interface AgentNoticeLedgerInspection {
  readonly counts: {
    readonly byState: Readonly<Record<AgentNoticeState, number>>;
    /** Notices the retention policy treats as terminal (including exhausted `attempted`). */
    readonly terminal: number;
    readonly total: number;
  };
  readonly journal: AgentStateJournalInspection;
  readonly policy: AgentNoticeRetentionPolicy;
  readonly retention?: AgentNoticeRetentionSummary;
  readonly revision: number;
}

export interface AgentNoticeLedger {
  expire(options: AgentNoticeExpiryOptions): Promise<AgentNoticeLedgerSnapshot>;
  /** Retention facts for diagnostics; never notice content. */
  inspect(): Promise<AgentNoticeLedgerInspection>;
  openRequest(request: AgentNoticeRequest): Promise<AgentNoticeRequestLease>;
  read(): Promise<AgentNoticeLedgerSnapshot>;
  /** Applies the retention policy now: prunes eligible terminal notices, then compacts an oversized journal. */
  retain(options: AgentNoticeRetainOptions): Promise<AgentNoticeRetentionReport>;
  /** Releases a reservation whose resources/updated send failed; no budget was spent. */
  releaseAvailability(options: AgentNoticeAvailabilityReleaseOptions): Promise<AgentNoticeLedgerSnapshot>;
  /** Holds one budget slot for a resources/updated send about to happen; records no receipt. */
  reserveAvailability(options: AgentNoticeAvailabilityReservationOptions): Promise<AgentNoticeLedgerSnapshot>;
  /** Records a wire-level resources/updated signal that succeeded; availability, never delivery. */
  signalAvailability(options: AgentNoticeAvailabilitySignalOptions): Promise<AgentNoticeLedgerSnapshot>;
  withdraw(id: string, options: AgentNoticeWithdrawOptions): Promise<AgentNoticeLedgerSnapshot>;
}

export type AgentNoticeErrorCode =
  | 'aborted'
  | 'invalid-input'
  | 'request-closed'
  /** A reserved availability receipt was refused because the reservation key no longer holds the slot. */
  | 'reservation-lost'
  | 'unauthorized';

export class AgentNoticeError extends Error {
  readonly code: AgentNoticeErrorCode;

  constructor(code: AgentNoticeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'AgentNoticeError';
  }
}
