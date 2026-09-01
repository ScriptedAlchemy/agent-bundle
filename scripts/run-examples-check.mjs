import { spawn } from 'node:child_process';

const requestedTimeScale = Number(process.env.AGENT_BUNDLE_TEST_TIME_SCALE ?? '');
const timeScale = Number.isSafeInteger(requestedTimeScale) && requestedTimeScale >= 1
  ? Math.max(requestedTimeScale, 2)
  : 2;
const pnpmEntrypoint = process.env.npm_execpath;

if (pnpmEntrypoint === undefined || pnpmEntrypoint.length === 0) {
  throw new Error('run-examples-check.mjs must be launched through a pnpm package script.');
}

// npm_execpath is a JavaScript entrypoint under corepack and pnpm's own
// installer, but a native shim (or a bare command name) under standalone
// setups such as pnpm/setup on hosted CI. Only JavaScript files can be
// launched through the current Node executable.
const isJavaScriptEntrypoint = /\.[cm]?js$/u.test(pnpmEntrypoint);
const command = isJavaScriptEntrypoint ? process.execPath : pnpmEntrypoint;
const child = spawn(command, [
  ...(isJavaScriptEntrypoint ? [pnpmEntrypoint] : []),
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
