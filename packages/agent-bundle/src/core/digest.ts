import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { isPlainRecord } from './strict-json.ts';

export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const sha256File = async (path: string): Promise<string> => sha256Hex(await readFile(path));

/**
 * Values remembered by the digest of the bytes they were computed from, at
 * most `limit` of them: when the cache is full, a new key evicts the oldest
 * entry (insertion order; re-setting a known key neither grows the cache nor
 * evicts). Within one process the same emitted bundle is read by several
 * passes whose bytes never change between them — the post-compile
 * self-containment check, then artifact validation before and after the
 * manifest is written — so a scan of a multi-megabyte module runs once and
 * the digest of the bytes just read, not of an earlier inspection, is what
 * says whether the remembered value still applies.
 */
export class DigestCache<T> {
  readonly #entries = new Map<string, T>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  set(key: string, value: T): void {
    if (this.#entries.size >= this.#limit && !this.#entries.has(key)) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, value);
  }
}

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
    const orderedKeys = isPlainRecord(object) ? keys.sort() : keys;
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
