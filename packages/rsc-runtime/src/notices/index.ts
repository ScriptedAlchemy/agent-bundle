/**
 * Optional recipient-scoped notice ledger (#99 narrow core):
 * `@agent-bundle/runtime/notices`.
 *
 * The ledger is implemented as one ordinary state-kernel definition. Host
 * wiring chooses the matching driver; workspace durability therefore comes
 * from `@agent-bundle/runtime/state/sqlite`, with the kernel owning
 * transactions, revisions, and idempotency.
 */
export {
  AGENT_NOTICE_AVAILABILITY_RESERVATION_TTL_MS,
  AGENT_NOTICE_DEFAULT_RETENTION,
  AGENT_NOTICE_STATES,
  AgentNoticeError,
} from './contract.js';
export type {
  AgentNotice,
  AgentNoticeAcknowledgement,
  AgentNoticeAttemptReceipt,
  AgentNoticeAuthorizationDecision,
  AgentNoticeAuthorizationRequest,
  AgentNoticeAuthorizer,
  AgentNoticeAvailability,
  AgentNoticeAvailabilityReleaseOptions,
  AgentNoticeAvailabilityReservation,
  AgentNoticeAvailabilityReservationOptions,
  AgentNoticeAvailabilitySignalOptions,
  AgentNoticeDelivery,
  AgentNoticeDisclosureReceipt,
  AgentNoticeErrorCode,
  AgentNoticeExposure,
  AgentNoticeExpiryOptions,
  AgentNoticeLedger,
  AgentNoticeLedgerInspection,
  AgentNoticeLedgerSnapshot,
  AgentNoticePrincipal,
  AgentNoticePriority,
  AgentNoticePublishInput,
  AgentNoticePublishOptions,
  AgentNoticePublishResult,
  AgentNoticeRequest,
  AgentNoticeRetainOptions,
  AgentNoticeRetentionPolicy,
  AgentNoticeRetentionReport,
  AgentNoticeRetentionSummary,
  AgentNoticeState,
  AgentNoticesHandle,
  AgentNoticeUnavailableReason,
  AgentNoticeWithdrawOptions,
  AgentNoticeWithheldEntry,
  AgentNoticeWithholding,
  AgentNoticeWithholdingReason,
  AgentNoticeWithholdings,
  AgentRecipient,
} from './contract.js';
export {
  AGENT_NOTICE_DEFAULT_SENSITIVITY,
  AGENT_NOTICE_SENSITIVITIES,
  NOTICE_REDACTION_MARK,
  NOTICE_SECRET_PATTERN_SOURCES,
  NOTICE_TITLE_MAX_LENGTH,
  compareNoticeSensitivity,
  containsSecretText,
  disclosedNoticeContent,
  isNoticeSensitivity,
  noticeTitle,
  redactNoticeDocument,
  redactSecretText,
} from './redaction.js';
export type {
  AgentNoticeDisclosure,
  AgentNoticeDisclosureShape,
  AgentNoticeSensitivity,
} from './redaction.js';
export {
  resolveNoticeRetentionPolicy,
  selectPrunableNotices,
} from './retention.js';
export type { AgentNoticeRetentionInput } from './retention.js';
export {
  AGENT_NOTICE_DELIVERY_ROUTES,
  AGENT_NOTICE_ROUTE_SHAPES,
  resolveNoticeDisclosure,
  routeSensitivityCeiling,
  selectNoticeDeliveryRoutes,
} from './router.js';
export type {
  AgentNoticeDeliveryAdvertisement,
  AgentNoticeDeliveryRoute,
  AgentNoticeDeliveryRouteState,
  AgentNoticeRouteSelection,
} from './router.js';
export {
  createAgentNoticeLedger,
} from './ledger.js';
export type {
  CreateAgentNoticeLedgerOptions,
} from './ledger.js';
export {
  AGENT_NOTICE_INBOX_URI,
  createNoticeInboxSignaller,
} from './resource-updated.js';
export type {
  AgentNoticeInboxSignaller,
  AgentNoticeInboxSignalOutcome,
  AgentNoticeInboxStore,
  CreateNoticeInboxSignallerOptions,
} from './resource-updated.js';
export {
  AGENT_NOTICE_STATE_VERSION,
  agentNoticeEventSchemas,
  agentNoticeStateDefinition,
  noticeSettledAt,
  recipientMatchesPrincipal,
} from './state.js';
export type {
  AgentNoticeLedgerState,
} from './state.js';
