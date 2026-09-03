import { defineConfig } from '@rstest/core';

import { agentBundleRstest } from '../../src/rstest/index.ts';

/**
 * The consumer's ordinary unit pool, built from the shipped preset so a plain
 * test that imports a source module reading `agent-bundle/meta` loads it with
 * the project identity (issue #386). A repository fixture reaches the preset
 * through source; a consumer imports it from `agent-bundle/rstest`.
 */
export default defineConfig(await agentBundleRstest({
  include: ['tests/unit/**/*.test.ts'],
  root: import.meta.dirname,
}));
