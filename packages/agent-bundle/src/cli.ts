#!/usr/bin/env node
import { Command, CommanderError } from 'commander';

import {
  build,
  inspect,
  validate,
  type ProjectOptions,
} from './api.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import { stableJson } from './core/digest.ts';

declare const __AGENT_BUNDLE_VERSION__: string;

interface Output {
  write(chunk: string): unknown;
}

export interface CliStreams {
  readonly stderr?: Output;
  readonly stdout?: Output;
}

interface SourceCommandOptions {
  readonly config?: string;
  readonly json?: boolean;
  readonly mode?: string;
  readonly root: string;
  readonly target?: readonly string[];
}

interface BuildCommandOptions extends SourceCommandOptions {
  readonly output?: string;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const configureSourceOptions = (command: Command): Command => command
  .option('--root <root>', 'Project root', process.cwd())
  .option('--config <path>', 'Configuration file relative to --root')
  .option('--mode <mode>', 'Configuration mode', 'production')
  .option('--target <target>', 'Target to select (repeatable)', collect, [])
  .option('--json', 'Write one machine-readable JSON document');

const projectOptions = (options: SourceCommandOptions): ProjectOptions => ({
  ...(options.config === undefined ? {} : { configPath: options.config }),
  mode: options.mode,
  root: options.root,
  targets: options.target,
});

const diagnosticsFor = (error: unknown): readonly Diagnostic[] => {
  if (error instanceof DiagnosticError) return error.diagnostics;
  return [{
    code: 'AB5000',
    message: error instanceof Error ? error.message : String(error),
    severity: 'error',
  }];
};

const writeMachine = (output: Output, result: unknown): void => {
  output.write(`${stableJson(result)}\n`);
};

const writeHumanBuild = (output: Output, result: Awaited<ReturnType<typeof build>>): void => {
  output.write(`Built ${result.model.metadata.name} to ${result.build.outputRoot}\n`);
};

const writeHumanInspect = (output: Output, result: Awaited<ReturnType<typeof inspect>>): void => {
  output.write(`Inspected ${result.model.metadata.name}: ${result.plans.map((plan) => plan.target).join(', ')}\n`);
};

const writeHumanValidate = (output: Output, result: Awaited<ReturnType<typeof validate>>): void => {
  output.write(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? `Validation reported ${result.diagnostics.length} diagnostic(s)\n`
    : 'Validation succeeded\n');
};

export const runCli = async (args: string[], streams: CliStreams = {}): Promise<number> => {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const program = new Command();
  program
    .name('agent-bundle')
    .version(__AGENT_BUNDLE_VERSION__)
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeErr: (chunk) => stderr.write(chunk),
      writeOut: (chunk) => stdout.write(chunk),
    });

  const buildCommand = configureSourceOptions(
    program.command('build').description('Build a validated Agent Bundle artifact'),
  ).option('--output <path>', 'Artifact output path relative to --root');
  buildCommand.action(async (options: BuildCommandOptions) => {
    const result = await build({ ...projectOptions(options), output: options.output });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanBuild(stdout, result);
  });

  const validateCommand = configureSourceOptions(
    program.command('validate').description('Validate project source or one artifact'),
  ).option('--artifact <path>', 'Validate exactly this built artifact');
  validateCommand.action(async (options: SourceCommandOptions & { readonly artifact?: string }) => {
    const result = await validate({ ...projectOptions(options), artifact: options.artifact });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanValidate(stdout, result);
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new DiagnosticError(result.diagnostics);
    }
  });

  const inspectCommand = configureSourceOptions(
    program.command('inspect').description('Inspect normalized targets and adapter plans'),
  )
    .option('--hooks', 'Include the hook focus')
    .option('--skills', 'Include the skill focus');
  inspectCommand.action(async (options: SourceCommandOptions & {
    readonly hooks?: boolean;
    readonly skills?: boolean;
  }) => {
    if (options.hooks === true && options.skills === true) {
      throw new TypeError('Choose at most one inspect focus.');
    }
    const result = await inspect({
      ...projectOptions(options),
      ...(options.hooks === true ? { focus: 'hooks' as const } : {}),
      ...(options.skills === true ? { focus: 'skills' as const } : {}),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanInspect(stdout, result);
  });

  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    writeMachine(stderr, diagnosticsFor(error));
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
