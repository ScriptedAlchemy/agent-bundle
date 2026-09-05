import { defineConfig } from '@rstest/core';

import {
  fixtureProjectTestFiles,
  integrationTestFiles,
  mcpConformanceTestFiles,
  nativeHostTestFiles,
  nightlyEvidenceTestFiles,
  packedReleaseOnlyTestFiles,
  packedTestFiles,
  projectionTestFiles,
  routeUnitTestFiles,
  templateTestFiles,
  workspaceTestFileGlob,
} from './rstest.integration-tests.ts';
import { poolTimeouts, workspaceGlobalSetup, workspaceSetupFiles } from './rstest.pools.ts';
import { withAgentBundleRslibConfig } from './rstest.rslib.ts';

/**
 * No builds, no long-lived processes: files that run the compiler (`build()`
 * from src/api, `compileMcpApps`) belong in integrationTestFiles; short-lived
 * children a test spawns and reaps itself (a `node -e`, `git --version`, a
 * one-shot Flight render worker) are fine here. Safe on parallel workers with
 * a shared module cache. `pnpm test` runs this before the integration config.
 */
export default defineConfig({
  extends: withAgentBundleRslibConfig(),
  globalSetup: [...workspaceGlobalSetup],
  include: [workspaceTestFileGlob],
  exclude: [
    ...fixtureProjectTestFiles,
    ...integrationTestFiles,
    ...mcpConformanceTestFiles,
    ...nativeHostTestFiles,
    ...nightlyEvidenceTestFiles,
    // Packs and installs like packedTestFiles, and is release-boundary-only:
    // `test:packed:release` owns it, not the build-free per-PR pool.
    ...packedReleaseOnlyTestFiles,
    ...packedTestFiles,
    ...projectionTestFiles,
    ...routeUnitTestFiles,
    ...templateTestFiles,
  ],
  setupFiles: [...workspaceSetupFiles],
  // Unit files construct per-test services; logs-real.e2e is not in this pool.
  isolate: false,
  // The slowest unit cases build a TypeScript program in-process
  // (inspect-state.test.ts: 2.3–4.5 s per case under load, and a 5 s-default
  // timeout in 1 of 3 audited runs — #576). 15 s is >3× that; the runCli
  // journeys that legitimately take longer (runtime-client-surface-proxy,
  // eval-native-mount) carry their own per-test timeouts, which win.
  ...poolTimeouts(15_000),
});
