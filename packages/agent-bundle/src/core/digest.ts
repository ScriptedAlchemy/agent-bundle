import { createHash } from 'node:crypto';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const sortPlainObjectKeys = (_key: string, value: unknown): unknown => {
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
};

export const stableJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, sortPlainObjectKeys);

  if (serialized === undefined) {
    throw new TypeError('Cannot serialize a top-level non-JSON value.');
  }

  return serialized;
};

export const digest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');
