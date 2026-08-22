// Evaluated and rejected libraries for this primitive: lossless-json only
// reports duplicate keys whose values differ (deep-equal duplicates parse
// silently), and json-bigint's strict mode is unmaintained. The contract here
// is stricter: any repeated key at any depth is an error.
// JSON whitespace is exactly tab, line feed, carriage return, and space; the
// trailing JSON.parse still rejects any other separator this scan passes over.
const isJsonWhitespace = (code: number): boolean =>
  code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20;

const isValueTerminator = (code: number): boolean =>
  isJsonWhitespace(code) || code === 0x2c || code === 0x7d || code === 0x5d;

const skipWhitespace = (bytes: string, index: number): number => {
  let cursor = index;
  while (cursor < bytes.length && isJsonWhitespace(bytes.charCodeAt(cursor))) cursor += 1;
  return cursor;
};

const scanJsonString = (bytes: string, index: number): readonly [string, number] => {
  let cursor = index + 1;
  while (cursor < bytes.length) {
    const character = bytes[cursor]!;
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '"') {
      const end = cursor + 1;
      return [JSON.parse(bytes.slice(index, end)) as string, end];
    }
    cursor += 1;
  }
  throw new SyntaxError('JSON has an unterminated string.');
};

const scanJsonValue = (bytes: string, index: number): number => {
  let cursor = skipWhitespace(bytes, index);
  const character = bytes[cursor];
  if (character === '{') {
    cursor = skipWhitespace(bytes, cursor + 1);
    const keys = new Set<string>();
    if (bytes[cursor] === '}') return cursor + 1;
    while (true) {
      if (bytes[cursor] !== '"') throw new SyntaxError('JSON has an invalid object key.');
      const [key, afterKey] = scanJsonString(bytes, cursor);
      if (keys.has(key)) throw new SyntaxError(`JSON has duplicate key ${JSON.stringify(key)}.`);
      keys.add(key);
      cursor = skipWhitespace(bytes, afterKey);
      if (bytes[cursor] !== ':') throw new SyntaxError('JSON has an invalid object entry.');
      cursor = skipWhitespace(bytes, scanJsonValue(bytes, cursor + 1));
      if (bytes[cursor] === '}') return cursor + 1;
      if (bytes[cursor] !== ',') throw new SyntaxError('JSON has an invalid object separator.');
      cursor = skipWhitespace(bytes, cursor + 1);
    }
  }
  if (character === '[') {
    cursor = skipWhitespace(bytes, cursor + 1);
    if (bytes[cursor] === ']') return cursor + 1;
    while (true) {
      cursor = skipWhitespace(bytes, scanJsonValue(bytes, cursor));
      if (bytes[cursor] === ']') return cursor + 1;
      if (bytes[cursor] !== ',') throw new SyntaxError('JSON has an invalid array separator.');
      cursor = skipWhitespace(bytes, cursor + 1);
    }
  }
  if (character === '"') return scanJsonString(bytes, cursor)[1];
  while (cursor < bytes.length && !isValueTerminator(bytes.charCodeAt(cursor))) cursor += 1;
  return cursor;
};

interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface OwnDataValue {
  readonly found: boolean;
  readonly value: unknown;
}

/** Non-null, non-array object guard shared across route, service, and client decoding. */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `isRecord` narrowed for values already known to be JSON. */
export const isJsonRecord = (value: JsonValue): value is Readonly<Record<string, JsonValue>> => isRecord(value);

/** Reads an own data property without invoking an accessor. */
export const ownDataValue = (value: object, key: string): OwnDataValue | undefined => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return { found: false, value: undefined };
  return 'value' in descriptor ? { found: true, value: descriptor.value } : undefined;
};

/** Copies a canonical array's own data elements without invoking accessors. */
export const dataArrayValues = (value: unknown): readonly unknown[] | undefined => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    length === undefined || !('value' in length) ||
    typeof length.value !== 'number' || !Number.isSafeInteger(length.value) || length.value < 0 ||
    Reflect.ownKeys(value).length !== length.value + 1
  ) {
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
};

const snapshotJsonValue = (value: unknown, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError('JSON values must be finite.');
  }
  if (typeof value !== 'object') throw new TypeError('JSON values must be primitives, arrays, or plain objects.');
  if (ancestors.has(value)) throw new TypeError('JSON values must not be cyclic.');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length = descriptors.length;
      if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
        throw new TypeError('JSON arrays must have a finite length.');
      }
      const values: JsonValue[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('JSON arrays must contain only enumerable data properties.');
        }
        values.push(snapshotJsonValue(descriptor.value, ancestors));
      }
      if (Reflect.ownKeys(descriptors).some((key) =>
        key !== 'length' && (
          typeof key !== 'string' ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= length.value
        ))) {
        throw new TypeError('JSON arrays must not have extra properties.');
      }
      return Object.freeze(values);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must be plain objects.');
    }
    const snapshot = Object.fromEntries(Reflect.ownKeys(descriptors).map((key) => {
      if (typeof key !== 'string') throw new TypeError('JSON objects must not use symbol keys.');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('JSON objects must contain only enumerable data properties.');
      }
      return [key, snapshotJsonValue(descriptor.value, ancestors)];
    }));
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
};

/** Detaches a finite JSON value without evaluating accessors or retaining hostile prototypes. */
export const snapshotStrictJsonValue = (value: unknown): JsonValue => snapshotJsonValue(value, new Set<object>());

/** Parses JSON only after rejecting duplicate object keys at every depth. */
export const parseJsonWithoutDuplicateKeys = (bytes: string): unknown => {
  const end = skipWhitespace(bytes, scanJsonValue(bytes, 0));
  if (end !== bytes.length) throw new SyntaxError('JSON has trailing data.');
  return JSON.parse(bytes) as unknown;
};
