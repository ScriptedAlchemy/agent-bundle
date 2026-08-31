import { execFile as executeFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, test } from '@rstest/core';

const readme = async (): Promise<string> => readFile(join(process.cwd(), 'README.md'), 'utf8');
const execFile = promisify(executeFile);

test('requires attached native evidence before documenting Claude or Codex observations', async () => {
  const source = await readme();

  expect(source).toContain('`apply_patch` hook');
  expect(source).toContain('`dist/runtime/agent-runtime.manifest.json`');
  expect(source).toContain('value-free hook launch probe');
  expect(source).toContain('native PostToolUse/shared state remains unproven under `exec --ephemeral`');
  expect(source).toMatch(/Real Claude Code and Codex CLI runs are\s+intentionally skip-gated out of ordinary CI and default test runs/u);
  expect(source).toMatch(/No attached tracked\s+schema-v2 native-evidence artifact exists in this repository snapshot/u);
  expect(source).toMatch(/profiles are local compatibility simulations, and deterministic evaluator tests are not native certification/u);
  expect(source).toContain('pnpm --filter @agent-bundle/rsc-agent-runtime-demo eval:hosts -- --host claude');
  expect(source).toContain('pnpm --filter @agent-bundle/rsc-agent-runtime-demo eval:hosts -- --host codex');
  expect(source).toContain('schema-v2 JSON evidence document');
  expect(source).toContain('MCP App iframe evidence is unavailable from either terminal CLI');
  expect(source).not.toContain('Claude fully proves hook→MCP/RSC shared behavior');
  expect(source).not.toContain('A non-authenticated session is reported as an environment limitation');
  expect(source).not.toContain('unavailable/not run');
  expect(source).not.toMatch(/in progress/iu);
});

test('documents the ordinary-CI micro-eval spot-check', async () => {
  const source = await readme();

  expect(source).toContain('### CI micro-eval spot-check');
  expect(source).toContain('pnpm eval:spot');
  expect(source).toMatch(/contacts\s+no real host and needs no credentials/u);
});

test('declares a shell-independent production build', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };

  // Ordering is the contract: the demo's own Rsbuild build must produce the
  // declared payload trees before `agent-bundle build` packages them.
  expect(manifest.scripts?.build).toBe('rsbuild build --mode production && agent-bundle build --json --output dist/plugins');
});

test('derives the native evaluator root from decoded module URLs', async () => {
  const helperUrl = pathToFileURL(join(process.cwd(), 'scripts/eval-host-paths.mjs')).href;
  const moduleUrl = pathToFileURL(join(tmpdir(), 'rsc runtime encoded path', 'scripts', 'eval-hosts.mjs')).href;
  const source = [
    `import { exampleRootFromModule } from ${JSON.stringify(helperUrl)};`,
    `process.stdout.write(exampleRootFromModule(${JSON.stringify(moduleUrl)}));`,
  ].join('\n');
  const { stdout } = await execFile(process.execPath, ['--input-type=module', '--eval', source]);

  expect(stdout).toBe(join(tmpdir(), 'rsc runtime encoded path'));
});
