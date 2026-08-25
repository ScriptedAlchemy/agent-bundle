import { execFile } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { meetsMinimumVersion, parseSemanticVersion } from '../core/semver.ts';
import { isCredentialKey, isProviderEndpointKey } from '../core/credentials.ts';
import { parseRedactedEventEnvelopes, type RedactedEventEnvelope } from './host-contract.ts';
import {
  digestFileTree,
  nativeSmokeOptIn,
  sameDigestSnapshot,
  snapshotDigestSites,
  withoutEnvironmentKeysMatching,
  type DigestSnapshot,
} from './native-host-spine.ts';
import { runBoundedChildProcess } from './process.ts';

const codexExecutable = 'codex';
const minimumCodexVersion = '0.147.0';
const candidatePluginName = 'agent-bundle-codex-smoke';
const candidateMarketplaceName = 'agent-bundle-codex-smoke-marketplace';
const smokeSkillSentinel = 'agent-bundle-codex-skill-sentinel';
const smokePrompt = 'Complete the Agent Bundle Codex smoke attestation by following its Skill, then reply with its exact sentinel and nothing else.';
const defaultProcessLimits = Object.freeze({
  killGraceMs: 1_000,
  maxOutputBytes: 256 * 1024,
  timeoutMs: 120_000,
});

type CodexNativeSmokeStage = 'auth' | 'candidate' | 'cleanup' | 'exec' | 'fixture' | 'marketplace.add' | 'normal-home' | 'plugin.add' | 'plugin.list' | 'temp-home' | 'version';

export interface CodexNativeSmokeProcessLimits {
  readonly killGraceMs: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface CodexNativeSmokeCommand {
  readonly args: readonly string[];
  readonly id: Exclude<CodexNativeSmokeStage, 'auth' | 'version'>;
}

export interface CodexNativeSmokeCommandResult {
  readonly exitCode: number;
  readonly failure?: 'output-limit' | 'timeout';
  readonly stderr: string;
  readonly stdout: string;
}

export interface CodexNativeSmokeProcessCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly limits: CodexNativeSmokeProcessLimits;
}

export type CodexNativeSmokeCommandRunner = (
  command: CodexNativeSmokeProcessCommand,
) => Promise<CodexNativeSmokeCommandResult>;

export interface CodexNativeSmokeFailureInput {
  readonly code?: string;
  readonly failure?: 'output-limit' | 'timeout';
  readonly output?: string;
  readonly stage: CodexNativeSmokeStage;
  readonly version?: string;
}

export interface CodexNativeSmokeFailure {
  readonly code: string;
  readonly kind: 'harness-failure';
}

export interface CodexNativeSmokeOptions {
  readonly candidateDirectory: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly fixtureDirectory: string;
  readonly cleanupTemporaryRoot?: (root: string) => Promise<void>;
  readonly initializeFixture?: (fixtureDirectory: string) => Promise<void>;
  readonly normalCodexHome?: string;
  readonly processLimits?: Partial<CodexNativeSmokeProcessLimits>;
  readonly run?: CodexNativeSmokeCommandRunner;
  readonly temporaryDirectoryParent?: string;
}

export interface CodexNativeSmokeResult {
  readonly activation: Readonly<{
    readonly automatic: 'inferred' | 'unavailable';
    readonly pluginAvailability: 'observed' | 'unavailable';
  }>;
  readonly cleanup?: Readonly<{ readonly status: 'failed' }>;
  readonly diagnostic?: CodexNativeSmokeFailure;
  readonly eventEnvelopes: readonly RedactedEventEnvelope[];
  readonly normalHome: Readonly<{
    readonly auth: 'unchanged' | 'unknown';
    readonly config: 'unchanged' | 'unknown';
    readonly plugins: 'unchanged' | 'unknown';
  }>;
  readonly status: 'harness-failure' | 'passed' | 'skipped';
}

type CodexStateSite = 'auth' | 'config' | 'plugins';
type CodexStateSnapshot = DigestSnapshot<CodexStateSite>;

class SmokeStepError extends Error {
  readonly code?: string;
  readonly failure?: 'output-limit' | 'timeout';
  readonly output?: string;
  readonly stage: CodexNativeSmokeStage;
  readonly version?: string;

  constructor(input: CodexNativeSmokeFailureInput) {
    super(input.stage);
    this.code = input.code;
    this.failure = input.failure;
    this.output = input.output;
    this.stage = input.stage;
    this.version = input.version;
  }
}

// Shared union credential classifier plus provider endpoint routing, so the
// hermetic child cannot see credential material or an env-configured endpoint.
const providerApiKeyName = (name: string): boolean =>
  isCredentialKey(name) || isProviderEndpointKey(name);

export const withoutProviderApiKeys = (environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  withoutEnvironmentKeysMatching(environment, providerApiKeyName);

export const nativeCodexSmokeEnabled = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean => nativeSmokeOptIn(environment, 'AGENT_BUNDLE_NATIVE_CODEX_SMOKE');

export const createCodexNativeSmokePlan = (
  paths: Readonly<{ readonly candidateDirectory: string; readonly fixtureDirectory: string }>,
): readonly CodexNativeSmokeCommand[] => Object.freeze([
  Object.freeze({
    args: Object.freeze(['plugin', 'marketplace', 'add', paths.candidateDirectory]),
    id: 'marketplace.add' as const,
  }),
  Object.freeze({
    args: Object.freeze(['plugin', 'add', `${candidatePluginName}@${candidateMarketplaceName}`]),
    id: 'plugin.add' as const,
  }),
  Object.freeze({ args: Object.freeze(['plugin', 'list', '--json']), id: 'plugin.list' as const }),
  Object.freeze({
    args: Object.freeze([
      'exec',
      '--strict-config',
      '--ephemeral',
      '--json',
      '-s',
      'read-only',
      '-C',
      paths.fixtureDirectory,
      smokePrompt,
    ]),
    id: 'exec' as const,
  }),
]);

export const normalizeCodexNativeSmokeEvents = (raw: string): readonly RedactedEventEnvelope[] =>
  parseRedactedEventEnvelopes(raw);

const isCompatibleVersion = (value: string): boolean => {
  const observed = parseSemanticVersion(value);
  const minimum = parseSemanticVersion(minimumCodexVersion)!;
  if (observed === undefined) return false;
  return meetsMinimumVersion(observed, minimum);
};

const authenticationFailure = (output: string | undefined): boolean =>
  output !== undefined && /(?:\bauth(?:entication)?\b|\blog[ -]?in\b|\bsign[ -]?in\b|\bsubscription\b)/iu.test(output);

export const classifyCodexNativeSmokeFailure = (
  input: CodexNativeSmokeFailureInput,
): CodexNativeSmokeFailure => {
  if (input.failure === 'timeout') return Object.freeze({ code: `native-codex.${input.stage}.timeout`, kind: 'harness-failure' });
  if (input.failure === 'output-limit') return Object.freeze({ code: `native-codex.${input.stage}.output-limit`, kind: 'harness-failure' });
  if (input.stage === 'auth' && input.code === 'ENOENT') {
    return Object.freeze({ code: 'native-codex.auth.missing', kind: 'harness-failure' });
  }
  if (input.stage === 'version' && input.code === 'ENOENT') {
    return Object.freeze({ code: 'native-codex.cli.missing', kind: 'harness-failure' });
  }
  if (input.stage === 'version' && input.version !== undefined && !isCompatibleVersion(input.version)) {
    return Object.freeze({ code: 'native-codex.cli.incompatible', kind: 'harness-failure' });
  }
  if (authenticationFailure(input.output)) {
    return Object.freeze({ code: 'native-codex.cli.unauthenticated', kind: 'harness-failure' });
  }
  return Object.freeze({ code: `native-codex.${input.stage}.failed`, kind: 'harness-failure' });
};

export const copyOpaqueCodexAuthState = async (source: string, destination: string): Promise<void> => {
  const sourceStat = await stat(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, sourceStat.mode & 0o777);
};

const snapshotCodexState = (codexHome: string): Promise<CodexStateSnapshot> =>
  snapshotDigestSites<CodexStateSite>(Object.freeze({
    auth: () => digestFileTree(join(codexHome, 'auth.json')),
    config: () => digestFileTree(join(codexHome, 'config.toml')),
    plugins: () => digestFileTree(join(codexHome, 'plugins')),
  }));

const normalHomeResult = (before: CodexStateSnapshot | undefined, after: CodexStateSnapshot | undefined) => Object.freeze({
  auth: before !== undefined && after !== undefined && before.auth === after.auth ? 'unchanged' as const : 'unknown' as const,
  config: before !== undefined && after !== undefined && before.config === after.config ? 'unchanged' as const : 'unknown' as const,
  plugins: before !== undefined && after !== undefined && before.plugins === after.plugins ? 'unchanged' as const : 'unknown' as const,
});

const boundedPositiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;

const resolveProcessLimits = (
  requested: Partial<CodexNativeSmokeProcessLimits> | undefined,
): CodexNativeSmokeProcessLimits => Object.freeze({
  killGraceMs: boundedPositiveInteger(requested?.killGraceMs, defaultProcessLimits.killGraceMs),
  maxOutputBytes: boundedPositiveInteger(requested?.maxOutputBytes, defaultProcessLimits.maxOutputBytes),
  timeoutMs: boundedPositiveInteger(requested?.timeoutMs, defaultProcessLimits.timeoutMs),
});

const defaultCodexRunner: CodexNativeSmokeCommandRunner = async (command) => {
  const result = await runBoundedChildProcess(Object.freeze({
    args: command.args,
    cwd: command.cwd,
    environment: command.environment,
    executable: codexExecutable,
  }), Object.freeze({
    discardAfterTermination: true,
    forceFinishMs: command.limits.killGraceMs * 2,
    gracePeriodMs: command.limits.killGraceMs,
    labels: Object.freeze({ outputLimit: 'output-limit', timedOut: 'timeout' }),
    maxOutputBytes: command.limits.maxOutputBytes,
    overflow: 'truncate',
    outputBudget: 'separate',
    timeoutMs: command.limits.timeoutMs,
    windowsHide: true,
  }));
  return Object.freeze({
    exitCode: result.exitCode ?? 1,
    failure: result.termination,
    stderr: result.stderr,
    stdout: result.stdout,
  });
};

const executeFileAsync = promisify(execFile);

const initializeCodexSmokeFixture = async (fixtureDirectory: string): Promise<void> => {
  await executeFileAsync('git', ['init', '--quiet', fixtureDirectory], {
    encoding: 'utf8',
    windowsHide: true,
  });
};

const outputContainsPlugin = (output: string): boolean => {
  try {
    const parsed = JSON.parse(output) as unknown;
    return JSON.stringify(parsed).includes(candidatePluginName);
  } catch {
    return output.split(/\r?\n/u).some((line) => {
      try {
        return JSON.stringify(JSON.parse(line) as unknown).includes(candidatePluginName);
      } catch {
        return false;
      }
    });
  }
};

const failedResult = (
  failure: CodexNativeSmokeFailure,
  before: CodexStateSnapshot | undefined,
  after: CodexStateSnapshot | undefined,
  eventEnvelopes: readonly RedactedEventEnvelope[] = Object.freeze([]),
): CodexNativeSmokeResult => Object.freeze({
  activation: Object.freeze({ automatic: 'unavailable', pluginAvailability: 'unavailable' }),
  diagnostic: failure,
  eventEnvelopes,
  normalHome: normalHomeResult(before, after),
  status: 'harness-failure',
});

const skippedCodexNativeSmokeResult: CodexNativeSmokeResult = Object.freeze({
  activation: Object.freeze({ automatic: 'unavailable', pluginAvailability: 'unavailable' }),
  eventEnvelopes: Object.freeze([]),
  normalHome: Object.freeze({ auth: 'unknown', config: 'unknown', plugins: 'unknown' }),
  status: 'skipped',
});

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const failedStep = (stage: CodexNativeSmokeStage, error: unknown): SmokeStepError =>
  error instanceof SmokeStepError ? error : new SmokeStepError({ code: errorCode(error), stage });

type CodexSmokeExecutor = (
  stage: CodexNativeSmokeStage,
  command: CodexNativeSmokeProcessCommand,
) => Promise<CodexNativeSmokeCommandResult>;

const createCodexSmokeExecutor = (runner: CodexNativeSmokeCommandRunner): CodexSmokeExecutor =>
  async (stage, command) => {
    try {
      const commandResult = await runner(command);
      if (commandResult.failure !== undefined) {
        throw new SmokeStepError({ failure: commandResult.failure, stage });
      }
      return commandResult;
    } catch (error) {
      throw failedStep(stage, error);
    }
  };

interface CodexSmokeStaging {
  readonly candidate: string;
  readonly fixture: string;
  readonly home: string;
  readonly root: string;
}

/** Events parsed so far; kept outside the phases so a failing phase still reports them. */
interface CodexSmokeEvidence {
  events: readonly RedactedEventEnvelope[];
}

const createCodexSmokeRoot = async (temporaryDirectoryParent: string): Promise<string> => {
  try {
    await mkdir(temporaryDirectoryParent, { recursive: true });
    return await mkdtemp(join(temporaryDirectoryParent, 'agent-bundle-codex-smoke-'));
  } catch (error) {
    throw failedStep('temp-home', error);
  }
};

const codexSmokeStagingFor = (root: string): CodexSmokeStaging => Object.freeze({
  candidate: join(root, 'candidate'),
  fixture: join(root, 'fixture'),
  home: join(root, 'home'),
  root,
});

const stageCodexSmokeInputs = async (
  options: CodexNativeSmokeOptions,
  staging: CodexSmokeStaging,
): Promise<void> => {
  try {
    await mkdir(staging.home, { recursive: true });
  } catch (error) {
    throw failedStep('temp-home', error);
  }
  try {
    await lstat(options.candidateDirectory);
    await cp(options.candidateDirectory, staging.candidate, { recursive: true });
  } catch (error) {
    throw failedStep('candidate', error);
  }
  try {
    await cp(options.fixtureDirectory, staging.fixture, { recursive: true });
    await (options.initializeFixture ?? initializeCodexSmokeFixture)(staging.fixture);
  } catch (error) {
    throw failedStep('fixture', error);
  }
};

const runCodexVersionPreflight = async (
  execute: CodexSmokeExecutor,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  limits: CodexNativeSmokeProcessLimits,
): Promise<void> => {
  const version = await execute('version', { args: ['--version'], cwd, environment, limits });
  if (version.exitCode !== 0) throw new SmokeStepError({ output: `${version.stdout}\n${version.stderr}`, stage: 'version' });
  if (!isCompatibleVersion(version.stdout)) throw new SmokeStepError({ stage: 'version', version: version.stdout });
};

const adoptCodexSmokeAuth = async (normalCodexHome: string, temporaryHome: string): Promise<void> => {
  try {
    await copyOpaqueCodexAuthState(join(normalCodexHome, 'auth.json'), join(temporaryHome, 'auth.json'));
  } catch (error) {
    throw failedStep('auth', error);
  }
};

const executeCodexSmokePlan = async (
  execute: CodexSmokeExecutor,
  staging: CodexSmokeStaging,
  environment: NodeJS.ProcessEnv,
  limits: CodexNativeSmokeProcessLimits,
  evidence: CodexSmokeEvidence,
): Promise<CodexNativeSmokeResult['activation']> => {
  const commands = createCodexNativeSmokePlan({
    candidateDirectory: staging.candidate,
    fixtureDirectory: staging.fixture,
  });
  let pluginAvailability: CodexNativeSmokeResult['activation']['pluginAvailability'] = 'unavailable';
  let automatic: CodexNativeSmokeResult['activation']['automatic'] = 'unavailable';
  for (const command of commands) {
    const commandResult = await execute(command.id, {
      args: command.args,
      cwd: staging.fixture,
      environment,
      limits,
    });
    if (command.id === 'plugin.list' && !outputContainsPlugin(commandResult.stdout)) {
      throw new SmokeStepError({ stage: command.id });
    }
    if (command.id === 'plugin.list') pluginAvailability = 'observed';
    if (command.id === 'exec') {
      try {
        evidence.events = normalizeCodexNativeSmokeEvents(commandResult.stdout);
      } catch {
        throw new SmokeStepError({ stage: command.id });
      }
      if (commandResult.stdout.includes(smokeSkillSentinel)) automatic = 'inferred';
    }
    if (commandResult.exitCode !== 0) {
      throw new SmokeStepError({ output: `${commandResult.stdout}\n${commandResult.stderr}`, stage: command.id });
    }
  }
  return Object.freeze({ automatic, pluginAvailability });
};

const removeCodexSmokeRoot = async (
  options: CodexNativeSmokeOptions,
  root: string,
  result: CodexNativeSmokeResult,
): Promise<CodexNativeSmokeResult> => {
  try {
    await (options.cleanupTemporaryRoot ?? (async (temporaryRoot: string) => {
      await rm(temporaryRoot, { force: true, recursive: true });
    }))(root);
    return result;
  } catch {
    if (result.status === 'passed') {
      return Object.freeze({
        ...result,
        cleanup: Object.freeze({ status: 'failed' as const }),
        diagnostic: Object.freeze({ code: 'native-codex.cleanup.failed', kind: 'harness-failure' as const }),
        status: 'harness-failure',
      });
    }
    return Object.freeze({ ...result, cleanup: Object.freeze({ status: 'failed' as const }) });
  }
};

export const runCodexNativeSmoke = async (options: CodexNativeSmokeOptions): Promise<CodexNativeSmokeResult> => {
  const environment = options.environment ?? process.env;
  if (!nativeCodexSmokeEnabled(environment)) return skippedCodexNativeSmokeResult;

  const normalCodexHome = options.normalCodexHome ?? environment.CODEX_HOME ?? join(homedir(), '.codex');
  const temporaryDirectoryParent = options.temporaryDirectoryParent ?? tmpdir();
  const execute = createCodexSmokeExecutor(options.run ?? defaultCodexRunner);
  const limits = resolveProcessLimits(options.processLimits);
  const evidence: CodexSmokeEvidence = { events: Object.freeze([]) };
  let before: CodexStateSnapshot | undefined;
  let after: CodexStateSnapshot | undefined;
  let root: string | undefined;
  let result: CodexNativeSmokeResult;

  try {
    try {
      before = await snapshotCodexState(normalCodexHome);
    } catch (error) {
      throw failedStep('normal-home', error);
    }
    root = await createCodexSmokeRoot(temporaryDirectoryParent);
    const staging = codexSmokeStagingFor(root);
    await stageCodexSmokeInputs(options, staging);
    const childEnvironment = Object.freeze({
      ...withoutProviderApiKeys(environment),
      CODEX_HOME: staging.home,
    });
    await runCodexVersionPreflight(execute, staging.fixture, childEnvironment, limits);
    await adoptCodexSmokeAuth(normalCodexHome, staging.home);
    const activation = await executeCodexSmokePlan(execute, staging, childEnvironment, limits, evidence);

    try {
      after = await snapshotCodexState(normalCodexHome);
    } catch (error) {
      throw failedStep('normal-home', error);
    }
    if (!sameDigestSnapshot(before, after)) {
      result = failedResult(Object.freeze({ code: 'native-codex.normal-home.changed', kind: 'harness-failure' }), before, after, evidence.events);
    } else {
      result = Object.freeze({
        activation,
        eventEnvelopes: evidence.events,
        normalHome: normalHomeResult(before, after),
        status: 'passed',
      });
    }
  } catch (error) {
    if (before !== undefined) {
      try {
        after = await snapshotCodexState(normalCodexHome);
      } catch {
        // The primary structured failure remains authoritative.
      }
    }
    const input = error instanceof SmokeStepError ? error : new SmokeStepError({ stage: 'exec' });
    result = failedResult(classifyCodexNativeSmokeFailure(input), before, after, evidence.events);
  }

  return root === undefined ? result : removeCodexSmokeRoot(options, root, result);
};

export const codexNativeSmokeReportPath = (repositoryRoot: string): string =>
  join(repositoryRoot, '.agent-bundle', 'w2-codex-native-contract-evidence.json');
