import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { isErrno } from './errors.ts';
import { exists } from './paths.ts';

/**
 * The manifest of dependency `name` as Node resolves it from `packageRoot`,
 * which honours hoisting: npm, Yarn, and pnpm with a hoist pattern place a
 * workspace dependency in an ancestor `node_modules`, where Rspack finds it
 * too. A package whose `exports` map hides `package.json` makes that lookup
 * throw, so the same ancestor walk is then performed by hand.
 *
 * Plain Node, no framework imports: the build's dependency-root discovery and
 * `agent-bundle/web-host`, which is bundled into generated executables, locate
 * packages the same way.
 */
export const dependencyManifestPath = async (packageRoot: string, name: string): Promise<string | undefined> => {
  try {
    return createRequire(join(packageRoot, 'package.json')).resolve(`${name}/package.json`);
  } catch (error) {
    if (isErrno(error, 'MODULE_NOT_FOUND')) return undefined;
    if (!isErrno(error, 'ERR_PACKAGE_PATH_NOT_EXPORTED')) throw error;
  }
  let directory = packageRoot;
  while (true) {
    const candidate = join(directory, 'node_modules', ...name.split('/'), 'package.json');
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};
