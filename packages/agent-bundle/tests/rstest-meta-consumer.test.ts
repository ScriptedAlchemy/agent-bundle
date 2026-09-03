import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it } from '@rstest/core';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/meta-consumer');
const require = createRequire(import.meta.url);
const rstestBin = resolve(dirname(require.resolve('@rstest/core/package.json')), 'bin', 'rstest.js');

interface RstestRun {
  readonly code: number | null;
  readonly output: string;
}

/**
 * Runs one of the fixture's own Rstest pools the way a consumer would:
 * `rstest --config <file>` from the project root, resolving the preset from
 * this repository's source. The default reporter is pinned because Rstest
 * switches to its agent report when it detects a non-interactive caller;
 * output is merged and stripped of escape sequences so a failure prints the
 * whole run in the assertion message and Node's colorized error dumps match.
 */
const runFixturePool = (configFile: string): Promise<RstestRun> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [rstestBin, '--config', configFile, '--reporter=default'], {
      cwd: fixtureRoot,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => { resolvePromise({ code, output: stripVTControlCharacters(output) }); });
  });

describe('a consumer project whose source imports agent-bundle/meta (#386)', () => {
  it('declares in package.json the identity its tests assert', async () => {
    const packageJson = JSON.parse(await readFile(resolve(fixtureRoot, 'package.json'), 'utf8')) as {
      readonly name: string;
      readonly version: string;
    };
    const unitTest = await readFile(resolve(fixtureRoot, 'tests/unit/identity.test.ts'), 'utf8');
    const routeTest = await readFile(resolve(fixtureRoot, 'tests/route-unit/identity.test.ts'), 'utf8');

    for (const source of [unitTest, routeTest]) {
      expect(source).toContain(`packageName: '${packageJson.name}'`);
      expect(source).toContain(`packageVersion: '${packageJson.version}'`);
      expect(source).toContain(`version: '${packageJson.version}'`);
    }
  });

  it('runs plain unit tests that import the module under agentBundleRstest()', { timeout: 180_000 }, async () => {
    const run = await runFixturePool('rstest.config.ts');

    expect(run.output).not.toContain('AB4760');
    expect(run.output).not.toContain('is available only inside a surface Agent Bundle compiles');
    expect(run.output).toMatch(/Tests\s+2 passed/u);
    expect(run.code).toBe(0);
  });

  it('renders and dispatches routes reaching the module through renderRoute and invokeCli', { timeout: 180_000 }, async () => {
    const run = await runFixturePool('rstest.route-unit.config.ts');

    expect(run.output).not.toContain('AB4760');
    expect(run.output).toMatch(/Tests\s+2 passed/u);
    expect(run.code).toBe(0);
  });

  it('fails the same unit tests with AB4760 when the pool is not built from the preset', { timeout: 180_000 }, async () => {
    // The published module is what `agent-bundle/meta` resolves to without
    // the alias; this pool runs after `pnpm build`, so that module is dist/meta.js.
    const run = await runFixturePool('rstest.no-preset.config.ts');

    expect(run.code).not.toBe(0);
    expect(run.output).toContain('[AB4760] agent-bundle/meta is available only inside a surface Agent Bundle compiles');
    expect(run.output).toContain('recovery: Run the test under agentBundleRstest() or agentBundleBrowserRstest()');
    expect(run.output).not.toContain('ReferenceError');
    expect(run.output).not.toMatch(/Tests\s+2 passed/u);
  });
});
