import { defineConfig } from '@rstest/core';

import { agentBundleRstest } from '../../src/rstest/index.ts';

/** The consumer's route-unit pool: the preset's defaults over this fixture root. */
export default defineConfig(await agentBundleRstest({ root: import.meta.dirname }));
