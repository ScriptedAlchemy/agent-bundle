export interface SerialQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

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
