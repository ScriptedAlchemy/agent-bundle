#!/usr/bin/env node
// Runs the opt-in packed native smoke for one host through `npm run`, never
// `pnpm run`: the smoke packs and installs the release tarball with the
// `npm_execpath` of the script runner, and only npm's entrypoint understands
// `pack --json` (array / package-keyed object) and `install --omit=dev
// --no-audit --no-fund`. Under pnpm the same proof fails before any host runs
// ("npm pack --json returned 4 entries", then "Unknown options: 'omit'").

import { spawnSync } from 'node:child_process';

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
  const run = (args, environment = process.env) => {
    const { error, signal, status } = spawnSync(npm, args, { env: environment, stdio: 'inherit' });
    if (error !== undefined) throw error;
    if (status !== 0) throw new Error(`npm ${args.join(' ')} failed (${signal ?? status ?? 'unknown'}).`);
  };

  try {
    run(['run', 'build']);
    run(['run', 'test:packed:native'], { ...process.env, [optIn]: '1' });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
