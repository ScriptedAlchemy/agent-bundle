import { dirname, join } from 'node:path';

import { exists } from './paths.ts';

/**
 * The manifest of dependency `name` as seen from `packageRoot`: the first
 * `<directory>/node_modules/<name>/package.json` that exists, walking from
 * `packageRoot` through its ancestors up to the filesystem root, or
 * `undefined` when no ancestor has the package. That walk probes only
 * `node_modules` up the ancestor chain, so it honours hoisting the same
 * way: npm, Yarn, and pnpm with a hoist pattern place a workspace
 * dependency in an ancestor `node_modules`, where Rspack finds it too.
 * `createRequire(…).resolve(…)` also consulted `NODE_PATH`, Node's global
 * folders (`$HOME/.node_modules`, `$HOME/.node_libraries`,
 * `$PREFIX/lib/node`), and a Yarn Plug'n'Play runtime when one is loaded;
 * this walk no longer consults any of those. A scoped `name` is one
 * package (`@scope/pkg`); a subpath is not supported.
 *
 * By hand, not through `createRequire(…).resolve(…)`: this module is bundled
 * into every generated executable that imports
 * `agent-bundle/serve-app-command`, and `AB6005` refuses a non-literal
 * `createRequire(…).resolve(…)` in compiled output (#591), so the resolver
 * call would fail the artifact build of every consumer that uses
 * `spawnServeApp`. The walk also no longer depends on the package exporting
 * `./package.json` — an `exports` map that hid it made the resolver throw,
 * and this same walk was the fallback.
 *
 * The result is the path through `node_modules`, so a pnpm symlink is not
 * followed here: the build-time caller (`declaredDependencyRoots` in
 * `build/rslib.ts`) realpaths it, and `locateFrameworkCli` resolves the bin
 * beside it, which works through the link. Plain Node, no framework imports,
 * so the build's dependency-root discovery and the bundled
 * `serve-app-command` locate packages the same way.
 */
export const dependencyManifestPath = async (packageRoot: string, name: string): Promise<string | undefined> => {
  let directory = packageRoot;
  while (true) {
    const candidate = join(directory, 'node_modules', ...name.split('/'), 'package.json');
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};
