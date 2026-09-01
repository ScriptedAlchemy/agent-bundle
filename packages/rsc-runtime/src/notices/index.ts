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
  AGENT_NOTICE_STATES,
  AgentNoticeError,
} from './contract.js';
export type {
  AgentNotice,
  AgentNoticeAttemptReceipt,
  AgentNoticeAuthorizationDecision,
  AgentNoticeAuthorizationRequest,
  AgentNoticeAuthorizer,
  AgentNoticeDelivery,
  AgentNoticeErrorCode,
  AgentNoticeExpiryOptions,
  AgentNoticeLedger,
  AgentNoticeLedgerSnapshot,
  AgentNoticePrincipal,
  AgentNoticePriority,
  AgentNoticePublishInput,
  AgentNoticePublishOptions,
  AgentNoticePublishResult,
  AgentNoticeRequest,
  AgentNoticeState,
  AgentNoticesHandle,
  AgentNoticeUnavailableReason,
  AgentNoticeWithdrawOptions,
  AgentRecipient,
} from './contract.js';
export {
  createAgentNoticeLedger,
} from './ledger.js';
export type {
  CreateAgentNoticeLedgerOptions,
} from './ledger.js';
export {
  agentNoticeEventSchemas,
  agentNoticeStateDefinition,
  recipientMatchesPrincipal,
} from './state.js';
export type {
  AgentNoticeLedgerState,
} from './state.js';
