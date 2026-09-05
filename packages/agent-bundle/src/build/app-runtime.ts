import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRuntimeSpecifier = 'agent-bundle/app';

/** Resolves the browser runtime from source and from the packed compiler. */
export const appRuntimePath = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'app.js'),
    join(here, '..', '..', 'dist', 'app.js'),
    join(here, '..', 'app', 'index.ts'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Unable to locate the compiler-owned MCP App client runtime.');
};
