/**
 * JSON-safety and canonicalization helpers for the state kernel (#98).
 *
 * Persisted state, event payloads, and reset seeds must round-trip through
 * JSON deterministically: drivers store canonical text, and idempotency-key
 * replay compares canonical forms. Keys are sorted so two structurally equal
 * values always canonicalize to the same bytes.
 */

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const isJsonSafe = (value: unknown): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    // Index-by-index so holes fail closed: `every` skips holes, which would
    // let a sparse array canonicalize to the same text as a denser one and
    // break both round-tripping and idempotency-key comparison.
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || !isJsonSafe(value[index])) return false;
    }
    return true;
  }
  return isPlainObject(value) && Object.values(value).every(isJsonSafe);
};

/** Deterministic JSON text with sorted object keys; callers must check {@link isJsonSafe} first. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
};

/** Recursively freezes JSON-safe data in place and returns it. */
export const deepFreezeJson = <T>(value: T): T => {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) deepFreezeJson(nested);
    return Object.freeze(value) as T;
  }
  return value;
};
