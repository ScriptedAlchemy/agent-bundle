import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const sha256File = async (path: string): Promise<string> => sha256Hex(await readFile(path));

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const serializeJson = (value: unknown, key = ''): string | undefined => {
  if (value !== null && typeof value === 'object') {
    const toJson = (value as { toJSON?: unknown }).toJSON;

    if (typeof toJson === 'function') {
      return serializeJson(toJson.call(value, key), key);
    }

    if (
      value instanceof Boolean ||
      value instanceof Number ||
      value instanceof String
    ) {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      const items = Array.from({ length: value.length }, (_, index) =>
        serializeJson(value[index], String(index)) ?? 'null',
      );
      return `[${items.join(',')}]`;
    }

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    const orderedKeys = isPlainObject(object) ? keys.sort() : keys;
    const entries = orderedKeys.flatMap((objectKey) => {
      const serialized = serializeJson(object[objectKey], objectKey);
      return serialized === undefined
        ? []
        : [`${JSON.stringify(objectKey)}:${serialized}`];
    });

    return `{${entries.join(',')}}`;
  }

  const serialized = JSON.stringify(value);
  return typeof serialized === 'string' ? serialized : undefined;
};

export const stableJson = (value: unknown): string => {
  const serialized = serializeJson(value);

  if (serialized === undefined) {
    throw new TypeError('Cannot serialize a top-level non-JSON value.');
  }

  return serialized;
};

export const digest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex');
