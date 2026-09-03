import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * The framework-generated projection pool (`tests/projection/**`): the
 * `cli-dispatch` and `script-dispatch` proof levels. One Agent Bundle compiler
 * pass runs here — the same route compilation the build performs, with no
 * artifact built — and supplies the command graph, the script inventory, and
 * the route loaders. It is a separate run from the plain `rstest tests` pool
 * so the two claims stay separately reported.
 */
export default defineConfig(await agentBundleRstest({
  include: ['tests/projection/**/*.test.ts'],
}));
