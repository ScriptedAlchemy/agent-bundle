import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const workbenchRoot = join(import.meta.dirname, '..', '..');
const requireFromWorkbench = createRequire(join(workbenchRoot, 'package.json'));

const dependencyRoot = (name: string): string => dirname(requireFromWorkbench.resolve(`${name}/package.json`));

export const workbenchBrowserAliases = {
  react: dependencyRoot('react'),
  'react-dom': dependencyRoot('react-dom'),
};
