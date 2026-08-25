/**
 * Installs a value at a `Symbol.for` global key with NODE_ENV=test for the duration of one
 * operation, restoring both afterwards. This mirrors the src durability test-hook contract
 * without exporting the private src hook types.
 */
export const withGlobalDurabilityValue = async <Value, T>(
  key: symbol,
  value: Value,
  operation: () => Promise<T>,
): Promise<T> => {
  const globals = globalThis as typeof globalThis & Record<symbol, Value | undefined>;
  const previous = globals[key];
  const previousNodeEnvironment = process.env.NODE_ENV;
  globals[key] = value;
  process.env.NODE_ENV = 'test';
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete globals[key];
    else globals[key] = previous;
    if (previousNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnvironment;
  }
};

/** Test-local mirror of the private eval run-store durability hook signature. */
export type EvalRunStoreDurabilityTestHook = (
  phase: 'after-event-write' | 'before-event-open' | 'before-event-write',
  event: Readonly<{ readonly kind: string }>,
  path: string,
  journal: Readonly<{ close(): Promise<void>; writeFile(contents: string, options?: string): Promise<void> }> | undefined,
) => void | Promise<void>;

const evalRunStoreDurabilityTestHookKey = Symbol.for('agent-bundle.eval-run-store.durability-test-hook');

export const withEvalRunStoreDurabilityTestHook = <T>(
  hook: EvalRunStoreDurabilityTestHook,
  operation: () => Promise<T>,
): Promise<T> => withGlobalDurabilityValue(evalRunStoreDurabilityTestHookKey, hook, operation);
