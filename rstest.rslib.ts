import { resolve } from 'node:path';

import { withRslibConfig } from '@rstest/adapter-rslib';

const workspaceRoot = import.meta.dirname;
const packageRoot = resolve(workspaceRoot, 'packages/agent-bundle');

export const withAgentBundleRslibConfig = () => withRslibConfig({
  cwd: packageRoot,
  modifyLibConfig: (config) => ({
    ...config,
    root: workspaceRoot,
    source: {
      ...config.source,
      tsconfigPath: resolve(workspaceRoot, 'tsconfig.json'),
    },
  }),
});
