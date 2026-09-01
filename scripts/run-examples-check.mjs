import { spawn } from 'node:child_process';

const requestedTimeScale = Number(process.env.AGENT_BUNDLE_TEST_TIME_SCALE ?? '');
const timeScale = Number.isSafeInteger(requestedTimeScale) && requestedTimeScale >= 1
  ? Math.max(requestedTimeScale, 2)
  : 2;
const pnpmEntrypoint = process.env.npm_execpath;

if (pnpmEntrypoint === undefined || pnpmEntrypoint.length === 0) {
  throw new Error('run-examples-check.mjs must be launched through a pnpm package script.');
}

const child = spawn(process.execPath, [
  pnpmEntrypoint,
  '--filter',
  './examples/*',
  '--workspace-concurrency=3',
  'check',
], {
  env: {
    ...process.env,
    AGENT_BUNDLE_TEST_TIME_SCALE: String(timeScale),
  },
  stdio: 'inherit',
});

process.exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
