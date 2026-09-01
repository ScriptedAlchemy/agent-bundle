import { execFile as executeFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  cursorHooksValidator,
  cursorMcpValidator,
  cursorPluginValidator,
} from '../../src/adapters/cursor.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../../src/test/manifest.ts';
import { packedNativeEnvironment } from './packed-native-smoke.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixtureRoot = join(packageRoot, 'tests', 'fixtures', 'host-install');
const cli = join(packageRoot, 'dist', 'cli.js');
const plugin = 'host-install-proof';
const marketplace = 'host-install-proof-marketplace';
const version = '1.0.0';
const proofLevel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface InstallResult {
  readonly bundleRoot?: unknown;
  readonly destination?: unknown;
  readonly host?: unknown;
  readonly marketplace?: unknown;
  readonly plugin?: unknown;
  readonly state?: unknown;
  readonly version?: unknown;
}

interface ClaudePluginRow {
  readonly enabled?: unknown;
  readonly id?: unknown;
  readonly installPath?: unknown;
  readonly mcpServers?: unknown;
  readonly scope?: unknown;
  readonly version?: unknown;
}

export interface BuiltHostInstallFixture {
  readonly artifactRoot: string;
  readonly bundles: Readonly<Record<'claude' | 'codex' | 'cursor', string>>;
  readonly cli: string;
  readonly root: string;
}

export interface ClaudeHostInstallReport {
  readonly host: 'claude';
  readonly install: { readonly state: 'installed'; readonly version: '1.0.0' };
  readonly inventory: { readonly hooks: 1; readonly mcpServers: 1; readonly skills: 1 };
  readonly proofLevel: string;
  readonly registration: {
    readonly enabled: true;
    readonly id: string;
    readonly installPath: string;
    readonly mcpServers: readonly string[];
    readonly scope: 'user';
    readonly version: '1.0.0';
  };
  readonly skill: string;
  readonly status: 'passed';
}

export interface CodexHostInstallReport {
  readonly host: 'codex';
  readonly install: { readonly state: 'installed'; readonly version: '1.0.0' };
  readonly proofLevel: string;
  readonly registration: {
    readonly cachePath: string;
    readonly state: 'installed, enabled';
    readonly version: '1.0.0';
  };
  readonly skill: string;
  readonly status: 'passed';
}

export interface CursorHostInstallReport {
  readonly destination: string;
  readonly documents: {
    readonly hooks: 'schema-valid';
    readonly mcp: 'schema-valid';
    readonly plugin: 'schema-valid';
  };
  readonly host: 'cursor';
  readonly install: {
    readonly first: 'installed';
    readonly second: 'already-installed';
    readonly version: '1.0.0';
  };
  readonly proofLevel: string;
  readonly skill: string;
  readonly status: 'passed';
}

const fail = (message: string): never => {
  throw new Error(`[${proofLevel}] ${message}`);
};

const assertProof: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) fail(message);
};

const commandDetail = (result: CommandResult): string =>
  result.stderr.trim() || result.stdout.trim() || `exit code ${String(result.exitCode)}`;

const run = async (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly timeout?: number;
  },
): Promise<CommandResult> => {
  try {
    const result = await execFile(executable, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      env: options.environment,
      killSignal: 'SIGTERM',
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    });
    return Object.freeze({ exitCode: 0, stderr: result.stderr, stdout: result.stdout });
  } catch (error) {
    const failed = error as {
      readonly code?: number | string;
      readonly stderr?: string;
      readonly stdout?: string;
    };
    return Object.freeze({
      exitCode: typeof failed.code === 'number' ? failed.code : 1,
      stderr: typeof failed.stderr === 'string' ? failed.stderr : '',
      stdout: typeof failed.stdout === 'string' ? failed.stdout : '',
    });
  }
};

const runNodeCli = (
  fixture: BuiltHostInstallFixture,
  args: readonly string[],
  options: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
): Promise<CommandResult> => run(
  process.execPath,
  [fixture.cli, ...args],
  { ...options, timeout: 180_000 },
);

const parseJson = <T>(text: string, context: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail(`${context} did not return JSON.`);
  }
};

const readJson = async (path: string, context: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return fail(`${context} was not readable JSON.`);
  }
};

const normalizedRelative = (root: string, path: string): string =>
  relative(root, path).split(sep).join('/');

const isolatedEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  values: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => ({
  ...packedNativeEnvironment(environment),
  ...values,
});

const assertInstallResult = (
  document: InstallResult,
  host: 'claude' | 'codex' | 'cursor',
  state: 'already-installed' | 'installed',
): void => {
  assertProof(document.host === host, `${host} install result did not identify the host.`);
  assertProof(document.plugin === plugin, `${host} install result did not identify ${plugin}.`);
  assertProof(document.version === version, `${host} install result did not identify version ${version}.`);
  assertProof(document.state === state, `${host} install result state was not ${state}.`);
  if (host !== 'cursor') {
    assertProof(document.marketplace === marketplace, `${host} install result did not identify ${marketplace}.`);
  }
};

/**
 * Builds the fixture once with the workspace's source-built CLI. This proves
 * real-host acceptance of that built bundle; packed provenance remains the
 * separate `packed-stdio` proof level.
 */
export const buildHostInstallFixture = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<BuiltHostInstallFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-build-'));
  const project = join(root, 'project');
  const artifactRoot = join(project, 'artifact');
  const fixture: BuiltHostInstallFixture = Object.freeze({
    artifactRoot,
    bundles: Object.freeze({
      claude: join(artifactRoot, 'claude'),
      codex: join(artifactRoot, 'codex'),
      cursor: join(artifactRoot, 'cursor'),
    }),
    cli,
    root,
  });
  try {
    await cp(fixtureRoot, project, { recursive: true });
    await symlink(join(workspaceRoot, 'node_modules'), join(project, 'node_modules'), 'dir');
    const result = await run(process.execPath, [
      cli,
      'build',
      '--root',
      project,
      '--output',
      artifactRoot,
    ], {
      cwd: project,
      environment: packedNativeEnvironment(options.environment),
      timeout: 180_000,
    });
    assertProof(result.exitCode === 0, `fixture build failed: ${commandDetail(result)}`);
    await Promise.all(Object.values(fixture.bundles).map((bundle) => access(bundle)));
    return fixture;
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};

export const disposeHostInstallFixture = async (fixture: BuiltHostInstallFixture): Promise<void> => {
  await rm(fixture.root, { force: true, recursive: true });
};

export const runClaudeHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<ClaudeHostInstallReport> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-claude-'));
  const config = join(root, 'config');
  const home = join(root, 'home');
  try {
    await Promise.all([mkdir(config, { recursive: true }), mkdir(home, { recursive: true })]);
    const environment = isolatedEnvironment(options.environment, {
      CLAUDE_CONFIG_DIR: config,
      HOME: home,
    });
    const installed = await runNodeCli(fixture, [
      'install',
      'claude',
      '--from',
      fixture.bundles.claude,
      '--json',
    ], { cwd: fixture.bundles.claude, environment });
    assertProof(installed.exitCode === 0, `Claude public install path failed: ${commandDetail(installed)}`);
    const installDocument = parseJson<InstallResult>(installed.stdout, 'Claude install');
    assertInstallResult(installDocument, 'claude', 'installed');

    const listed = await run('claude', ['plugin', 'list', '--json'], {
      cwd: fixture.bundles.claude,
      environment,
    });
    assertProof(listed.exitCode === 0, `Claude plugin list failed: ${commandDetail(listed)}`);
    const listing = parseJson<readonly ClaudePluginRow[]>(listed.stdout, 'Claude plugin list');
    assertProof(Array.isArray(listing), 'Claude plugin list was not a JSON array.');
    const id = `${plugin}@${marketplace}`;
    const row = listing.find((candidate) => candidate.id === id);
    assertProof(row !== undefined, `Claude plugin list did not contain ${id}.`);
    assertProof(row.version === version, `Claude registered version was not ${version}.`);
    assertProof(row.scope === 'user', 'Claude registered scope was not user.');
    assertProof(row.enabled === true, 'Claude registration was not enabled.');
    assertProof(typeof row.installPath === 'string', 'Claude registration had no installPath.');
    const expectedInstallPath = join(config, 'plugins', 'cache', marketplace, plugin, version);
    assertProof(row.installPath === expectedInstallPath, 'Claude installPath was outside the isolated config cache.');
    assertProof(
      row.mcpServers !== null && typeof row.mcpServers === 'object' && !Array.isArray(row.mcpServers),
      'Claude registration had no mcpServers object.',
    );
    const mcpServers = Object.keys(row.mcpServers as Record<string, unknown>).sort();
    assertProof(mcpServers.includes('probe'), 'Claude registration did not expose the probe MCP server.');

    const details = await run('claude', ['plugin', 'details', id], {
      cwd: fixture.bundles.claude,
      environment,
    });
    assertProof(details.exitCode === 0, `Claude plugin details failed: ${commandDetail(details)}`);
    assertProof(/\bSkills\s+\(1\)/iu.test(details.stdout), 'Claude component inventory did not report Skills (1).');
    assertProof(/\bHooks\s+\(1\)/iu.test(details.stdout), 'Claude component inventory did not report Hooks (1).');
    assertProof(/\bMCP servers\s+\(1\)/iu.test(details.stdout), 'Claude component inventory did not report MCP servers (1).');

    const skillPath = join(expectedInstallPath, 'skills', 'probe', 'SKILL.md');
    await access(skillPath).catch(() => fail('Claude cache did not contain skills/probe/SKILL.md.'));
    return Object.freeze({
      host: 'claude',
      install: Object.freeze({ state: 'installed', version }),
      inventory: Object.freeze({ hooks: 1, mcpServers: 1, skills: 1 }),
      proofLevel,
      registration: Object.freeze({
        enabled: true,
        id,
        installPath: normalizedRelative(config, expectedInstallPath),
        mcpServers: Object.freeze(mcpServers),
        scope: 'user',
        version,
      }),
      skill: normalizedRelative(config, skillPath),
      status: 'passed',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const runCodexHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<CodexHostInstallReport> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-codex-'));
  const codexHome = join(root, 'codex');
  const home = join(root, 'home');
  try {
    await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(home, { recursive: true })]);
    const environment = isolatedEnvironment(options.environment, {
      CODEX_HOME: codexHome,
      HOME: home,
    });
    const installed = await runNodeCli(fixture, [
      'install',
      'codex',
      '--from',
      fixture.bundles.codex,
      '--json',
    ], { cwd: fixture.bundles.codex, environment });
    assertProof(installed.exitCode === 0, `Codex public install path failed: ${commandDetail(installed)}`);
    const installDocument = parseJson<InstallResult>(installed.stdout, 'Codex install');
    assertInstallResult(installDocument, 'codex', 'installed');

    const listed = await run('codex', ['plugin', 'list'], {
      cwd: fixture.bundles.codex,
      environment,
    });
    assertProof(listed.exitCode === 0, `Codex plugin list failed: ${commandDetail(listed)}`);
    assertProof(listed.stdout.includes(`${plugin}@${marketplace}`), 'Codex plugin list did not identify the plugin.');
    assertProof(listed.stdout.includes(version), `Codex plugin list did not report version ${version}.`);
    assertProof(/installed,\s*enabled/iu.test(listed.stdout), 'Codex plugin list did not report installed, enabled.');

    const cachePath = join(codexHome, 'plugins', 'cache', marketplace, plugin, version);
    const skillPath = join(cachePath, 'skills', 'probe', 'SKILL.md');
    await access(skillPath).catch(() => fail('Codex cache did not contain skills/probe/SKILL.md.'));
    return Object.freeze({
      host: 'codex',
      install: Object.freeze({ state: 'installed', version }),
      proofLevel,
      registration: Object.freeze({
        cachePath: normalizedRelative(codexHome, cachePath),
        state: 'installed, enabled',
        version,
      }),
      skill: normalizedRelative(codexHome, skillPath),
      status: 'passed',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const runCursorHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<CursorHostInstallReport> => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-cursor-'));
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const environment = isolatedEnvironment(options.environment, { HOME: home });
    const install = async (): Promise<InstallResult> => {
      const result = await runNodeCli(fixture, [
        'install',
        'cursor',
        '--from',
        fixture.bundles.cursor,
        '--json',
      ], { cwd: fixture.bundles.cursor, environment });
      assertProof(result.exitCode === 0, `Cursor public install path failed: ${commandDetail(result)}`);
      return parseJson<InstallResult>(result.stdout, 'Cursor install');
    };
    const first = await install();
    assertInstallResult(first, 'cursor', 'installed');
    const destination = join(home, '.cursor', 'plugins', 'local', plugin);
    assertProof(first.destination === destination, 'Cursor install result did not report the isolated destination.');

    const pluginDocument = await readJson(join(destination, '.cursor-plugin', 'plugin.json'), 'Cursor plugin manifest');
    assertProof(cursorPluginValidator(pluginDocument), `Cursor plugin manifest failed its pinned schema: ${JSON.stringify(cursorPluginValidator.errors)}`);
    const hooksDocument = await readJson(join(destination, 'hooks', 'hooks.json'), 'Cursor hooks document');
    assertProof(cursorHooksValidator(hooksDocument), `Cursor hooks document failed its pinned schema: ${JSON.stringify(cursorHooksValidator.errors)}`);
    const mcpDocument = await readJson(join(destination, 'mcp.json'), 'Cursor MCP document');
    assertProof(cursorMcpValidator(mcpDocument), `Cursor MCP document failed its pinned schema: ${JSON.stringify(cursorMcpValidator.errors)}`);

    const skillPath = join(destination, 'skills', 'probe', 'SKILL.md');
    await access(skillPath).catch(() => fail('Cursor install did not contain skills/probe/SKILL.md.'));
    const second = await install();
    assertInstallResult(second, 'cursor', 'already-installed');
    assertProof(second.destination === destination, 'Cursor idempotent install reported a different destination.');

    return Object.freeze({
      destination: normalizedRelative(home, destination),
      documents: Object.freeze({
        hooks: 'schema-valid',
        mcp: 'schema-valid',
        plugin: 'schema-valid',
      }),
      host: 'cursor',
      install: Object.freeze({
        first: 'installed',
        second: 'already-installed',
        version,
      }),
      proofLevel,
      skill: normalizedRelative(home, skillPath),
      status: 'passed',
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};
