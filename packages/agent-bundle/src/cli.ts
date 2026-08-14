#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  build,
  inspect,
  invokeMcp,
  listHooks,
  listMcp,
  simulateHook,
  startDevServer,
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

export interface CliDependencies {
  readonly startDevServer?: typeof startDevServer;
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

interface InspectCommandOptions {
  readonly config?: string;
  readonly hooks?: boolean;
  readonly json?: boolean;
  readonly mode?: string;
  readonly root: string;
  readonly skills?: boolean;
  readonly target?: string;
}

interface ArtifactCommandOptions {
  readonly artifact?: string;
  readonly config?: string;
  readonly json?: boolean;
  readonly mode?: string;
  readonly root: string;
  readonly target?: string;
}

interface JsonInputOptions {
  readonly input?: string;
  readonly inputFile?: string;
}

interface DevCommandOptions {
  readonly open?: boolean;
  readonly port?: number;
  readonly root: string;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

const port = (value: string): number => {
  if (!/^(0|[1-9]\d{0,4})$/u.test(value)) throw new TypeError('Port must be a TCP port number.');
  const number = Number(value);
  if (number > 65_535) throw new TypeError('Port must be a TCP port number.');
  return number;
};

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

const inspectProjectOptions = (options: InspectCommandOptions): ProjectOptions => ({
  ...(options.config === undefined ? {} : { configPath: options.config }),
  mode: options.mode,
  root: options.root,
});

const configureInspectOptions = (command: Command): Command => command
  .option('--root <root>', 'Project root', process.cwd())
  .option('--config <path>', 'Configuration file relative to --root')
  .option('--mode <mode>', 'Configuration mode', 'production')
  .option('--target <target>', 'Filter inspection plans to one target')
  .option('--json', 'Write one machine-readable JSON document');

const configureArtifactOptions = (command: Command, targetRequired = false): Command => {
  const configured = command
    .option('--root <root>', 'Project root', process.cwd())
    .option('--config <path>', 'Configuration file relative to --root')
    .option('--mode <mode>', 'Configuration mode', 'production')
    .option('--artifact <path>', 'Use exactly this built artifact');
  const targetOption = targetRequired
    ? configured.requiredOption('--target <target>', 'Artifact target')
    : configured.option('--target <target>', 'Artifact target');
  return targetOption.option('--json', 'Write one machine-readable JSON document');
};

const artifactOptions = (options: ArtifactCommandOptions): ProjectOptions & { readonly artifact?: string } => ({
  ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
  ...(options.config === undefined ? {} : { configPath: options.config }),
  mode: options.mode,
  root: options.root,
  ...(options.target === undefined ? {} : { targets: [options.target] }),
});

const parseJsonObject = async (options: JsonInputOptions): Promise<Record<string, unknown>> => {
  if (options.input !== undefined && options.inputFile !== undefined) {
    throw new TypeError('Use either --input or --input-file, not both.');
  }
  const source = options.input ?? (options.inputFile === undefined
    ? undefined
    : await readFile(resolve(options.inputFile), 'utf8'));
  if (source === undefined) {
    throw new TypeError('Provide a JSON object with --input or --input-file.');
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new TypeError('Input must be valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Input must be a JSON object.');
  }
  return value as Record<string, unknown>;
};

const diagnosticsFor = (error: unknown): readonly Diagnostic[] => {
  if (error instanceof DiagnosticError) return error.diagnostics;
  return [{
    code: 'AB5000',
    message: error instanceof Error ? error.message : String(error),
    severity: 'error',
  }];
};

const writeMachine = (output: Output, result: unknown): void => {
  output.write(`${stableJson(result === undefined ? null : result)}\n`);
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

export const runCli = async (
  args: string[],
  streams: CliStreams = {},
  dependencies: CliDependencies = {},
): Promise<number> => {
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

  const devCommand = program.command('dev').description('Serve the packaged development workbench on loopback')
    .option('--root <root>', 'Project root', process.cwd())
    .option('--port <port>', 'Loopback TCP port', port)
    .option('--open', 'Open the workbench after the foreground server starts')
    .option('--no-open', 'Do not open the workbench after the foreground server starts');
  devCommand.action(async (options: DevCommandOptions) => {
    const session = await (dependencies.startDevServer ?? startDevServer)({
      open: options.open === true,
      ...(options.port === undefined ? {} : { port: options.port }),
      root: options.root,
    });
    stdout.write(`Development workbench at ${session.url}\n`);
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
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new DiagnosticError(result.diagnostics);
    }
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanValidate(stdout, result);
  });

  const inspectCommand = configureInspectOptions(
    program.command('inspect').description('Inspect normalized targets and adapter plans'),
  )
    .option('--hooks', 'Include the hook focus')
    .option('--skills', 'Include the skill focus');
  inspectCommand.action(async (options: InspectCommandOptions) => {
    if (options.hooks === true && options.skills === true) {
      throw new TypeError('Choose at most one inspect focus.');
    }
    const result = await inspect({
      ...inspectProjectOptions(options),
      ...(options.hooks === true ? { focus: 'hooks' as const } : {}),
      ...(options.skills === true ? { focus: 'skills' as const } : {}),
      ...(options.target === undefined ? {} : { target: options.target }),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanInspect(stdout, result);
  });

  const mcpCommand = program.command('mcp').description('Operate an MCP server from an artifact');
  const mcpListCommand = configureArtifactOptions(
    mcpCommand.command('list').description('List tools from one MCP server'),
    true,
  ).requiredOption('--server <server>', 'MCP server name');
  mcpListCommand.action(async (options: ArtifactCommandOptions & { readonly server: string }) => {
    const result = await listMcp({
      ...artifactOptions(options),
      server: options.server,
      target: options.target!,
    });
    if (options.json === true) writeMachine(stdout, result);
    else stdout.write(`Listed ${result.tools.length} tool(s) from ${options.server}\n`);
  });

  const mcpInvokeCommand = configureArtifactOptions(
    mcpCommand.command('invoke').description('Invoke one MCP tool'),
    true,
  )
    .requiredOption('--server <server>', 'MCP server name')
    .requiredOption('--tool <tool>', 'MCP tool name')
    .option('--input <json>', 'Inline JSON object input')
    .option('--input-file <path>', 'JSON object input file');
  mcpInvokeCommand.action(async (options: ArtifactCommandOptions & JsonInputOptions & {
    readonly server: string;
    readonly tool: string;
  }) => {
    const result = await invokeMcp({
      ...artifactOptions(options),
      input: await parseJsonObject(options),
      server: options.server,
      target: options.target!,
      tool: options.tool,
    });
    if (options.json === true) writeMachine(stdout, result);
    else stdout.write(`Invoked ${options.tool} on ${options.server}\n`);
  });

  const hooksCommand = program.command('hooks').description('Inspect and simulate generated hooks');
  const hooksListCommand = configureArtifactOptions(
    hooksCommand.command('list').description('List hooks from one artifact'),
  );
  hooksListCommand.action(async (options: ArtifactCommandOptions) => {
    const result = await listHooks({ ...artifactOptions(options), target: options.target });
    if (options.json === true) writeMachine(stdout, result);
    else stdout.write(`Listed ${result.length} hook(s)${options.target === undefined ? '' : ` from ${options.target}`}\n`);
  });

  const hooksSimulateCommand = configureArtifactOptions(
    hooksCommand.command('simulate').description('Simulate one generated hook'),
    true,
  )
    .requiredOption('--hook <hook>', 'Hook ID or name')
    .option('--input <json>', 'Inline JSON object input')
    .option('--input-file <path>', 'JSON object input file');
  hooksSimulateCommand.action(async (options: ArtifactCommandOptions & JsonInputOptions & {
    readonly hook: string;
  }) => {
    const result = await simulateHook({
      ...artifactOptions(options),
      hook: options.hook,
      input: await parseJsonObject(options),
      target: options.target!,
    });
    if (options.json === true) writeMachine(stdout, result);
    else stdout.write(`Simulated ${options.hook}\n`);
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
