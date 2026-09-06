import { createCanonicalEventProps, validateNativeEventEnvelope } from '../events/project.ts';
import type { JsonValue } from '../core/strict-json.ts';
import type { AgentEventCanonicalIdentity, AgentEventNativePayload, CanonicalAgentEvent } from '../routes/public.ts';
import { AgentTestError, captured } from './errors.ts';

export interface CreateEventRouteInputOptions {
  /** The host the envelope came from; selects the canonical payload mapping and the validator. */
  readonly host: 'claude' | 'codex' | 'cursor' | (string & {});
  /**
   * The pinned host contract revision recorded in `canonical.provenance`.
   * A route-unit test rarely depends on it; defaults to `'route-unit'`.
   */
  readonly hostContractRevision?: string;
  /** The host-native event name; defaults to the envelope's own `hook_event_name`. */
  readonly nativeEvent?: string;
  /**
   * Validate the envelope with the same per-host, per-event rules the
   * generated wrapper applies before it reaches a route (default `true`).
   * Pass `false` to hand a route a deliberately partial envelope.
   */
  readonly validate?: boolean;
}

/** The `{ canonical, native, preflight? }` half of `AgentEventRouteProps<E>`; the harness supplies `signal`. */
export interface AgentEventRouteInput<E extends CanonicalAgentEvent = CanonicalAgentEvent> {
  readonly canonical: AgentEventCanonicalIdentity<E>;
  readonly native: AgentEventNativePayload;
  readonly preflight?: JsonValue;
}

/**
 * Builds the `renderRoute` input of an event route from one host-native
 * envelope, exactly as the generated wrapper does: the envelope is validated
 * per host and event, frozen as `native`, and projected into the family's
 * canonical `payload` through the same table the artifact uses (#466). A
 * route test therefore reads `canonical.payload.toolName` from a real Claude,
 * Codex, or Cursor fixture instead of hand-writing the identity.
 *
 * ```ts
 * const rendered = await renderRoute('event:tool/after', {
 *   input: createEventRouteInput('tool/after', claudeFixture, { host: 'claude' }),
 * });
 * ```
 */
export const createEventRouteInput = <E extends CanonicalAgentEvent>(
  event: E,
  native: Readonly<Record<string, unknown>>,
  options: CreateEventRouteInputOptions,
): AgentEventRouteInput<E> => {
  const nativeEvent = options.nativeEvent ?? native.hook_event_name;
  if (typeof nativeEvent !== 'string' || nativeEvent.trim() === '') {
    throw new AgentTestError('invalid-input', 'An event-route input needs the host-native event name.', {
      details: [
        `event:        ${event}`,
        `received:     ${captured(native.hook_event_name)}`,
      ],
      recovery: 'Put hook_event_name on the envelope, as every host does, or pass options.nativeEvent.',
    });
  }
  const validated = options.validate === false
    ? native
    : validateNativeEventEnvelope(native, { canonicalEvent: event, nativeEvent, target: options.host });
  const props = createCanonicalEventProps(
    event,
    validated,
    options.host,
    nativeEvent,
    options.hostContractRevision ?? 'route-unit',
    new AbortController().signal,
  );
  return Object.freeze({ canonical: props.canonical, native: props.native });
};
