#!/usr/bin/env node

/**
 * Compares process startup with the cheap event preflight path and the full
 * standalone rendered-event path. The fixture intentionally uses the public
 * CLI and the composite-root hook layout emitted after #578.
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(workspaceRoot, 'packages', 'agent-bundle', 'bin', 'agent-bundle.js');
const defaultRuns = 7;

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const roundMs = (value) => Math.round(value * 100) / 100;

const parseRuns = () => {
  let value = process.env.AGENT_BUNDLE_BENCH_RUNS;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--runs') {
      value = process.argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith('--runs=')) {
      value = argument.slice('--runs='.length);
      continue;
    }
    throw new Error(`Unknown argument ${JSON.stringify(argument)}. Use --runs <positive integer>.`);
  }
  if (value === undefined) return defaultRuns;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`Run count must be a positive integer, received ${JSON.stringify(value)}.`);
  }
  return Number(value);
};

const run = (command, args, options = {}) =>
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
    child.once('close', (code, signal) => resolve({ code, signal, stderr, stdout }));
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const assertSuccessful = (label, result) => {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${label} failed (exit ${String(result.code)}, signal ${String(result.signal)}):\n${result.stderr || result.stdout}`,
    );
  }
};

const findGnuTime = async () => {
  for (const candidate of ['/usr/bin/time', '/bin/time']) {
    try {
      await access(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const version = await run(candidate, ['--version']);
    if (version.code === 0 && /GNU time/iu.test(`${version.stdout}\n${version.stderr}`)) return candidate;
  }
  return undefined;
};

const measureOnce = async ({ args, command, input, label, time, timeFile }) => {
  const measuredArgs = time === undefined
    ? args
    : [`--format=%M`, `--output=${timeFile}`, '--', command, ...args];
  const measuredCommand = time ?? command;
  const started = performance.now();
  const result = await run(measuredCommand, measuredArgs, { input });
  const wallMs = roundMs(performance.now() - started);
  assertSuccessful(label, result);

  let maxRssKiB = null;
  if (time !== undefined) {
    const rss = (await readFile(timeFile, 'utf8')).trim();
    if (!/^\d+$/u.test(rss)) {
      throw new Error(`GNU time returned an invalid max RSS for ${label}: ${JSON.stringify(rss)}.`);
    }
    maxRssKiB = Number(rss);
  }
  return { maxRssKiB, result, wallMs };
};

const cursorBeforeTool = (command) => JSON.stringify({
  conversation_id: 'conversation-cold-start',
  cwd: '/workspace',
  hook_event_name: 'preToolUse',
  session_id: 'session-cold-start',
  tool_input: { command },
  tool_name: 'Shell',
  tool_use_id: 'tool-cold-start',
});

const writeFixture = async (root) => {
  await mkdir(join(root, 'src', 'events', 'tool'), { recursive: true });
  await Promise.all([
    symlink(join(workspaceRoot, 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir'),
    writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'preflight-cold-start-fixture',
      type: 'module',
      version: '0.0.0',
    })),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        "import { defineConfig } from 'agent-bundle/config';",
        "export default defineConfig({ plugin: { name: 'preflight-cold-start-fixture', version: '0.0.0' }, targets: ['cursor'] });",
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'events', 'tool', 'before.preflight.ts'),
      [
        'export default ({ canonical }) => {',
        '  const input = canonical.payload.toolInput?.value;',
        '  const command = input !== null && typeof input === "object" && !Array.isArray(input)',
        '    ? input.command',
        '    : undefined;',
        '  return command === "execute-rendered-route" ? "execute" : { outcome: "continue" };',
        '};',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'events', 'tool', 'before.tsx'),
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "export { default as preflight } from './before.preflight.js';",
        "export const config = { providers: [], runtime: 'standalone', targets: ['cursor'] };",
        'export default async function BeforeTool() {',
        "  return createElement(Agent.Result, { value: { outcome: 'allow' } });",
        '}',
        '',
      ].join('\n'),
    ),
  ]);
};

const validatePlainNode = (result) => {
  if (result.stdout !== '' || result.stderr !== '') {
    throw new Error(`Plain Node produced output: ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout })}.`);
  }
};

const validatePreflight = (result) => {
  if (result.stdout !== '' || result.stderr !== '') {
    throw new Error(
      `No-op event preflight must pass through without output; received ${JSON.stringify({ stderr: result.stderr, stdout: result.stdout })}. The generated hook may still be loading and executing the rendered route.`,
    );
  }
};

const validateRenderedRoute = (result) => {
  if (result.stderr !== '') {
    throw new Error(`Rendered event route wrote stderr: ${JSON.stringify(result.stderr)}.`);
  }
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Rendered event route returned invalid JSON: ${JSON.stringify(result.stdout)}.`);
  }
  if (
    output === null
    || typeof output !== 'object'
    || Array.isArray(output)
    || output.permission !== 'allow'
    || Object.keys(output).length !== 1
  ) {
    throw new Error(`Rendered event route returned an unexpected result: ${JSON.stringify(output)}.`);
  }
};

const summarize = (measurements) => {
  const wallMs = measurements.map((sample) => sample.wallMs);
  const maxRssKiB = measurements.map((sample) => sample.maxRssKiB);
  const availableRss = maxRssKiB.every((value) => value !== null)
    ? maxRssKiB
    : null;
  return {
    samples: {
      maxRssKiB,
      wallMs,
    },
    medians: {
      maxRssKiB: availableRss === null ? null : median(availableRss),
      wallMs: roundMs(median(wallMs)),
    },
  };
};

const main = async () => {
  const runs = parseRuns();
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-preflight-cold-start-'));
  const output = join(root, 'artifact');
  const time = await findGnuTime();
  try {
    await writeFixture(root);
    const built = await run(process.execPath, [cli, 'build', '--root', root, '--output', output], {
      cwd: workspaceRoot,
    });
    assertSuccessful('agent-bundle build', built);

    // #578 emits all generated surfaces at the composite root. A one-target
    // event still keeps its host suffix because hook codecs are host-specific.
    const outputFiles = await readdir(output, { recursive: true });
    const hookMatches = outputFiles
      .filter((path) => path.endsWith('/hooks/event-route-tool-before.cursor.mjs')
        || path === 'hooks/event-route-tool-before.cursor.mjs'
        || path.endsWith('/hooks/event-route-tool-before.mjs')
        || path === 'hooks/event-route-tool-before.mjs');
    if (hookMatches.length !== 1) {
      throw new Error(
        `Build emitted ${String(hookMatches.length)} cursor tool/before wrappers; expected exactly one. Hooks: ${JSON.stringify(outputFiles.filter((path) => path.includes('hooks/')))}.`,
      );
    }
    const hook = join(output, hookMatches[0]);

    const measurements = {
      plainNode: [],
      preflightContinue: [],
      renderedRoute: [],
    };
    for (let index = 0; index < runs; index += 1) {
      const plain = await measureOnce({
        args: ['-e', ''],
        command: process.execPath,
        label: 'plain Node',
        time,
        timeFile: join(root, `time-plain-${String(index)}.txt`),
      });
      validatePlainNode(plain.result);
      measurements.plainNode.push(plain);

      const preflight = await measureOnce({
        args: [hook],
        command: process.execPath,
        input: cursorBeforeTool('no-op'),
        label: 'event preflight continue',
        time,
        timeFile: join(root, `time-preflight-${String(index)}.txt`),
      });
      validatePreflight(preflight.result);
      measurements.preflightContinue.push(preflight);

      const rendered = await measureOnce({
        args: [hook],
        command: process.execPath,
        input: cursorBeforeTool('execute-rendered-route'),
        label: 'rendered event route',
        time,
        timeFile: join(root, `time-rendered-${String(index)}.txt`),
      });
      validateRenderedRoute(rendered.result);
      measurements.renderedRoute.push(rendered);
    }

    const report = {
      kind: 'event-preflight-cold-start',
      runs,
      node: process.version,
      platform: process.platform,
      rss: time === undefined
        ? {
            available: false,
            reason: 'GNU time was not found; max RSS samples and medians are null.',
            source: null,
            unit: 'KiB',
          }
        : {
            available: true,
            reason: null,
            source: 'GNU time %M',
            unit: 'KiB',
          },
      benchmarks: {
        plainNode: {
          path: "node -e ''",
          ...summarize(measurements.plainNode),
        },
        preflightContinue: {
          path: 'hooks/event-route-tool-before.cursor.mjs (preflight continue)',
          ...summarize(measurements.preflightContinue),
        },
        renderedRoute: {
          path: 'hooks/event-route-tool-before.cursor.mjs (execute rendered route)',
          ...summarize(measurements.renderedRoute),
        },
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

await main();
