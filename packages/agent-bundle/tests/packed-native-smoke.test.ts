import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const loadPackedNativeSmoke = async () => import('./support/packed-native-smoke.ts').catch(() => undefined);

const enabledHosts = [
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE === '1' ? ['claude' as const] : []),
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE === '1' ? ['codex' as const] : []),
];
const nativeIt = enabledHosts.length === 0 ? it.skip : it;

it('requires a host-specific opt-in and keeps the canonical Claude model pinned', async () => {
  const harness = await loadPackedNativeSmoke();
  expect(harness).toBeDefined();

  expect(harness!.packedNativeSmokePlan({})).toEqual({
    hosts: [
      { enabled: false, host: 'claude', model: 'claude-sonnet-4-5', reason: 'explicit-opt-in-required' },
      { enabled: false, host: 'codex', reason: 'explicit-opt-in-required' },
    ],
  });
  expect(harness!.packedNativeSmokePlan({ AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE: '1' })).toEqual({
    hosts: [
      { enabled: false, host: 'claude', model: 'claude-sonnet-4-5', reason: 'explicit-opt-in-required' },
      { enabled: true, host: 'codex' },
    ],
  });
});

it('removes workspace module resolution and credential-shaped environment values', async () => {
  const harness = await loadPackedNativeSmoke() as undefined | {
    readonly packedNativeEnvironment?: (environment: Readonly<NodeJS.ProcessEnv>) => NodeJS.ProcessEnv;
  };
  expect(harness?.packedNativeEnvironment).toBeDefined();

  expect(harness!.packedNativeEnvironment!({
    CODEX_HOME: '/ordinary/codex-home',
    CUSTOM_SETTING: 'preserved',
    NODE_PATH: '/workspace/node_modules',
    OPENAI_API_KEY: 'must-not-reach-installed-cli',
    PATH: '/usr/bin',
    THIRD_PARTY_ACCESS_TOKEN: 'must-not-reach-installed-cli',
  })).toEqual({
    CODEX_HOME: '/ordinary/codex-home',
    CUSTOM_SETTING: 'preserved',
    PATH: '/usr/bin',
  });
});

it('detects normal Claude config, settings, or plugin changes without retaining digests', async () => {
  const harness = await loadPackedNativeSmoke() as undefined | {
    readonly normalClaudeHomeUnchanged?: (
      environment: Readonly<NodeJS.ProcessEnv>,
      operation: () => Promise<void>,
    ) => Promise<boolean>;
  };
  expect(harness?.normalClaudeHomeUnchanged).toBeDefined();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-claude-home-'));
  try {
    await mkdir(join(root, 'plugins'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'config.json'), '{"theme":"dark"}\n'),
      writeFile(join(root, 'settings.json'), '{"model":"subscription"}\n'),
      writeFile(join(root, 'plugins', 'installed.json'), '{"plugins":[]}\n'),
      writeFile(join(root, 'session.json'), '{"opaque":"session"}\n'),
    ]);
    const environment = { CLAUDE_CONFIG_DIR: root };

    await expect(harness!.normalClaudeHomeUnchanged!(environment, async () => undefined)).resolves.toBe(true);
    await expect(harness!.normalClaudeHomeUnchanged!(environment, async () => {
      await writeFile(join(root, 'plugins', 'installed.json'), '{"plugins":["changed"]}\n');
    })).resolves.toBe(false);

    const pluginPath = join(root, 'plugins', 'installed.json');
    await writeFile(pluginPath, '{"marker":"normal-plugin-marker"}\n');
    const fixedTime = new Date('2026-08-14T12:00:00.000Z');
    await utimes(pluginPath, fixedTime, fixedTime);
    await expect(harness!.normalClaudeHomeUnchanged!(environment, async () => {
      await writeFile(pluginPath, '{"marker":"normal-plugin-change"}\n');
      await utimes(pluginPath, fixedTime, fixedTime);
    })).resolves.toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

nativeIt('runs opted-in authored Eval hosts through one production-only packed installation', async () => {
  const harness = await loadPackedNativeSmoke();
  expect(harness).toBeDefined();

  const report = await harness!.runPackedNativeSmoke({ environment: process.env });
  expect(report.package).toEqual({ externalBinary: true, productionOnly: true, tarballs: 1 });
  expect(report.hosts.map((host) => host.host)).toEqual(enabledHosts);
  expect(report.hosts.every((host) => host.status === 'passed')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(
    /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|authorization|sk-[A-Za-z0-9_-]{16,}|\/home\/|\/Users\/|prompt|response|stdout|stderr)/iu,
  );
}, 600_000);
