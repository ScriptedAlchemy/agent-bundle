import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const workbenchRoot = join(import.meta.dirname, '..', '..');
const vendorRoot = join(workbenchRoot, 'src', 'inspector', 'vendor');
const requireFromWorkbench = createRequire(join(workbenchRoot, 'package.json'));

export const workbenchNodeModules = join(workbenchRoot, 'node_modules');

export const dependencyRoot = (name: string): string => dirname(requireFromWorkbench.resolve(`${name}/package.json`));

export const workbenchBrowserAliases = {
  // @mantine/core's exports map blocks package.json resolution, so its path
  // comes from the workbench package's own direct dependency directory.
  '@mantine/core': join(workbenchRoot, 'node_modules', '@mantine', 'core'),
  react: dependencyRoot('react'),
  'react-dom': dependencyRoot('react-dom'),
  'react-dom/client': join(dependencyRoot('react-dom'), 'client.js'),
};

/** The @mantine/core browser ESM entry (exports-map blocked from require.resolve). */
export const mantineEsmEntry = join(workbenchRoot, 'node_modules', '@mantine', 'core', 'esm', 'index.mjs');
