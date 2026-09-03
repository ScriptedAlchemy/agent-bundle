export interface SerialQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));

export const mapConcurrent = async <T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> => {
  if (items.length === 0) return;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await operation(items[index]!);
    }
  }));
};

/** Runs operations one at a time in submission order; a rejected operation does not stall later ones. */
export const serialQueue = (): SerialQueue => {
  let tail: Promise<void> = Promise.resolve();
  return Object.freeze({
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  });
};
