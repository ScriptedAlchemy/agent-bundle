import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/**
 * The framework's own copy of the built page script. The package build emits
 * `web-host/browser/main.ts` as `dist/web-host/page.js` (an Rsbuild web
 * build, inline-safe); framework hosts (`agent-bundle serve-app`) read it
 * from there, while a generated bin inlines the same bytes as a string
 * through a virtual module and never reaches this module.
 */

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

/**
 * The built page script's bytes, read once and cached for the process. A
 * package built without it (a source checkout before `pnpm build`, or a build
 * that skipped the web host page) fails with the path it looked in; the miss
 * is not cached, so a later build is picked up.
 */
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
