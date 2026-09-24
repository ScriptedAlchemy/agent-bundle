import { rm as removeDirectory } from 'node:fs/promises';

const nodeRetryCodes = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
const maxRetries = 5;
const retryDelay = 50;

export type TreeRemoval = {
  readonly rm: (path: string, options: { readonly force: true; readonly recursive: true }) => Promise<void>;
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const defaultRemoval: TreeRemoval = {
  rm: (path, options) => removeDirectory(path, options),
};

export const removeTree = async (path: string, fs: TreeRemoval = defaultRemoval): Promise<void> => {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await fs.rm(path, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (attempt === maxRetries || typeof code !== 'string' || !nodeRetryCodes.has(code)) throw error;
      await delay(retryDelay * (attempt + 1));
    }
  }
};
