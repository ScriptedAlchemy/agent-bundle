import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  disposeHostInstallFixture,
  runDevLiveHostProof,
  type BuiltHostInstallFixture,
} from './support/host-install.ts';

const enabled = process.env.AGENT_BUNDLE_NATIVE_HOST_CONTRACTS === '1'
  && spawnSync('codex', ['--version'], { stdio: 'ignore', timeout: 5_000, windowsHide: true }).status === 0;
const nativeIt = enabled ? it : it.skip;
let fixture: BuiltHostInstallFixture | undefined;

beforeAll(async () => {
  if (!enabled) return;
  fixture = await buildHostInstallFixture({ environment: process.env });
}, 180_000);

afterAll(async () => {
  if (fixture !== undefined) await disposeHostInstallFixture(fixture);
});

nativeIt(
  enabled
    ? 'refreshes MCP and hook components in a Codex app-server started before the development install'
    : 'refreshes a pre-existing Codex app-server [missing native Codex contract prerequisites]',
  async () => {
    if (fixture === undefined) throw new Error('The native Codex app-server fixture was not built.');
    const report = await runDevLiveHostProof(fixture, 'codex', {
      environment: process.env,
      persistentCodexAppServer: true,
    });

    expect(report.codexAppServer).toMatchObject({
      mcpServers: ['probe'],
      registrationCount: 1,
      startedBeforeInstall: true,
    });
    expect(report.codexAppServer?.hookDocumentHashes[1])
      .not.toBe(report.codexAppServer?.hookDocumentHashes[0]);
  },
  240_000,
);
