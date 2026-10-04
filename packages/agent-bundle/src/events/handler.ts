import { settleBeforeAbort } from '../core/abort.ts';
import { isJsonRecord, isRecord, snapshotStrictJsonValue, type JsonObject, type JsonValue } from '../core/strict-json.ts';
import { eventContracts, type CanonicalAgentEvent } from '../routes/events.ts';
import type { AgentEventCanonicalIdentity } from '../routes/public.ts';
import type { AgentTerminal } from '../terminal-capability.ts';
import type { EventTracer } from './trace.ts';

export type EventHandlerResult<
  Data extends JsonValue = JsonValue,
  Event extends CanonicalAgentEvent = CanonicalAgentEvent,
> =
  | { readonly outcome: 'render'; readonly module: string; readonly data: Data }
  | ({ readonly outcome: 'continue'; readonly additionalContext?: string } &
      (Event extends 'tool/before' ? { readonly updatedInput?: JsonObject } : { readonly updatedInput?: never }))
  | { readonly outcome: 'deny'; readonly reason: string; readonly additionalContext?: string };

export interface EventHandlerContext<E extends CanonicalAgentEvent = CanonicalAgentEvent> {
  readonly render: (module: string, data: JsonValue) => Extract<EventHandlerResult, { outcome: 'render' }>;
  readonly canonical: AgentEventCanonicalIdentity<E>;
  readonly host: Readonly<{ readonly name: string; readonly nativeEvent: string }>;
  readonly signal: AbortSignal;
  readonly terminal: AgentTerminal;
  readonly native?: Readonly<Record<string, unknown>>;
}

export type EventHandler<
  E extends CanonicalAgentEvent = CanonicalAgentEvent,
  Data extends JsonValue = JsonValue,
> = (
  context: EventHandlerContext<E>,
) => EventHandlerResult<Data> | void | Promise<EventHandlerResult<Data> | void>;

type HandlerObjectOutcome = 'continue' | 'deny' | 'render';

const isHandlerObjectOutcome = (value: unknown): value is HandlerObjectOutcome =>
  value === 'continue' || value === 'deny' || value === 'render';

const unsupportedResult = (detail: string): never => {
  throw new TypeError(`Event handler result ${detail}`);
};

const unexpectedFields = (record: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Event handler result has unsupported field ${JSON.stringify(key)}.`);
    }
  }
};

const handlerContext = (value: Readonly<Record<string, unknown>>): { readonly additionalContext?: string } => {
  if (value.additionalContext === undefined) return {};
  if (typeof value.additionalContext !== 'string') {
    throw new TypeError('Event handler additionalContext must be a string.');
  }
  return { additionalContext: value.additionalContext };
};

/**
 * Validates a runtime handler return into {@link EventHandlerResult}.
 * Unknown outcomes, extra fields, an empty denial reason, and deny on a
 * family that cannot deny fail closed.
 */
export const validateEventHandlerResult = (
  value: unknown,
  event: CanonicalAgentEvent,
  view?: string,
): EventHandlerResult => {
  if (value === undefined) return Object.freeze({ outcome: 'continue' });
  if (!isRecord(value)) {
    return unsupportedResult('must be void or a render/continue/deny object.');
  }
  const outcome = value.outcome;
  if (!isHandlerObjectOutcome(outcome)) {
    return unsupportedResult(`outcome ${JSON.stringify(outcome)} is not supported.`);
  }
  switch (outcome) {
    case 'render':
      unexpectedFields(value, new Set(['outcome', 'module', 'data']));
      if (view === undefined || value.module !== view) throw new TypeError('ctx.render() must name the event handler’s sibling .view.js module.');
      return Object.freeze({ data: snapshotStrictJsonValue(value.data), module: view, outcome: 'render' });
    case 'continue': {
      unexpectedFields(value, new Set(['outcome', 'updatedInput', 'additionalContext']));
      const updatedInput = value.updatedInput === undefined ? undefined : snapshotStrictJsonValue(value.updatedInput);
      if (updatedInput !== undefined && (event !== 'tool/before' || !isJsonRecord(updatedInput))) {
        throw new TypeError('Event handler updatedInput must be an object on tool/before.');
      }
      return Object.freeze({
        outcome: 'continue',
        ...(updatedInput === undefined ? {} : { updatedInput }),
        ...handlerContext(value),
      });
    }
    case 'deny': {
      unexpectedFields(value, new Set(['outcome', 'reason', 'additionalContext']));
      if (!eventContracts[event].deny) {
        throw new TypeError(`${event} cannot deny from handler.`);
      }
      if (typeof value.reason !== 'string' || value.reason.trim() === '') {
        throw new TypeError(`${event} requires a nonempty reason when outcome is deny.`);
      }
      return Object.freeze({ outcome: 'deny', reason: value.reason, ...handlerContext(value) });
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
export const executeEventHandler = async <
  E extends CanonicalAgentEvent,
  Data extends JsonValue = JsonValue,
>(
  handler: EventHandler<E, Data>,
  context: Omit<EventHandlerContext<E>, 'render'>,
  trace?: EventTracer,
  view?: string,
): Promise<EventHandlerResult<Data>> => {
  trace?.handlerStart();
  try {
    context.signal.throwIfAborted();
    const frozenContext = Object.freeze({
      render: (module: string, data: JsonValue) => ({ outcome: 'render' as const, module, data }),
      canonical: context.canonical,
      host: Object.freeze({ ...context.host }),
      signal: context.signal,
      terminal: context.terminal,
      ...(context.native === undefined ? {} : { native: context.native }),
    });
    const value = await settleBeforeAbort(Promise.resolve().then(() => handler(frozenContext)), context.signal);
    context.signal.throwIfAborted();
    const result = validateEventHandlerResult(value, context.canonical.event, view) as EventHandlerResult<Data>;
    trace?.handlerOutcome(result);
    return result;
  } catch (error) {
    trace?.failure('handler', error);
    throw error;
  }
};
