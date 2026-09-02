import type { ZodError, ZodType, z } from 'zod';

import { canonicalJson, deepFreezeJson, isJsonSafe } from './json.js';

/**
 * Driver-neutral contract for the optional Agent state kernel (#98).
 *
 * Stateful applications declare typed events and a pure reducer with
 * {@link defineState}; drivers supply storage for one explicit lifetime and
 * must preserve the kernel's revision, idempotency, transaction, and error
 * semantics (enforced by the shared conformance suite in `conformance.ts`).
 * Stateless projects never import this module: it ships behind the
 * `@agent-bundle/runtime/state` subpath, outside the package root export.
 */

/**
 * Where a state instance lives and when it is honestly lost.
 *
 * - `request`: one invocation; discarded when the request settles.
 * - `process`: one warm runtime process; lost on restart by definition.
 * - `workspace-durable`: survives process restarts for one workspace via a
 *   durable local driver.
 * - `external`: an application-provided authority (database, daemon, remote
 *   service); durability is whatever that driver honestly declares.
 *
 * v1 ships `request`, `process`, and `workspace-durable` drivers; `external`
 * drivers are admitted through the conformance suite.
 */
export type AgentStateLifetime = 'request' | 'process' | 'workspace-durable' | 'external';

export const AGENT_STATE_LIFETIMES: readonly AgentStateLifetime[] = Object.freeze([
  'request',
  'process',
  'workspace-durable',
  'external',
]);

export type AgentStateErrorCode =
  | 'aborted'
  | 'budget-exceeded'
  | 'corrupt'
  | 'idempotency-conflict'
  | 'invalid-definition'
  | 'invalid-event'
  | 'invalid-input'
  | 'invalid-state'
  | 'lifetime-mismatch'
  | 'migration-failure'
  | 'migration-missing'
  | 'reducer-failure'
  | 'revision-conflict'
  | 'revision-unavailable'
  | 'store-closed'
  | 'unavailable';

/**
 * Typed state kernel failure. Messages identify definitions, events, keys,
 * and revisions but never embed state or payload contents: state stays out
 * of logs and error channels by default.
 */
export class AgentStateError extends Error {
  readonly code: AgentStateErrorCode;

  constructor(code: AgentStateErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = 'AgentStateError';
  }
}

/** True when the lifetime is lost with its owning request or process rather than stored durably. */
export const agentStateLifetimeIsVolatile = (lifetime: AgentStateLifetime): boolean => {
  switch (lifetime) {
    case 'request':
    case 'process':
      return true;
    case 'workspace-durable':
    case 'external':
      return false;
    default: {
      const unreachable: never = lifetime;
      throw new AgentStateError('invalid-definition', `Unknown state lifetime ${String(unreachable)}`);
    }
  }
};

export type AgentStateEventSchemas = Readonly<Record<string, ZodType>>;

export type AgentStateEventName<TEvents extends AgentStateEventSchemas> = Extract<keyof TEvents, string>;

export type AgentStateEventPayload<
  TEvents extends AgentStateEventSchemas,
  TName extends AgentStateEventName<TEvents>,
> = z.output<TEvents[TName]>;

/** Discriminated event union passed to the reducer; `switch (event.name)` narrows `payload`. */
export type AgentStateEvent<TEvents extends AgentStateEventSchemas> = {
  [TName in AgentStateEventName<TEvents>]: {
    readonly name: TName;
    readonly payload: z.output<TEvents[TName]>;
  };
}[AgentStateEventName<TEvents>];

/**
 * Explicit, versioned migration steps. `migrations[n]` migrates a state
 * persisted at definition version `n - 1` to version `n`; a definition of
 * version `v > 1` must supply every step from `2` through `v`. Steps receive
 * the raw persisted value and their final output must satisfy the current
 * schema; steps must accept any valid version `n - 1` state, because
 * committed results stored for idempotent replay migrate through the same
 * chain. Migrating rebases history: exact-revision reads below the recorded
 * migration become `revision-unavailable`, but replaying a committed
 * idempotency key still returns its committed result (migrated to the
 * current version).
 */
export type AgentStateMigrations = Readonly<Record<number, (persisted: unknown) => unknown>>;

/**
 * Optional runtime policy overrides for state mutations. Budgets are not
 * persisted in storage metadata: reopening the same storage with different
 * budgets is allowed.
 */
export interface AgentStateBudgetsInput {
  /**
   * Maximum wall-clock time in milliseconds from mutation validation start
   * until just before commit. A slower event or reset fails
   * `budget-exceeded`; raise this definition budget to admit slower commits.
   */
  readonly maxCommitMs?: number;
  /**
   * Maximum UTF-8 bytes in a validated event payload, measured with
   * `Buffer.byteLength(canonicalJson(payload), 'utf8')`. A larger payload
   * fails `budget-exceeded`; raise this definition budget to admit it.
   */
  readonly maxEventBytes?: number;
  /**
   * Maximum total journal revisions admitted for caller-initiated commits.
   * The next event or reset past this cap fails `budget-exceeded`; raise this
   * definition budget to retain more revisions. Kernel migrations are exempt.
   */
  readonly maxRevisions?: number;
  /**
   * Maximum UTF-8 bytes in a committed state, measured with
   * `Buffer.byteLength(canonicalJson(state), 'utf8')`. A larger initial,
   * event, reset, or migrated state fails closed; raise this definition
   * budget to admit it.
   */
  readonly maxStateBytes?: number;
}

/** Resolved runtime state budgets. These values are policy, not persisted metadata. */
export interface AgentStateBudgets {
  /**
   * Maximum wall-clock time in milliseconds from mutation validation start
   * until just before commit. A slower event or reset fails
   * `budget-exceeded`; raise this definition budget to admit slower commits.
   */
  readonly maxCommitMs: number;
  /**
   * Maximum UTF-8 bytes in a validated event payload, measured with
   * `Buffer.byteLength(canonicalJson(payload), 'utf8')`. A larger payload
   * fails `budget-exceeded`; raise this definition budget to admit it.
   */
  readonly maxEventBytes: number;
  /**
   * Maximum total journal revisions admitted for caller-initiated commits.
   * The next event or reset past this cap fails `budget-exceeded`; raise this
   * definition budget to retain more revisions. Kernel migrations are exempt.
   */
  readonly maxRevisions: number;
  /**
   * Maximum UTF-8 bytes in a committed state, measured with
   * `Buffer.byteLength(canonicalJson(state), 'utf8')`. A larger initial,
   * event, reset, or migrated state fails closed; raise this definition
   * budget to admit it.
   */
  readonly maxStateBytes: number;
}

export const AGENT_STATE_DEFAULT_BUDGETS: AgentStateBudgets = Object.freeze({
  maxCommitMs: 5_000,
  maxEventBytes: 262_144,
  maxRevisions: 100_000,
  maxStateBytes: 1_048_576,
});

export interface AgentStateDefinitionInput<TState, TEvents extends AgentStateEventSchemas> {
  /** Runtime-only mutation policy; omitted fields resolve from {@link AGENT_STATE_DEFAULT_BUDGETS}. */
  readonly budgets?: AgentStateBudgetsInput;
  /** Event name to payload schema; dispatch validates payloads before the reducer runs. */
  readonly events: TEvents;
  /** Stable identity for storage naming and cross-process addressing. */
  readonly id: string;
  /** Initial state; must satisfy `schema` and be JSON-safe. */
  readonly initial: TState;
  readonly lifetime: AgentStateLifetime;
  readonly migrations?: AgentStateMigrations;
  /** Pure, deterministic, synchronous transition; must not mutate its input (it is frozen). */
  readonly reduce: (state: TState, event: AgentStateEvent<TEvents>) => TState;
  readonly schema: ZodType<TState>;
  /** Schema version for explicit migrations; defaults to 1. */
  readonly version?: number;
}

export interface AgentStateDefinition<
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
> {
  /** Resolved runtime-only mutation policy; never persisted in storage metadata. */
  readonly budgets: AgentStateBudgets;
  readonly events: TEvents;
  readonly id: string;
  readonly initial: TState;
  readonly lifetime: AgentStateLifetime;
  readonly migrations: AgentStateMigrations;
  readonly reduce: (state: TState, event: AgentStateEvent<TEvents>) => TState;
  readonly schema: ZodType<TState>;
  readonly version: number;
}

/** Compact zod issue summary that names paths and codes without embedding rejected values. */
export const describeSchemaIssues = (error: ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.code}`)
    .join('; ');

const expectNonEmptyText = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AgentStateError('invalid-definition', `${label} must be a non-empty string`);
  }
  return value;
};

const resolveStateBudgets = (id: string, input: AgentStateBudgetsInput | undefined): AgentStateBudgets => {
  const resolved = {
    ...AGENT_STATE_DEFAULT_BUDGETS,
    ...input,
  };
  for (const field of ['maxCommitMs', 'maxEventBytes', 'maxRevisions', 'maxStateBytes'] as const) {
    const value = resolved[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new AgentStateError(
        'invalid-definition',
        `State '${id}' budget '${field}' must be an integer >= 1`,
      );
    }
  }
  return Object.freeze(resolved);
};

export const defineState = <TState, TEvents extends AgentStateEventSchemas>(
  input: AgentStateDefinitionInput<TState, TEvents>,
): AgentStateDefinition<TState, TEvents> => {
  const id = expectNonEmptyText(input.id, 'State definition id');
  if (!AGENT_STATE_LIFETIMES.includes(input.lifetime)) {
    throw new AgentStateError('invalid-definition', `State '${id}' declares an unknown lifetime`);
  }
  if (typeof input.reduce !== 'function') {
    throw new AgentStateError('invalid-definition', `State '${id}' requires a reduce function`);
  }
  const budgets = resolveStateBudgets(id, input.budgets);
  const eventNames = Object.keys(input.events);
  if (eventNames.length === 0) {
    throw new AgentStateError('invalid-definition', `State '${id}' must declare at least one event`);
  }
  for (const name of eventNames) {
    expectNonEmptyText(name, `State '${id}' event name`);
    if (typeof input.events[name]?.safeParse !== 'function') {
      throw new AgentStateError('invalid-definition', `State '${id}' event '${name}' requires a zod schema`);
    }
  }
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new AgentStateError('invalid-definition', `State '${id}' version must be an integer >= 1`);
  }
  const migrations = input.migrations ?? {};
  const migrationVersions = Object.keys(migrations).map((key) => Number(key));
  for (const target of migrationVersions) {
    if (!Number.isInteger(target) || target < 2 || target > version) {
      throw new AgentStateError(
        'invalid-definition',
        `State '${id}' migration targets must be integers from 2 through ${String(version)}`,
      );
    }
    if (typeof migrations[target] !== 'function') {
      throw new AgentStateError('invalid-definition', `State '${id}' migration to version ${String(target)} must be a function`);
    }
  }
  for (let target = 2; target <= version; target += 1) {
    if (migrations[target] === undefined) {
      throw new AgentStateError('invalid-definition', `State '${id}' is missing the migration to version ${String(target)}`);
    }
  }
  const parsedInitial = input.schema.safeParse(input.initial);
  if (!parsedInitial.success) {
    throw new AgentStateError(
      'invalid-definition',
      `State '${id}' initial state failed its schema: ${describeSchemaIssues(parsedInitial.error)}`,
    );
  }
  if (!isJsonSafe(parsedInitial.data)) {
    throw new AgentStateError('invalid-definition', `State '${id}' initial state must be JSON-safe`);
  }
  const initialBytes = Buffer.byteLength(canonicalJson(parsedInitial.data), 'utf8');
  if (initialBytes > budgets.maxStateBytes) {
    throw new AgentStateError(
      'invalid-definition',
      `State '${id}' initial state is ${String(initialBytes)} bytes, exceeding maxStateBytes ${String(budgets.maxStateBytes)}`,
    );
  }
  return Object.freeze({
    budgets,
    events: Object.freeze({ ...input.events }) as TEvents,
    id,
    initial: deepFreezeJson(parsedInitial.data),
    lifetime: input.lifetime,
    migrations: Object.freeze({ ...migrations }),
    reduce: input.reduce,
    schema: input.schema,
    version,
  });
};

export interface AgentStateSnapshot<TState = unknown> {
  readonly revision: number;
  readonly state: TState;
}

export interface AgentStateCommitResult<TState = unknown> extends AgentStateSnapshot<TState> {
  /** True when the idempotency key had already committed and the stored result was returned. */
  readonly replayed: boolean;
}

/**
 * One committed journal entry, exposed through the polling change cursor.
 * `reset` and `migrate` entries mark history discontinuities: consumers
 * re-read instead of folding payloads.
 */
export type AgentStateChange =
  | {
      readonly committedAt: string;
      readonly kind: 'event';
      readonly name: string;
      readonly payload: unknown;
      readonly revision: number;
    }
  | { readonly committedAt: string; readonly kind: 'migrate'; readonly revision: number }
  | { readonly committedAt: string; readonly kind: 'reset'; readonly revision: number };

export interface AgentStateChangeBatch {
  readonly changes: readonly AgentStateChange[];
  readonly headRevision: number;
}

export interface AgentStateDispatchOptions {
  /** Compare-and-swap: fail with `revision-conflict` unless the head revision matches. */
  readonly expectedRevision?: number;
  /**
   * Required caller-owned dedupe identity. Replaying a committed key with an
   * identical payload returns the committed result; reusing it with a
   * different payload is an `idempotency-conflict`.
   */
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal;
}

export interface AgentStateReadOptions {
  /** Exact-revision snapshot read; defaults to the head revision. */
  readonly revision?: number;
  readonly signal?: AbortSignal;
}

export interface AgentStateChangesOptions {
  /** Change cursor position: return changes with revisions greater than this. */
  readonly afterRevision: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface AgentStateResetOptions<TState = unknown> {
  readonly expectedRevision?: number;
  readonly idempotencyKey: string;
  /** Replacement state; defaults to the definition's initial state. Must satisfy the schema. */
  readonly seed?: TState;
  readonly signal?: AbortSignal;
}

/**
 * An open state instance. Revisions are monotonic across events, resets, and
 * migrations; revision 0 is the initial state.
 */
export interface AgentStateStore<
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
> {
  readonly definition: AgentStateDefinition<TState, TEvents>;
  /** Storage identity for diagnostics (path or memory label); never state contents. */
  readonly location: string;
  changes(options: AgentStateChangesOptions): Promise<AgentStateChangeBatch>;
  close(): Promise<void>;
  dispatch<TName extends AgentStateEventName<TEvents>>(
    name: TName,
    payload: AgentStateEventPayload<TEvents, TName>,
    options: AgentStateDispatchOptions,
  ): Promise<AgentStateCommitResult<TState>>;
  read(options?: AgentStateReadOptions): Promise<AgentStateSnapshot<TState>>;
  reset(options: AgentStateResetOptions<TState>): Promise<AgentStateCommitResult<TState>>;
}

/**
 * Storage backend for exactly one lifetime. Opening a definition whose
 * lifetime differs from the driver's is a `lifetime-mismatch`; a driver must
 * never claim a stronger lifetime than its storage honestly provides, and
 * in-memory storage is never durable.
 */
export interface AgentStateDriver {
  /** Whether commits survive a process restart. Volatile drivers must say false. */
  readonly durable: boolean;
  readonly kind: string;
  readonly lifetime: AgentStateLifetime;
  close(): Promise<void>;
  open<TState, TEvents extends AgentStateEventSchemas>(
    definition: AgentStateDefinition<TState, TEvents>,
  ): Promise<AgentStateStore<TState, TEvents>>;
}

/**
 * Request-bound view of one open store, installed on the reserved `state`
 * slot of the Agent request context: `(await agent()).state`.
 */
export interface AgentStateHandle<
  TState = unknown,
  TEvents extends AgentStateEventSchemas = AgentStateEventSchemas,
> {
  readonly lifetime: AgentStateLifetime;
  changes(options: AgentStateChangesOptions): Promise<AgentStateChangeBatch>;
  dispatch<TName extends AgentStateEventName<TEvents>>(
    name: TName,
    payload: AgentStateEventPayload<TEvents, TName>,
    options: AgentStateDispatchOptions,
  ): Promise<AgentStateCommitResult<TState>>;
  read(options?: AgentStateReadOptions): Promise<AgentStateSnapshot<TState>>;
}

/** Reserved namespace for kernel-generated idempotency keys (migrations). */
export const AGENT_STATE_RESERVED_KEY_PREFIX = 'agent-state:';

export const expectIdempotencyKey = (key: string): string => {
  if (typeof key !== 'string' || key.trim() === '') {
    throw new AgentStateError('invalid-input', 'State mutations require a non-empty idempotency key');
  }
  if (key.startsWith(AGENT_STATE_RESERVED_KEY_PREFIX)) {
    throw new AgentStateError(
      'invalid-input',
      `Idempotency keys must not use the reserved '${AGENT_STATE_RESERVED_KEY_PREFIX}' prefix`,
    );
  }
  return key;
};

export const expectCanonicalPayload = (value: unknown, label: string): string => {
  if (!isJsonSafe(value)) {
    throw new AgentStateError('invalid-event', `${label} must be JSON-safe`);
  }
  return canonicalJson(value);
};
