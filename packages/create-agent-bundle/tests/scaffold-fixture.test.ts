import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import { expectPassedPool } from './support/scaffold-fixture.ts';

/**
 * `expectPassedPool` is the release matrix's verdict on a scaffolded pool, so
 * its own fence is pinned here against a stub project whose npm scripts print
 * a Rstest-shaped JSON report and exit as instructed. The scaffolded pools
 * themselves run in scaffold-packed-matrix.e2e.test.ts.
 */
const poolScript = `
const scenario = process.argv[2];
const report = (tests) => JSON.stringify({
  files: [{ status: tests.some((test) => test.status === 'fail') ? 'fail' : 'pass' }],
  status: tests.some((test) => test.status === 'fail') ? 'fail' : 'pass',
  summary: { failedTests: tests.filter((test) => test.status === 'fail').length },
  tests,
}, null, 2);
console.log('Rstest v0.0.0');
switch (scenario) {
  case 'pass':
    console.log(report([{ name: 'greets', status: 'pass' }]));
    break;
  case 'pass-exit-1':
    console.log(report([{ name: 'greets', status: 'pass' }]));
    process.exitCode = 1;
    break;
  case 'fail':
    console.log(report([{ name: 'greets', status: 'fail' }]));
    process.exitCode = 1;
    break;
  case 'no-report':
    console.error('failed to load rstest.config.ts');
    process.exitCode = 2;
    break;
  default:
    throw new Error('unknown scenario ' + String(scenario));
}
`;

describe('expectPassedPool', () => {
  let projectRoot = '';

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'scaffold-fixture-pool-'));
    await writeFile(join(projectRoot, 'pool.mjs'), poolScript);
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
      name: 'pool-fixture',
      private: true,
      scripts: {
        'pool:fail': 'node pool.mjs fail',
        'pool:no-report': 'node pool.mjs no-report',
        'pool:pass': 'node pool.mjs pass',
        'pool:pass-exit-1': 'node pool.mjs pass-exit-1',
      },
      version: '0.0.0',
    }, null, 2));
  });

  afterAll(async () => {
    await rm(projectRoot, { force: true, recursive: true });
  });

  it('accepts a passing report whose script exited 0 and names the expected tests', async () => {
    await expect(expectPassedPool(projectRoot, 'pool:pass', ['greets'])).resolves.toBeUndefined();
  });

  it('rejects a passing report whose script exited non-zero', async () => {
    await expect(expectPassedPool(projectRoot, 'pool:pass-exit-1', ['greets']))
      .rejects.toThrow(/`npm run pool:pass-exit-1` exited 1 although its report says pass/u);
  });

  it('rejects a passing report that does not name an expected test', async () => {
    await expect(expectPassedPool(projectRoot, 'pool:pass', ['greets', 'lists'])).rejects.toThrow(/lists/u);
  });

  it('reports the failing test entry before the exit code', async () => {
    await expect(expectPassedPool(projectRoot, 'pool:fail', ['greets'])).rejects.toThrow(/greets[\s\S]*to deeply equal \[\]/u);
  });

  it('rejects a script that wrote no report, quoting its exit and stderr', async () => {
    await expect(expectPassedPool(projectRoot, 'pool:no-report', ['greets']))
      .rejects.toThrow(/wrote no Rstest JSON report \(exit 2\)[\s\S]*failed to load rstest\.config\.ts/u);
  });
});
