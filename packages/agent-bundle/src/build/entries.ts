import { extname, resolve } from 'node:path';

import type { NormalizedScript } from '../core/types.ts';
import { resolveArtifactDestination } from './emit.ts';
import { buildWithRslib } from './rslib.ts';

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly source: string;
}

const outputName = (script: NormalizedScript): string => {
  const extension = extname(script.name);
  return extension.length > 0 ? script.name.slice(0, -extension.length) : script.name;
};

export const planCompiledEntries = (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): readonly CompiledEntry[] => {
  const names = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const name = outputName(script);
    if (name.length === 0 || names.has(name)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${name}.mjs`)}.`);
    }
    names.add(name);
    return {
      name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        `${name}.mjs`,
      ),
      source: script.source,
    };
  }).map((entry) => Object.freeze(entry)));
};

export const compileEntries = async (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledEntry[]> => {
  const compiled = planCompiledEntries(entries, options);

  await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map(({ name, source }) => ({ name, source })),
    outputRoot: options.outDir,
  });

  return compiled;
};
