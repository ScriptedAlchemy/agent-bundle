/**
 * Shared reader for the stores' symbol-keyed durability test seams.
 *
 * Each filesystem-backed store publishes a `Symbol.for` key (the key strings
 * are part of the test contract in tests/support/durability.ts and must not
 * change). A hook installed at that key on `globalThis` is visible only while
 * the process explicitly runs with NODE_ENV=test; outside test mode the seam
 * reads as absent, so production behavior cannot be altered through it.
 */
export const testModeGlobalValue = <Value>(key: symbol): Value | undefined => {
  if (process.env.NODE_ENV !== 'test') return undefined;
  const globals = globalThis as typeof globalThis & Record<symbol, Value | undefined>;
  return globals[key];
};
