import { spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import {
  buildHostInstallFixture,
  CLAUDE_SESSION_OPT_IN,
  disposeHostInstallFixture,
  runClaudeLiveDevSessionProof,
  runDevLiveHostProof,
  type BuiltHostInstallFixture,
} from './support/host-install.ts';

const claudeAvailable = spawnSync('claude', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
const codexAvailable = spawnSync('codex', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0;
const claudeSessionOptedIn = process.env[CLAUDE_SESSION_OPT_IN] === '1';
const claudeIt = claudeAvailable ? it : it.skip;
const codexIt = codexAvailable ? it : it.skip;
const claudeSessionIt = claudeAvailable && claudeSessionOptedIn ? it : it.skip;

let fixture: BuiltHostInstallFixture | undefined;

const builtFixture = (): BuiltHostInstallFixture => {
  if (fixture === undefined) throw new Error('The shared live-host fixture was not built.');
  return fixture;
};

beforeAll(async () => {
  fixture = await buildHostInstallFixture({ environment: process.env });
}, 180_000);

afterAll(async () => {
  if (fixture !== undefined) await disposeHostInstallFixture(fixture);
});

describe.sequential('development live-host acceptance', () => {
  it('keeps the exact Cursor-installed proxy connected while a rebuild re-syncs host files', async () => {
    const report = await runDevLiveHostProof(builtFixture(), 'cursor', { environment: process.env });

    expect(report).toMatchObject({
      connection: {
        initialized: 1,
        observations: ['v1:cursor', 'v2:cursor'],
        toolsListChanged: 1,
      },
      host: 'cursor',
      hostBinaryVersion: 'not-required',
      install: {
        commandFromInstalledDocument: true,
        hostCliCommandsUnchangedAcrossRebuild: true,
      },
      resync: {
        hook: 'v2',
        markerAdvanced: true,
        skill: 'v2',
      },
      sessionEvidence: 'unavailable: Cursor exposes no non-interactive plugin-loading session surface',
      status: 'passed',
    });
  }, 180_000);

  claudeIt(
    claudeAvailable
      ? 'keeps the exact Claude-installed proxy connected while a rebuild re-syncs the host cache'
      : 'keeps the Claude-installed proxy connected through rebuild [missing evidence: claude binary unavailable on PATH]',
    async () => {
      const report = await runDevLiveHostProof(builtFixture(), 'claude', { environment: process.env });

      expect(report).toMatchObject({
        connection: {
          initialized: 1,
          observations: ['v1:claude', 'v2:claude'],
          toolsListChanged: 1,
        },
        host: 'claude',
        hostBinaryVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        install: {
          commandFromInstalledDocument: true,
          hostCliCommandsUnchangedAcrossRebuild: true,
        },
        resync: { hook: 'v2', markerAdvanced: true, skill: 'v2' },
        status: 'passed',
      });
    },
    240_000,
  );

  codexIt(
    codexAvailable
      ? 'keeps the exact Codex-installed proxy connected while a rebuild re-syncs the host cache'
      : 'keeps the Codex-installed proxy connected through rebuild [missing evidence: codex binary unavailable on PATH]',
    async () => {
      const report = await runDevLiveHostProof(builtFixture(), 'codex', { environment: process.env });

      expect(report).toMatchObject({
        connection: {
          initialized: 1,
          observations: ['v1:codex', 'v2:codex'],
          toolsListChanged: 1,
        },
        host: 'codex',
        hostBinaryVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        install: {
          commandFromInstalledDocument: true,
          hostCliCommandsUnchangedAcrossRebuild: true,
        },
        resync: { hook: 'v2', markerAdvanced: true, skill: 'v2' },
        sessionEvidence: expect.stringContaining('installed proxy'),
        status: 'passed',
      });
    },
    240_000,
  );

  claudeSessionIt(
    claudeAvailable && claudeSessionOptedIn
      ? 'observes v1 then v2 through the installed Claude plugin without reinstalling'
      : `observes v1 then v2 through the installed Claude plugin [missing evidence: ${
          claudeAvailable
            ? `${CLAUDE_SESSION_OPT_IN}=1 opt-in required for live model turns`
            : 'claude binary unavailable on PATH'
        }]`,
    async () => {
      const report = await runClaudeLiveDevSessionProof(builtFixture(), { environment: process.env });

      expect(report).toMatchObject({
        attempts: 2,
        host: 'claude',
        hostBinaryVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        normalHome: {
          settingsAndPlugins: 'unchanged',
        },
        reinstalledAfterRebuild: false,
        sessionMode: 'resumed inline installed-tree session',
        status: 'passed',
        toolOutputs: ['v1:claude-session', 'v2:claude-session'],
      });
    },
    660_000,
  );

  it.skip(
    'observes v1 then v2 through a real Codex model session '
      + '[missing evidence: Codex exec exposes no inline plugin-loading surface for the isolated dev install]',
    () => undefined,
  );
});
