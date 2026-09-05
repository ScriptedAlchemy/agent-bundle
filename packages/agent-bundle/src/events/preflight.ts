import type { CanonicalAgentEvent } from '../routes/events.ts';
import type { AgentEventCanonicalIdentity } from '../routes/public.ts';
import type { AgentTerminal } from '../terminal-capability.ts';

/**
 * The gate result a conventional event route's re-exported preflight may return (#595).
 * `execute` is the only value that loads the rendered route; `continue` is a
 * pass-through with no host decision; `deny` blocks through the existing
 * canonical event outcome projection and always carries a nonempty reason.
 */
export type EventPreflightResult =
  | 'execute'
  | { readonly outcome: 'continue' }
  | { readonly outcome: 'deny'; readonly reason: string };

/**
 * Frozen, deliberately small context a preflight gate receives: the same
 * canonical identity the rendered route would see, compiled host metadata,
 * the hook-deadline signal, and translated terminal capability metadata. It does not include
 * `native`, state, notices, lineage, providers, or React/RSC helpers.
 */
export interface EventPreflightContext<E extends CanonicalAgentEvent = CanonicalAgentEvent> {
  readonly canonical: AgentEventCanonicalIdentity<E>;
  /** Target-specific host identity already known from the compiled hook. */
  readonly host: Readonly<{ readonly name: string; readonly nativeEvent: string }>;
  readonly signal: AbortSignal;
  readonly terminal: AgentTerminal;
}

/** Sync or async gate export on an event route module. */
export type EventPreflight<E extends CanonicalAgentEvent = CanonicalAgentEvent> = (
  context: EventPreflightContext<E>,
) => EventPreflightResult | Promise<EventPreflightResult>;

const preflightObjectOutcomes = ['continue', 'deny'] as const;
type PreflightObjectOutcome = (typeof preflightObjectOutcomes)[number];

const isPreflightObjectOutcome = (value: unknown): value is PreflightObjectOutcome =>
  value === 'continue' || value === 'deny';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unsupportedResult = (detail: string): never => {
  throw new TypeError(`Event preflight result ${detail}`);
};

const unexpectedFields = (record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Event preflight result has unsupported field ${JSON.stringify(key)}.`);
    }
  }
};

/**
 * Family-level deny admission: true when at least one supported host's
 * canonical event document projection emits a blocking deny. Observation-only
 * families — and families whose projection ignores deny — fail closed here
 * so host-specific projection stays in `events/projection.ts`.
 */
export const eventFamilyAllowsPreflightDeny = (event: CanonicalAgentEvent): boolean => {
  switch (event) {
    case 'agent/idle':
    case 'agent/start':
    case 'agent/stop':
    case 'compact/before':
    case 'config/change':
    case 'model-switch/before':
    case 'permission/request':
    case 'prompt/submit':
    case 'stop':
    case 'task/create':
    case 'tool/before':
      return true;
    case 'compact/after':
    case 'file/change':
    case 'model-switch/after':
    case 'permission/denied':
    case 'session/end':
    case 'session/start':
    case 'stop/failure':
    case 'task/complete':
    case 'tool/after':
    case 'tool/failure':
    case 'workspace/open':
      return false;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
};

/**
 * Validates a runtime preflight return into {@link EventPreflightResult}.
 * Unknown outcomes, extra fields, an empty denial reason, and deny on a
 * family that cannot deny fail closed.
 */
export const validateEventPreflightResult = (
  value: unknown,
  event: CanonicalAgentEvent,
): EventPreflightResult => {
  if (value === 'execute') return 'execute';
  if (!isPlainObject(value)) {
    return unsupportedResult('must be "execute" or a continue/deny object.');
  }
  const outcome = value.outcome;
  if (!isPreflightObjectOutcome(outcome)) {
    return unsupportedResult(`outcome ${JSON.stringify(outcome)} is not supported.`);
  }
  switch (outcome) {
    case 'continue':
      unexpectedFields(value, new Set(['outcome']));
      return Object.freeze({ outcome: 'continue' });
    case 'deny': {
      unexpectedFields(value, new Set(['outcome', 'reason']));
      if (!eventFamilyAllowsPreflightDeny(event)) {
        throw new TypeError(`${event} cannot deny from preflight.`);
      }
      if (typeof value.reason !== 'string' || value.reason.trim() === '') {
        throw new TypeError(`${event} requires a nonempty reason when outcome is deny.`);
      }
      return Object.freeze({ outcome: 'deny', reason: value.reason });
    }
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
};

/**
 * Runs the gate inside the common event kernel and validates its result before
 * any caller projects host output or loads the rendered route runtime.
 */
export const executeEventPreflight = async <E extends CanonicalAgentEvent>(
  preflight: EventPreflight<E>,
  context: EventPreflightContext<E>,
): Promise<EventPreflightResult> => {
  context.signal.throwIfAborted();
  const frozenContext = Object.freeze({
    canonical: context.canonical,
    host: Object.freeze({ ...context.host }),
    signal: context.signal,
    terminal: context.terminal,
  });
  const value = await preflight(frozenContext);
  context.signal.throwIfAborted();
  return validateEventPreflightResult(value, context.canonical.event);
};
