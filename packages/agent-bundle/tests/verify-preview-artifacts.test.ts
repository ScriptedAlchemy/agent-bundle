import { execFile as executeFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/verify-preview-artifacts.sh');
const sha = 'b435f7b9179271cbff81d3e40d14ee342cbd65dd';
const packages = {
  'packages/agent-bundle': 'agent-bundle',
  'packages/create-agent-bundle': 'create-agent-bundle',
  'packages/rsc-markdown-stream': 'rsc-markdown-stream',
  'packages/rsc-runtime': '@agent-bundle/runtime',
};
const previewUrl = (name: string) =>
  `https://pkg.pr.new/ScriptedAlchemy/agent-bundle/${name}@${sha}`;

const setup = async (available: ReadonlySet<string>, failFirst = 0) => {
  const root = await mkdtemp(join(tmpdir(), 'verify-preview-'));
  for (const [dir, name] of Object.entries(packages)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), `${JSON.stringify({ name })}\n`);
  }
  const bin = join(root, 'bin');
  await mkdir(bin);
  const fakeCurl = join(bin, 'curl');
  await writeFile(fakeCurl, [
    '#!/usr/bin/env bash',
    'url="${@: -1}"',
    `echo "$url" >> "${root}/calls.log"`,
    `count=$(grep -Fxc -- "$url" "${root}/calls.log")`,
    `[ "$count" -le ${failFirst} ] && exit 22`,
    ...[...available].map((url) => `[ "$url" = "${url}" ] && exit 0`),
    'exit 22',
  ].join('\n'));
  await chmod(fakeCurl, 0o755);
  const run = (revision = sha) => execFile('bash', [scriptPath, revision], {
    cwd: root,
    env: {
      PATH: `${bin}:${process.env['PATH']}`,
      PREVIEW_ATTEMPTS: '3',
      PREVIEW_RETRY_SECONDS: '0',
    },
  });
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8')).trim().split('\n');
  return { calls, root, run };
};

const allAvailable = new Set(Object.values(packages).map(previewUrl));

it('passes when every publishable package preview resolves', async () => {
  const { calls, run } = await setup(allAvailable);
  const { stdout } = await run();
  for (const name of Object.values(packages)) {
    expect(stdout).toContain(`preview ${previewUrl(name)}`);
  }
  expect(await calls()).toHaveLength(4);
});

it('retries a preview that appears after replication lag', async () => {
  const { calls, run } = await setup(allAvailable, 1);
  const { stdout } = await run();
  expect(stdout).toContain(`attempt 1/3: ${previewUrl('agent-bundle')} not available yet`);
  expect(await calls()).toHaveLength(8);
});

it('fails and names every preview that remains unavailable', async () => {
  const available = new Set([previewUrl('agent-bundle'), previewUrl('rsc-markdown-stream')]);
  const { calls, run } = await setup(available);
  const failure = await run().catch((error: Error & { code?: number; stdout?: string }) => error);
  expect(failure).toMatchObject({ code: 1 });
  expect(failure.stdout).toContain([
    '::error::Missing pkg.pr.new previews:',
    previewUrl('@agent-bundle/runtime'),
    previewUrl('create-agent-bundle'),
  ].join(' '));
  expect(await calls()).toHaveLength(2 + 3 * 2);
});

it('fails without a commit SHA', async () => {
  const { run } = await setup(allAvailable);
  const failure = await run('').catch((error: Error & { code?: number; stdout?: string }) => error);
  expect(failure).toMatchObject({ code: 1 });
  expect(failure.stdout).toContain('::error::A commit SHA is required');
});
