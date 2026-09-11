import { existsSync, readFileSync } from 'node:fs';

import { scanRouteModuleExports, validateEventRouteModuleContract } from './contract.ts';
import type { CompiledEventHandler } from './types.ts';

/** Handler and view files are separate compiler entries; user code is never extracted. */
export const eventHandlerEntry = (
  text: string,
  relativePath: string,
  sourcePath: string,
): CompiledEventHandler | undefined => {
  const { named, definition } = scanRouteModuleExports(text, relativePath);
  if (definition?.event !== undefined) {
    const expected = relativePath.match(/(?:^|\/)src\/events\/(.+)\.tsx?$/u)?.[1];
    if (expected !== definition.event) throw new TypeError(`Event definition ${definition.event} disagrees with conventional path ${relativePath}.`);
  }
  if (named.has('preflight') || named.has('before')) {
    throw new TypeError(`Event ${relativePath} must use a .ts handler and ctx.render('./${relativePath.split('/').at(-1)!.replace(/\.tsx?$/u, '.view.js')}', data); before/preflight exports are no longer supported.`);
  }
  if (!relativePath.endsWith('.ts')) return undefined;
  const view = sourcePath.replace(/\.ts$/u, '.view.tsx');
  const hasView = existsSync(view);
  if (hasView) {
    const viewText = readFileSync(view, 'utf8');
    const viewExports = scanRouteModuleExports(viewText, view).named;
    if (viewExports.has('config') || viewExports.has('preflight') || viewExports.has('before')) {
      throw new TypeError(`Keep event configuration and control flow in ${relativePath}; ${view} only renders JSX.`);
    }
    const diagnostics = validateEventRouteModuleContract(viewText, relativePath.replace(/\.ts$/u, '.view.tsx'), view);
    if (diagnostics.length !== 0) throw new TypeError(diagnostics.map((item) => item.message).join('\n'));
  }
  return {
    provenance: { kind: 'conventional', relativePath },
    source: sourcePath,
    ...(hasView ? { view } : {}),
  };
};
