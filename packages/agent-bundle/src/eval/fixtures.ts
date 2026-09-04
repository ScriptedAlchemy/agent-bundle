import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Effect, FileSystem } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import fastGlob from 'fast-glob';

import { digest, sha256File, sha256Hex } from '../core/digest.ts';
import { EvalFixtureError } from './errors.ts';
import type { EvalFixture } from './types.ts';
import { isInside } from '../core/paths.ts';
import { isErrno } from '../core/errors.ts';
import { deepFreeze } from '../core/freeze.ts';
import { runWithPlatform } from '../effect/platform.ts';


const runCommand = promisify(execFile);

export interface EvalFixturePlanEntry {
  readonly executable: boolean;
  readonly path: string;
  readonly sha256: string;
}

export interface EvalFixturePlan {
  readonly digest: string;
  readonly entries: readonly EvalFixturePlanEntry[];
  readonly git: boolean;
  readonly sourcePath: string;
}

export interface PlanEvalFixtureOptions {
  readonly baseDir: string;
  readonly fixture: EvalFixture;
}

export interface MaterializeEvalFixtureOptions {
  readonly destination: string;
  readonly plan: EvalFixturePlan;
}

export interface MaterializedEvalFixture {
  readonly digest: string;
  readonly path: string;
}

const gitIgnorePatterns = Object.freeze(['.git', '.git/**']);

const fixtureError = (
  code: ConstructorParameters<typeof EvalFixtureError>[0],
  message: string,
): EvalFixtureError => new EvalFixtureError(code, message);

const resolveFixtureSource = async (options: PlanEvalFixtureOptions): Promise<string> => {
  const baseDir = resolve(options.baseDir);
  const source = resolve(baseDir, options.fixture.path);
  if (!isInside(baseDir, source)) {
    throw fixtureError('EVAL_FIXTURE_SOURCE_INVALID', 'An eval fixture must live inside its suite directory.');
  }
  let metadata;
  try {
    metadata = await lstat(source);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw fixtureError('EVAL_FIXTURE_SOURCE_INVALID', `Eval fixture ${JSON.stringify(options.fixture.path)} does not exist.`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw fixtureError(
      'EVAL_FIXTURE_SOURCE_INVALID',
      `Eval fixture ${JSON.stringify(options.fixture.path)} must be a non-symlink directory.`,
    );
  }
  if (!isInside(await realpath(baseDir), await realpath(source))) {
    throw fixtureError('EVAL_FIXTURE_SOURCE_INVALID', 'An eval fixture must not resolve outside its suite directory.');
  }
  return source;
};

/**
 * Records the exact allowlisted content of a fixture once, so every trial of a case
 * copies the same bytes and reports the same digest.
 */
export const planEvalFixture = async (options: PlanEvalFixtureOptions): Promise<EvalFixturePlan> => {
  const sourcePath = await resolveFixtureSource(options);
  const matches = await fastGlob([...options.fixture.include], {
    cwd: sourcePath,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...gitIgnorePatterns],
    onlyFiles: false,
  });
  const entries: EvalFixturePlanEntry[] = [];
  for (const match of [...new Set(matches)].sort((left, right) => left.localeCompare(right))) {
    const candidate = join(sourcePath, match);
    if (!isInside(sourcePath, candidate)) {
      throw fixtureError('EVAL_FIXTURE_ENTRY_UNSUPPORTED', `Eval fixture entry ${JSON.stringify(match)} escapes the fixture.`);
    }
    const metadata = await lstat(candidate);
    if (metadata.isDirectory()) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw fixtureError(
        'EVAL_FIXTURE_ENTRY_UNSUPPORTED',
        `Eval fixture entry ${JSON.stringify(match)} must be a regular file; symbolic links and special files are not copied.`,
      );
    }
    entries.push(Object.freeze({
      executable: (metadata.mode & 0o111) !== 0,
      path: match,
      sha256: await sha256File(candidate),
    }));
  }
  const frozenEntries = Object.freeze(entries);
  return Object.freeze({
    digest: digest({ entries: frozenEntries, git: options.fixture.git }),
    entries: frozenEntries,
    git: options.fixture.git,
    sourcePath,
  });
};

const initializeGitBaseline = async (workspace: string): Promise<void> => {
  const environment = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'evals@agent-bundle.invalid',
    GIT_AUTHOR_NAME: 'Agent Bundle Evals',
    GIT_COMMITTER_EMAIL: 'evals@agent-bundle.invalid',
    GIT_COMMITTER_NAME: 'Agent Bundle Evals',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const commands: readonly (readonly string[])[] = deepFreeze([
    ['-c', 'init.defaultBranch=main', 'init', '--quiet'],
    ['add', '--all'],
    ['commit', '--no-gpg-sign', '--quiet', '--allow-empty', '--message', 'Eval fixture baseline'],
  ]);
  for (const args of commands) {
    try {
      await runCommand('git', [...args], { cwd: workspace, env: environment });
    } catch (error) {
      throw fixtureError(
        'EVAL_FIXTURE_GIT_FAILED',
        `Eval fixture Git baseline failed at "git ${args.join(' ')}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
};

/** Creates one trial-owned workspace; a second trial always receives its own copy. */
export const materializeEvalFixture = async (
  options: MaterializeEvalFixtureOptions,
): Promise<MaterializedEvalFixture> => {
  const destination = resolve(options.destination);
  try {
    await lstat(destination);
    throw fixtureError(
      'EVAL_FIXTURE_DESTINATION_EXISTS',
      `Eval fixture destination ${JSON.stringify(destination)} already exists; every trial needs a fresh workspace.`,
    );
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await runWithPlatform(copyPlannedEntries(options.plan, destination));
  if (options.plan.git) await initializeGitBaseline(destination);

  return Object.freeze({ digest: options.plan.digest, path: destination });
};

/** The ordinary copy: every planned regular file, re-digested, written with its planned mode. */
const copyPlannedEntries = Effect.fnUntraced(function* (
  plan: EvalFixturePlan,
  destination: string,
): Effect.fn.Return<void, EvalFixtureError | PlatformError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(destination, { recursive: true });
  for (const entry of plan.entries) {
    const source = join(plan.sourcePath, entry.path);
    const target = join(destination, entry.path);
    const contents = yield* fs.readFile(source);
    if (sha256Hex(contents) !== entry.sha256) {
      return yield* Effect.fail(fixtureError(
        'EVAL_FIXTURE_SOURCE_INVALID',
        `Eval fixture entry ${JSON.stringify(entry.path)} changed after its digest was recorded.`,
      ));
    }
    yield* fs.makeDirectory(dirname(target), { recursive: true });
    yield* fs.writeFile(target, contents);
    yield* fs.chmod(target, entry.executable ? 0o755 : 0o644);
  }
});
