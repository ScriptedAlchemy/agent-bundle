import type {
  PlaygroundJsonObject,
  PlaygroundJsonValue,
} from '../../../agent-bundle/src/services/playground-service.ts';

/**
 * Only plain objects qualify. A Date or class instance has no own enumerable
 * entries, so a looser check would silently record it as an empty object.
 */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
};

/**
 * Trace payloads arrive as decoded JSON but carry nominal service types, so a
 * producer must prove a value is JSON rather than assert it. Frozen structural
 * copies also keep a recorded event independent of the view that produced it.
 */
export const playgroundJsonValue = (value: unknown): PlaygroundJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Playground trace values must be finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(value.map(playgroundJsonValue));
  if (!isRecord(value)) throw new TypeError('Playground trace values must be JSON-compatible.');
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, playgroundJsonValue(entry)]),
  )) as PlaygroundJsonObject;
};

export const playgroundJsonObject = (value: unknown): PlaygroundJsonObject => {
  if (!isRecord(value)) throw new TypeError('Playground trace payloads must be JSON objects.');
  return playgroundJsonValue(value) as PlaygroundJsonObject;
};
