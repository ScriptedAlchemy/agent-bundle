import { rmSync } from 'node:fs';
import { rm as removeDirectory } from 'node:fs/promises';

const nodeRetryCodes = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
const maxRetries = 5;
const retryDelay = 50;

export type TreeRemoval = {
  readonly rm: (path: string, options: { readonly force: true; readonly recursive: true }) => Promise<void>;
};

export type SyncTreeRemoval = (path: string, options: { readonly force: true; readonly recursive: true }) => void;

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const delaySync = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

const isRetryable = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && nodeRetryCodes.has(code);
};

const defaultRemoval: TreeRemoval = {
  rm: (path, options) => removeDirectory(path, options),
};

export const removeTree = async (path: string, fs: TreeRemoval = defaultRemoval): Promise<void> => {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await fs.rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      if (attempt === maxRetries || !isRetryable(error)) throw error;
      await delay(retryDelay * (attempt + 1));
    }
  }
};

/** `removeTree` for callers that cannot await, such as `exit` handlers. */
export const removeTreeSync = (path: string, remove: SyncTreeRemoval = rmSync): void => {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      remove(path, { force: true, recursive: true });
      return;
    } catch (error) {
      if (attempt === maxRetries || !isRetryable(error)) throw error;
      delaySync(retryDelay * (attempt + 1));
    }
  }
};
