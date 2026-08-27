import { join } from 'node:path';

import type { LoadedConfig } from '../../src/config/load.ts';
import type { AgentBundleConfig } from '../../src/core/types.ts';

/** A production-mode `build` LoadedConfig rooted at `root`, for normalization suites. */
export const loadedProject = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});
