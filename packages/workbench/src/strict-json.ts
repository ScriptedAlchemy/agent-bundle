export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export type StrictJsonReason = 'nonfinite' | 'not-json' | 'cyclic' | 'exotic-prototype' | 'array-shape';

export class StrictJsonError extends Error {
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
      if (Reflect.ownKeys(descriptors).some((key) =>
        key !== 'length' && (
          typeof key !== 'string' ||
          !/^(?:0|[1-9]\d*)$/u.test(key) ||
          Number(key) >= length.value
        ))) {
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

export const mapStrictJsonReason = <Result>(
  error: unknown,
  messages: Readonly<Record<StrictJsonReason, Result>>,
): Result => {
  if (error instanceof StrictJsonError) return messages[error.reason];
  throw error;
};
