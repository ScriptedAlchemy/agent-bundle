import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  globalBinDirectory,
  hostCliPinFromProvenance,
  hostCliProvenancePaths,
  installArguments,
  parseCliVersion,
  pinsCacheKey,
  readHostCliPins,
  runHostCliPins,
  verifyHostCliPins,
  type HostCliPins,
} from '../../../scripts/host-cli-pins.mjs';
import claudeCapabilities from '../src/adapters/capabilities/claude-2.1.250.json' with { type: 'json' };
import codexCapabilities from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };

const pins: HostCliPins = Object.freeze({
  claude: Object.freeze({
    host: 'claude',
    package: '@anthropic-ai/claude-code',
    provenancePath: hostCliProvenancePaths.claude,
    version: '2.1.250',
  }),
  codex: Object.freeze({
    host: 'codex',
    package: '@openai/codex',
    provenancePath: hostCliProvenancePaths.codex,
    version: '0.147.0',
  }),
});

it('pins the CI host CLIs to the schema-observed versions in each adapter PROVENANCE', async () => {
  const read = await readHostCliPins();

  expect(read.claude).toEqual({
    host: 'claude',
    package: '@anthropic-ai/claude-code',
    provenancePath: 'packages/agent-bundle/src/adapters/schemas/claude/PROVENANCE.json',
    version: claudeCapabilities.observedCliVersion,
  });
  expect(read.codex).toEqual({
    host: 'codex',
    package: '@openai/codex',
    provenancePath: 'packages/agent-bundle/src/adapters/schemas/codex/PROVENANCE.json',
    version: codexCapabilities.observedCliVersion,
  });
});

it('refuses a hostCli pin that drifts from observedCliVersion or is malformed', () => {
  const path = 'schemas/claude/PROVENANCE.json';
  expect(() => hostCliPinFromProvenance('claude', path, {
    hostCli: { package: '@anthropic-ai/claude-code', version: '2.1.257' },
    observedCliVersion: '2.1.250',
  })).toThrow(/pins hostCli\.version 2\.1\.257 but observedCliVersion is 2\.1\.250/u);
  expect(() => hostCliPinFromProvenance('claude', path, { observedCliVersion: '2.1.250' }))
    .toThrow(/has no hostCli block/u);
  expect(() => hostCliPinFromProvenance('claude', path, {
    hostCli: { package: '@anthropic-ai/claude-code', version: '^2.1.250' },
    observedCliVersion: '^2.1.250',
  })).toThrow(/exact semantic version/u);
  expect(() => hostCliPinFromProvenance('claude', path, {
    hostCli: { package: '', version: '2.1.250' },
    observedCliVersion: '2.1.250',
  })).toThrow(/hostCli\.package/u);
  expect(() => hostCliPinFromProvenance('codex', path, { hostCli: { package: '@openai/codex', version: '0.147.0' } }))
    .toThrow(/no observedCliVersion/u);
});

it('parses the version line each host CLI prints', () => {
  expect(parseCliVersion('2.1.250 (Claude Code)\n')).toBe('2.1.250');
  expect(parseCliVersion('codex-cli 0.147.0\n')).toBe('0.147.0');
  expect(parseCliVersion('no version here\n')).toBeUndefined();
});

it('passes only when every host on PATH reports exactly the pinned version', async () => {
  const matched = await verifyHostCliPins(pins, (host) => ({
    exitCode: 0,
    stderr: '',
    stdout: host === 'claude' ? '2.1.250 (Claude Code)\n' : 'codex-cli 0.147.0\n',
  }));
  expect(matched).toEqual({
    ok: true,
    results: [
      { host: 'claude', installed: '2.1.250', line: 'host-cli pin ok: claude 2.1.250 (@anthropic-ai/claude-code@2.1.250)', status: 'match' },
      { host: 'codex', installed: '0.147.0', line: 'host-cli pin ok: codex 0.147.0 (@openai/codex@0.147.0)', status: 'match' },
    ],
  });

  const drifted = await verifyHostCliPins(pins, (host) => ({
    exitCode: 0,
    stderr: '',
    stdout: host === 'claude' ? '2.1.257 (Claude Code)\n' : 'codex-cli 0.147.0\n',
  }));
  expect(drifted.ok).toBe(false);
  expect(drifted.results[0]).toEqual({
    host: 'claude',
    installed: '2.1.257',
    line: 'host-cli pin mismatch: claude on PATH is 2.1.257 but '
      + 'packages/agent-bundle/src/adapters/schemas/claude/PROVENANCE.json pins @anthropic-ai/claude-code@2.1.250; '
      + 'install @anthropic-ai/claude-code@2.1.250 or bump hostCli.version and observedCliVersion in '
      + 'packages/agent-bundle/src/adapters/schemas/claude/PROVENANCE.json deliberately.',
    status: 'mismatch',
  });
  expect(drifted.results[1]).toMatchObject({ host: 'codex', status: 'match' });
  for (const result of drifted.results) {
    expect(result.line.split('\n')).toHaveLength(1);
  }
});

it('reports a missing or broken host CLI as unmet instead of guessing a version', async () => {
  const missing = await verifyHostCliPins(pins, (host) => host === 'codex'
    ? { error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
    : { exitCode: 1, stderr: 'claude native binary not installed.', stdout: '' });
  expect(missing.ok).toBe(false);
  expect(missing.results).toEqual([
    {
      host: 'claude',
      line: expect.stringMatching(/^host-cli pin unmet: `claude --version` failed on PATH \(claude native binary not installed\.\); install @anthropic-ai\/claude-code@2\.1\.250/u),
      status: 'missing',
    },
    {
      host: 'codex',
      line: expect.stringMatching(/^host-cli pin unmet: `codex --version` failed on PATH \(spawn codex ENOENT\); install @openai\/codex@0\.147\.0/u),
      status: 'missing',
    },
  ]);

  const unparseable = await verifyHostCliPins(pins, () => ({ exitCode: 0, stderr: '', stdout: 'dev build\n' }));
  expect(unparseable.results.every((result) => result.status === 'missing')).toBe(true);
  expect(unparseable.results[0]?.line).toContain('printed no semantic version (dev build)');
});

it('installs exact pinned packages globally into the requested prefix', () => {
  expect(installArguments(pins, '/tmp/host-cli')).toEqual([
    'install',
    '-g',
    '--no-fund',
    '--no-audit',
    '--prefix',
    '/tmp/host-cli',
    '@anthropic-ai/claude-code@2.1.250',
    '@openai/codex@0.147.0',
  ]);
  expect(installArguments(pins)).not.toContain('--prefix');
});

it('keys the CLI cache on package names as well as versions', () => {
  expect(pinsCacheKey(pins)).toMatch(
    /^claude-anthropic-ai-claude-code-2\.1\.250-codex-openai-codex-0\.147\.0-[0-9a-f]{16}$/u,
  );
  expect(pinsCacheKey(pins)).toBe(pinsCacheKey({ ...pins }));
  expect(pinsCacheKey({
    ...pins,
    claude: { ...pins.claude, package: '@anthropic-ai/claude-code-preview' },
  })).not.toBe(pinsCacheKey(pins));
});

it('distinguishes package names that sanitise to the same readable text', () => {
  const scoped = { ...pins, codex: { ...pins.codex, package: '@foo/bar' } };
  const flat = { ...pins, codex: { ...pins.codex, package: 'foo-bar' } };
  expect(pinsCacheKey(scoped).replace(/-[0-9a-f]{16}$/u, ''))
    .toBe(pinsCacheKey(flat).replace(/-[0-9a-f]{16}$/u, ''));
  expect(pinsCacheKey(scoped)).not.toBe(pinsCacheKey(flat));
});

it('locates npm global executables in <prefix>/bin on POSIX and in the prefix itself on Windows', () => {
  expect(globalBinDirectory('/tmp/host-cli', 'linux')).toBe(join('/tmp/host-cli', 'bin'));
  expect(globalBinDirectory('/tmp/host-cli', 'darwin')).toBe(join('/tmp/host-cli', 'bin'));
  expect(globalBinDirectory('C:\\tmp\\host-cli', 'win32')).toBe('C:\\tmp\\host-cli');
});

it('prints the pins and a cache key to stdout and GITHUB_OUTPUT', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-host-cli-pins-'));
  const outputPath = join(fixtureRoot, 'github-output');
  const written: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const read = await runHostCliPins({ argv: ['print'], env: { GITHUB_OUTPUT: outputPath } });
    const expected = [
      `claude=${read.claude.version}`,
      `codex=${read.codex.version}`,
      `pins=${pinsCacheKey(read)}`,
    ];
    expect(written.join('')).toBe(`${expected.join('\n')}\n`);
    expect(await readFile(outputPath, 'utf8')).toBe(`${expected.join('\n')}\n`);
  } finally {
    process.stdout.write = originalWrite;
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
