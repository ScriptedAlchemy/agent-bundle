/**
 * Local CI gate — one command that proves what the hosted CI gate jobs prove
 * (.github/workflows/ci.yml), on the development machine, across the same
 * three Node.js majors, in parallel. `pnpm check:local-ci` runs everything;
 * `pnpm check:local-ci --current-node-only` runs one Verify leg on the
 * current Node for quick iteration. docs/local-ci.md is the workflow
 * contract (including what is deliberately NOT covered); keep it in sync.
 *
 * Hosted job → local leg mapping:
 * - verify (Node 22.19 / 24 / 26) → legs `verify-node22|24|26`: install,
 *   playwright chrome, build, lint:package, typecheck, lint, test:unit,
 *   test:integration — the same package scripts in the same order.
 * - examples-check + release-gates + rsc-runtime-micro-eval (all Node 22.19)
 *   → leg `gates-node22`: examples:check, check:release, eval:spot run
 *   sequentially in one worktree. Each of those scripts starts from
 *   `pnpm build`, so folding three hosted checkouts into one worktree keeps
 *   every artifact expectation they have.
 * - dependency-review (GitHub-side action), package-preview and the release
 *   publish (publish-side), host-install-proofs (needs the pinned claude and
 *   codex CLIs on PATH; `pnpm check:host-cli` + the test:host-install
 *   scripts run it by hand), and native-host-smoke (opt-in, needs signed-in
 *   host CLIs) are intentionally not mirrored — see docs/local-ci.md.
 *
 * Isolation model: every leg gets its own git worktree pinned to HEAD with
 * its own node_modules — node_modules trees with native modules must never
 * be shared across Node ABIs. The shared pnpm store is content-addressed
 * (and side-effects caches are keyed by engine), so concurrent per-leg
 * installs stay cheap. Legs live under .worktrees/local-ci/ (gitignored) and
 * are reused across runs for warm caches; `--fresh` recreates them. Each leg
 * also gets a private TMPDIR (os.tmpdir()/abci-<hash8>-<leg>, where <hash8>
 * is derived from the repo root path; recreated every run): concurrent legs
 * would otherwise share /tmp, and suites that assert temp-root hygiene
 * (cli.test.ts scans os.tmpdir() for leaked agent-bundle-artifact-*
 * directories) would see a sibling leg's in-flight temp traffic and fail on
 * it (#110). The temp roots deliberately live under the SYSTEM temp
 * directory, not the repo worktree: Chrome creates AF_UNIX sockets inside
 * TMPDIR, and the kernel caps socket paths at 108 bytes — a repo-nested
 * TMPDIR overflows that and crashes every browser test at launch.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile as executeFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const usage = `Usage: pnpm check:local-ci [--current-node-only] [--fresh]
  --current-node-only  Run a single Verify leg on the Node currently on PATH
                       (fast iteration path; skips the Node matrix and the
                       examples/release/micro-eval gates).
  --fresh              Recreate the per-leg worktrees from scratch (drops
                       their node_modules and build caches).`;

const cliArguments = new Set(process.argv.slice(2));
const currentNodeOnly = cliArguments.delete('--current-node-only');
const freshLegs = cliArguments.delete('--fresh');
if (cliArguments.delete('--help') || cliArguments.delete('-h')) {
  console.log(usage);
  process.exit(0);
}
if (cliArguments.size > 0) {
  console.error(`Unknown arguments: ${[...cliArguments].join(' ')}\n${usage}`);
  process.exit(2);
}

const legsRoot = process.env.AGENT_BUNDLE_LOCAL_CI_DIR ?? join(repositoryRoot, '.worktrees', 'local-ci');
const logsRoot = join(legsRoot, 'logs');

const execGit = (args) => execFile('git', args, { cwd: repositoryRoot });

/** The hosted Verify matrix. `spec` feeds version-manager lookups; `matches` pins the leg to the hosted runtime line. */
const hostedNodeLines = [
  { key: '22', spec: '22.19', hostedRuntime: '22.19.0', matches: (v) => v.major === 22 && v.minor === 19 },
  { key: '24', spec: '24', hostedRuntime: '24', matches: (v) => v.major === 24 },
  { key: '26', spec: '26', hostedRuntime: '26', matches: (v) => v.major === 26 },
];

const parseNodeVersion = (raw) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (match === null) throw new Error(`Unparseable Node version: ${raw}`);
  return { major: Number(match[1]), minor: Number(match[2]), text: raw.trim().replace(/^v/, 'v') };
};

const nodeBinaryVersion = async (binary) => parseNodeVersion((await execFile(binary, ['--version'])).stdout);

/**
 * Resolve a Node binary for a hosted runtime line without introducing new
 * tooling: an explicit override, then mise, then nvm, then the current
 * process. Anything found is version-checked against the hosted line.
 */
const resolveNodeBinary = async (line) => {
  const candidates = [];
  const override = process.env[`AGENT_BUNDLE_LOCAL_CI_NODE_${line.key}`];
  if (override !== undefined && override.length > 0) {
    candidates.push(existsSync(join(override, 'node')) ? join(override, 'node') : override);
  }
  try {
    const { stdout } = await execFile('mise', ['where', `node@${line.spec}`]);
    candidates.push(join(stdout.trim(), 'bin', 'node'));
  } catch {
    // mise is absent or has no matching install; fall through.
  }
  try {
    const nvmVersions = await readdir(join(homedir(), '.nvm', 'versions', 'node'));
    const matching = nvmVersions
      .map((name) => {
        try {
          return parseNodeVersion(name);
        } catch {
          return undefined;
        }
      })
      .filter((version) => version !== undefined && line.matches(version))
      .sort((a, b) => b.major - a.major || b.minor - a.minor);
    if (matching.length > 0) candidates.push(join(homedir(), '.nvm', 'versions', 'node', matching[0].text, 'bin', 'node'));
  } catch {
    // No nvm directory; fall through.
  }
  candidates.push(process.execPath);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const version = await nodeBinaryVersion(candidate);
      if (line.matches(version)) return { binary: candidate, version };
    } catch {
      // Candidate is not a runnable Node binary; keep looking.
    }
  }
  throw new Error(
    `No Node ${line.spec}.x found for the ${line.hostedRuntime} leg. Install one non-interactively `
    + `(e.g. \`mise install node@${line.spec}\` or \`nvm install ${line.spec}\`) or point `
    + `AGENT_BUNDLE_LOCAL_CI_NODE_${line.key} at a Node binary or bin directory.`,
  );
};

/**
 * The pnpm CLI entrypoint, pinned to the pnpm this run was launched with:
 * npm_execpath when launched through `pnpm check:local-ci`, otherwise the
 * `pnpm` on PATH (a corepack shim is a Node script, which works the same
 * way). Each leg runs this entrypoint ON ITS OWN Node via a wrapper, so
 * pnpm and every lifecycle child agree on the leg's runtime.
 */
const resolvePnpmEntrypoint = async () => {
  const fromEnvironment = process.env.npm_execpath;
  if (fromEnvironment !== undefined && /pnpm/i.test(fromEnvironment) && existsSync(fromEnvironment)) return fromEnvironment;
  const { stdout } = await execFile('/bin/sh', ['-c', 'command -v pnpm']);
  const onPath = stdout.trim();
  if (onPath.length === 0) throw new Error('pnpm was not found on PATH.');
  return onPath;
};

const scrubbedExactKeys = new Set(['CI', 'NODE', 'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'INIT_CWD']);
const scrubbedPrefixPattern = /^(npm_|PNPM_|COREPACK_|GITHUB_|AGENT_BUNDLE_)/i;

/**
 * A leg environment starts from the caller's environment minus everything a
 * package-manager parent or CI shell would leak in (npm_, PNPM_, CI, ...),
 * with PATH rebuilt so the leg's Node wins and no workspace .bin leaks in.
 */
const buildLegEnvironment = (syntheticBinDirectory, overrides) => {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (scrubbedExactKeys.has(key) || scrubbedPrefixPattern.test(key)) continue;
    environment[key] = value;
  }
  const retainedPath = (process.env.PATH ?? '')
    .split(':')
    .filter((entry) => entry.length > 0 && !entry.includes('/node_modules/.bin'));
  environment.PATH = [syntheticBinDirectory, ...retainedPath].join(':');
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  environment.COREPACK_ENABLE_AUTO_PIN = '0';
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

/**
 * node symlink, npm/npx exec wrappers, and a pnpm wrapper that pins pnpm to
 * the leg's Node. npm and npx must be exec wrappers to their real paths (not
 * symlinks): npm's shell launcher resolves its Node sibling relative to $0
 * without following symlinks, so a symlinked npm looks for node next to the
 * symlink and finds nothing.
 */
const createSyntheticBinDirectory = async (leg, pnpmEntrypoint) => {
  const directory = join(legsRoot, '.bin', leg.name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const nodeBinDirectory = dirname(leg.nodeBinary);
  await symlink(leg.nodeBinary, join(directory, 'node'));
  const writeExecWrapper = async (name, commandLine) => {
    const wrapper = join(directory, name);
    await writeFile(wrapper, `#!/bin/sh\nexec ${commandLine} "$@"\n`);
    await chmod(wrapper, 0o755);
  };
  for (const tool of ['npm', 'npx']) {
    const source = join(nodeBinDirectory, tool);
    if (existsSync(source)) await writeExecWrapper(tool, `"${source}"`);
  }
  await writeExecWrapper('pnpm', `"${leg.nodeBinary}" "${pnpmEntrypoint}"`);
  return directory;
};

const ensureLegWorktree = async (legDirectory, sha) => {
  if (freshLegs) {
    await execGit(['worktree', 'remove', '--force', legDirectory]).catch(() => {});
    await rm(legDirectory, { recursive: true, force: true });
  }
  try {
    await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: legDirectory });
    await execFile('git', ['reset', '--hard', sha], { cwd: legDirectory });
    return;
  } catch {
    // Not an existing worktree: (re)create it.
  }
  await rm(legDirectory, { recursive: true, force: true });
  await execGit(['worktree', 'prune']);
  await execGit(['worktree', 'add', '--detach', legDirectory, sha]);
};

const formatDuration = (milliseconds) => {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
};

/**
 * Test census for the summary table, from the repo reporter's JSON counts
 * block (last one in the step log; a step like examples:check aggregates
 * several suites and is labelled as such).
 */
const extractTestCensus = (logText) => {
  const blocks = [
    ...logText.matchAll(
      /"testFiles":\s*(\d+)[\s\S]{0,200}?"tests":\s*(\d+),\s*"failedTests":\s*(\d+),\s*"passedTests":\s*(\d+),\s*"skippedTests":\s*(\d+)/g,
    ),
  ];
  if (blocks.length === 0) return undefined;
  const [, files, tests, , passed, skipped] = blocks[blocks.length - 1];
  const skippedSuffix = Number(skipped) > 0 ? `, ${skipped} skipped` : '';
  const summary = `${passed}/${tests} passed${skippedSuffix}, ${files} files`;
  return blocks.length > 1 ? `${summary} (last of ${blocks.length} suites)` : summary;
};

const runStep = async (leg, step, stepIndex) => {
  const logPath = join(logsRoot, leg.name, `${String(stepIndex + 1).padStart(2, '0')}-${step.id.replaceAll(':', '-')}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  const [tool, ...args] = step.command;
  const command = tool === 'pnpm' ? join(leg.syntheticBinDirectory, 'pnpm') : tool;
  const startedAt = Date.now();
  console.log(`[${leg.name}] ${step.id} started`);
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { cwd: leg.directory, env: leg.environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => {
      chunks.push(Buffer.from(`\nFailed to spawn ${command}: ${error.message}\n`));
      writeFile(logPath, Buffer.concat(chunks)).then(() => resolveExit(1), rejectExit);
    });
    child.on('close', (code) => {
      writeFile(logPath, Buffer.concat(chunks)).then(() => resolveExit(code ?? 1), rejectExit);
    });
  });
  const durationMs = Date.now() - startedAt;
  const logText = await readFile(logPath, 'utf8').catch(() => '');
  const census = extractTestCensus(logText);
  const status = exitCode === 0 ? 'pass' : 'fail';
  console.log(`[${leg.name}] ${step.id} ${status} in ${formatDuration(durationMs)}${census === undefined ? '' : ` (${census})`}`);
  if (status === 'fail') {
    const tail = logText.split('\n').slice(-25).join('\n');
    console.error(`[${leg.name}] ${step.id} failed (exit ${exitCode}). Log: ${logPath}\n${tail}`);
  }
  return { leg: leg.name, step: step.id, hostedJob: step.hostedJob, status, durationMs, census, logPath };
};

/** Steps run sequentially inside a leg; a failure skips the leg's remaining steps (matching a hosted job's step semantics). */
const runLeg = async (leg) => {
  const results = [];
  let failed = false;
  for (const [index, step] of leg.steps.entries()) {
    if (failed) {
      results.push({ leg: leg.name, step: step.id, hostedJob: step.hostedJob, status: 'skipped', durationMs: 0 });
      continue;
    }
    const result = await runStep(leg, step, index);
    results.push(result);
    if (result.status === 'fail') failed = true;
  }
  return results;
};

const main = async () => {
  const startedAt = Date.now();
  const { stdout: shaRaw } = await execGit(['rev-parse', 'HEAD']);
  const sha = shaRaw.trim();
  const { stdout: dirtyRaw } = await execGit(['status', '--porcelain']);
  if (dirtyRaw.trim().length > 0) {
    console.warn(
      '\nWARNING: the working tree has uncommitted changes. Legs check out the HEAD commit '
      + `(${sha.slice(0, 8)}); uncommitted work is NOT covered by this gate.\n`,
    );
  }

  const totalCores = availableParallelism();
  const verifyLegCount = currentNodeOnly ? 1 : 3;
  // Per-leg cap over the repo's own derivation (integration config computes
  // min(4, cores/2) for a leg that owns the machine): give each concurrent
  // leg a cores/N slice before halving, and keep the memory-bounding cap of 4.
  const integrationWorkerCap = Math.max(1, Math.min(4, Math.floor(totalCores / (2 * verifyLegCount))));
  const unitWorkerCap = Math.max(2, Math.floor(totalCores / verifyLegCount));
  // Full runs pin the polling-budget scale to 4 — the same scale hosted CI
  // uses — because three legs plus the gates leg share the machine by design.
  const timeScale = process.env.AGENT_BUNDLE_TEST_TIME_SCALE ?? (currentNodeOnly ? undefined : '4');

  const pnpmEntrypoint = await resolvePnpmEntrypoint();

  const verifyStepList = (unitCapArguments) => [
    { id: 'install', hostedJob: 'verify', command: ['pnpm', 'install', '--frozen-lockfile'] },
    // Hosted runs `playwright install --with-deps chrome`; --with-deps is
    // apt/root-only and the OS packages are a one-time machine setup, so the
    // local step installs/validates the browser only.
    { id: 'browsers', hostedJob: 'verify', command: ['pnpm', 'exec', 'playwright', 'install', 'chrome'] },
    { id: 'build', hostedJob: 'verify', command: ['pnpm', 'build'] },
    { id: 'lint:package', hostedJob: 'verify', command: ['pnpm', 'lint:package'] },
    { id: 'typecheck', hostedJob: 'verify', command: ['pnpm', 'typecheck'] },
    { id: 'lint', hostedJob: 'verify', command: ['pnpm', 'lint'] },
    { id: 'test:unit', hostedJob: 'verify', command: ['pnpm', 'test:unit', ...unitCapArguments] },
    { id: 'test:integration', hostedJob: 'verify', command: ['pnpm', 'test:integration'] },
  ];

  const legPlans = [];
  if (currentNodeOnly) {
    const version = await nodeBinaryVersion(process.execPath);
    legPlans.push({
      name: `verify-current-${version.text}`,
      nodeBinary: process.execPath,
      nodeVersion: version,
      // Fast path: keep the repo's own local defaults (this leg owns the machine).
      environmentOverrides: {},
      steps: verifyStepList([]),
    });
  } else {
    const sharedOverrides = {
      AGENT_BUNDLE_INTEGRATION_MAX_WORKERS: String(integrationWorkerCap),
      AGENT_BUNDLE_TEST_TIME_SCALE: timeScale,
    };
    for (const line of hostedNodeLines) {
      const { binary, version } = await resolveNodeBinary(line);
      legPlans.push({
        name: `verify-node${line.key}`,
        nodeBinary: binary,
        nodeVersion: version,
        environmentOverrides: sharedOverrides,
        steps: verifyStepList(['--pool.maxWorkers', String(unitWorkerCap)]),
      });
    }
    const node22 = legPlans.find((leg) => leg.name === 'verify-node22');
    legPlans.push({
      name: 'gates-node22',
      nodeBinary: node22.nodeBinary,
      nodeVersion: node22.nodeVersion,
      environmentOverrides: sharedOverrides,
      steps: [
        { id: 'install', hostedJob: 'examples-check/release-gates/micro-eval', command: ['pnpm', 'install', '--frozen-lockfile'] },
        { id: 'browsers', hostedJob: 'release-gates', command: ['pnpm', 'exec', 'playwright', 'install', 'chrome'] },
        { id: 'examples:check', hostedJob: 'examples-check', command: ['pnpm', 'examples:check'] },
        { id: 'check:release', hostedJob: 'release-gates', command: ['pnpm', 'check:release'] },
        { id: 'eval:spot', hostedJob: 'rsc-runtime-micro-eval', command: ['pnpm', 'eval:spot'] },
      ],
    });
  }

  console.log(`Local CI gate at ${sha.slice(0, 8)} — ${legPlans.length} leg(s), ${totalCores} cores`);
  console.log(
    `Caps: integration ${integrationWorkerCap} worker(s)/leg, unit ${currentNodeOnly ? '(repo default)' : `${unitWorkerCap} workers/leg`}, `
    + `time scale ${timeScale ?? '(repo default)'}`,
  );
  for (const leg of legPlans) console.log(`  ${leg.name}: ${leg.nodeVersion.text} (${leg.nodeBinary})`);

  await mkdir(legsRoot, { recursive: true });
  await rm(logsRoot, { recursive: true, force: true });
  const legs = [];
  for (const plan of legPlans) {
    const directory = join(legsRoot, plan.name);
    await ensureLegWorktree(directory, sha);
    const syntheticBinDirectory = await createSyntheticBinDirectory(plan, pnpmEntrypoint);
    // Private per-leg temp root (see the isolation model above). Recreating
    // it keeps every run's hygiene scans free of a crashed prior run's
    // leftovers, while a leak WITHIN a run still fails its own leg's scan.
    // It must be a SHORT path under the system temp root (never under the
    // repo worktree): Chrome creates AF_UNIX sockets in TMPDIR and the
    // kernel's sun_path limit is 108 bytes. The hash keys the directory to
    // this repo root, so concurrent runs from different checkouts cannot
    // collide while reruns from the same checkout reuse (and reset) it.
    const repositoryHash = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 8);
    const temporaryDirectory = join(tmpdir(), `abci-${repositoryHash}-${plan.name}`);
    await rm(temporaryDirectory, { recursive: true, force: true });
    await mkdir(temporaryDirectory, { recursive: true });
    legs.push({
      ...plan,
      directory,
      syntheticBinDirectory,
      environment: buildLegEnvironment(syntheticBinDirectory, {
        ...plan.environmentOverrides,
        TMPDIR: temporaryDirectory,
      }),
    });
  }

  const legResults = await Promise.all(legs.map((leg) => runLeg(leg)));
  const results = legResults.flat();
  const wallMs = Date.now() - startedAt;
  const failed = results.some((result) => result.status === 'fail');

  const rows = results.map((result) => [
    result.leg,
    result.step,
    result.status,
    result.status === 'skipped' ? '—' : formatDuration(result.durationMs),
    result.census ?? '—',
  ]);
  const header = ['Leg', 'Step', 'Status', 'Duration', 'Tests'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const renderRow = (row) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  const tableLines = [
    renderRow(header),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...rows.map(renderRow),
  ];
  const summaryMarkdown = [
    `# Local CI gate — ${new Date(startedAt).toISOString()}`,
    '',
    `Commit ${sha} · ${legs.length} leg(s) · wall time ${formatDuration(wallMs)} · ${failed ? 'FAILED' : 'GREEN'}`,
    '',
    ...tableLines,
    '',
    'Not covered locally: dependency-review (GitHub-side), package previews and npm publish (publish-side), native host smokes (opt-in). See docs/local-ci.md.',
    '',
  ].join('\n');

  const summaryPath = join(legsRoot, 'summary.md');
  await writeFile(summaryPath, summaryMarkdown);
  await writeFile(join(legsRoot, 'summary.json'), `${JSON.stringify({ sha, startedAt, wallMs, failed, results }, null, 2)}\n`);

  console.log(`\n${tableLines.join('\n')}`);
  console.log(`\nWall time ${formatDuration(wallMs)} · summary written to ${summaryPath}`);
  console.log(failed ? 'Local CI gate: FAILED' : 'Local CI gate: GREEN');
  process.exitCode = failed ? 1 : 0;
};

await main();
