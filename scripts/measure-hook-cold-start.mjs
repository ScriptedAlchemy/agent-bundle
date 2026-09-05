#!/usr/bin/env node

/**
 * Cold-start budget for a generated stdio hook entry. Hosts run hooks under
 * tight deadlines; Stage 2 must not regress this number. Writes
 * docs/effect-cold-start-baseline.json, or checks it with --check.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = join(workspaceRoot, 'docs', 'effect-cold-start-baseline.json');
const samples = 7;
const cli = join(workspaceRoot, 'packages', 'agent-bundle', 'bin', 'agent-bundle.js');

const nativeSessionStart = JSON.stringify({
  cwd: '/workspace',
  hook_event_name: 'SessionStart',
  session_id: 'session-cold-start',
  source: 'startup',
  transcript_path: '/workspace/transcript.json',
});

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr, stdout }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const measureOnce = async (hookPath) => {
  const started = performance.now();
  const result = await run(process.execPath, [hookPath], { input: nativeSessionStart });
  const elapsedMs = performance.now() - started;
  if (result.code !== 0) {
    throw new Error(`Generated hook exited ${String(result.code)}: ${result.stderr || result.stdout}`);
  }
  return elapsedMs;
};

const findGeneratedHook = async (artifactRoot) => {
  // The built artifact is the plugin root itself (#555): hooks/ sits at its top.
  const claudeHooks = join(artifactRoot, 'hooks');
  const names = await readdir(claudeHooks);
  const hook = names.find((name) => name.endsWith('.mjs') && !name.includes('cursor'));
  if (hook === undefined) throw new Error(`No generated stdio hook under ${claudeHooks}`);
  return join(claudeHooks, hook);
};

const measure = async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-cold-start-'));
  const output = join(root, 'artifact');
  try {
    await mkdir(join(root, 'src', 'hooks'), { recursive: true });
    await Promise.all([
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(root, 'agent-bundle.config.ts'),
        [
          'export default {',
          '  hooks: { sessionStart: { handler: "./src/hooks/session-start.ts" } },',
          "  plugin: { name: 'cold-start', version: '0.0.0' },",
          "  targets: ['claude'],",
          '};',
          '',
        ].join('\n'),
      ),
      writeFile(
        join(root, 'src', 'hooks', 'session-start.ts'),
        "export default () => ({ additionalContext: 'cold-start', outcome: 'continue' as const });\n",
      ),
    ]);
    const built = await run(process.execPath, [cli, 'build', '--root', root, '--output', output], {
      cwd: workspaceRoot,
    });
    if (built.code !== 0) {
      throw new Error(`agent-bundle build failed:\n${built.stderr || built.stdout}`);
    }
    const hookPath = await findGeneratedHook(output);
    const samplesMs = [];
    for (let index = 0; index < samples; index += 1) {
      samplesMs.push(await measureOnce(hookPath));
    }
    const rounded = samplesMs.map((value) => Math.round(value * 100) / 100);
    return {
      effect: '4.0.0-rc.112',
      hookPath: 'hooks/<generated-session-start>.mjs',
      kind: 'generated-stdio-hook-cold-start',
      maxMs: Math.round(Math.max(...rounded) * 100) / 100,
      measuredAt: new Date().toISOString(),
      medianMs: Math.round(median(rounded) * 100) / 100,
      minMs: Math.round(Math.min(...rounded) * 100) / 100,
      node: process.version,
      notes: 'Budget gate for Wave 3.5 stage 2. Re-run with pnpm bench:hook-cold-start -- --check.',
      samplesMs: rounded,
    };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const checkAgainst = (baseline, measured) => {
  const slack = Math.max(25, baseline.medianMs * 0.25);
  const limit = baseline.medianMs + slack;
  if (measured.medianMs > limit) {
    throw new Error(
      `Hook cold-start median ${String(measured.medianMs)}ms exceeds budget ${String(limit)}ms (baseline ${String(baseline.medianMs)}ms + ${String(slack)}ms).`,
    );
  }
};

const writeBaseline = async (measured) => {
  await writeFile(baselinePath, `${JSON.stringify(measured, null, 2)}\n`);
};

const main = async () => {
  const check = process.argv.includes('--check');
  const measured = await measure();
  if (check) {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    checkAgainst(baseline, measured);
    process.stdout.write(
      `hook cold-start ok: median ${String(measured.medianMs)}ms (baseline ${String(baseline.medianMs)}ms)\n`,
    );
    return;
  }
  await writeBaseline(measured);
  process.stdout.write(`wrote ${baselinePath} (median ${String(measured.medianMs)}ms)\n`);
};

await main();
