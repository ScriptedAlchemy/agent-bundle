/**
 * Rejects if `promise` has not settled within `milliseconds`.
 *
 * The timer is always cleared: leaving it armed keeps the event loop alive for
 * the full timeout after the promise settles, which stalls suite shutdown.
 */
export const within = async <Value>(promise: Promise<Value>, milliseconds = 1_000): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolvePromise, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error(`Timed out after ${milliseconds}ms.`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

/** Polls a synchronous predicate until it holds or the timeout elapses. */
export const eventually = async (predicate: () => boolean, milliseconds = 250): Promise<void> => {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${milliseconds}ms.`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
};

/** Retries an assertion until it stops throwing, rethrowing its last failure once attempts are exhausted. */
export const eventuallyPasses = async (
  assertion: () => Promise<void> | void,
  options: Readonly<{ readonly attempts: number; readonly delayMs: number }>,
): Promise<void> => {
  let failure: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, options.delayMs); });
    }
  }
  throw failure;
};
