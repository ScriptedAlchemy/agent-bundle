import type { JsonValue } from '../core/strict-json.ts';
import {
  agentEventPayloadFieldKinds,
  agentEventPayloadFields,
  agentEventPayloadNativeKeys,
  isAgentEventPayloadHost,
  type AgentEventPayload,
  type AgentEventPayloadField,
  type AgentEventPayloadFieldKind,
  type AgentEventPayloadFieldName,
  type AgentEventPayloadNativeKey,
  type CanonicalAgentEvent,
} from '../routes/events.ts';

const isJsonValue = (value: unknown): value is JsonValue => {
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return true;
    case 'object':
      if (value === null) return true;
      if (Array.isArray(value)) return value.every(isJsonValue);
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
};

/** Reads one native value as the field's declared JSON shape; `undefined` when the host sent another shape. */
const decodeKind = (kind: AgentEventPayloadFieldKind, value: unknown): unknown => {
  switch (kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'json':
      return isJsonValue(value) ? value : undefined;
    case 'nullable-string':
      return value === null || typeof value === 'string' ? value : undefined;
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'string-array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined;
    case 'trigger':
      return value === 'manual' || value === 'auto' ? value : undefined;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

/** Applies the host-specific transformation named by the mapping, then the field's shape check. */
const decodeNative = (
  field: AgentEventPayloadFieldName,
  mapping: AgentEventPayloadNativeKey,
  raw: unknown,
): unknown => {
  const kind = agentEventPayloadFieldKinds[field];
  switch (mapping.decode) {
    case 'json-string': {
      if (typeof raw !== 'string') return undefined;
      // Cursor documents tool_output as a JSON-stringified record; a payload
      // that is not valid JSON is still what the host said, so it stays a string.
      try {
        return decodeKind(kind, JSON.parse(raw));
      } catch {
        return raw;
      }
    }
    case 'positive-count':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw > 0 : undefined;
    case undefined:
      return decodeKind(kind, raw);
    default: {
      const exhaustive: never = mapping.decode;
      return exhaustive;
    }
  }
};

/**
 * Projects a validated native envelope into the canonical payload of its
 * family, reading each admitted field through the host's own key from
 * {@link agentEventPayloadNativeKeys}. A field the host did not send — or
 * sent in another shape — is omitted rather than fabricated; a host without a
 * mapping table (the portable target, an unknown host) yields an empty
 * payload and the route still has `native`.
 */
export const projectEventPayload = <E extends CanonicalAgentEvent>(
  event: E,
  native: Readonly<Record<string, unknown>>,
  target: string,
): AgentEventPayload<E> => {
  const payload: Record<string, AgentEventPayloadField<unknown>> = {};
  const mappings = isAgentEventPayloadHost(target) ? agentEventPayloadNativeKeys[target][event] : undefined;
  if (mappings !== undefined) {
    for (const field of agentEventPayloadFields[event]) {
      const mapping = mappings[field];
      if (mapping === undefined || !Object.hasOwn(native, mapping.nativeKey)) continue;
      const value = decodeNative(field, mapping, native[mapping.nativeKey]);
      if (value === undefined) continue;
      // Values are shared with the frozen `native` snapshot and keep its depth of
      // freezing; only the payload's own records are frozen here.
      payload[field] = Object.freeze({ nativeKey: mapping.nativeKey, value });
    }
  }
  return Object.freeze(payload) as AgentEventPayload<E>;
};
