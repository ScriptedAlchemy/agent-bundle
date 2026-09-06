/**
 * The workspace's invocation state machine plus the small helpers every
 * backend and workspace share: last-input persistence, backend selection, and
 * the summary projection of an envelope.
 */
import type { Diagnostic } from '../../../agent-bundle/src/contracts/diagnostics.ts';
import {
  emptyRetainedRenderEvents,
  retainRenderEvent,
  type RetainedRenderEvents,
  type RouteInvocation,
  type RouteInvocationOutcome,
  type RouteInvocationStatus,
  type RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import {
  parseJsonWithoutDuplicateKeys,
  type JsonValue,
} from '../../../agent-bundle/src/contracts/strict-json.ts';
import type { AgentRenderEvent } from '../runtime/agent-document-client.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';

export interface InvocationFailure {
  readonly code: string;
  readonly message: string;
}

/** The workspace's view of one run: idle, running, or settled with the envelope (or the transport failure). */
export type InvocationState =
  | Readonly<{ readonly phase: 'idle' }>
  | Readonly<{
      readonly correlationId: string;
      /** The live render window, held under the same retention policy the server applies to its replay and envelope. */
      readonly history?: RetainedRenderEvents;
      readonly invocationId?: string;
      readonly phase: 'running';
      readonly startedAt: number;
    }>
  | Readonly<{ readonly durationMs?: number; readonly invocation: RouteInvocation; readonly phase: 'succeeded' }>
  | Readonly<{
      readonly diagnostics: readonly Diagnostic[];
      readonly durationMs?: number;
      readonly failure?: InvocationFailure;
      readonly invocation?: RouteInvocation;
      readonly phase: 'failed';
    }>;

export type InvocationAction =
  | Readonly<{ readonly correlationId: string; readonly startedAt: number; readonly type: 'start' }>
  /** The backend answered; a `status: 'failed'` envelope becomes the `failed` phase with its diagnostics. */
  | Readonly<{ readonly completedAt: number; readonly invocation: RouteInvocation; readonly type: 'settle' }>
  /** The backend rejected (transport, malformed request, unknown route). */
  | Readonly<{ readonly completedAt: number; readonly failure: InvocationFailure; readonly type: 'fail' }>
  | Readonly<{ readonly event: AgentRenderEvent; readonly type: 'render' }>
  | Readonly<{ readonly invocationId: string; readonly type: 'stream.start' }>
  /** A snapshot loaded by id (deep link, trace entry) — no timing of our own. */
  | Readonly<{ readonly invocation: RouteInvocation; readonly type: 'load' }>
  | Readonly<{ readonly type: 'reset' }>;

const settled = (invocation: RouteInvocation, durationMs?: number): InvocationState => invocation.status === 'succeeded'
  ? Object.freeze({ ...(durationMs === undefined ? {} : { durationMs }), invocation, phase: 'succeeded' })
  : Object.freeze({ diagnostics: invocation.diagnostics, ...(durationMs === undefined ? {} : { durationMs }), invocation, phase: 'failed' });

export const idleInvocationState: InvocationState = Object.freeze({ phase: 'idle' });

export const reduceInvocationState = (state: InvocationState, action: InvocationAction): InvocationState => {
  switch (action.type) {
    case 'start':
      return Object.freeze({ correlationId: action.correlationId, phase: 'running', startedAt: action.startedAt });
    case 'settle':
      return settled(action.invocation, state.phase === 'running' ? Math.max(0, action.completedAt - state.startedAt) : undefined);
    case 'fail':
      return Object.freeze({
        diagnostics: Object.freeze([]),
        ...(state.phase === 'running' ? { durationMs: Math.max(0, action.completedAt - state.startedAt) } : {}),
        failure: action.failure,
        phase: 'failed',
      });
    case 'render':
      return state.phase === 'running'
        ? Object.freeze({ ...state, history: retainRenderEvent(state.history ?? emptyRetainedRenderEvents, action.event).retained })
        : state;
    case 'stream.start':
      return state.phase === 'running'
        ? Object.freeze({ ...state, invocationId: action.invocationId })
        : state;
    case 'load':
      return settled(action.invocation);
    case 'reset':
      return idleInvocationState;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

const storagePrefix = 'agent-bundle:invocation-input:';

const sessionStorageFor = (): Storage | undefined => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

export const readLastInput = (leafKey: string): JsonValue | undefined => {
  try {
    const raw = sessionStorageFor()?.getItem(`${storagePrefix}${leafKey}`);
    return raw === null || raw === undefined
      ? undefined
      : snapshotStrictJsonValue(parseJsonWithoutDuplicateKeys(raw));
  } catch {
    return undefined;
  }
};

export const writeLastInput = (leafKey: string, input: JsonValue): void => {
  try {
    sessionStorageFor()?.setItem(
      `${storagePrefix}${leafKey}`,
      JSON.stringify(snapshotStrictJsonValue(input)),
    );
  } catch {
    // Storage is optional: privacy settings, quota limits, and hostile values
    // must not prevent an invocation.
  }
};

/** The execution status as the UI words it: the boundary completed or did not; never "succeeded", which the outcome decides. */
export const statusLabel = (status: RouteInvocationStatus): string => {
  switch (status) {
    case 'cancelled':
      return 'Cancelled';
    case 'succeeded':
      return 'Completed';
    case 'failed':
      return 'Failed';
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

/** What a completed run meant, in the words every outcome badge shows. */
export const outcomeLabel = (outcome: RouteInvocationOutcome): string => {
  switch (outcome.kind) {
    case 'success':
      return 'Success';
    case 'represented-error':
      return `Represented error · ${outcome.summary}`;
    case 'process-exit':
      return `Exit code ${String(outcome.exitCode)}`;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};

export const selectBackend = (
  backends: readonly InvocationBackend[],
  leaf: ApplicationLeaf,
): InvocationBackend | undefined => backends.find((backend) => backend.accepts(leaf));

export const invocationSummaryOf = (
  invocation: RouteInvocation,
): RouteInvocationSummary => Object.freeze({
  completedAt: invocation.completedAt,
  ...(invocation.correlationId === undefined ? {} : { correlationId: invocation.correlationId }),
  diagnostics: invocation.diagnostics,
  ...(invocation.event === undefined ? {} : { event: invocation.event }),
  id: invocation.id,
  input: invocation.input,
  kind: invocation.kind,
  manifestDigest: invocation.manifestDigest,
  ...(invocation.outcome === undefined ? {} : { outcome: invocation.outcome }),
  routeId: invocation.routeId,
  source: invocation.source,
  sourceRevision: invocation.sourceRevision,
  startedAt: invocation.startedAt,
  status: invocation.status,
  surface: invocation.surface,
  timings: invocation.timings,
});
