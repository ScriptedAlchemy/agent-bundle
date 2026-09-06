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

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface OwnDataValue {
  readonly found: boolean;
  readonly value: unknown;
}

export type StrictJsonReason = 'nonfinite' | 'not-json' | 'cyclic' | 'exotic-prototype' | 'array-shape';

/** Extends TypeError so callers that only catch TypeError keep working. */
export class StrictJsonError extends TypeError {
  readonly reason: StrictJsonReason;

  constructor(reason: StrictJsonReason, message: string) {
    super(message);
    this.name = 'StrictJsonError';
    this.reason = reason;
  }
}

export interface SnapshotStrictJsonOptions {
  /** When true, objects are copied onto `Object.create(null)` so `__proto__` stays an own key. */
  readonly nullPrototype?: boolean;
}

export const mapStrictJsonReason = <Result>(
  error: unknown,
  messages: Readonly<Record<StrictJsonReason, Result>>,
): Result => {
  if (error instanceof StrictJsonError) return messages[error.reason];
  throw error;
};

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

/** Non-null, non-array object whose prototype is `Object.prototype` or `null`. */
export const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Exact own-key contract for records whose expected keys are unique constants. */
export const hasExactOwnKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

/** Every own key is allowed; missing keys are tolerated (subset contract). */
export const hasOnlyOwnKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

/** Plain object whose own properties are all string-keyed data properties (no accessors, no symbols). */
export const isPlainDataRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
};

/** `isPlainDataRecord` with an exact required/optional key contract for hostile-document decoding. */
export const hasDataKeys = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> => {
  if (!isPlainDataRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return Reflect.ownKeys(value).length >= required.length &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key));
};

const fail = (reason: StrictJsonReason, message: string): never => {
  throw new StrictJsonError(reason, message);
};

const snapshotJsonValue = (value: unknown, ancestors: Set<object>, nullPrototype: boolean): JsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    return fail('nonfinite', 'JSON values must be finite.');
  }
  if (typeof value !== 'object') return fail('not-json', 'JSON values must be primitives, arrays, or plain objects.');
  if (ancestors.has(value)) return fail('cyclic', 'JSON values must not be cyclic.');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return fail('array-shape', 'JSON arrays must be ordinary arrays.');
      }
      const length = descriptors.length;
      if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
        return fail('array-shape', 'JSON arrays must have a finite length.');
      }
      const values: JsonValue[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return fail('array-shape', 'JSON arrays must contain only enumerable data properties.');
        }
        values.push(snapshotJsonValue(descriptor.value, ancestors, nullPrototype));
      }
      // Indices 0..length-1 and `length` are all verified own keys, so any extra key inflates the count.
      if (Reflect.ownKeys(descriptors).length !== length.value + 1) {
        return fail('array-shape', 'JSON arrays must not have extra properties.');
      }
      return Object.freeze(values);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('exotic-prototype', 'JSON objects must be plain objects.');
    }
    const entries = Reflect.ownKeys(descriptors).map((key) => {
      if (typeof key !== 'string') return fail('not-json', 'JSON objects must not use symbol keys.');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return fail('not-json', 'JSON objects must contain only enumerable data properties.');
      }
      return [key, snapshotJsonValue(descriptor.value, ancestors, nullPrototype)] as const;
    });
    if (nullPrototype) {
      const snapshot = Object.create(null) as Record<string, JsonValue>;
      for (const [key, entry] of entries) snapshot[key] = entry;
      return Object.freeze(snapshot);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
};

/** Detaches a finite JSON value without evaluating accessors or retaining hostile prototypes. */
export const snapshotStrictJsonValue = (value: unknown, options: SnapshotStrictJsonOptions = {}): JsonValue =>
  snapshotJsonValue(value, new Set<object>(), options.nullPrototype === true);

/** Parses JSON only after rejecting duplicate object keys at every depth. */
export const parseJsonWithoutDuplicateKeys = (bytes: string): unknown => {
  const end = skipWhitespace(bytes, scanJsonValue(bytes, 0));
  if (end !== bytes.length) throw new SyntaxError('JSON has trailing data.');
  return JSON.parse(bytes) as unknown;
};
