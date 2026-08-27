import { spawn } from 'node:child_process';

const target = process.env.AGENT_BUNDLE_WORKBENCH_API_PROXY;

if (target === undefined || target.trim().length === 0) {
  console.error('Set AGENT_BUNDLE_WORKBENCH_API_PROXY to the running Agent Bundle foreground server URL before starting contributor HMR.');
  process.exitCode = 2;
} else {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, ['exec', 'rsbuild', 'dev', ...process.argv.slice(2)], {
    env: process.env,
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === null ? 0 : 1);
  });
}
