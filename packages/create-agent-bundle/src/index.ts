import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cancel, intro, isCancel, log, multiselect, note, outro, select, text } from '@clack/prompts';

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
const ownVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    readonly version: string;
  };
  return manifest.version;
};

const runInstall = async (options: ResolvedOptions, targetDirectory: string): Promise<number> => {
  log.step(`Installing dependencies with ${options.packageManager}...`);
  return new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(options.packageManager, ['install'], { cwd: targetDirectory, stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('close', (code) => { resolvePromise(code ?? 1); });
  });
};

const nextSteps = (options: ResolvedOptions): string => {
  const steps = [`cd ${options.targetDir}`];
  if (!options.install) steps.push(`${options.packageManager} install`);
  steps.push(`${options.packageManager} run dev`, `${options.packageManager} run check`);
  return steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
};

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

  const version = await ownVersion();
  intro(`create-agent-bundle ${version}`);
  try {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    const options = await resolveOptions(flags, {
      interactive,
      prompter: clackPrompter,
      userAgent: process.env['npm_config_user_agent'],
    });
    const frameworkSpec = resolveFrameworkSpec(version, options.frameworkVersion);
    const targetDirectory = resolve(process.cwd(), options.targetDir);
    await assertScaffoldTarget(targetDirectory, options.targetDir);

    const templateRoot = fileURLToPath(new URL(`../templates/${options.template}`, import.meta.url));
    const files = await scaffold({
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
      const exitCode = await runInstall(options, targetDirectory);
      if (exitCode !== 0) {
        log.warn(`${options.packageManager} install failed (exit code ${exitCode}). Run "${options.packageManager} install" in ${options.targetDir} manually.`);
        outro('Scaffolded, but dependencies are not installed.');
        return 1;
      }
    }

    note(nextSteps(options), 'Next steps');
    outro('Project ready.');
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      cancel(error.message);
      return 2;
    }
    cancel(error instanceof Error ? error.message : String(error));
    return 1;
  }
};
