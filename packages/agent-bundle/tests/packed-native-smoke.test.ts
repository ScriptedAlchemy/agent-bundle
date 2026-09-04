import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const loadPackedNativeSmoke = async () => import('./support/packed-native-smoke.ts').catch(() => undefined);

const enabledHosts = [
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE === '1' ? ['claude' as const] : []),
  ...(process.env.AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE === '1' ? ['codex' as const] : []),
];
const nativeIt = enabledHosts.length === 0 ? it.skip : it;
const claudePluginIt = spawnSync('claude', ['--version'], {
  stdio: 'ignore',
  timeout: 5_000,
  windowsHide: true,
}).status === 0 ? it : it.skip;

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

it('runs npm and the installed CLI through Node entrypoints on Windows', async () => {
  const harness = await loadPackedNativeSmoke() as undefined | {
    readonly packedNativeNodeCommand?: (
      entrypoint: string,
      args: readonly string[],
      nodeExecutable?: string,
    ) => Readonly<{ readonly args: readonly string[]; readonly executable: string }>;
  };
  expect(harness?.packedNativeNodeCommand).toBeDefined();

  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const npm = 'C:\\Users\\runner\\npm\\node_modules\\npm\\bin\\npm-cli.js';
  const cli = 'C:\\work\\consumer\\node_modules\\agent-bundle\\dist\\cli.js';
  expect(harness!.packedNativeNodeCommand!(npm, ['pack', '--json'], node)).toEqual({
    args: [npm, 'pack', '--json'],
    executable: node,
  });
  expect(harness!.packedNativeNodeCommand!(cli, ['eval', '--json'], node)).toEqual({
    args: [cli, 'eval', '--json'],
    executable: node,
  });
  expect(JSON.stringify(harness!.packedNativeNodeCommand!(cli, [], node))).not.toContain('.cmd');
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
      options?: Readonly<{ readonly homeDirectory: string }>,
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

it('opaquely detects default ~/.claude.json mutation without extending custom config scope', async () => {
  const harness = await loadPackedNativeSmoke() as undefined | {
    readonly normalClaudeHomeUnchanged?: (
      environment: Readonly<NodeJS.ProcessEnv>,
      operation: () => Promise<void>,
      options?: Readonly<{ readonly homeDirectory: string }>,
    ) => Promise<boolean>;
  };
  expect(harness?.normalClaudeHomeUnchanged).toBeDefined();

  const userHome = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-claude-default-'));
  const customHome = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-claude-custom-'));
  const privateValue = 'opaque-default-claude-state';
  try {
    await Promise.all([
      mkdir(join(userHome, '.claude'), { recursive: true }),
      mkdir(customHome, { recursive: true }),
      writeFile(join(userHome, '.claude.json'), `${privateValue}\n`),
      writeFile(join(customHome, '.claude.json'), `${privateValue}-custom\n`),
      writeFile(join(customHome, 'settings.json'), '{"model":"subscription"}\n'),
    ]);

    const changed = await harness!.normalClaudeHomeUnchanged!({}, async () => {
      await writeFile(join(userHome, '.claude.json'), `${privateValue}-changed\n`);
    }, { homeDirectory: userHome });
    expect(changed).toBe(false);
    expect(JSON.stringify(changed)).not.toContain(privateValue);
    expect(JSON.stringify(changed)).not.toContain(userHome);

    const customUnchanged = await harness!.normalClaudeHomeUnchanged!({ CLAUDE_CONFIG_DIR: customHome }, async () => {
      await writeFile(join(userHome, '.claude.json'), `${privateValue}-changed-again\n`);
    }, { homeDirectory: userHome });
    expect(customUnchanged).toBe(true);

    const customChanged = await harness!.normalClaudeHomeUnchanged!({ CLAUDE_CONFIG_DIR: customHome }, async () => {
      await writeFile(join(customHome, '.claude.json'), `${privateValue}-custom-changed\n`);
    }, { homeDirectory: userHome });
    expect(customChanged).toBe(false);
    expect(JSON.stringify(customChanged)).toBe('false');
    expect(JSON.stringify(customChanged)).not.toContain(privateValue);
    expect(JSON.stringify(customChanged)).not.toContain(customHome);
  } finally {
    await Promise.all([
      rm(userHome, { force: true, recursive: true }),
      rm(customHome, { force: true, recursive: true }),
    ]);
  }
});

it('guards Claude settings and plugins across a real turn while tolerating the .claude.json rewrite', async () => {
  const harness = await loadPackedNativeSmoke() as undefined | {
    readonly normalClaudeSettingsAndPluginsUnchanged?: (
      environment: Readonly<NodeJS.ProcessEnv>,
      operation: () => Promise<void>,
      options?: Readonly<{ readonly homeDirectory: string }>,
    ) => Promise<boolean>;
  };
  expect(harness?.normalClaudeSettingsAndPluginsUnchanged).toBeDefined();

  const userHome = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-claude-turn-'));
  try {
    await mkdir(join(userHome, '.claude', 'plugins'), { recursive: true });
    await Promise.all([
      writeFile(join(userHome, '.claude.json'), '{"opaque":"before"}\n'),
      writeFile(join(userHome, '.claude', 'settings.json'), '{"model":"subscription"}\n'),
      writeFile(join(userHome, '.claude', 'plugins', 'installed.json'), '{"plugins":[]}\n'),
    ]);
    // Claude Code 2.1.257 rewrites its session bookkeeping on every signed-in
    // turn (observed 2026-09-03); that alone must not fail the packed smoke.
    await expect(harness!.normalClaudeSettingsAndPluginsUnchanged!({}, async () => {
      await writeFile(join(userHome, '.claude.json'), '{"opaque":"after"}\n');
    }, { homeDirectory: userHome })).resolves.toBe(true);
    await expect(harness!.normalClaudeSettingsAndPluginsUnchanged!({}, async () => {
      await writeFile(join(userHome, '.claude', 'settings.json'), '{"model":"changed"}\n');
    }, { homeDirectory: userHome })).resolves.toBe(false);
    await expect(harness!.normalClaudeSettingsAndPluginsUnchanged!({}, async () => {
      await writeFile(join(userHome, '.claude', 'plugins', 'installed.json'), '{"plugins":["changed"]}\n');
    }, { homeDirectory: userHome })).resolves.toBe(false);
  } finally {
    await rm(userHome, { force: true, recursive: true });
  }
});

claudePluginIt('builds, strictly validates, and smoke-loads a packed Claude artifact', async () => {
  const harness = await loadPackedNativeSmoke();
  expect(harness).toBeDefined();

  await expect(harness!.runPackedClaudePluginProof({ environment: process.env })).resolves.toEqual({
    host: 'claude',
    registration: 'observed',
    status: 'passed',
    strictValidation: 'passed',
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
  });
}, 600_000);

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
