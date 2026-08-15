const skipWhitespace = (bytes: string, index: number): number => {
  let cursor = index;
  while (/\s/u.test(bytes[cursor] ?? '')) cursor += 1;
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
  while (cursor < bytes.length && !/[\s,}\]]/u.test(bytes[cursor]!)) cursor += 1;
  return cursor;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
      return values;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must be plain objects.');
    }
    return Object.fromEntries(Reflect.ownKeys(descriptors).map((key) => {
      if (typeof key !== 'string') throw new TypeError('JSON objects must not use symbol keys.');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('JSON objects must contain only enumerable data properties.');
      }
      return [key, snapshotJsonValue(descriptor.value, ancestors)];
    }));
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
