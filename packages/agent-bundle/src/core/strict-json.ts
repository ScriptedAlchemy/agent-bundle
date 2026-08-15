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

/** Parses JSON only after rejecting duplicate object keys at every depth. */
export const parseJsonWithoutDuplicateKeys = (bytes: string): unknown => {
  const end = skipWhitespace(bytes, scanJsonValue(bytes, 0));
  if (end !== bytes.length) throw new SyntaxError('JSON has trailing data.');
  return JSON.parse(bytes) as unknown;
};
