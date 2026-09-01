import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * The framework-generated route-unit pool (`tests/route-unit/**`). One Agent
 * Bundle compiler pass runs here — the same route compilation the build
 * performs, with no artifact built — and it supplies the route manifest, the
 * route loaders, the TypeScript transform, and the React Server Components
 * conditions route rendering needs. Nothing below is maintained by hand.
 */
export default defineConfig(await agentBundleRstest());
