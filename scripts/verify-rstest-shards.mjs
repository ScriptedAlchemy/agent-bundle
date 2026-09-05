/**
 * Guards the sharded integration pool: every `rstest --shard i/N` slice CI
 * runs must together cover `rstest.integration.config.ts` exactly. Rstest
 * sorts the collected files and hands each shard a contiguous slice, so a
 * shard that silently drops a file (or two shards that both run one) is a
 * pool-level bug the per-shard reporters cannot see — each shard only knows
 * its own files. This script lists the whole pool once and each shard once
 * (`rstest list --filesOnly`, no tests run) and fails when the shards are
 * not a partition of the pool: a file in no shard, a file in more than one,
 * a file outside the pool, or an empty shard.
 *
 *   node scripts/verify-rstest-shards.mjs --config rstest.integration.config.ts --count 2
 *
 * `rstest` is spawned directly from `@rstest/core`'s bin, not through
 * `pnpm exec`: with `CI=true` (every hosted runner) pnpm's exec runs its
 * install check first and prints that report on stdout, ahead of the file
 * list. The prebuilt seams are set so listing never triggers a build.
 */
import { execFile as executeFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';

const execFile = promisify(executeFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `rstest list --shard` prints this banner on stdout above the file list. */
const shardBannerPattern = /^Running shard \d+ of \d+/u;

/**
 * The test paths in `rstest list --filesOnly` stdout: one per line, with the
 * blank lines and the `Running shard i of N (...)` banner dropped. Color is
 * disabled when spawning, and stripped here in case a caller forces it on.
 */
export const parseRstestFileList = (text) => stripVTControlCharacters(text)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !shardBannerPattern.test(line));

/**
 * Compares the pool's file list with the per-shard lists. Pure: `ok` is true
 * only when the pool is non-empty, no shard is empty, and the shards are
 * pairwise disjoint with a union equal to the pool. Shard indices in `empty`
 * and `shards` are 1-based like `--shard i/N`.
 */
export const partitionReport = ({ all, shards }) => {
  const pool = new Set(all);
  const seen = new Map();
  for (const files of shards) {
    for (const file of files) {
      seen.set(file, (seen.get(file) ?? 0) + 1);
    }
  }

  const missing = [...pool].filter((file) => !seen.has(file)).sort();
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([file]) => file).sort();
  const extra = [...seen.keys()].filter((file) => !pool.has(file)).sort();
  const empty = shards.flatMap((files, index) => (files.length === 0 ? [index + 1] : []));
  const summaries = shards.map((files, index) => ({
    count: files.length,
    first: files[0],
    index: index + 1,
    last: files[files.length - 1],
  }));

  return {
    duplicated,
    empty,
    extra,
    missing,
    ok: pool.size > 0
      && empty.length === 0
      && missing.length === 0
      && duplicated.length === 0
      && extra.length === 0,
    shards: summaries,
    total: pool.size,
  };
};

const parseArgs = (argv) => {
  const options = { config: undefined, count: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') {
      options.config = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--count') {
      options.count = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.config === undefined || options.config.length === 0) {
    throw new Error('--config <rstest config> is required.');
  }
  if (options.count === undefined || !/^[1-9]\d*$/u.test(options.count)) {
    throw new Error('--count <shards> is required and must be a positive integer.');
  }
  return { config: options.config, count: Number(options.count) };
};

const rstestBinPath = () => {
  const nodeRequire = createRequire(import.meta.url);
  const packagePath = nodeRequire.resolve('@rstest/core/package.json');
  return resolve(dirname(packagePath), nodeRequire(packagePath).bin.rstest);
};

/** Lists the files `rstest --config <config> [--shard i/N]` would run, without running them. */
export const listRstestFiles = async ({ config, env = process.env, shard }) => {
  const args = ['list', '--config', config, '--filesOnly'];
  if (shard !== undefined) args.push('--shard', `${shard.index}/${shard.count}`);
  const label = `rstest ${args.join(' ')}`;
  let stdout;
  try {
    ({ stdout } = await execFile(process.execPath, [rstestBinPath(), ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...env,
        AGENT_BUNDLE_PACKAGE_PREBUILT: '1',
        AGENT_BUNDLE_WORKBENCH_PREBUILT: '1',
        NO_COLOR: '1',
      },
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    const detail = error !== null && typeof error === 'object' && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : String(error);
    throw new Error(`${label} failed: ${detail}`, { cause: error });
  }
  return parseRstestFileList(stdout);
};

const formatFiles = (files) => files.map((file) => `    ${file}`).join('\n');

const describeShard = ({ count, first, index, last }, shardCount) => {
  const prefix = `  shard ${index}/${shardCount}:`;
  if (count === 0) return `${prefix} 0 files`;
  if (count === 1) return `${prefix} 1 file, ${first}`;
  return `${prefix} ${count} files, ${first} … ${last}`;
};

export const runVerifyShards = async ({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) => {
  const { config, count } = parseArgs(argv);
  const all = await listRstestFiles({ config, env });
  const shards = [];
  for (let index = 1; index <= count; index += 1) {
    shards.push(await listRstestFiles({ config, env, shard: { count, index } }));
  }
  const report = partitionReport({ all, shards });

  const lines = [`${config}: ${report.total} test files`];
  for (const shard of report.shards) {
    lines.push(describeShard(shard, count));
  }
  if (report.ok) {
    lines.push(`Shards 1..${count} partition the pool exactly.`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return report;
  }

  const failures = [];
  if (report.total === 0) failures.push('  the pool lists no test files');
  if (report.empty.length > 0) failures.push(`  empty shards: ${report.empty.join(', ')}`);
  if (report.missing.length > 0) {
    failures.push(`  in the pool but in no shard (${report.missing.length}):\n${formatFiles(report.missing)}`);
  }
  if (report.duplicated.length > 0) {
    failures.push(`  in more than one shard (${report.duplicated.length}):\n${formatFiles(report.duplicated)}`);
  }
  if (report.extra.length > 0) {
    failures.push(`  in a shard but not in the pool (${report.extra.length}):\n${formatFiles(report.extra)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  process.stderr.write(`Shards 1..${count} do not partition ${config}:\n${failures.join('\n')}\n`);
  process.exitCode = 1;
  return report;
};

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await runVerifyShards();
}
