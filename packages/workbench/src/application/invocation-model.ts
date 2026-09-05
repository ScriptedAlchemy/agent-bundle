import type {
  RouteInvocation,
  RouteInvocationRequest,
  RouteInvocationSummary,
} from '../../../agent-bundle/src/contracts/invocations.ts';
import {
  parseJsonWithoutDuplicateKeys,
  type JsonValue,
} from '../../../agent-bundle/src/contracts/strict-json.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';
import type { ApplicationLeaf } from './application-tree-model.ts';
import type { InvocationBackend } from './invocation-backend.ts';

export type InvocationState =
  | Readonly<{ readonly status: 'idle' }>
  | Readonly<{ readonly request: RouteInvocationRequest; readonly status: 'running' }>
  | Readonly<{ readonly invocation: RouteInvocation; readonly status: 'succeeded' }>
  | Readonly<{ readonly error: unknown; readonly status: 'failed' }>;

export type InvocationAction =
  | Readonly<{ readonly request: RouteInvocationRequest; readonly type: 'invoke.started' }>
  | Readonly<{ readonly invocation: RouteInvocation; readonly type: 'invoke.succeeded' }>
  | Readonly<{ readonly error: unknown; readonly type: 'invoke.failed' }>
  | Readonly<{ readonly type: 'reset' }>;

const idleState = Object.freeze({ status: 'idle' as const });
const storagePrefix = 'agent-bundle:invocation-input:';

export const reduceInvocationState = (
  state: InvocationState,
  action: InvocationAction,
): InvocationState => {
  switch (action.type) {
    case 'invoke.started':
      return Object.freeze({ request: action.request, status: 'running' });
    case 'invoke.succeeded':
      return Object.freeze({ invocation: action.invocation, status: 'succeeded' });
    case 'invoke.failed':
      return Object.freeze({ error: action.error, status: 'failed' });
    case 'reset':
      return idleState;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
};

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

export const writeLastInput = (leafKey: string, input: unknown): void => {
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
  routeId: invocation.routeId,
  source: invocation.source,
  sourceRevision: invocation.sourceRevision,
  startedAt: invocation.startedAt,
  status: invocation.status,
  timings: invocation.timings,
});
