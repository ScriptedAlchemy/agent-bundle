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

// The native smoke installs the production closure a real consumer would get,
// so it stays on npm's default metadata staleness checks.
import { npmInstallArguments, packOutputFromJson, sharedPackedTarball } from './shared-pack.ts';
import { deepFreeze } from '../../src/core/freeze.ts';


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
    /**
     * Codex: auth, config, and plugins unchanged. Claude: settings and the
     * installed-plugin tree unchanged — a real turn rewrites `.claude.json`
     * session bookkeeping, so that file is not part of the guard.
     */
    readonly normalHome?: 'settings-and-plugins-unchanged' | 'unchanged';
    readonly status: 'failed' | 'passed';
    readonly trials: number;
  }[];
  readonly package: {
    readonly externalBinary: true;
    readonly productionOnly: true;
    readonly tarballs: 1;
  };
}

export interface PackedClaudePluginProof {
  readonly host: 'claude';
  readonly registration: 'observed';
  readonly status: 'passed';
  readonly strictValidation: 'passed';
  readonly version: string;
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

export const packedNativeNodeCommand = (
  entrypoint: string,
  args: readonly string[],
  nodeExecutable = process.execPath,
) => Object.freeze({
  args: Object.freeze([entrypoint, ...args]),
  executable: nodeExecutable,
});

const runNodeEntrypoint = (
  entrypoint: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): Promise<CommandResult> => {
  const command = packedNativeNodeCommand(entrypoint, args);
  return run(command.executable, command.args, options);
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

/**
 * The Claude state a proof must never mutate: settings and the installed
 * plugin tree. Session bookkeeping (`.claude.json`) is deliberately excluded
 * so a caller that runs a real turn can still assert this surface.
 */
const digestClaudeSettingsAndPlugins = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: Readonly<{ readonly homeDirectory: string }>,
) => {
  const claudeHome = environment.CLAUDE_CONFIG_DIR ?? join(options.homeDirectory, '.claude');
  return Object.freeze({
    config: await digestTree(join(claudeHome, 'config.json'), true),
    localSettings: await digestTree(join(claudeHome, 'settings.local.json'), true),
    plugins: await digestTree(join(claudeHome, 'plugins'), true),
    settings: await digestTree(join(claudeHome, 'settings.json'), true),
  });
};

const digestNormalClaudeState = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  options: Readonly<{ readonly homeDirectory: string }>,
) => Object.freeze({
  ...(await digestClaudeSettingsAndPlugins(environment, options)),
  state: await digestTree(
    join(environment.CLAUDE_CONFIG_DIR ?? options.homeDirectory, '.claude.json'),
    true,
  ),
});

const sameClaudeState = (
  left: Awaited<ReturnType<typeof digestNormalClaudeState>>,
  right: Awaited<ReturnType<typeof digestNormalClaudeState>>,
): boolean => left.config === right.config
  && left.localSettings === right.localSettings
  && left.plugins === right.plugins
  && left.settings === right.settings
  && left.state === right.state;

export const normalClaudeHomeUnchanged = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  operation: () => Promise<void>,
  options: Readonly<{ readonly homeDirectory: string }> = { homeDirectory: homedir() },
): Promise<boolean> => {
  const before = await digestNormalClaudeState(environment, options);
  await operation();
  return sameClaudeState(before, await digestNormalClaudeState(environment, options));
};

/**
 * The guard for an operation that runs a real signed-in turn: Claude Code
 * rewrites its own `.claude.json` session bookkeeping on every such turn, so
 * `normalClaudeHomeUnchanged` cannot hold. This asserts the surface that must
 * still hold — settings and the installed plugin tree.
 */
export const normalClaudeSettingsAndPluginsUnchanged = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  operation: () => Promise<void>,
  options: Readonly<{ readonly homeDirectory: string }> = { homeDirectory: homedir() },
): Promise<boolean> => {
  const before = await digestClaudeSettingsAndPlugins(environment, options);
  await operation();
  const after = await digestClaudeSettingsAndPlugins(environment, options);
  return before.config === after.config
    && before.localSettings === after.localSettings
    && before.plugins === after.plugins
    && before.settings === after.settings;
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

interface PackedClaudeValidationDocument {
  readonly diagnostics?: readonly unknown[];
  readonly hostValidation?: readonly {
    readonly diagnostics?: readonly unknown[];
    readonly host?: unknown;
    readonly load?: { readonly status?: unknown };
    readonly status?: unknown;
    readonly target?: unknown;
    readonly version?: unknown;
  }[];
}

/**
 * The packed `validate --artifact --strict --json` document must carry one Claude
 * report that passed both the plugin-mode validation runs and the
 * `--plugin-dir … plugin list --json` load check against the installed `claude`.
 */
const packedClaudeValidationPassed = (stdout: string, versionNumber: string): boolean => {
  let document: PackedClaudeValidationDocument;
  try {
    document = JSON.parse(stdout) as PackedClaudeValidationDocument;
  } catch {
    return false;
  }
  const report = document.hostValidation?.find((entry) => entry.host === 'claude' && entry.target === 'claude');
  return report !== undefined
    && report.status === 'passed'
    && report.version === versionNumber
    && report.load?.status === 'loaded'
    && (report.diagnostics?.length ?? 0) === 0
    && (document.diagnostics?.length ?? 0) === 0;
};

/**
 * Packed-artifact proof for Claude's developer tools. It requires only the
 * installed binary, never authentication, and retains no plugin-list output.
 */
export const runPackedClaudePluginProof = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<PackedClaudePluginProof> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-claude-plugin-'));
  const consumer = join(root, 'consumer');
  const project = join(consumer, 'project');
  const artifact = join(project, 'artifact');
  const environment = packedNativeEnvironment(options.environment);

  try {
    await mkdir(consumer, { recursive: true });
    await Promise.all([
      writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n'),
      cp(fixtureRoot, project, { recursive: true }),
    ]);
    const packed = await sharedPackedTarball('agent-bundle');
    const installed = await run('npm', [
      'install',
      '--omit=dev',
      ...npmInstallArguments,
      packed.tarball,
    ], { cwd: consumer, environment });
    if (installed.exitCode !== 0) throw new Error('packed-claude-proof:install');

    const cli = await realpath(join(consumer, 'node_modules', 'agent-bundle', 'dist', 'cli.js'));
    if (cli.startsWith(workspaceRoot)) throw new Error('Packed Claude plugin proof resolved a workspace-linked binary.');
    const built = await runNodeEntrypoint(cli, [
      'build',
      '--root',
      project,
      '--output',
      artifact,
    ], { cwd: project, environment });
    if (built.exitCode !== 0) throw new Error('packed-claude-proof:build');

    const pluginDirectory = join(artifact, 'claude');
    const version = await run('claude', ['--version'], { cwd: project, environment });
    const versionNumber = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(version.stdout)?.[1];
    if (version.exitCode !== 0 || versionNumber === undefined) {
      throw new Error('packed-claude-proof:version');
    }
    // The packed CLI's own host validation: `claude plugin validate --strict` against
    // `.claude-plugin/plugin.json` (plugin.json, hooks/hooks.json, skills/, agents/, commands/),
    // then `marketplace.json`, then the `--plugin-dir … plugin list --json` load check. A raw
    // run against the directory would be a marketplace run that never opens the component
    // files (#475), and the shared runner is what `build`, `validate --artifact`, and `doctor`
    // execute in production.
    const validation = await runNodeEntrypoint(cli, [
      'validate',
      '--root',
      project,
      '--artifact',
      artifact,
      '--strict',
      '--json',
    ], { cwd: project, environment });
    if (validation.exitCode !== 0 || !packedClaudeValidationPassed(validation.stdout, versionNumber)) {
      throw new Error('packed-claude-proof:validate');
    }
    const plugins = await run('claude', ['--plugin-dir', pluginDirectory, 'plugin', 'list', '--json'], {
      cwd: project,
      environment,
    });
    let listingDocument: readonly { readonly id?: unknown }[] = [];
    try {
      listingDocument = JSON.parse(plugins.stdout) as readonly { readonly id?: unknown }[];
    } catch {
      listingDocument = [];
    }
    if (
      plugins.exitCode !== 0 ||
      !Array.isArray(listingDocument) ||
      !listingDocument.some((plugin) => plugin.id === 'packed-native-smoke@inline')
    ) {
      throw new Error('packed-claude-proof:register');
    }
    return Object.freeze({
      host: 'claude',
      registration: 'observed',
      status: 'passed',
      strictValidation: 'passed',
      version: versionNumber,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const runPackedNativeSmoke = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<PackedNativeSmokeReport> => {
  const enabled = packedNativeSmokePlan(options.environment).hosts.filter((host) => host.enabled);
  if (enabled.length === 0) throw new Error('Packed native smoke requires an explicit host opt-in.');
  const npmEntrypoint = options.environment.npm_execpath;
  if (npmEntrypoint === undefined || npmEntrypoint.length === 0) {
    throw new Error('Packed native smoke requires the npm JavaScript entrypoint.');
  }

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

    const packed = await runNodeEntrypoint(npmEntrypoint, ['pack', '--json', '--pack-destination', tarballs], {
      cwd: packageRoot,
      environment,
    });
    if (packed.exitCode !== 0) {
      throw new Error('Packed native smoke could not create the release tarball.');
    }
    // Select the agent-bundle entry by name: a workspace-aware `npm pack --json`
    // can list sibling packages, and index 0 is not necessarily this one.
    const packOutput = packOutputFromJson(packed.stdout, 'agent-bundle');
    const installed = await runNodeEntrypoint(npmEntrypoint, [
      'install',
      '--omit=dev',
      ...npmInstallArguments,
      join(tarballs, packOutput.filename),
    ], { cwd: consumer, environment });
    if (installed.exitCode !== 0) throw new Error('Packed native smoke could not install the release tarball.');

    const cli = join(consumer, 'node_modules', 'agent-bundle', 'dist', 'cli.js');
    const resolvedCli = await realpath(cli);
    if (resolvedCli.startsWith(workspaceRoot)) throw new Error('Packed native smoke resolved a workspace-linked binary.');

    const reports: PackedNativeSmokeReport['hosts'][number][] = [];
    for (const selected of enabled) {
      const host = selected.host;
      const normalCodexHome = options.environment.CODEX_HOME ?? join(homedir(), '.codex');
      const before = host === 'codex' ? await digestNormalCodexState(normalCodexHome) : undefined;
      let command: CommandResult | undefined;
      const executeEval = async (): Promise<void> => {
        command = await runNodeEntrypoint(cli, [
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
      // The Claude Eval is a real signed-in turn, and Claude Code 2.1.257
      // rewrites `.claude.json` on every such turn (observed 2026-09-03,
      // docs/audits/2026-09-03-claude-live-session-proofs.md), so the guard is
      // the settings-and-plugins surface, as in the host-install session proofs.
      const claudeSettingsAndPluginsUnchanged = host === 'claude'
        ? await normalClaudeSettingsAndPluginsUnchanged(options.environment, executeEval)
        : undefined;
      if (host === 'codex') await executeEval();
      if (command === undefined) throw new Error('Packed native smoke did not execute the selected Eval host.');
      const summary = summarizeEval(host, command);
      if (host === 'claude') {
        reports.push(claudeSettingsAndPluginsUnchanged === true
          ? Object.freeze({ ...summary, normalHome: 'settings-and-plugins-unchanged' })
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

    return deepFreeze({
      hosts: reports,
      package: { externalBinary: true, productionOnly: true, tarballs: 1 },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};
