#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
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
  prepack,
  runEvals,
  startDevServer,
  validate,
  InspectionComponentCapability,
  InspectionSkippedComponent,
  ProjectOptions,
} from './api.ts';
import type {
  installBundle,
  InstallHost,
  InstallMode,
  InstallResult,
  InstallScope,
} from './install/install.ts';
import type {
  DoctorDurableStateReport,
  DoctorHost,
  DoctorInstallComparison,
  DoctorReport,
  runDoctor,
} from './install/doctor.ts';
import type { runHostMcpProxy } from './dev/host-mcp-proxy.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import { errorMessage } from './core/errors.ts';
import { formatInstallResult } from './install/format.ts';
import { projectVersionLabel } from './core/project-context.ts';
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
  /** Injectable only to verify the build host-validation CLI policy without an installed host. */
  readonly build?: typeof build;
  readonly installBundle?: typeof installBundle;
  readonly prepack?: typeof prepack;
  readonly runDoctor?: typeof runDoctor;
  readonly runHostMcpProxy?: typeof runHostMcpProxy;
  /** Injectable only to make foreground shutdown behavior deterministic in tests. */
  readonly signals?: CliSignalSource;
  readonly startDevServer?: typeof startDevServer;
  /** Injectable only to verify host-validation CLI policy without an installed host. */
  readonly validate?: typeof validate;
}

interface SourceCommandOptions {
  readonly config?: string;
  readonly hostValidation?: boolean;
  readonly json?: boolean;
  readonly mode?: string;
  readonly root: string;
  readonly strict?: boolean;
  readonly target?: readonly string[];
}

interface BuildCommandOptions extends SourceCommandOptions {
  readonly output?: string;
}

interface InstallCommandOptions {
  readonly force?: boolean;
  readonly from: string;
  readonly json?: boolean;
  readonly replace?: boolean;
  readonly mode?: InstallMode;
  readonly scope: string;
}

interface DoctorCommandOptions {
  readonly from?: string;
  readonly host: readonly DoctorHost[];
  readonly json?: boolean;
}

interface EvalCommandOptions extends SourceCommandOptions {
  readonly artifact?: string;
  readonly case?: readonly string[];
  readonly harness?: string;
  readonly suite?: readonly string[];
  readonly trials?: number;
}

interface InspectCommandOptions {
  readonly bundler?: boolean;
  readonly config?: string;
  readonly hooks?: boolean;
  readonly json?: boolean;
  readonly mode?: string;
  readonly root: string;
  readonly routes?: boolean;
  readonly skills?: boolean;
  readonly state?: boolean;
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
  readonly installHost: readonly InstallHost[];
  readonly open?: boolean;
  readonly port?: number;
  readonly root: string;
}

interface DevProxyCommandOptions {
  readonly server: string;
  readonly target: string;
  readonly url?: string;
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

const installHost = (value: string): InstallHost => {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value;
  throw new TypeError('Install host must be claude, codex, or cursor.');
};

const collectInstallHost = (value: string, previous: readonly InstallHost[]): readonly InstallHost[] =>
  [...previous, installHost(value)];

const installMode = (value: string): InstallMode => {
  if (value === 'local' || value === 'marketplace') return value;
  throw new TypeError('Install mode must be local or marketplace.');
};

const installScope = (value: string): InstallScope => {
  if (value === 'user' || value === 'project' || value === 'local') return value;
  throw new TypeError('Install scope must be user, project, or local.');
};

const doctorHost = (value: string): DoctorHost => {
  if (value === 'claude' || value === 'codex' || value === 'cursor') return value;
  throw new InvalidArgumentError('Doctor host must be claude, codex, or cursor.');
};

const collectDoctorHost = (value: string, previous: readonly DoctorHost[]): readonly DoctorHost[] =>
  [...previous, doctorHost(value)];

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
    message: errorMessage(error),
    severity: 'error',
  }];
};

const writeMachine = (output: Output, result: unknown): void => {
  output.write(`${stableJson(result === undefined ? null : result)}\n`);
};

const writeHumanBuild = (output: Output, result: Awaited<ReturnType<typeof build>>): void => {
  // Errors abort the command before this writer runs, so any diagnostics
  // reaching it are informational nudges or host-validation warnings.
  for (const diagnostic of result.diagnostics) {
    output.write(`${diagnostic.code} (${diagnostic.severity}): ${diagnostic.message}\n`);
  }
  output.write(`Built ${result.model.metadata.name} to ${result.build.outputRoot}\n`);
  for (const report of result.hostValidation ?? []) {
    output.write(
      `Host validation (${report.target}): ${report.status}` +
        `${report.version === undefined ? '' : ` (Claude Code ${report.version})`}` +
        `${report.load === undefined ? '' : `, load check ${report.load.status}`}\n`,
    );
  }
  if (result.packageBuild !== undefined) {
    output.write(`Package build (${result.packageBuild.files.length} file(s)) at ${result.packageBuild.outputRoot}\n`);
  }
};

const writeHumanPrepack = (output: Output, result: Awaited<ReturnType<typeof prepack>>): void => {
  output.write(
    `Prepack validated ${result.pack.files.length} file(s) for ${result.build.model.metadata.name}\n`,
  );
};

const shortContentHash = (hash: string): string => hash.slice(0, 12);

const writeHumanInstall = (output: Output, result: InstallResult): void => {
  output.write(formatInstallResult(result));
};

const describeInstallComparison = (comparison: DoctorInstallComparison): string => {
  const installed = (comparison.installedContentHash === undefined
    ? ''
    : `; installed ${comparison.installedVersion ?? 'unknown version'} ` +
      `content ${shortContentHash(comparison.installedContentHash)}, ` +
      `artifact content ${shortContentHash(comparison.artifactContentHash)}`) +
    (comparison.enabled === false ? '; disabled by the host' : '');
  switch (comparison.status) {
    case 'current':
      return `current${installed}`;
    case 'stale':
      return `stale (same version, different content)${installed}`;
    case 'version-mismatch':
      return `version mismatch${installed}`;
    case 'foreign':
      return `foreign install${installed}`;
    case 'load-failed':
      return `load failed (installed ${comparison.installedVersion ?? 'unknown version'}, refused by the host: ` +
        `${(comparison.errors ?? []).join(' | ')})`;
    case 'not-installed':
      return 'not installed';
    case 'unknown':
      return 'unknown (host inventory unavailable)';
    default: {
      const exhaustive: never = comparison.status;
      throw new TypeError(`Unknown install comparison ${String(exhaustive)}.`);
    }
  }
};

const formatByteSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) return `${kibibytes.toFixed(1).replace(/\.0$/u, '')} KiB`;
  return `${(kibibytes / 1024).toFixed(1).replace(/\.0$/u, '')} MiB`;
};

const writeHumanDoctor = (output: Output, result: DoctorReport): void => {
  for (const host of result.hosts) {
    const detail = host.probe.version ?? host.probe.evidence;
    output.write(`${host.host}: ${host.probe.status}${detail === undefined ? '' : ` (${detail})`}\n`);
    output.write(
      `  inventory: ${host.inventory.status}` +
      `${host.inventory.status === 'known' ? ` (${host.inventory.findings.length} finding(s))` : ''}\n`,
    );
    if (host.bundle !== undefined) {
      const identity = host.bundle.name === undefined
        ? ''
        : ` ${host.bundle.name}${host.bundle.version === undefined ? '' : `@${host.bundle.version}`}`;
      output.write(`  bundle:${identity} ${host.bundle.state}\n`);
      if (host.bundle.comparison !== undefined) {
        output.write(`  installed copy: ${describeInstallComparison(host.bundle.comparison)}\n`);
      }
      for (const validation of host.bundle.hostValidation ?? []) {
        output.write(
          `  host validation (${validation.copy} ${validation.pluginDirectory}` +
          `${validation.scope === undefined ? '' : `, scope ${validation.scope}`}): ${validation.status}\n`,
        );
      }
    }
    const reports = [
      ...host.inventory.findings.map((finding) => finding.durableState),
      host.bundle?.durableState,
    ].filter((report): report is DoctorDurableStateReport => report !== undefined);
    const uniqueReports = [...new Map(reports.map((report) => [report.directory, report])).values()];
    if (uniqueReports.length > 0) {
      const stores = uniqueReports.reduce((total, report) => total + report.summary.stores, 0);
      const bytes = uniqueReports.reduce((total, report) => total + report.summary.bytes, 0);
      output.write(
        `  durable state: ${stores} ${stores === 1 ? 'store' : 'stores'}, ${formatByteSize(bytes)}\n`,
      );
    }
  }
  output.write(
    `runtime endpoints: ${result.endpoints.status}; ${result.endpoints.summary.live} live, ` +
    `${result.endpoints.summary.staleSockets} stale socket(s), ` +
    `${result.endpoints.summary.staleLocks} stale lock(s)\n`,
  );
  for (const entry of result.diagnostics) {
    output.write(`${entry.code}: ${entry.message}\nRecovery: ${entry.recovery}\n`);
  }
  output.write(
    `Doctor summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ` +
    `${result.summary.infos} info(s)\n`,
  );
};

const writeHumanInspect = (output: Output, result: Awaited<ReturnType<typeof inspect>>): void => {
  if (result.state === 'invalid') {
    for (const diagnostic of result.diagnostics) {
      output.write(`${diagnostic.code}: ${diagnostic.message}\nRecovery: ${diagnostic.recovery}\n`);
    }
    return;
  }
  if (result.selected?.bundler !== undefined) {
    // The bundler focus is a debugging dump: the full synthesized
    // configuration is the human output, not a one-line summary.
    output.write(`${JSON.stringify(result.selected.bundler, null, 2)}\n`);
    return;
  }
  if (result.selected?.routes !== undefined) {
    // The route focus follows the bundler contract: the compiled graph is
    // the human output, not a one-line summary.
    output.write(`${JSON.stringify(result.selected.routes, null, 2)}\n`);
    return;
  }
  if (result.selected?.state !== undefined) {
    output.write(`${JSON.stringify(result.selected.state, null, 2)}\n`);
    return;
  }
  output.write(`Inspected ${result.model.metadata.name}: ${result.plans.map((plan) => plan.target).join(', ')}\n`);
  // Release identity is derived from package.json (issue #94); a project
  // without a package version gets a clearly labeled development fallback.
  if (result.projectContext.packageName !== undefined) {
    output.write(`Package: ${result.projectContext.packageName}\n`);
  }
  output.write(`Version: ${projectVersionLabel(result.projectContext)}\n`);
  if (result.model.state !== undefined) {
    const driver = result.model.state.lifetime === 'workspace-durable' ? 'sqlite' : 'memory';
    output.write(`state: ${result.model.state.id} (${result.model.state.lifetime}, ${driver} driver)\n`);
  }
  // Per-target component accounting: what each host emits and, for every
  // omission, whether the author excluded it or the host's pinned capability
  // judgment (degraded/unavailable/prohibited, with its reason) ruled it out.
  for (const plan of result.plans) {
    output.write(`${plan.target}: ${plan.selected.length} component(s) selected, ${plan.skipped.length} omitted\n`);
    for (const component of plan.skipped) {
      output.write(`  omitted ${component.kind} ${component.name}: ${formatInspectionOmission(component)}\n`);
    }
    // Feature-set omissions (#100): the component ships, minus a feature the
    // host's `<kind>.<feature>` row does not support.
    for (const component of plan.selected) {
      for (const omitted of component.omittedFeatures ?? []) {
        output.write(`  ${component.kind} ${component.name} omits ${omitted.feature}: ${formatCapabilityJudgment(omitted.capability)}\n`);
      }
    }
    // The kind matrix names every canonical kind this host cannot emit, with
    // the host's own state, even when the project declares none of them.
    const unsupportedKinds = plan.kinds
      .filter((report) => report.capability !== undefined && report.capability.state !== 'supported')
      .map((report) => `${report.kind} (${report.capability!.state})`);
    if (unsupportedKinds.length > 0) {
      output.write(`  kinds this host cannot emit: ${unsupportedKinds.join(', ')}\n`);
    }
  }
};

const formatCapabilityJudgment = (capability: InspectionComponentCapability): string => {
  switch (capability.state) {
    case 'supported':
      return `${capability.name} supported`;
    case 'degraded':
    case 'unavailable':
    case 'prohibited':
      return `${capability.name} ${capability.state} — ${capability.reason}`;
    default: {
      const exhaustive: never = capability;
      throw new TypeError(`Unhandled capability state ${JSON.stringify(exhaustive)}.`);
    }
  }
};

const formatInspectionOmission = (component: InspectionSkippedComponent): string => {
  switch (component.reason) {
    case 'excluded-by-targets':
      return 'excluded by targets';
    case 'unsupported-capability': {
      const capability = component.capability;
      if (capability === undefined) return 'unsupported capability';
      return formatCapabilityJudgment(capability);
    }
    default: {
      const exhaustive: never = component.reason;
      throw new TypeError(`Unhandled inspection skip reason ${String(exhaustive)}.`);
    }
  }
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
  // Errors abort the command before this writer runs, so any diagnostics
  // reaching it are informational nudges or warnings worth surfacing.
  for (const diagnostic of result.diagnostics) {
    output.write(`${diagnostic.code} (${diagnostic.severity}): ${diagnostic.message}\n`);
  }
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
    .option('--install-host <host>', 'Install and re-sync a development host (repeatable)', collectInstallHost, [])
    .option('--open', 'Open the workbench after the foreground server starts')
    .option('--no-open', 'Do not open the workbench after the foreground server starts');
  devCommand.action(async (options: DevCommandOptions) => {
    const { startDevServer: start } = await import('./api.ts');
    const session = await (dependencies.startDevServer ?? start)({
      ...(options.agentApi === undefined ? {} : { agentApi: options.agentApi }),
      installHosts: options.installHost,
      open: options.open === true,
      ...(options.port === undefined ? {} : { port: options.port }),
      root: options.root,
    });
    stdout.write(`Development workbench at ${session.url}\n`);
    closeForegroundOnSignal(session, dependencies.signals ?? process, stderr);
  });

  const devProxyCommand = devCommand.command('proxy')
    .description('Bridge host stdio MCP traffic to a running development server')
    .requiredOption('--server <server>', 'Generated MCP server name')
    .option('--target <target>', 'Generated target containing the MCP server', 'portable')
    .option('--url <url>', 'Explicit loopback development server origin');
  devProxyCommand.action(async (options: DevProxyCommandOptions) => {
    const proxy = dependencies.runHostMcpProxy ?? (await import('./dev/host-mcp-proxy.ts')).runHostMcpProxy;
    exitCode = await proxy({
      projectRoot: devCommand.opts<DevCommandOptions>().root,
      serverName: options.server,
      target: options.target,
      ...(options.url === undefined ? {} : { url: options.url }),
      writeDiagnostic: (message) => { stderr.write(`${message}\n`); },
    });
  });

  const buildCommand = configureSourceOptions(
    program.command('build').description('Build a validated Agent Bundle artifact'),
  )
    .option('--output <path>', 'Artifact output path relative to --root (overrides config output.distPath; default artifact, since dist is the npm package build output)')
    .option('--host-validation', 'Run the installed Claude developer validator over built claude and plugin targets', true)
    .option('--no-host-validation', 'Skip the installed Claude developer validator')
    .option('--strict', 'Promote host-tool warnings to errors');
  buildCommand.action(async (options: BuildCommandOptions) => {
    const { build } = await import('./api.ts');
    const result = await (dependencies.build ?? build)({
      ...projectOptions(options),
      hostValidation: options.hostValidation,
      output: options.output,
      packageOutputs: true,
      strict: options.strict,
    });
    if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      throw new DiagnosticError(result.diagnostics);
    }
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanBuild(stdout, result);
  });

  const prepackCommand = configureSourceOptions(
    program.command('prepack').description('Build and validate the npm pack inventory'),
  ).option('--output <path>', 'Artifact output path relative to --root (overrides config output.distPath; default artifact, since dist is the npm package build output)');
  prepackCommand.action(async (options: BuildCommandOptions) => {
    const { prepack } = await import('./api.ts');
    const result = await (dependencies.prepack ?? prepack)({
      ...projectOptions(options),
      output: options.output,
      packageOutputs: true,
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanPrepack(stdout, result);
  });

  const installCommand = program.command('install')
    .description('Install a built bundle into a supported host')
    .argument('<host>', 'Destination host: claude, codex, or cursor', installHost)
    .option('--from <bundle-dir>', 'Target bundle directory or artifact root', process.cwd())
    .option('--scope <scope>', 'Host install scope', installScope, 'user')
    .option(
      '--replace',
      'Replace an existing agent-bundle install of this plugin even when its version differs; ' +
        'same-version content drift is replaced automatically and foreign installs are always refused',
    )
    .option('--force', 'Alias for --replace')
    .option('--mode <mode>', 'Cursor delivery mode: local (default) or marketplace', installMode)
    .option('--json', 'Write one machine-readable JSON document');
  installCommand.action(async (
    host: InstallHost,
    options: InstallCommandOptions,
  ) => {
    const install = dependencies.installBundle ?? (await import('./install/install.ts')).installBundle;
    const result = await install({
      from: options.from,
      host,
      replace: options.replace === true || options.force === true,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      scope: installScope(options.scope),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanInstall(stdout, result);
  });

  const doctorCommand = program.command('doctor')
    .description('Inspect host installs and runtime endpoints without changing them')
    .option('--host <host>', 'Host to inspect (repeatable)', collectDoctorHost, [])
    .option('--from <bundle-dir>', 'Target bundle directory or artifact root')
    .option('--json', 'Write one machine-readable JSON document');
  doctorCommand.action(async (options: DoctorCommandOptions) => {
    const doctor = dependencies.runDoctor ?? (await import('./install/doctor.ts')).runDoctor;
    const result = await doctor({
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.host.length === 0 ? {} : { hosts: options.host }),
    });
    if (options.json === true) writeMachine(stdout, result);
    else writeHumanDoctor(stdout, result);
    if (result.diagnostics.some((entry) => entry.severity === 'error')) exitCode = 1;
  });

  const validateCommand = configureSourceOptions(
    program.command('validate').description('Validate project source or one artifact'),
  )
    .option('--artifact <path>', 'Validate exactly this built artifact')
    .option('--host-validation', 'Run installed host developer tools for compatible built targets', true)
    .option('--no-host-validation', 'Skip installed host developer tools')
    .option('--strict', 'Promote host-tool warnings to errors');
  validateCommand.action(async (options: SourceCommandOptions & { readonly artifact?: string }) => {
    const { validate } = await import('./api.ts');
    const result = await (dependencies.validate ?? validate)({
      ...projectOptions(options),
      artifact: options.artifact,
      hostValidation: options.hostValidation,
      strict: options.strict,
    });
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
    .option('--bundler', 'Include the synthesized bundler configuration focus')
    .option('--hooks', 'Include the hook focus')
    .option('--routes', 'Include the compiled route-graph focus')
    .option('--skills', 'Include the skill focus')
    .option('--state', 'Include the state lifetime focus');
  inspectCommand.action(async (options: InspectCommandOptions) => {
    const focuses = [
      options.bundler,
      options.hooks,
      options.routes,
      options.skills,
      options.state,
    ].filter((focus) => focus === true);
    if (focuses.length > 1) {
      throw new TypeError('Choose at most one inspect focus.');
    }
    const { inspect } = await import('./api.ts');
    const result = await inspect({
      ...inspectProjectOptions(options),
      ...(options.bundler === true ? { focus: 'bundler' as const } : {}),
      ...(options.hooks === true ? { focus: 'hooks' as const } : {}),
      ...(options.routes === true ? { focus: 'routes' as const } : {}),
      ...(options.skills === true ? { focus: 'skills' as const } : {}),
      ...(options.state === true ? { focus: 'state' as const } : {}),
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

  const mcpRunCommand = configureArtifactOptions(
    mcpCommand.command('run').description('Run one stdio MCP server in the foreground from an artifact'),
    true,
  )
    .requiredOption('--server <server>', 'MCP server name')
    .option('--env-file <path>', 'Load exactly this .env file, replacing the project-root set (repeatable)', collect, [])
    .option('--no-env', 'Launch without loading any .env files')
    .option('--plugin-root <path>', 'Expand env plugin-root anchors against this root instead of the project root');
  mcpRunCommand.action(async (options: ArtifactCommandOptions & {
    readonly env: boolean;
    readonly envFile: readonly string[];
    readonly pluginRoot?: string;
    readonly server: string;
    readonly target: string;
  }) => {
    if (options.env === false && options.envFile.length > 0) {
      throw new TypeError('Use either --env-file or --no-env, not both.');
    }
    const { runMcp } = await import('./api.ts');
    // No stdout writes here: with inherited stdio the server owns the
    // JSON-RPC channel for the whole foreground run.
    exitCode = await runMcp({
      ...artifactOptions(options),
      ...(options.envFile.length === 0 ? {} : { envFiles: options.envFile }),
      ...(options.env === false ? { loadEnvFiles: false } : {}),
      ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
      server: options.server,
      target: options.target,
    });
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
