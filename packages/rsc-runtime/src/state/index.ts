/**
 * Optional Agent state kernel (#98): `@agent-bundle/runtime/state`.
 *
 * This subpath is the only way state code enters an artifact — the package
 * root export never imports it, so stateless projects ship none of the
 * kernel. The workspace-durable driver lives one subpath deeper
 * (`@agent-bundle/runtime/state/sqlite`) so volatile-state users never load
 * `node:sqlite`.
 */
export {
  AGENT_STATE_DEFAULT_BUDGETS,
  AGENT_STATE_LIFETIMES,
  AGENT_STATE_RESERVED_KEY_PREFIX,
  AgentStateError,
  agentStateLifetimeIsVolatile,
  defineState,
  describeSchemaIssues,
  expectIdempotencyKey,
} from './contract.js';
export type {
  AgentStateBudgets,
  AgentStateBudgetsInput,
  AgentStateChange,
  AgentStateChangeBatch,
  AgentStateChangesOptions,
  AgentStateCommitResult,
  AgentStateDefinition,
  AgentStateDefinitionInput,
  AgentStateDispatchOptions,
  AgentStateDriver,
  AgentStateErrorCode,
  AgentStateEvent,
  AgentStateEventName,
  AgentStateEventPayload,
  AgentStateEventSchemas,
  AgentStateHandle,
  AgentStateLifetime,
  AgentStateMigrations,
  AgentStateReadOptions,
  AgentStateResetOptions,
  AgentStateSnapshot,
  AgentStateStore,
} from './contract.js';
// Driver-author toolkit: external drivers implement the same journal
// semantics with these helpers and prove it against the conformance suite.
export {
  applyStateEvent,
  canonicalCommitInput,
  changeFromJournalRecord,
  expectCommitWithinBudgets,
  expectConsistentJournal,
  expectMigrationWithinStateBudget,
  migrationIdempotencyKey,
  parseEventPayload,
  reduceStateEvent,
  replayJournal,
  resolveResetState,
  runStateMigrations,
} from './journal.js';
export type { AgentStateJournalRecord } from './journal.js';
export { canonicalJson, deepFreezeJson, isJsonSafe } from './json.js';
export { createAgentStateHandle } from './handle.js';
export type { AgentStateHandleOptions } from './handle.js';
export { createMemoryStateDriver } from './memory-driver.js';
export type { MemoryStateDriverOptions } from './memory-driver.js';
export { stateDriverConformanceCases } from './conformance.js';
export type { StateConformanceCase, StateConformanceContext } from './conformance.js';
