import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const examplesCheckScript = join(workspaceRoot, 'scripts', 'run-examples-check.mjs');

it('runs pnpm without shell syntax and floors the example time scale at two', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-examples-check-'));
  const fakePnpm = join(fixtureRoot, 'fake-pnpm.mjs');
  const capturePath = join(fixtureRoot, 'capture.json');
  await writeFile(fakePnpm, `
import { writeFile } from 'node:fs/promises';

await writeFile(process.env.FAKE_PNPM_CAPTURE, JSON.stringify({
  args: process.argv.slice(2),
  timeScale: process.env.AGENT_BUNDLE_TEST_TIME_SCALE,
}));
`, 'utf8');

  try {
    for (const [requestedScale, expectedScale] of [
      [undefined, '2'],
      ['1', '2'],
      ['invalid', '2'],
      ['4', '4'],
    ] as const) {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        FAKE_PNPM_CAPTURE: capturePath,
        npm_execpath: fakePnpm,
      };
      if (requestedScale === undefined) {
        delete environment.AGENT_BUNDLE_TEST_TIME_SCALE;
      } else {
        environment.AGENT_BUNDLE_TEST_TIME_SCALE = requestedScale;
      }

      await execFile(process.execPath, [examplesCheckScript], {
        cwd: workspaceRoot,
        env: environment,
      });
      const capture = JSON.parse(await readFile(capturePath, 'utf8')) as {
        readonly args: readonly string[];
        readonly timeScale: string;
      };
      expect(capture).toEqual({
        args: ['--filter', './examples/*', '--workspace-concurrency=3', 'check'],
        timeScale: expectedScale,
      });
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
