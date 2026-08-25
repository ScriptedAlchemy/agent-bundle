import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const workbenchRoot = join(import.meta.dirname, '..', '..');
const vendorRoot = join(workbenchRoot, 'src', 'inspector', 'vendor');
const requireFromWorkbench = createRequire(join(workbenchRoot, 'package.json'));

const dependencyRoot = (name: string): string => dirname(requireFromWorkbench.resolve(`${name}/package.json`));

export const workbenchBrowserAliases = {
  '@inspector/core/json/xMcpHeader.js': join(vendorRoot, 'core', 'json', 'xMcpHeader.ts'),
  '@inspector/core/mcp/fetchTracking.js': join(vendorRoot, 'core', 'mcp', 'fetchTracking.ts'),
  '@inspector/core/mcp/types.js': join(vendorRoot, 'core', 'mcp', 'types.ts'),
  '@inspector/core': join(vendorRoot, 'core'),
  '@mantine/core': join(workbenchRoot, 'node_modules', '@mantine', 'core'),
  react: dependencyRoot('react'),
  'react-dom': dependencyRoot('react-dom'),
};
