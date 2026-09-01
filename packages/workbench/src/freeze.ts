const isPlainObjectOrArray = (value: object): boolean => {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Freezes a value tree in place; cycle-safe and symbol-aware. Freezing is idempotent. */
export const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  if (!isPlainObjectOrArray(value)) return value;
  seen.add(value);
  for (const property of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, property), seen);
  }
  return Object.freeze(value);
};
