import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * The in-process projection pool (`tests/projection/**`): the `mcp-in-memory`
 * proof level, built from the same configuration helper the route-unit pool
 * uses. It is a separate run so a route-unit pass and a projection pass are
 * reported separately — they are separate claims, and neither is a receipt
 * for the other.
 */
export default defineConfig(await agentBundleRstest({
  include: ['tests/projection/**/*.test.ts'],
}));
