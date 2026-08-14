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
const smokePrompt = 'Reply with exactly: agent-bundle-codex-smoke';

type CodexNativeSmokeStage = 'auth' | 'exec' | 'fixture' | 'marketplace.add' | 'plugin.add' | 'plugin.list' | 'version';

export interface CodexNativeSmokeCommand {
  readonly args: readonly string[];
  readonly id: Exclude<CodexNativeSmokeStage, 'auth' | 'version'>;
}

export interface CodexNativeSmokeCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface CodexNativeSmokeProcessCommand {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export type CodexNativeSmokeCommandRunner = (
  command: CodexNativeSmokeProcessCommand,
) => Promise<CodexNativeSmokeCommandResult>;

export interface CodexNativeSmokeFailureInput {
  readonly code?: string;
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
  readonly initializeFixture?: (fixtureDirectory: string) => Promise<void>;
  readonly normalCodexHome?: string;
  readonly run?: CodexNativeSmokeCommandRunner;
  readonly temporaryDirectoryParent?: string;
}

export interface CodexNativeSmokeResult {
  readonly activation: Readonly<{
    readonly automatic: 'inferred' | 'unavailable';
    readonly pluginAvailability: 'observed' | 'unavailable';
  }>;
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
  readonly output?: string;
  readonly stage: CodexNativeSmokeStage;
  readonly version?: string;

  constructor(input: CodexNativeSmokeFailureInput) {
    super(input.stage);
    this.code = input.code;
    this.output = input.output;
    this.stage = input.stage;
    this.version = input.version;
  }
}

const providerApiKeyName = (name: string): boolean =>
  /(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN)$/iu.test(name)
  || /^(?:ANTHROPIC|AZURE_OPENAI|COHERE|DEEPSEEK|FIREWORKS|GEMINI|GOOGLE|GROQ|HUGGINGFACE|MISTRAL|OPENAI|PERPLEXITY|TOGETHER|XAI)_(?:API_KEY|TOKEN)$/iu.test(name);

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
  if (input.stage === 'auth' && input.code === 'ENOENT') {
    return Object.freeze({ code: 'native-codex.auth.missing', kind: 'harness-failure' });
  }
  if (input.code === 'ENOENT') return Object.freeze({ code: 'native-codex.cli.missing', kind: 'harness-failure' });
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

const normalHomeResult = (before: CodexStateSnapshot, after: CodexStateSnapshot) => Object.freeze({
  auth: before.auth === after.auth ? 'unchanged' as const : 'unknown' as const,
  config: before.config === after.config ? 'unchanged' as const : 'unknown' as const,
  plugins: before.plugins === after.plugins ? 'unchanged' as const : 'unknown' as const,
});

const defaultCodexRunner: CodexNativeSmokeCommandRunner = (command) => new Promise((resolvePromise, reject) => {
  const child = spawn(codexExecutable, command.args, {
    cwd: command.cwd,
    env: command.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolvePromise(Object.freeze({
    exitCode: code ?? 1,
    stderr,
    stdout,
  })));
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
  before: CodexStateSnapshot,
  after: CodexStateSnapshot,
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
  const before = await snapshotCodexState(normalCodexHome);
  const temporaryDirectoryParent = options.temporaryDirectoryParent ?? tmpdir();
  await mkdir(temporaryDirectoryParent, { recursive: true });
  const root = await mkdtemp(join(temporaryDirectoryParent, 'agent-bundle-codex-smoke-'));
  const temporaryHome = join(root, 'home');
  const temporaryFixture = join(root, 'fixture');
  const runner = options.run ?? defaultCodexRunner;
  let events: readonly RedactedEventEnvelope[] = Object.freeze([]);

  try {
    await mkdir(temporaryHome, { recursive: true });
    await cp(options.fixtureDirectory, temporaryFixture, { recursive: true });
    await (options.initializeFixture ?? initializeCodexSmokeFixture)(temporaryFixture).catch(() => {
      throw new SmokeStepError({ stage: 'fixture' });
    });
    const childEnvironment = Object.freeze({
      ...withoutProviderApiKeys(environment),
      CODEX_HOME: temporaryHome,
    });

    const version = await runner({
      args: ['--version'],
      cwd: temporaryFixture,
      environment: childEnvironment,
    }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
      throw new SmokeStepError({ code, stage: 'version' });
    });
    if (version.exitCode !== 0) throw new SmokeStepError({ output: `${version.stdout}\n${version.stderr}`, stage: 'version' });
    if (!isCompatibleVersion(version.stdout)) throw new SmokeStepError({ stage: 'version', version: version.stdout });

    await copyOpaqueCodexAuthState(join(normalCodexHome, 'auth.json'), join(temporaryHome, 'auth.json')).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
      throw new SmokeStepError({ code, stage: 'auth' });
    });

    const commands = createCodexNativeSmokePlan({
      candidateDirectory: options.candidateDirectory,
      fixtureDirectory: temporaryFixture,
    });
    for (const command of commands) {
      const result = await runner({
        args: command.args,
        cwd: temporaryFixture,
        environment: childEnvironment,
      }).catch((error: unknown) => {
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
          ? error.code
          : undefined;
        throw new SmokeStepError({ code, stage: command.id });
      });
      if (command.id === 'plugin.list' && !outputContainsPlugin(result.stdout)) {
        throw new SmokeStepError({ stage: command.id });
      }
      if (command.id === 'exec') {
        try {
          events = normalizeCodexNativeSmokeEvents(result.stdout);
        } catch {
          if (result.exitCode === 0) throw new SmokeStepError({ stage: command.id });
        }
      }
      if (result.exitCode !== 0) {
        throw new SmokeStepError({ output: `${result.stdout}\n${result.stderr}`, stage: command.id });
      }
    }

    const after = await snapshotCodexState(normalCodexHome);
    if (!sameSnapshot(before, after)) {
      return failedResult(Object.freeze({ code: 'native-codex.normal-home.changed', kind: 'harness-failure' }), before, after);
    }
    return Object.freeze({
      activation: Object.freeze({ automatic: 'inferred', pluginAvailability: 'observed' }),
      eventEnvelopes: events,
      normalHome: normalHomeResult(before, after),
      status: 'passed',
    });
  } catch (error) {
    const after = await snapshotCodexState(normalCodexHome);
    const input = error instanceof SmokeStepError ? error : { stage: 'exec' as const };
    return failedResult(classifyCodexNativeSmokeFailure(input), before, after, events);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const codexNativeSmokeReportPath = (repositoryRoot: string): string =>
  join(repositoryRoot, '.agent-bundle', 'w2-codex-native-contract-evidence.json');
