#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Type-only: the product surface reaches the CLI through `await import('./api.ts')`
 * inside each action. A static import would load Rsbuild, Rslib, Rslint, the MCP
 * SDK, chokidar and ajv before argv is even parsed, so `--version`, `--help` and
 * an argv error would each pay the full graph for nothing.
 */
import type {
  build,
  compareEvals,
  inspect,
  runEvals,
  startDevServer,
  validate,
  ProjectOptions,
} from './api.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import { stableJson } from './core/digest.ts';
import type { EvalComparisonDelta, EvalConditionMetrics } from './eval/compare.ts';

declare const __AGENT_BUNDLE_VERSION__: string;

interface Output {
  write(chunk: string): unknown;
}

export interface CliStreams {
  readonly stderr?: Output;
  readonly stdout?: Output;
}

interface CliSignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface CliDependencies {
  /** Injectable only to make foreground shutdown behavior deterministic in tests. */
  readonly signals?: CliSignalSource;
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

interface EvalCommandOptions extends SourceCommandOptions {
  readonly artifact?: string;
  readonly case?: readonly string[];
  readonly harness?: string;
  readonly suite?: readonly string[];
  readonly trials?: number;
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
  readonly agentApi?: boolean;
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

const trialCount = (value: string): number => {
  if (!/^[1-9]\d{0,2}$/u.test(value)) throw new TypeError('Trials must be a positive integer.');
  const number = Number(value);
  if (number > 100) throw new TypeError('Trials must be at most 100.');
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
  if (result.state === 'invalid') {
    for (const diagnostic of result.diagnostics) {
      output.write(`${diagnostic.code}: ${diagnostic.message}\nRecovery: ${diagnostic.recovery}\n`);
    }
    return;
  }
  output.write(`Inspected ${result.model.metadata.name}: ${result.plans.map((plan) => plan.target).join(', ')}\n`);
};

const emptyEvalSummary = Object.freeze({ cases: 0, fail: 0, inconclusive: 0, pass: 0, trials: 0 });

/** Inconclusive trials are counted on their own line; they are never reported as failures. */
const writeHumanEval = (output: Output, result: Awaited<ReturnType<typeof runEvals>>): void => {
  for (const diagnostic of result.diagnostics) {
    output.write(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
  const summary = result.run.summary ?? emptyEvalSummary;
  output.write([
    `Evaluated ${summary.cases} case(s) in run ${result.run.id}: `,
    `${summary.pass} passed, ${summary.fail} failed, ${summary.inconclusive} inconclusive `,
    `across ${summary.trials} trial(s)\n`,
  ].join(''));
};

const signed = (value: number): string => `${value > 0 ? '+' : ''}${value}`;

const formatComparisonMetrics = (metrics: EvalConditionMetrics): string => [
  `${metrics.outcome}; ${metrics.passes}/${metrics.trials} passed`,
  `${metrics.fail} failed`,
  `${metrics.inconclusive} inconclusive`,
  `${metrics.harnessFailures} harness failures`,
  `${metrics.meanDurationMs}ms mean`,
  ...(metrics.usage === undefined ? [] : [`${metrics.usage.totalTokens} tokens`]),
].join(', ');

const formatComparisonDelta = (delta: EvalComparisonDelta): string => [
  `pass rate ${signed(delta.passRate)}`,
  `passes ${signed(delta.passes)}`,
  `mean duration ${signed(delta.meanDurationMs)}ms`,
  `trials ${signed(delta.trials)}`,
  ...(delta.reliability === undefined
    ? []
    : [`pass@k ${signed(delta.reliability.passAtK)}`, `pass^k ${signed(delta.reliability.passPowerK)}`]),
  ...(delta.totalTokens === undefined ? [] : [`tokens ${signed(delta.totalTokens)}`]),
].join(', ');

const writeHumanEvalComparison = (output: Output, result: Awaited<ReturnType<typeof compareEvals>>): void => {
  const { summary } = result;
  output.write([
    `Compared ${result.baselineRunId} to ${result.candidateRunId}: `,
    `${summary.comparable} comparable, ${summary.nonComparable} non-comparable `,
    `(${summary.reliability} reliability, ${summary.smoke} smoke)\n`,
  ].join(''));
  for (const row of result.rows) {
    output.write(`case ${row.caseId} / host ${row.host} / model ${row.model ?? 'unverified'}\n`);
    if (row.baseline !== undefined) output.write(`  baseline: ${formatComparisonMetrics(row.baseline)}\n`);
    if (row.candidate !== undefined) output.write(`  candidate: ${formatComparisonMetrics(row.candidate)}\n`);
    if (row.comparable) {
      output.write(`  delta: ${formatComparisonDelta(row.delta)}\n`);
      continue;
    }
    for (const cause of row.causes) output.write(`  not comparable: ${cause.code}: ${cause.message}\n`);
  }
};

const writeHumanValidate = (output: Output, result: Awaited<ReturnType<typeof validate>>): void => {
  output.write(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? `Validation reported ${result.diagnostics.length} diagnostic(s)\n`
    : 'Validation succeeded\n');
};

const closeForegroundOnSignal = (
  session: Pick<Awaited<ReturnType<typeof startDevServer>>, 'close'>,
  signals: CliSignalSource,
  stderr: Output,
): void => {
  const terminationSignals = ['SIGINT', 'SIGTERM'] as const;
  let closing: Promise<void> | undefined;
  const close = (): void => {
    closing ??= session.close().catch((error: unknown) => {
      writeMachine(stderr, diagnosticsFor(error));
    }).finally(() => {
      for (const signal of terminationSignals) signals.removeListener(signal, close);
    });
  };
  for (const signal of terminationSignals) signals.once(signal, close);
};

export const runCli = async (
  args: string[],
  streams: CliStreams = {},
  dependencies: CliDependencies = {},
): Promise<number> => {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  let exitCode = 0;
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
    .option('--agent-api', 'Enable the authenticated Agent API on /mcp')
    .option('--no-agent-api', 'Disable the authenticated Agent API on /mcp')
    .option('--open', 'Open the workbench after the foreground server starts')
    .option('--no-open', 'Do not open the workbench after the foreground server starts');
  devCommand.action(async (options: DevCommandOptions) => {
    const { startDevServer: start } = await import('./api.ts');
    const session = await (dependencies.startDevServer ?? start)({
      ...(options.agentApi === undefined ? {} : { agentApi: options.agentApi }),
      open: options.open === true,
      ...(options.port === undefined ? {} : { port: options.port }),
      root: options.root,
    });
    stdout.write(`Development workbench at ${session.url}\n`);
    closeForegroundOnSignal(session, dependencies.signals ?? process, stderr);
  });

  const buildCommand = configureSourceOptions(
    program.command('build').description('Build a validated Agent Bundle artifact'),
  ).option('--output <path>', 'Artifact output path relative to --root');
  buildCommand.action(async (options: BuildCommandOptions) => {
    const { build } = await import('./api.ts');
    const result = await build({ ...projectOptions(options), output: options.output });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanBuild(stdout, result);
  });

  const validateCommand = configureSourceOptions(
    program.command('validate').description('Validate project source or one artifact'),
  ).option('--artifact <path>', 'Validate exactly this built artifact');
  validateCommand.action(async (options: SourceCommandOptions & { readonly artifact?: string }) => {
    const { validate } = await import('./api.ts');
    const result = await validate({ ...projectOptions(options), artifact: options.artifact });
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new DiagnosticError(result.diagnostics);
    }
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanValidate(stdout, result);
  });

  const evalCommand = configureSourceOptions(
    program.command('eval').description('Run deterministic or native eval suites against a built artifact'),
  )
    .option('--artifact <path>', 'Evaluate exactly this built artifact')
    .option('--case <case>', 'Eval case id to run (repeatable)', collect, [])
    .option('--harness <harness>', 'Eval harness to run', 'deterministic')
    .option('--suite <suite>', 'Eval suite name to run (repeatable)', collect, [])
    .option('--trials <count>', 'Run this many trials of every selected case', trialCount);
  evalCommand.action(async (options: EvalCommandOptions) => {
    const { runEvals } = await import('./api.ts');
    const result = await runEvals({
      ...projectOptions(options),
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
      ...(options.case === undefined || options.case.length === 0 ? {} : { caseIds: options.case }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.suite === undefined || options.suite.length === 0 ? {} : { suites: options.suite }),
      ...(options.trials === undefined ? {} : { trials: options.trials }),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanEval(stdout, result);
    const summary = result.run.summary ?? emptyEvalSummary;
    // Inconclusive trials produced no evidence, so they cannot report success either.
    if (summary.fail > 0 || summary.inconclusive > 0) exitCode = 1;
  });

  const evalCompareCommand = configureSourceOptions(
    evalCommand.command('compare').description('Compare two persisted eval runs'),
  )
    .argument('<baseline>', 'Baseline eval run id')
    .argument('<candidate>', 'Candidate eval run id');
  evalCompareCommand.action(async (baseline: string, candidate: string) => {
    const sourceOptions = evalCommand.opts<EvalCommandOptions>();
    const { compareEvals } = await import('./api.ts');
    const result = await compareEvals({
      ...projectOptions(sourceOptions),
      baseRunId: baseline,
      candidateRunId: candidate,
    });
    if (sourceOptions.json === true) writeMachine(stdout, result);
    else writeHumanEvalComparison(stdout, result);
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
    const { inspect } = await import('./api.ts');
    const result = await inspect({
      ...inspectProjectOptions(options),
      ...(options.hooks === true ? { focus: 'hooks' as const } : {}),
      ...(options.skills === true ? { focus: 'skills' as const } : {}),
      ...(options.target === undefined ? {} : { target: options.target }),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanInspect(stdout, result);
    if (result.state === 'invalid') exitCode = 1;
  });

  const mcpCommand = program.command('mcp').description('Operate an MCP server from an artifact');
  const mcpListCommand = configureArtifactOptions(
    mcpCommand.command('list').description('List tools from one MCP server'),
    true,
  ).requiredOption('--server <server>', 'MCP server name');
  mcpListCommand.action(async (options: ArtifactCommandOptions & { readonly server: string; readonly target: string }) => {
    const { listMcp } = await import('./api.ts');
    const result = await listMcp({
      ...artifactOptions(options),
      server: options.server,
      target: options.target,
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
    readonly target: string;
    readonly tool: string;
  }) => {
    const { invokeMcp } = await import('./api.ts');
    const result = await invokeMcp({
      ...artifactOptions(options),
      input: await parseJsonObject(options),
      server: options.server,
      target: options.target,
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
    const { listHooks } = await import('./api.ts');
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
    readonly target: string;
  }) => {
    const { simulateHook } = await import('./api.ts');
    const result = await simulateHook({
      ...artifactOptions(options),
      hook: options.hook,
      input: await parseJsonObject(options),
      target: options.target,
    });
    if (options.json === true) writeMachine(stdout, result);
    else stdout.write(`Simulated ${options.hook}\n`);
  });

  try {
    await program.parseAsync(args, { from: 'user' });
    return exitCode;
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
