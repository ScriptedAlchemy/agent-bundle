import { createHash } from 'node:crypto';

import type { JsonValue } from 'agent-bundle';

/**
 * Key-sorted, undefined-skipping canonical JSON used for runtime metadata
 * digests. Throws on non-finite numbers and non-JSON values so digests can
 * never silently diverge between writers.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime metadata contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError('Runtime metadata is not JSON serializable.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().flatMap((key) => {
    const item = record[key];
    return item === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(item)}`];
  }).join(',')}}`;
};

export const digestValue = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * Deep-frozen, undefined-skipping JSON copy of `value` in its original key
 * order; rejects the same non-JSON values as `canonicalJson` plus cycles.
 */
export const freezeJson = (value: unknown, seen = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime metadata contains a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Runtime metadata is not JSON serializable.');
  if (seen.has(value)) throw new TypeError('Runtime metadata cannot contain cyclic values.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item, seen)));
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input)) {
      const item = input[key];
      if (item !== undefined) output[key] = freezeJson(item, seen);
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
};
