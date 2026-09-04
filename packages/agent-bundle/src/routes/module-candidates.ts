import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

/**
 * How one relative specifier's extension maps onto the TypeScript sources it
 * may name, in resolution order: the emitted extension probes its source
 * first, then the emitted file itself.
 */
const moduleExtensions: Readonly<Record<string, readonly string[]>> = {
  '.cjs': ['.cts', '.cjs'],
  '.cts': ['.cts'],
  '.js': ['.ts', '.tsx', '.js'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.mts': ['.mts'],
  '.ts': ['.ts'],
  '.tsx': ['.tsx'],
};

/**
 * The on-disk candidates one relative specifier may name, in TypeScript
 * resolution order: an explicit `.ts`/`.tsx` extension is exact, a `.js`-style
 * extension maps onto its TypeScript source, and an extensionless specifier
 * probes `.ts`, `.tsx`, and an index module. Shared by every static scan that
 * follows a route module's relative imports or re-exports without evaluating
 * it, so they all agree on which file a specifier names.
 */
export const moduleCandidates = (fromDirectory: string, specifier: string): readonly string[] => {
  const base = resolve(fromDirectory, specifier);
  const extension = extname(specifier).toLowerCase();
  const mapped = moduleExtensions[extension];
  if (mapped !== undefined) {
    const stem = base.slice(0, -extension.length);
    return mapped.map((candidate) => `${stem}${candidate}`);
  }
  return [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')];
};

/** True for a specifier that names a module by path relative to the importing module. */
export const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../');

/** Reads one candidate module's text; undefined when missing, unreadable, or a directory. */
export const readModuleFromDisk = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};
