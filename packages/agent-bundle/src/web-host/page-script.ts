import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

// Rslib bundles this module into a chunk at the dist root, while source-level
// consumers (tests) run it from src/web-host. Spelled as paths, not
// `new URL(…, import.meta.url)`: the package's own Rslib build would read a
// static URL as an asset to emit. The same rule dev/workbench-assets.ts uses
// to find dist/workbench.
const packageRoot = basename(import.meta.dirname) === 'dist'
  ? resolve(import.meta.dirname, '..')
  : resolve(import.meta.dirname, '../..');

const pageScriptPath = resolve(packageRoot, 'dist', 'web-host', 'page.js');

let pageScript: Promise<string> | undefined;

/** Cache successful reads only, so a later build repairs an initial miss. */
export const readWebHostPageScript = (): Promise<string> => {
  pageScript ??= readFile(pageScriptPath, 'utf8').catch((error: unknown) => {
    pageScript = undefined;
    throw new Error(
      `agent-bundle was built without its web host page (${pageScriptPath}); run pnpm build.`,
      { cause: error },
    );
  });
  return pageScript;
};
