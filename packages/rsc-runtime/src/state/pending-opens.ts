/**
 * Tracks in-flight driver `open()` promises so `close()` can wait for every
 * pending open — including ones that start while it waits — to settle before
 * tearing down the stores they may have created.
 */
export interface PendingOpenTracker {
  readonly track: <T>(operation: Promise<T>) => Promise<T>;
  readonly settle: () => Promise<void>;
}

export const createPendingOpenTracker = (): PendingOpenTracker => {
  const pending = new Set<Promise<void>>();
  return Object.freeze({
    track<T>(operation: Promise<T>): Promise<T> {
      const settled = operation.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => {
        pending.delete(settled);
      });
      return operation;
    },
    async settle(): Promise<void> {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  });
};
