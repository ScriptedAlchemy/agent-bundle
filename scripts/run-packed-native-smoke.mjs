#!/usr/bin/env node
// Runs the opt-in packed native smoke for one host through `npm run`, never
// `pnpm run`: the smoke packs and installs the release tarball with the
// `npm_execpath` of the script runner, and only npm's entrypoint understands
// `pack --json` (array / package-keyed object) and `install --omit=dev
// --no-audit --no-fund`. Under pnpm the same proof fails before any host runs
// ("npm pack --json returned 4 entries", then "Unknown options: 'omit'").

import { spawn } from 'node:child_process';

const host = process.argv[2];
const optIn = host === 'claude'
  ? 'AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE'
  : host === 'codex'
    ? 'AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE'
    : undefined;

if (optIn === undefined) {
  process.stderr.write('Usage: node scripts/run-packed-native-smoke.mjs <claude|codex>\n');
  process.exitCode = 2;
} else {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const run = (args, environment = process.env) => new Promise((resolvePromise, reject) => {
    const child = spawn(npm, args, { env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`npm ${args.join(' ')} failed (${signal ?? code ?? 'unknown'}).`));
    });
  });

  try {
    await run(['run', 'build']);
    await run(['run', 'test:packed:native'], { ...process.env, [optIn]: '1' });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
