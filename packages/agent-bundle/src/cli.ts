#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import type { Layer } from 'effect';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Type-only: the product surface reaches the CLI through `await import('./api.ts')`
 * inside each action. A static import would load Rsbuild, Rslib, Rslint, the MCP
 * SDK, chokidar and ajv before argv is even parsed, so `--version`, `--help` and
 * an argv error would each pay the full graph for nothing.
 *
 * The Effect terminal runtime (`./effect/cli-runtime.ts`) is type-only here for
 * the same reason: `effect` + `effect/Terminal` + the platform-node-shared
 * layers measured ≈250 ms of module loading, so `runCli` imports that module
 * on the first command write, after Commander has parsed.
 */
import type {
  build,
  compareEvals,
  inspect,
  prepack,
  runEvals,
  serveApp,
  startDevServer,
  validate,
  InspectionComponentCapability,
  InspectionSkippedComponent,
  McpAppConsentCapability,
  McpAppProfileId,
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
  DoctorLifecycle,
  DoctorReport,
  runDoctor,
} from './install/doctor.ts';
import type { uninstallBundle, UninstallResult } from './install/uninstall.ts';
import type { runHostMcpProxy } from './dev/host-mcp-proxy.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
import { errorMessage } from './core/errors.ts';
import { formatInstallResult, formatUninstallResult } from './install/format.ts';
import { projectVersionLabel } from './core/project-context.ts';
import { stableJson } from './core/digest.ts';
import type { EvalComparisonDelta, EvalConditionMetrics } from './eval/compare.ts';
import type { CliTerminal } from './effect/cli-runtime.ts';
import type { CliServices } from './effect/terminal.ts';

declare const __AGENT_BUNDLE_VERSION__: string;

/** Synchronous text sinks for the text Commander writes itself while parsing argv. */
export interface ArgvTextSinks {
  readonly stderr: (text: string) => void;
  readonly stdout: (text: string) => void;
}

/**
 * The CLI's output seams (#465 / Effect Terminal adoption). Command output —
 * user-facing text through `Terminal.display`, diagnostics and machine output
 * through `Stdio` — runs against `services`; the process-backed Node layers
 * are the default and are loaded on the first write. Commander's own text —
 * `--help`, `--version`, and argv errors — is written synchronously to
 * `argvText` (default: the process streams) before any command runs, so those
 * invocations never load the Effect runtime. Tests provide capture sinks for
 * both instead of spying on `process.stdout`.
 */
export interface CliOutput {
  readonly argvText?: ArgvTextSinks;
  readonly services?: Layer.Layer<CliServices>;
}

const processArgvText: ArgvTextSinks = Object.freeze({
  stderr: (text: string): void => void process.stderr.write(text),
  stdout: (text: string): void => void process.stdout.write(text),
});

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
  /** Injectable only to verify the serve-app CLI contract without a built artifact. */
  readonly serveApp?: typeof serveApp;
  /** Injectable only to make foreground shutdown behavior deterministic in tests. */
  readonly signals?: CliSignalSource;
  readonly startDevServer?: typeof startDevServer;
  readonly uninstallBundle?: typeof uninstallBundle;
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

interface UninstallCommandOptions {
  readonly confirmPurge?: boolean;
  readonly force?: boolean;
  readonly from: string;
  readonly json?: boolean;
  readonly keepData?: boolean;
  readonly mode?: InstallMode;
  readonly plan?: boolean;
  readonly purgeData?: boolean;
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
  readonly workbenchDevOrigin: readonly string[];
}

interface DevProxyCommandOptions {
  readonly server: string;
  readonly target: string;
  readonly url?: string;
}

interface ServeAppCommandOptions extends JsonInputOptions {
  readonly allow: readonly McpAppConsentCapability[];
  readonly artifact?: string;
  readonly config?: string;
  readonly env: boolean;
  readonly envFile: readonly string[];
  readonly mode?: string;
  readonly open?: boolean;
  readonly pluginRoot?: string;
  readonly port?: number;
  readonly profile: McpAppProfileId;
  readonly root: string;
  readonly target: string;
  readonly tool?: string;
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

const mcpAppProfile = (value: string): McpAppProfileId => {
  if (value === 'portable' || value === 'claude' || value === 'chatgpt') return value;
  throw new InvalidArgumentError('MCP App profile must be portable, claude, or chatgpt.');
};

const consentCapabilities: ReadonlySet<McpAppConsentCapability> = new Set<McpAppConsentCapability>([
  'call-tool', 'download-file', 'open-external-link', 'request-display-mode',
]);

const consentCapability = (value: string): McpAppConsentCapability => {
  if (consentCapabilities.has(value as McpAppConsentCapability)) return value as McpAppConsentCapability;
  throw new InvalidArgumentError('Consent capability must be call-tool, download-file, open-external-link, or request-display-mode.');
};

const collectConsentCapability = (value: string, previous: readonly McpAppConsentCapability[]): readonly McpAppConsentCapability[] =>
  [...previous, consentCapability(value)];

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

/** One canonical JSON line: the `--json` document on stdout, or the diagnostics document on stderr. */
const machineLine = (result: unknown): string => `${stableJson(result === undefined ? null : result)}\n`;

const humanBuild = (result: Awaited<ReturnType<typeof build>>): string => {
  const out: string[] = [];
  // Errors abort the command before this formatter runs, so any diagnostics
  // reaching it are informational nudges or host-validation warnings.
  for (const diagnostic of result.diagnostics) {
    out.push(`${diagnostic.code} (${diagnostic.severity}): ${diagnostic.message}\n`);
  }
  out.push(`Built ${result.model.metadata.name} to ${result.build.outputRoot}\n`);
  for (const report of result.hostValidation ?? []) {
    out.push(
      `Host validation (${report.target}): ${report.status}` +
        `${report.version === undefined ? '' : ` (Claude Code ${report.version})`}` +
        `${report.load === undefined ? '' : `, load check ${report.load.status}`}\n`,
    );
  }
  if (result.packageBuild !== undefined) {
    out.push(`Package build (${result.packageBuild.files.length} file(s)) at ${result.packageBuild.outputRoot}\n`);
  }
  return out.join('');
};

const humanPrepack = (result: Awaited<ReturnType<typeof prepack>>): string => [
  // Errors abort the command before this formatter runs; what reaches it are warnings the pack survives.
  ...result.diagnostics.map((diagnostic) => `${diagnostic.code} (${diagnostic.severity}): ${diagnostic.message}\n`),
  `Prepack validated ${result.pack.files.length} file(s) for ${result.build.model.metadata.name}\n`,
].join('');

const shortContentHash = (hash: string): string => hash.slice(0, 12);

const humanInstall = (result: InstallResult): string => formatInstallResult(result);

const humanUninstall = (result: UninstallResult): string => formatUninstallResult(result);

const describeLifecycle = (lifecycle: DoctorLifecycle): string => {
  const observations = (['placed', 'registered', 'enabled', 'active'] as const).map((stage) => {
    const observation = lifecycle[stage];
    return observation.status === 'observed'
      ? `${stage}=${observation.value ? 'yes' : 'no'}`
      : `${stage}=unavailable`;
  });
  return `${lifecycle.stage} (${observations.join(', ')})`;
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

const humanDoctor = (result: DoctorReport): string => {
  const out: string[] = [];
  for (const host of result.hosts) {
    const detail = host.probe.version ?? host.probe.evidence;
    out.push(`${host.host}: ${host.probe.status}${detail === undefined ? '' : ` (${detail})`}\n`);
    out.push(
      `  inventory: ${host.inventory.status}` +
      `${host.inventory.status === 'known' ? ` (${host.inventory.findings.length} finding(s))` : ''}\n`,
    );
    if (host.bundle !== undefined) {
      const identity = host.bundle.name === undefined
        ? ''
        : ` ${host.bundle.name}${host.bundle.version === undefined ? '' : `@${host.bundle.version}`}`;
      out.push(`  bundle:${identity} ${host.bundle.state}\n`);
      if (host.bundle.comparison !== undefined) {
        out.push(`  installed copy: ${describeInstallComparison(host.bundle.comparison)}\n`);
      }
      for (const validation of host.bundle.hostValidation ?? []) {
        out.push(
          `  host validation (${validation.copy} ${validation.pluginDirectory}` +
          `${validation.scope === undefined ? '' : `, scope ${validation.scope}`}): ${validation.status}\n`,
        );
      }
      if (host.bundle.lifecycle !== undefined) {
        out.push(`  lifecycle: ${describeLifecycle(host.bundle.lifecycle)}\n`);
      }
    }
    if (host.receipts.length > 0) {
      out.push(`  receipts: ${host.receipts.length} store receipt(s)\n`);
      for (const receipt of host.receipts) {
        out.push(`    ${receipt.plugin}@${receipt.version} (${receipt.mode}, ${receipt.scope}): ${receipt.state}\n`);
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
      out.push(
        `  durable state: ${stores} ${stores === 1 ? 'store' : 'stores'}, ${formatByteSize(bytes)}\n`,
      );
    }
    // The operator `.env` layer (#469): present files and their variable counts, never a value.
    const operatorEnvFiles = [
      ...host.inventory.findings.map((finding) => finding.operatorEnv),
      host.bundle?.operatorEnv,
    ].flatMap((report) => report?.files ?? []).filter((file) => file.state !== 'absent');
    const uniqueEnvFiles = [...new Map(operatorEnvFiles.map((file) => [file.path, file])).values()];
    if (uniqueEnvFiles.length > 0) {
      out.push(`  operator env: ${uniqueEnvFiles.map((file) =>
        `${file.path} (${file.state === 'present' ? `${String(file.variables ?? 0)} variable${file.variables === 1 ? '' : 's'}` : file.state})`).join(', ')}\n`);
    }
  }
  out.push(
    `runtime endpoints: ${result.endpoints.status}; ${result.endpoints.summary.live} live, ` +
    `${result.endpoints.summary.staleSockets} stale socket(s), ` +
    `${result.endpoints.summary.staleLocks} stale lock(s)\n`,
  );
  for (const entry of result.diagnostics) {
    out.push(`${entry.code}: ${entry.message}\nRecovery: ${entry.recovery}\n`);
  }
  out.push(
    `Doctor summary: ${result.summary.errors} error(s), ${result.summary.warnings} warning(s), ` +
    `${result.summary.infos} info(s)\n`,
  );
  return out.join('');
};

const humanInspect = (result: Awaited<ReturnType<typeof inspect>>): string => {
  const out: string[] = [];
  if (result.state === 'invalid') {
    for (const diagnostic of result.diagnostics) {
      out.push(`${diagnostic.code}: ${diagnostic.message}\nRecovery: ${diagnostic.recovery}\n`);
    }
    return out.join('');
  }
  if (result.selected?.bundler !== undefined) {
    // The bundler focus is a debugging dump: the full synthesized
    // configuration is the human output, not a one-line summary.
    out.push(`${JSON.stringify(result.selected.bundler, null, 2)}\n`);
    return out.join('');
  }
  if (result.selected?.routes !== undefined) {
    // The route focus follows the bundler contract: the compiled graph is
    // the human output, not a one-line summary.
    out.push(`${JSON.stringify(result.selected.routes, null, 2)}\n`);
    return out.join('');
  }
  if (result.selected?.state !== undefined) {
    out.push(`${JSON.stringify(result.selected.state, null, 2)}\n`);
    return out.join('');
  }
  out.push(`Inspected ${result.model.metadata.name}: ${result.plans.map((plan) => plan.target).join(', ')}\n`);
  // Release identity is derived from package.json (issue #94); a project
  // without a package version gets a clearly labeled development fallback.
  if (result.projectContext.packageName !== undefined) {
    out.push(`Package: ${result.projectContext.packageName}\n`);
  }
  out.push(`Version: ${projectVersionLabel(result.projectContext)}\n`);
  if (result.model.state !== undefined) {
    const driver = result.model.state.lifetime === 'workspace-durable' ? 'sqlite' : 'memory';
    out.push(`state: ${result.model.state.id} (${result.model.state.lifetime}, ${driver} driver)\n`);
  }
  // Per-target component accounting: what each host emits and, for every
  // omission, whether the author excluded it or the host's pinned capability
  // judgment (degraded/unavailable/prohibited, with its reason) ruled it out.
  for (const plan of result.plans) {
    out.push(`${plan.target}: ${plan.selected.length} component(s) selected, ${plan.skipped.length} omitted\n`);
    for (const component of plan.skipped) {
      out.push(`  omitted ${component.kind} ${component.name}: ${formatInspectionOmission(component)}\n`);
    }
    // Feature-set omissions (#100): the component ships, minus a feature the
    // host's `<kind>.<feature>` row does not support.
    for (const component of plan.selected) {
      for (const omitted of component.omittedFeatures ?? []) {
        out.push(`  ${component.kind} ${component.name} omits ${omitted.feature}: ${formatCapabilityJudgment(omitted.capability)}\n`);
      }
    }
    // The kind matrix names every canonical kind this host cannot emit, with
    // the host's own state, even when the project declares none of them.
    const unsupportedKinds = plan.kinds
      .filter((report) => report.capability !== undefined && report.capability.state !== 'supported')
      .map((report) => `${report.kind} (${report.capability!.state})`);
    if (unsupportedKinds.length > 0) {
      out.push(`  kinds this host cannot emit: ${unsupportedKinds.join(', ')}\n`);
    }
  }
  return out.join('');
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
const humanEval = (result: Awaited<ReturnType<typeof runEvals>>): string => {
  const out: string[] = [];
  for (const diagnostic of result.diagnostics) {
    out.push(`${diagnostic.code}: ${diagnostic.message}\n`);
  }
  const summary = result.run.summary ?? emptyEvalSummary;
  out.push([
    `Evaluated ${summary.cases} case(s) in run ${result.run.id}: `,
    `${summary.pass} passed, ${summary.fail} failed, ${summary.inconclusive} inconclusive `,
    `across ${summary.trials} trial(s)\n`,
  ].join(''));
  return out.join('');
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

const humanEvalComparison = (result: Awaited<ReturnType<typeof compareEvals>>): string => {
  const out: string[] = [];
  const { summary } = result;
  out.push([
    `Compared ${result.baselineRunId} to ${result.candidateRunId}: `,
    `${summary.comparable} comparable, ${summary.nonComparable} non-comparable `,
    `(${summary.reliability} reliability, ${summary.smoke} smoke)\n`,
  ].join(''));
  for (const row of result.rows) {
    out.push(`case ${row.caseId} / host ${row.host} / model ${row.model ?? 'unverified'}\n`);
    if (row.baseline !== undefined) out.push(`  baseline: ${formatComparisonMetrics(row.baseline)}\n`);
    if (row.candidate !== undefined) out.push(`  candidate: ${formatComparisonMetrics(row.candidate)}\n`);
    if (row.comparable) {
      out.push(`  delta: ${formatComparisonDelta(row.delta)}\n`);
      continue;
    }
    for (const cause of row.causes) out.push(`  not comparable: ${cause.code}: ${cause.message}\n`);
  }
  return out.join('');
};

const humanValidate = (result: Awaited<ReturnType<typeof validate>>): string => {
  const out: string[] = [];
  // Errors abort the command before this writer runs, so any diagnostics
  // reaching it are informational nudges or warnings worth surfacing.
  for (const diagnostic of result.diagnostics) {
    out.push(`${diagnostic.code} (${diagnostic.severity}): ${diagnostic.message}\n`);
  }
  out.push(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? `Validation reported ${result.diagnostics.length} diagnostic(s)\n`
    : 'Validation succeeded\n');
  return out.join('');
};

/**
 * Closes the foreground session on SIGINT/SIGTERM. Returns a promise that
 * settles once a signal has closed the session (so the caller can keep the
 * terminal services alive until the close diagnostics, if any, have been
 * written). Without `until` it never settles when no signal arrives; when
 * `until` settles first, the signal listeners are released and the promise
 * settles without closing anything.
 */
const closeForegroundOnSignal = (
  session: Pick<Awaited<ReturnType<typeof startDevServer>>, 'close'>,
  signals: CliSignalSource,
  writeDiagnostics: (text: string) => Promise<void>,
  until?: Promise<unknown>,
): Promise<void> => new Promise<void>((settle) => {
  const terminationSignals = ['SIGINT', 'SIGTERM'] as const;
  let closing: Promise<void> | undefined;
  const detach = (): void => {
    for (const signal of terminationSignals) signals.removeListener(signal, close);
  };
  const close = (): void => {
    closing ??= session.close().catch((error: unknown) => writeDiagnostics(machineLine(diagnosticsFor(error)))).finally(() => {
      detach();
      settle();
    });
  };
  for (const signal of terminationSignals) signals.once(signal, close);
  void until?.then(() => {
    if (closing !== undefined) return;
    detach();
    settle();
  }, () => undefined);
});

export const runCli = async (
  args: string[],
  output: CliOutput = {},
  dependencies: CliDependencies = {},
): Promise<number> => {
  // The terminal services are provided exactly once, here at the composition
  // root, but built lazily: the runtime module loads on the first command
  // write, so `--version`, `--help`, and argv errors (which Commander writes
  // synchronously to the sinks below and then aborts parsing) never load it.
  let terminal: Promise<CliTerminal> | undefined;
  const cliTerminal = (): Promise<CliTerminal> =>
    (terminal ??= import('./effect/cli-runtime.ts').then(({ makeCliTerminal }) => makeCliTerminal(output.services)));
  const show = async (text: string): Promise<void> => (await cliTerminal()).display(text);
  const machine = async (result: unknown): Promise<void> => (await cliTerminal()).writeStdout(machineLine(result));
  const diagnostics = async (text: string): Promise<void> => (await cliTerminal()).writeStderr(text);
  const argvText = output.argvText ?? processArgvText;
  let foreground: Promise<void> | undefined;
  let exitCode = 0;
  const program = new Command();
  program
    .name('agent-bundle')
    .version(__AGENT_BUNDLE_VERSION__)
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeErr: (chunk) => argvText.stderr(chunk),
      writeOut: (chunk) => argvText.stdout(chunk),
    });

  const devCommand = program.command('dev').description('Serve the packaged development workbench on loopback')
    .option('--root <root>', 'Project root', process.cwd())
    .option('--port <port>', 'Loopback TCP port', port)
    .option('--agent-api', 'Enable the authenticated Agent API on /mcp')
    .option('--no-agent-api', 'Disable the authenticated Agent API on /mcp')
    .option('--install-host <host>', 'Install and re-sync a development host (repeatable)', collectInstallHost, [])
    .option('--open', 'Open the workbench after the foreground server starts')
    .option('--no-open', 'Do not open the workbench after the foreground server starts')
    .option('--workbench-dev-origin <origin>', 'Accept Workbench UI requests from this loopback contributor HMR origin (repeatable)', collect, []);
  devCommand.action(async (options: DevCommandOptions) => {
    const { startDevServer: start } = await import('./api.ts');
    const session = await (dependencies.startDevServer ?? start)({
      ...(options.agentApi === undefined ? {} : { agentApi: options.agentApi }),
      installHosts: options.installHost,
      open: options.open === true,
      ...(options.port === undefined ? {} : { port: options.port }),
      root: options.root,
      ...(options.workbenchDevOrigin.length === 0 ? {} : { workbenchDevOrigins: options.workbenchDevOrigin }),
    });
    await show(`Development workbench at ${session.url}\n`);
    foreground = closeForegroundOnSignal(session, dependencies.signals ?? process, diagnostics);
  });

  const devProxyCommand = devCommand.command('proxy')
    .description('Bridge host stdio MCP traffic to a running development server')
    .requiredOption('--server <server>', 'Generated MCP server name')
    .option('--target <target>', 'Generated target containing the MCP server', 'portable')
    .option('--url <url>', 'Explicit loopback development server origin');
  devProxyCommand.action(async (options: DevProxyCommandOptions) => {
    const proxy = dependencies.runHostMcpProxy ?? (await import('./dev/host-mcp-proxy.ts')).runHostMcpProxy;
    // The bridge reports at arbitrary times over its lifetime; a serial chain
    // keeps its stderr lines in order and lets the action await the last one.
    let pending = Promise.resolve();
    exitCode = await proxy({
      projectRoot: devCommand.opts<DevCommandOptions>().root,
      serverName: options.server,
      target: options.target,
      ...(options.url === undefined ? {} : { url: options.url }),
      writeDiagnostic: (message) => { pending = pending.then(() => diagnostics(`${message}\n`)); },
    });
    await pending;
  });

  const serveAppCommand = program.command('serve-app')
    .description('Serve one built MCP App standalone in a browser, bound to its packed MCP server')
    .argument('<app>', 'MCP App as <server>/<app>, or <server>/ui://... for an exact resource URI')
    .option('--root <root>', 'Project root', process.cwd())
    .option('--config <path>', 'Configuration file relative to --root')
    .option('--mode <mode>', 'Configuration mode', 'production')
    .option('--artifact <path>', 'Use exactly this built artifact')
    .option('--target <target>', 'Artifact target containing the MCP server', 'portable')
    .option('--tool <tool>', 'Tool whose result opens the App (default: the only tool that declares the App)')
    .option('--input <json>', 'Inline JSON object input for the opening tool call')
    .option('--input-file <path>', 'JSON object input file for the opening tool call')
    .option('--port <port>', 'Loopback TCP port', port)
    .option('--profile <profile>', 'Simulated MCP Apps host profile: portable, claude, or chatgpt', mcpAppProfile, 'portable')
    .option(
      '--allow <capability>',
      'Approve one consent capability on your behalf as the App requests it (repeatable): call-tool, download-file, open-external-link, request-display-mode',
      collectConsentCapability,
      [],
    )
    .option('--open', 'Open the default browser once the host is listening')
    .option('--no-open', 'Do not open the default browser')
    .option('--env-file <path>', 'Load exactly this .env file, replacing the project-root set (repeatable)', collect, [])
    .option('--no-env', 'Launch the server without loading any .env files')
    .option('--plugin-root <path>', 'Expand env plugin-root anchors against this root instead of the project root');
  serveAppCommand.action(async (app: string, options: ServeAppCommandOptions) => {
    if (options.env === false && options.envFile.length > 0) {
      throw new TypeError('Use either --env-file or --no-env, not both.');
    }
    const input = options.input === undefined && options.inputFile === undefined ? {} : await parseJsonObject(options);
    const { serveApp: serve } = await import('./api.ts');
    const served = await (dependencies.serveApp ?? serve)({
      ...(options.allow.length === 0 ? {} : { autoApprove: options.allow }),
      app,
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
      ...(options.config === undefined ? {} : { configPath: options.config }),
      ...(options.envFile.length === 0 ? {} : { envFiles: options.envFile }),
      input,
      ...(options.env === false ? { loadEnvFiles: false } : {}),
      mode: options.mode,
      open: options.open === true,
      ...(options.pluginRoot === undefined ? {} : { pluginRoot: options.pluginRoot }),
      ...(options.port === undefined ? {} : { port: options.port }),
      profile: options.profile,
      root: options.root,
      target: options.target,
      ...(options.tool === undefined ? {} : { tool: options.tool }),
    });
    await show(`MCP App ${app} at ${served.url} (tool ${served.tool}; Ctrl-C stops the server)\n`);
    // The host outlives this call like `dev` does; it ends on a termination
    // signal, or when the bound server exits on its own, which is reported
    // as a diagnostic and, in the real process, as exit code 1.
    let closedBySignal = false;
    const session = {
      close: () => {
        closedBySignal = true;
        return served.close();
      },
    };
    foreground = closeForegroundOnSignal(session, dependencies.signals ?? process, diagnostics, served.closed).then(async () => {
      if (closedBySignal) return;
      await diagnostics(machineLine([{
        code: 'AB5000',
        message: `The MCP server behind ${app} exited; the MCP App host closed.`,
        severity: 'error',
      } satisfies Diagnostic]));
      if (dependencies.signals === undefined) process.exitCode = 1;
      await served.close().catch(() => undefined);
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
    await (options.json === true ? machine(result) : show(humanBuild(result)));
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
    await (options.json === true ? machine(result) : show(humanPrepack(result)));
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
    await (options.json === true ? machine(result) : show(humanInstall(result)));
  });

  const uninstallCommand = program.command('uninstall')
    .description('Remove a receipt-owned host install of a built bundle, and nothing else')
    .argument('<host>', 'Host to uninstall from: claude, codex, or cursor', installHost)
    .option('--from <bundle-dir>', 'Target bundle directory or artifact root that identifies the plugin', process.cwd())
    .option('--scope <scope>', 'Host install scope', installScope, 'user')
    .option('--mode <mode>', 'Cursor delivery mode to uninstall: local (default) or marketplace', installMode)
    .option('--keep-data', 'Keep the plugin\'s durable runtime state (state/) in place; this is the default')
    .option('--purge-data', 'Also remove the plugin\'s durable runtime state; requires --confirm-purge')
    .option('--confirm-purge', 'Confirm that --purge-data may delete durable state')
    .option(
      '--force',
      'Proceed without an install receipt (legacy or host-only install) or when owned content no longer matches the receipt; ' +
        'foreign directories are still refused',
    )
    .option('--plan', 'Print the exact paths and host registrations that would be removed without changing anything')
    .option('--json', 'Write one machine-readable JSON document');
  uninstallCommand.action(async (
    host: InstallHost,
    options: UninstallCommandOptions,
  ) => {
    const uninstall = dependencies.uninstallBundle ?? (await import('./install/uninstall.ts')).uninstallBundle;
    const result = await uninstall({
      ...(options.confirmPurge === undefined ? {} : { confirmPurge: options.confirmPurge }),
      ...(options.force === undefined ? {} : { force: options.force }),
      from: options.from,
      host,
      ...(options.keepData === undefined ? {} : { keepData: options.keepData }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.plan === undefined ? {} : { plan: options.plan }),
      ...(options.purgeData === undefined ? {} : { purgeData: options.purgeData }),
      scope: installScope(options.scope),
    });
    await (options.json === true ? machine(result) : show(humanUninstall(result)));
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
    await (options.json === true ? machine(result) : show(humanDoctor(result)));
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
    await (options.json === true ? machine(result) : show(humanValidate(result)));
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
    await (options.json === true ? machine(result) : show(humanEval(result)));
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
    await (sourceOptions.json === true ? machine(result) : show(humanEvalComparison(result)));
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
    await (options.json === true ? machine(result) : show(humanInspect(result)));
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
    await (options.json === true ? machine(result) : show(`Listed ${result.tools.length} tool(s) from ${options.server}\n`));
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
    await (options.json === true ? machine(result) : show(`Invoked ${options.tool} on ${options.server}\n`));
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
    await (options.json === true ? machine(result) : show(`Listed ${result.length} hook(s)${options.target === undefined ? '' : ` from ${options.target}`}\n`));
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
    await (options.json === true ? machine(result) : show(`Simulated ${options.hook}\n`));
  });

  try {
    await program.parseAsync(args, { from: 'user' });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    await diagnostics(machineLine(diagnosticsFor(error)));
    return 1;
  } finally {
    // Only a command that wrote something built the runtime. A foreground
    // session outlives this call; its close diagnostics still need the
    // services, so the runtime follows the session instead.
    if (terminal !== undefined) {
      const built = terminal;
      const close = (): Promise<void> => built.then((active) => active.close(), () => undefined);
      if (foreground === undefined) await close();
      else void foreground.then(close);
    }
  }
};

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
