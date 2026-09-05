/**
 * Settles with an operation or rejects immediately when its owning signal
 * aborts, without waiting for cooperative cancellation inside the operation.
 */
export const settleBeforeAbort = <Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
  reason: () => unknown = () => signal.reason,
): Promise<Value> => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (outcome: () => void): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    outcome();
  };
  const onAbort = (): void => finish(() => reject(reason()));
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  void operation.then(
    (value) => finish(() => resolve(value)),
    (error: unknown) => finish(() => reject(error)),
  );
});
