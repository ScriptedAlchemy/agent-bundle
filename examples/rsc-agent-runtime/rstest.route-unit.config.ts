import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

/**
 * The framework-generated route-unit configuration. One Agent Bundle compiler
 * pass runs here — no artifact build — and it supplies the route manifest, the
 * TypeScript transform, and the React Server Components conditions the demo's
 * event route needs. The example maintains none of that by hand.
 */
export default defineConfig(await agentBundleRstest());
