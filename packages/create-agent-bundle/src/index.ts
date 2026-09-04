import { spawn } from 'node:child_process';

import { cancel, intro, isCancel, log, multiselect, note, outro, select, text } from '@clack/prompts';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import type { PlatformError } from 'effect/PlatformError';

import { mapCause, runPromise } from './effect/boundary.ts';
import { liftPromise, liftTry } from './effect/lift.ts';
import { resolveFrameworkSpec } from './framework.ts';
import {
  UsageError,
  helpText,
  parseFlags,
  resolveOptions,
  type ParsedFlags,
  type Prompter,
  type ResolvedOptions,
} from './options.ts';
import { assertScaffoldTarget, scaffold } from './scaffold.ts';

/** Cancelled prompts end the run quietly with exit code 0, as create-rstack does. */
const checkCancel = <T>(value: T | symbol): T => {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    process.exit(0);
  }
  return value as T;
};

const clackPrompter: Prompter = {
  multiselect: async (options) => checkCancel(await multiselect({
    initialValues: [...options.initialValues],
    message: options.message,
    options: options.options.map((option) => ({ ...option })),
    required: false,
  })),
  select: async (options) => checkCancel(await select({
    message: options.message,
    options: options.options.map((option) => ({ ...option })),
  })),
  text: async (options) => checkCancel(await text({
    defaultValue: options.defaultValue,
    message: options.message,
    placeholder: options.placeholder,
  })),
};

/**
 * The version must be read from disk at run time, not inlined at build time:
 * pkg.pr.new rewrites the manifest version to `<version>-preview-<sha>` when
 * it packs the preview tarball, and that suffix is what pairs the scaffolded
 * project with the matching agent-bundle preview.
 */
const ownVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = yield* path.fromFileUrl(new URL('../package.json', import.meta.url)).pipe(
    // The URL is built from import.meta.url, so a `BadArgument` here is a bug.
    Effect.orDie,
  );
  const manifest = JSON.parse(yield* fs.readFileString(manifestPath)) as { readonly version: string };
  return manifest.version;
});

const runInstall = (options: ResolvedOptions, targetDirectory: string): Effect.Effect<number, Error> =>
  liftPromise(() => {
    log.step(`Installing dependencies with ${options.packageManager}...`);
    return new Promise<number>((resolvePromise, rejectPromise) => {
      const child = spawn(options.packageManager, ['install'], { cwd: targetDirectory, stdio: 'inherit' });
      child.on('error', rejectPromise);
      child.on('close', (code) => { resolvePromise(code ?? 1); });
    });
  });

const nextSteps = (options: ResolvedOptions): string => {
  const steps = [`cd ${options.targetDir}`];
  if (!options.install) steps.push(`${options.packageManager} install`);
  steps.push(`${options.packageManager} run dev`, `${options.packageManager} run check`);
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
};

/**
 * The scaffold run after flag parsing. Filesystem work goes through the
 * `FileSystem` / `Path` services; the failure → exit-code contract is the
 * CLI's: `UsageError` cancels with exit 2, anything else with exit 1.
 */
const scaffoldProgram = Effect.fnUntraced(function* (
  flags: ParsedFlags,
): Effect.fn.Return<0 | 1 | 2, PlatformError, FileSystem.FileSystem | Path.Path> {
  // Reading this package's own manifest fails before the intro, exactly as
  // it did as a rejected Promise: no cancel banner, the error leaves runCli.
  const version = yield* ownVersion;
  intro(`create-agent-bundle ${version}`);
  const run = Effect.gen(function* () {
    const path = yield* Path.Path;
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const options = yield* liftPromise(() => resolveOptions(flags, {
      interactive,
      prompter: clackPrompter,
      userAgent: process.env['npm_config_user_agent'],
    }));
    const frameworkSpec = yield* liftTry(() => resolveFrameworkSpec(version, options.frameworkVersion));
    const targetDirectory = path.resolve(process.cwd(), options.targetDir);
    yield* assertScaffoldTarget(targetDirectory, options.targetDir);

    const templateRoot = yield* path.fromFileUrl(new URL(`../templates/${options.template}`, import.meta.url)).pipe(
      Effect.orDie,
    );
    const files = yield* scaffold({
      frameworkSpec,
      packageName: options.packageName,
      pluginName: options.pluginName,
      targetDirectory,
      targets: options.targets,
      templateRoot,
    });
    log.success(`Scaffolded the ${options.template} template into ${options.targetDir} (${files.length} files).`);
    log.info(`agent-bundle is pinned to ${frameworkSpec} — see docs/preview-packages.md in the repository for the preview channel.`);

    if (options.install) {
      const exitCode = yield* runInstall(options, targetDirectory);
      if (exitCode !== 0) {
        log.warn(`${options.packageManager} install failed (exit code ${exitCode}). Run "${options.packageManager} install" in ${options.targetDir} manually.`);
        outro('Scaffolded, but dependencies are not installed.');
        return 1 as const;
      }
    }

    note(nextSteps(options), 'Next steps');
    outro('Project ready.');
    return 0 as const;
  });
  // `catchCause`, not `catch`: template-drift rewrites throw plain Errors,
  // which surface as defects, and they must cancel with the same message.
  return yield* run.pipe(Effect.catchCause((cause) => Effect.sync((): 1 | 2 => {
    const error = mapCause(cause);
    if (error instanceof UsageError) {
      cancel(error.message);
      return 2;
    }
    cancel(error.message);
    return 1;
  })));
});

export const runCli = async (argv: readonly string[]): Promise<0 | 1 | 2> => {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${helpText}`);
      return 2;
    }
    throw error;
  }
  if (flags.help) {
    process.stdout.write(helpText);
    return 0;
  }
  // The one composition root: the Node platform services are provided here
  // and nowhere else in the package.
  return runPromise(Effect.provide(scaffoldProgram(flags), NodeServices.layer));
};
