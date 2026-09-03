import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const conventionalEntryExtensions = ['.ts', '.tsx'] as const;

/**
 * Probe for a conventional entry source file. A leaf module so both
 * config/normalize.ts and routes/graph.ts can share one rule without closing
 * the discover.ts -> routes/graph.ts -> normalize.ts -> discover.ts cycle.
 */
export const conventionalEntryAt = (root: string, ...segments: string[]): string | undefined => {
  const stem = resolve(root, ...segments);
  for (const extension of conventionalEntryExtensions) {
    const candidate = `${stem}${extension}`;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // A racing deletion means the convention does not apply.
    }
  }
  return undefined;
};
