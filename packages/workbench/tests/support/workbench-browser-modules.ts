import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const workbenchRoot = join(import.meta.dirname, '..', '..');
const vendorRoot = join(workbenchRoot, 'src', 'inspector', 'vendor');
const requireFromWorkbench = createRequire(join(workbenchRoot, 'package.json'));

export const workbenchNodeModules = join(workbenchRoot, 'node_modules');

export const dependencyRoot = (name: string): string => dirname(requireFromWorkbench.resolve(`${name}/package.json`));

export const workbenchBrowserAliases = {
  react: dependencyRoot('react'),
  'react-dom': dependencyRoot('react-dom'),
  'react-dom/client': join(dependencyRoot('react-dom'), 'client.js'),
};
