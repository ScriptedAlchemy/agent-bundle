import { AsyncLocalStorage } from 'node:async_hooks';

export interface RscRequestContext<T> {
  run<TResult>(value: T, operation: () => TResult): TResult;
  use(): T;
}

export const createRscRequestContext = <T>(label: string): Readonly<RscRequestContext<T>> => {
  const storage = new AsyncLocalStorage<T>();
  return Object.freeze({
    run<TResult>(value: T, operation: () => TResult): TResult {
      return storage.run(value, operation);
    },
    use(): T {
      const value = storage.getStore();
      if (value === undefined) {
        throw new Error(`${label} used outside a render request`);
      }
      return value;
    },
  });
};
