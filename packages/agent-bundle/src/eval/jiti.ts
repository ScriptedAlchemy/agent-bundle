import type { Jiti } from 'jiti';

/**
 * The one place the vendored Jiti runtime is loaded. The dynamic import is the
 * documented exception to top-of-module imports: only commands that execute
 * authored TypeScript modules pay for the loader, and everything else never
 * touches it.
 */
export const loadJiti = async (): Promise<Jiti> => {
  const { createJiti } = await import('jiti');
  return createJiti(import.meta.url, { moduleCache: false });
};
