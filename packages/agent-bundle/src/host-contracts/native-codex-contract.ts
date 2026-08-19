import { execFile, spawn } from 'node:child_process';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseRedactedEventEnvelopes, type RedactedEventEnvelope } from './host-contract.ts';

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

interface CodexStateSnapshot {
  readonly auth: string;
  readonly config: string;
  readonly plugins: string;
}

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

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

const providerApiKeyName = (name: string): boolean =>
  /(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$/iu.test(name)
  || /^(?:ANTHROPIC|AZURE_OPENAI|CODEX|COHERE|DEEPSEEK|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|MISTRAL|OPENAI|PERPLEXITY|TOGETHER|XAI)_(?:API_KEY|TOKEN)$/iu.test(name)
  || /^(?:CODEX|OPENAI)_(?:API_BASE|BASE_URL|URL)$/iu.test(name);

export const withoutProviderApiKeys = (environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(environment).filter(([name]) => !providerApiKeyName(name)));

export const nativeCodexSmokeEnabled = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean => environment.AGENT_BUNDLE_NATIVE_CODEX_SMOKE === '1';

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

const parseSemanticVersion = (value: string): SemanticVersion | undefined => {
  const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:$|[^0-9])/u.exec(value);
  if (match === null) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  });
};

const isCompatibleVersion = (value: string): boolean => {
  const observed = parseSemanticVersion(value);
  const minimum = parseSemanticVersion(minimumCodexVersion)!;
  if (observed === undefined) return false;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (observed[key] !== minimum[key]) return observed[key] > minimum[key];
  }
  return !observed.prerelease;
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

const digestFileTree = async (path: string): Promise<string> => {
  try {
    const entry = await lstat(path);
    const digest = createHash('sha256');
    const add = (value: string | Uint8Array): void => { digest.update(value); };
    if (entry.isFile()) {
      add('file\0');
      add(await readFile(path));
      return digest.digest('hex');
    }
    if (entry.isDirectory()) {
      add('directory\0');
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        add(`${child.name}\0${await digestFileTree(join(path, child.name))}\0`);
      }
      return digest.digest('hex');
    }
    add(`other\0${entry.mode}\0`);
    return digest.digest('hex');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
};

const snapshotCodexState = async (codexHome: string): Promise<CodexStateSnapshot> => Object.freeze({
  auth: await digestFileTree(join(codexHome, 'auth.json')),
  config: await digestFileTree(join(codexHome, 'config.toml')),
  plugins: await digestFileTree(join(codexHome, 'plugins')),
});

const sameSnapshot = (left: CodexStateSnapshot, right: CodexStateSnapshot): boolean =>
  left.auth === right.auth && left.config === right.config && left.plugins === right.plugins;

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

const defaultCodexRunner: CodexNativeSmokeCommandRunner = (command) => new Promise((resolvePromise, reject) => {
  const child = spawn(codexExecutable, command.args, {
    cwd: command.cwd,
    env: command.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure: CodexNativeSmokeCommandResult['failure'];
  let finished = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  let forcedFinishTimer: NodeJS.Timeout | undefined;

  const clearTimers = (): void => {
    clearTimeout(timeoutTimer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    if (forcedFinishTimer !== undefined) clearTimeout(forcedFinishTimer);
  };
  const complete = (exitCode: number): void => {
    if (finished) return;
    finished = true;
    clearTimers();
    resolvePromise(Object.freeze({
      exitCode,
      failure,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    }));
  };
  const terminate = (reason: NonNullable<CodexNativeSmokeCommandResult['failure']>): void => {
    if (failure !== undefined || finished) return;
    failure = reason;
    child.kill('SIGTERM');
    escalationTimer = setTimeout(() => {
      if (!finished) child.kill('SIGKILL');
    }, command.limits.killGraceMs);
    forcedFinishTimer = setTimeout(() => complete(1), command.limits.killGraceMs * 2);
  };
  const append = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
    if (failure !== undefined) return currentBytes;
    const availableBytes = command.limits.maxOutputBytes - currentBytes;
    if (availableBytes <= 0) {
      terminate('output-limit');
      return currentBytes;
    }
    if (chunk.byteLength <= availableBytes) {
      chunks.push(chunk);
      return currentBytes + chunk.byteLength;
    }
    chunks.push(chunk.subarray(0, availableBytes));
    terminate('output-limit');
    return command.limits.maxOutputBytes;
  };
  const timeoutTimer = setTimeout(() => terminate('timeout'), command.limits.timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = append(stdoutChunks, stdoutBytes, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = append(stderrChunks, stderrBytes, chunk); });
  child.once('error', (error) => {
    if (finished) return;
    finished = true;
    clearTimers();
    reject(error);
  });
  child.once('close', (code) => complete(code ?? 1));
});

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

export const runCodexNativeSmoke = async (options: CodexNativeSmokeOptions): Promise<CodexNativeSmokeResult> => {
  const environment = options.environment ?? process.env;
  if (!nativeCodexSmokeEnabled(environment)) {
    return Object.freeze({
      activation: Object.freeze({ automatic: 'unavailable', pluginAvailability: 'unavailable' }),
      eventEnvelopes: Object.freeze([]),
      normalHome: Object.freeze({ auth: 'unknown', config: 'unknown', plugins: 'unknown' }),
      status: 'skipped',
    });
  }

  const normalCodexHome = options.normalCodexHome ?? environment.CODEX_HOME ?? join(homedir(), '.codex');
  const temporaryDirectoryParent = options.temporaryDirectoryParent ?? tmpdir();
  const runner = options.run ?? defaultCodexRunner;
  const limits = resolveProcessLimits(options.processLimits);
  let before: CodexStateSnapshot | undefined;
  let after: CodexStateSnapshot | undefined;
  let events: readonly RedactedEventEnvelope[] = Object.freeze([]);
  let root: string | undefined;
  let result: CodexNativeSmokeResult;

  const errorCode = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  const failedStep = (stage: CodexNativeSmokeStage, error: unknown): SmokeStepError =>
    error instanceof SmokeStepError ? error : new SmokeStepError({ code: errorCode(error), stage });
  const execute = async (
    stage: CodexNativeSmokeStage,
    command: CodexNativeSmokeProcessCommand,
  ): Promise<CodexNativeSmokeCommandResult> => {
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

  try {
    try {
      before = await snapshotCodexState(normalCodexHome);
    } catch (error) {
      throw failedStep('normal-home', error);
    }
    try {
      await mkdir(temporaryDirectoryParent, { recursive: true });
      root = await mkdtemp(join(temporaryDirectoryParent, 'agent-bundle-codex-smoke-'));
    } catch (error) {
      throw failedStep('temp-home', error);
    }
    const temporaryHome = join(root, 'home');
    const temporaryCandidate = join(root, 'candidate');
    const temporaryFixture = join(root, 'fixture');
    try {
      await mkdir(temporaryHome, { recursive: true });
    } catch (error) {
      throw failedStep('temp-home', error);
    }
    try {
      await lstat(options.candidateDirectory);
      await cp(options.candidateDirectory, temporaryCandidate, { recursive: true });
    } catch (error) {
      throw failedStep('candidate', error);
    }
    try {
      await cp(options.fixtureDirectory, temporaryFixture, { recursive: true });
      await (options.initializeFixture ?? initializeCodexSmokeFixture)(temporaryFixture);
    } catch (error) {
      throw failedStep('fixture', error);
    }
    const childEnvironment = Object.freeze({
      ...withoutProviderApiKeys(environment),
      CODEX_HOME: temporaryHome,
    });

    const version = await execute('version', {
      args: ['--version'],
      cwd: temporaryFixture,
      environment: childEnvironment,
      limits,
    });
    if (version.exitCode !== 0) throw new SmokeStepError({ output: `${version.stdout}\n${version.stderr}`, stage: 'version' });
    if (!isCompatibleVersion(version.stdout)) throw new SmokeStepError({ stage: 'version', version: version.stdout });

    try {
      await copyOpaqueCodexAuthState(join(normalCodexHome, 'auth.json'), join(temporaryHome, 'auth.json'));
    } catch (error) {
      throw failedStep('auth', error);
    }

    const commands = createCodexNativeSmokePlan({
      candidateDirectory: temporaryCandidate,
      fixtureDirectory: temporaryFixture,
    });
    let pluginAvailability: CodexNativeSmokeResult['activation']['pluginAvailability'] = 'unavailable';
    let automatic: CodexNativeSmokeResult['activation']['automatic'] = 'unavailable';
    for (const command of commands) {
      const commandResult = await execute(command.id, {
        args: command.args,
        cwd: temporaryFixture,
        environment: childEnvironment,
        limits,
      });
      if (command.id === 'plugin.list' && !outputContainsPlugin(commandResult.stdout)) {
        throw new SmokeStepError({ stage: command.id });
      }
      if (command.id === 'plugin.list') pluginAvailability = 'observed';
      if (command.id === 'exec') {
        try {
          events = normalizeCodexNativeSmokeEvents(commandResult.stdout);
        } catch {
          throw new SmokeStepError({ stage: command.id });
        }
        if (commandResult.stdout.includes(smokeSkillSentinel)) automatic = 'inferred';
      }
      if (commandResult.exitCode !== 0) {
        throw new SmokeStepError({ output: `${commandResult.stdout}\n${commandResult.stderr}`, stage: command.id });
      }
    }

    try {
      after = await snapshotCodexState(normalCodexHome);
    } catch (error) {
      throw failedStep('normal-home', error);
    }
    if (!sameSnapshot(before, after)) {
      result = failedResult(Object.freeze({ code: 'native-codex.normal-home.changed', kind: 'harness-failure' }), before, after, events);
    } else {
      result = Object.freeze({
        activation: Object.freeze({ automatic, pluginAvailability }),
        eventEnvelopes: events,
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
    result = failedResult(classifyCodexNativeSmokeFailure(input), before, after, events);
  }

  if (root !== undefined) {
    try {
      await (options.cleanupTemporaryRoot ?? (async (temporaryRoot: string) => {
        await rm(temporaryRoot, { force: true, recursive: true });
      }))(root);
    } catch {
      if (result.status === 'passed') {
        result = Object.freeze({
          ...result,
          cleanup: Object.freeze({ status: 'failed' as const }),
          diagnostic: Object.freeze({ code: 'native-codex.cleanup.failed', kind: 'harness-failure' as const }),
          status: 'harness-failure',
        });
      } else {
        result = Object.freeze({ ...result, cleanup: Object.freeze({ status: 'failed' as const }) });
      }
    }
  }
  return result;
};

export const codexNativeSmokeReportPath = (repositoryRoot: string): string =>
  join(repositoryRoot, '.agent-bundle', 'w2-codex-native-contract-evidence.json');
