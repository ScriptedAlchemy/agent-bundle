import { createHash } from 'node:crypto';
import { execFile as executeFile } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixtureRoot = join(packageRoot, 'tests', 'fixtures', 'packed-native-smoke');
const claudeModel = 'claude-sonnet-4-5';

type PackedNativeHost = 'claude' | 'codex';

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

interface EvalDocument {
  readonly run?: { readonly summary?: { readonly fail?: number; readonly inconclusive?: number; readonly pass?: number; readonly trials?: number } };
}

export interface PackedNativeSmokeReport {
  readonly hosts: readonly {
    readonly host: PackedNativeHost;
    readonly normalHome?: 'unchanged';
    readonly status: 'failed' | 'passed';
    readonly trials: number;
  }[];
  readonly package: {
    readonly externalBinary: true;
    readonly productionOnly: true;
    readonly tarballs: 1;
  };
}

const hostOptIns = Object.freeze({
  claude: 'AGENT_BUNDLE_PACKED_NATIVE_CLAUDE_SMOKE',
  codex: 'AGENT_BUNDLE_PACKED_NATIVE_CODEX_SMOKE',
} as const);

export const packedNativeSmokePlan = (environment: Readonly<NodeJS.ProcessEnv>) => Object.freeze({
  hosts: Object.freeze([
    Object.freeze({
      enabled: environment[hostOptIns.claude] === '1',
      host: 'claude' as const,
      model: claudeModel,
      ...(environment[hostOptIns.claude] === '1' ? {} : { reason: 'explicit-opt-in-required' as const }),
    }),
    Object.freeze({
      enabled: environment[hostOptIns.codex] === '1',
      host: 'codex' as const,
      ...(environment[hostOptIns.codex] === '1' ? {} : { reason: 'explicit-opt-in-required' as const }),
    }),
  ]),
});

const alternateProviderKeys = new Set([
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_VERTEX',
]);
const credentialEnvironmentKey = (name: string): boolean => {
  const compact = name.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/gu, '');
  return /(?:apikey|apitoken|authtoken|accesstoken|authorization|credential|password|secret|token)/u.test(compact);
};

export const packedNativeEnvironment = (environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  Object.freeze(Object.fromEntries(Object.entries(environment).filter(([name]) =>
    name !== 'NODE_PATH' && !alternateProviderKeys.has(name) && !credentialEnvironmentKey(name))));

const run = async (
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): Promise<CommandResult> => {
  try {
    const result = await execFile(executable, [...args], {
      cwd: options.cwd,
      env: options.environment,
      killSignal: 'SIGTERM',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 540_000,
    });
    return Object.freeze({ exitCode: 0, stdout: result.stdout });
  } catch (error) {
    const failed = error as { readonly code?: number | string; readonly stdout?: string };
    return Object.freeze({
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
    });
  }
};

const digestTree = async (path: string, contents: boolean): Promise<string> => {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
  const hash = createHash('sha256');
  if (entry.isFile()) {
    hash.update(`file\0${entry.mode}\0${entry.size}\0`);
    hash.update(contents ? await readFile(path) : `${entry.mtimeMs}\0`);
  } else if (entry.isDirectory()) {
    hash.update('directory\0');
    for (const child of (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      hash.update(`${child.name}\0${await digestTree(join(path, child.name), contents)}\0`);
    }
  } else {
    hash.update(`other\0${entry.mode}\0`);
  }
  return hash.digest('hex');
};

const digestNormalCodexState = async (codexHome: string) => Object.freeze({
  auth: await digestTree(join(codexHome, 'auth.json'), true),
  config: await digestTree(join(codexHome, 'config.toml'), true),
  plugins: await digestTree(join(codexHome, 'plugins'), false),
});

const digestNormalClaudeState = async (environment: Readonly<NodeJS.ProcessEnv>) => {
  const claudeHome = environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return Object.freeze({
    config: await digestTree(join(claudeHome, 'config.json'), true),
    localSettings: await digestTree(join(claudeHome, 'settings.local.json'), true),
    plugins: await digestTree(join(claudeHome, 'plugins'), false),
    settings: await digestTree(join(claudeHome, 'settings.json'), true),
  });
};

const sameClaudeState = (
  left: Awaited<ReturnType<typeof digestNormalClaudeState>>,
  right: Awaited<ReturnType<typeof digestNormalClaudeState>>,
): boolean => left.config === right.config
  && left.localSettings === right.localSettings
  && left.plugins === right.plugins
  && left.settings === right.settings;

export const normalClaudeHomeUnchanged = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  operation: () => Promise<void>,
): Promise<boolean> => {
  const before = await digestNormalClaudeState(environment);
  await operation();
  return sameClaudeState(before, await digestNormalClaudeState(environment));
};

const summarizeEval = (host: PackedNativeHost, command: CommandResult) => {
  let document: EvalDocument | undefined;
  try {
    document = JSON.parse(command.stdout) as EvalDocument;
  } catch {
    document = undefined;
  }
  const summary = document?.run?.summary;
  const passed = command.exitCode === 0
    && summary?.trials === 1
    && summary.pass === 1
    && summary.fail === 0
    && summary.inconclusive === 0;
  return Object.freeze({ host, status: passed ? 'passed' as const : 'failed' as const, trials: summary?.trials ?? 0 });
};

export const runPackedNativeSmoke = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<PackedNativeSmokeReport> => {
  const enabled = packedNativeSmokePlan(options.environment).hosts.filter((host) => host.enabled);
  if (enabled.length === 0) throw new Error('Packed native smoke requires an explicit host opt-in.');

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-native-'));
  const consumer = join(root, 'consumer');
  const project = join(consumer, 'project');
  const tarballs = join(root, 'tarballs');
  const environment = packedNativeEnvironment(options.environment);

  try {
    await Promise.all([mkdir(consumer, { recursive: true }), mkdir(tarballs, { recursive: true })]);
    await Promise.all([
      writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n'),
      cp(fixtureRoot, project, { recursive: true }),
    ]);

    const packed = await run('npm', ['pack', '--json', '--pack-destination', tarballs], {
      cwd: packageRoot,
      environment,
    });
    const listing = JSON.parse(packed.stdout) as readonly { readonly filename: string }[];
    if (packed.exitCode !== 0 || listing.length !== 1 || listing[0] === undefined) {
      throw new Error('Packed native smoke could not create exactly one release tarball.');
    }
    const installed = await run('npm', [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(tarballs, listing[0].filename),
    ], { cwd: consumer, environment });
    if (installed.exitCode !== 0) throw new Error('Packed native smoke could not install the release tarball.');

    const cli = join(consumer, 'node_modules', '.bin', 'agent-bundle');
    const resolvedCli = await realpath(cli);
    if (resolvedCli.startsWith(workspaceRoot)) throw new Error('Packed native smoke resolved a workspace-linked binary.');

    const reports: PackedNativeSmokeReport['hosts'][number][] = [];
    for (const selected of enabled) {
      const host = selected.host;
      const normalCodexHome = options.environment.CODEX_HOME ?? join(homedir(), '.codex');
      const before = host === 'codex' ? await digestNormalCodexState(normalCodexHome) : undefined;
      let command: CommandResult | undefined;
      const executeEval = async (): Promise<void> => {
        command = await run(cli, [
          'eval',
          '--root',
          project,
          '--suite',
          'packed-native-smoke',
          '--case',
          `packed-native-${host}`,
          '--harness',
          host,
          '--trials',
          '1',
          '--json',
        ], { cwd: project, environment });
      };
      const claudeHomeUnchanged = host === 'claude'
        ? await normalClaudeHomeUnchanged(options.environment, executeEval)
        : undefined;
      if (host === 'codex') await executeEval();
      if (command === undefined) throw new Error('Packed native smoke did not execute the selected Eval host.');
      const summary = summarizeEval(host, command);
      if (host === 'claude') {
        reports.push(claudeHomeUnchanged === true
          ? Object.freeze({ ...summary, normalHome: 'unchanged' })
          : Object.freeze({ host, status: 'failed', trials: summary.trials }));
      } else if (before !== undefined) {
        const after = await digestNormalCodexState(normalCodexHome);
        if (before.auth !== after.auth || before.config !== after.config || before.plugins !== after.plugins) {
          reports.push(Object.freeze({ host, status: 'failed', trials: summary.trials }));
        } else {
          reports.push(Object.freeze({ ...summary, normalHome: 'unchanged' }));
        }
      }
    }

    return Object.freeze({
      hosts: Object.freeze(reports),
      package: Object.freeze({ externalBinary: true, productionOnly: true, tarballs: 1 }),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
