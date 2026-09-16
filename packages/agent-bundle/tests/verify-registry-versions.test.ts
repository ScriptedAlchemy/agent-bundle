import { execFile as executeFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/verify-registry-versions.sh');

const packages = {
  'packages/agent-bundle': { name: 'agent-bundle', version: '0.2.1' },
  'packages/create-agent-bundle': { name: 'create-agent-bundle', version: '0.1.1' },
  'packages/rsc-markdown-stream': { name: 'rsc-markdown-stream', version: '0.1.2' },
  'packages/rsc-runtime': { name: '@agent-bundle/runtime', version: '0.1.1' },
};

/**
 * Stand up a tree with the four publishable package.json files and a fake
 * `npm` on PATH that answers `npm view <spec> version` from `registry`
 * (spec -> version), optionally failing the first `failFirst` calls per spec
 * to exercise the retry loop. Calls are appended to `calls.log`.
 */
const setup = async (registry: Record<string, string>, failFirst = 0) => {
  const root = await mkdtemp(join(tmpdir(), 'verify-registry-'));
  for (const [dir, manifest] of Object.entries(packages)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), `${JSON.stringify(manifest)}\n`);
  }
  const bin = join(root, 'bin');
  await mkdir(bin);
  const fakeNpm = join(bin, 'npm');
  await writeFile(fakeNpm, [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${root}/calls.log"`,
    '[ "$1" = view ] || exit 1',
    `count=$(grep -c -- "view $2 " "${root}/calls.log")`,
    `[ "$count" -le ${failFirst} ] && exit 1`,
    ...Object.entries(registry).map(([spec, version]) => `[ "$2" = "${spec}" ] && { echo "${version}"; exit 0; }`),
    'exit 1',
  ].join('\n'));
  await chmod(fakeNpm, 0o755);
  const run = () => execFile('bash', [scriptPath], {
    cwd: root,
    env: { PATH: `${bin}:${process.env['PATH']}`, REGISTRY_ATTEMPTS: '3', REGISTRY_RETRY_SECONDS: '0' },
  });
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8')).trim().split('\n');
  return { calls, root, run };
};

const allPublished = Object.fromEntries(
  Object.values(packages).map(({ name, version }) => [`${name}@${version}`, version]),
);

it('passes when every publishable version resolves on the registry', async () => {
  const { calls, run } = await setup(allPublished);
  const { stdout } = await run();
  for (const { name, version } of Object.values(packages)) expect(stdout).toContain(`registry ${name}@${version}`);
  expect(await calls()).toHaveLength(4);
});

it('retries a version that appears after replication lag', async () => {
  const { calls, run } = await setup(allPublished, 1);
  const { stdout } = await run();
  expect(stdout).toContain('attempt 1/3: agent-bundle@0.2.1 not on npm yet');
  expect(stdout).toContain('registry agent-bundle@0.2.1');
  expect(await calls()).toHaveLength(8);
});

it('fails and names every version the registry lacks after exhausting attempts', async () => {
  const { calls, run } = await setup({ 'agent-bundle@0.2.1': '0.2.1', 'rsc-markdown-stream@0.1.2': '0.1.2' });
  const failure = await run().catch((error: Error & { code?: number; stdout?: string }) => error);
  expect(failure).toMatchObject({ code: 1 });
  expect(failure.stdout).toContain('::error::Not on npm: @agent-bundle/runtime@0.1.1 create-agent-bundle@0.1.1.');
  expect(await calls()).toHaveLength(2 + 3 * 2);
});

it('fails on a package.json without a version instead of comparing empty strings', async () => {
  const { root, run } = await setup(allPublished);
  await writeFile(join(root, 'packages/rsc-runtime/package.json'), '{"name":"@agent-bundle/runtime"}\n');
  const failure = await run().catch((error: Error & { code?: number; stdout?: string }) => error);
  expect(failure).toMatchObject({ code: 1 });
  expect(failure.stdout).toContain('::error::packages/rsc-runtime/package.json has no name/version to verify.');
});
