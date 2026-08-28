import { serializeRuntimeDefinition } from '../build/serialize-definition.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

const canonicalize = (value: unknown): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Runtime definition must contain finite JSON numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object') throw new TypeError('Runtime definition must be JSON serializable.');

  const input = value as Record<string, unknown>;
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(input).sort()) {
    const item = input[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
};

process.stdout.write(`${JSON.stringify(canonicalize(serializeRuntimeDefinition()))}\n`);
