import { execFile as executeFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';

import {
  cursorHooksValidator,
  cursorMcpValidator,
  cursorPluginValidator,
} from '../../src/adapters/cursor.ts';
import { isInsideOrEqual } from '../../src/core/paths.ts';
import { validateCodexOpenaiYaml } from '../../src/schemas/skill-hosts/contract.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../../src/test/manifest.ts';
import {
  normalClaudeSettingsAndPluginsUnchanged,
  packedNativeEnvironment,
} from './packed-native-smoke.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixturesRoot = join(packageRoot, 'tests', 'fixtures');
const cli = join(packageRoot, 'dist', 'cli.js');
const plugin = 'host-install-proof';
const marketplace = 'host-install-proof-marketplace';
const tokenPlugin = 'host-install-token-proof';
const version = '1.0.0';
const proofLevel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const cursorPluginRootVariable = '${CURSOR_PLUGIN_ROOT}';
const skillSidecarPath = join('skills', 'probe', 'agents', 'openai.yaml');

/** Opt-in for the one billable `claude -p` invocation the session proof makes. */
export const CLAUDE_SESSION_OPT_IN = 'AGENT_BUNDLE_HOST_INSTALL_CLAUDE_SESSION';

/** The argument the session prompt passes so `$ARGUMENTS` substitution is observable. */
export const CLAUDE_SESSION_ARGUMENT = 'alpha-bravo-42';

const claudeSessionModel = 'claude-sonnet-4-5';

/**
 * Session-token evidence is a qualifier on the host-install level, not a level
 * of its own: it observes canonical Skill tokens resolving inside one real
 * `claude -p` turn against an inline `--plugin-dir` bundle. It proves nothing
 * about an installed registration, packed provenance, or any other host.
 */
export const claudeSessionQualifier = (claudeVersion: string): string =>
  `session-token (canonical Skill tokens observed resolving in one real \`claude -p\` turn `
  + `with the built bundle loaded inline via --plugin-dir; observed Claude Code ${claudeVersion}; `
  + 'NOT installed-registration, packed-artifact, or other-host evidence)';

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

export interface BuiltFixtureProject {
  readonly artifactRoot: string;
  readonly cli: string;
  readonly root: string;
}

export interface BuiltHostInstallFixture extends BuiltFixtureProject {
  readonly bundles: Readonly<Record<'claude' | 'codex' | 'cursor', string>>;
}

export interface BuiltHostInstallTokenFixture extends BuiltFixtureProject {
  readonly claudeBundle: string;
  readonly loweredSkillMarkdown: string;
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
  readonly manifest: {
    readonly interfaceCapabilities: readonly string[];
    readonly interfaceFields: readonly string[];
    readonly path: string;
  };
  readonly proofLevel: string;
  readonly registration: {
    readonly cachePath: string;
    readonly state: 'installed, enabled';
    readonly version: '1.0.0';
  };
  readonly skill: string;
  readonly skillSidecar: {
    readonly matchesBuiltArtifact: true;
    readonly path: string;
    readonly schema: 'schema-valid';
    readonly sections: readonly string[];
  };
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
  readonly logo: {
    readonly path: string;
    readonly resolvesInsideDeployTree: true;
  };
  readonly pluginRootVariable: {
    readonly locations: readonly string[];
    readonly resolvedAtInstall: false;
    readonly sessionEvidence: 'unavailable: Cursor exposes no non-interactive plugin-loading session surface';
    readonly spelling: '${CURSOR_PLUGIN_ROOT}';
  };
  readonly proofLevel: string;
  readonly skill: string;
  readonly status: 'passed';
}

export interface ClaudeTokenSessionReport {
  readonly claudeVersion: string;
  readonly host: 'claude';
  readonly invocation: {
    readonly attempts: number;
    readonly mode: 'inline --plugin-dir session';
    readonly model: string;
    readonly normalHome: {
      readonly sessionBookkeeping: 'rewritten by Claude Code on every real turn';
      readonly settingsAndPlugins: 'unchanged';
    };
  };
  /** Bundle-relative resolutions of the marker values the real session printed. */
  readonly markers: {
    readonly arguments: string;
    readonly pluginRoot: string;
    readonly skillRoot: string;
  };
  readonly proofLevel: string;
  readonly qualifier: string;
  readonly resolved: {
    readonly arguments: 'substituted';
    readonly pluginRoot: 'absolute path that exists and is the loaded bundle root';
    readonly skillRoot: 'absolute path that exists and is the loaded skill directory';
  };
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

const readText = async (path: string, context: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fail(`${context} was not readable.`);
  }
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

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
 * Builds one fixture project with the workspace's source-built CLI. This proves
 * real-host acceptance of that built bundle; packed provenance remains the
 * separate `packed-stdio` proof level.
 */
const buildFixtureProject = async (options: {
  readonly bundleNames: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly fixture: string;
}): Promise<BuiltFixtureProject> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-${options.fixture}-build-`));
  const project = join(root, 'project');
  const artifactRoot = join(project, 'artifact');
  try {
    await cp(join(fixturesRoot, options.fixture), project, { recursive: true });
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
    assertProof(result.exitCode === 0, `${options.fixture} fixture build failed: ${commandDetail(result)}`);
    await Promise.all(options.bundleNames.map((name) => access(join(artifactRoot, name))));
    return Object.freeze({ artifactRoot, cli, root });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};

export const buildHostInstallFixture = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<BuiltHostInstallFixture> => {
  const built = await buildFixtureProject({
    bundleNames: ['claude', 'codex', 'cursor'],
    environment: options.environment,
    fixture: 'host-install',
  });
  return Object.freeze({
    ...built,
    bundles: Object.freeze({
      claude: join(built.artifactRoot, 'claude'),
      codex: join(built.artifactRoot, 'codex'),
      cursor: join(built.artifactRoot, 'cursor'),
    }),
  });
};

/**
 * The token fixture is a separate Claude-only project because skill selection
 * is project-wide: `targets:` in Skill frontmatter carries per-host extension
 * fields, not a host restriction, so the arguments and skill-root tokens would
 * raise AB3008 for Codex and Cursor if they shared the host-install fixture.
 */
export const buildHostInstallTokenFixture = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<BuiltHostInstallTokenFixture> => {
  const built = await buildFixtureProject({
    bundleNames: ['claude'],
    environment: options.environment,
    fixture: 'host-install-tokens',
  });
  const claudeBundle = join(built.artifactRoot, 'claude');
  return Object.freeze({
    ...built,
    claudeBundle,
    loweredSkillMarkdown: await readFile(join(claudeBundle, 'skills', 'token-probe', 'SKILL.md'), 'utf8'),
  });
};

export const disposeHostInstallFixture = async (fixture: BuiltFixtureProject): Promise<void> => {
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

    const installedSidecar = await readText(join(cachePath, skillSidecarPath), 'Codex installed skill sidecar');
    const builtSidecar = await readText(
      join(fixture.bundles.codex, skillSidecarPath),
      'Codex built skill sidecar',
    );
    assertProof(
      installedSidecar === builtSidecar,
      'Codex install did not copy skills/probe/agents/openai.yaml byte-identically from the built bundle.',
    );
    const sidecarDocument = parseYaml(installedSidecar) as unknown;
    const sidecar = record(sidecarDocument);
    assertProof(sidecar !== undefined, 'Codex installed skill sidecar was not a YAML mapping.');
    const sidecarIssues = validateCodexOpenaiYaml(sidecarDocument);
    assertProof(
      sidecarIssues.length === 0,
      `Codex installed skill sidecar failed its pinned schema: ${JSON.stringify(sidecarIssues)}`,
    );
    const sidecarSections = Object.keys(sidecar).sort();

    const manifestPath = join(cachePath, '.codex-plugin', 'plugin.json');
    const manifest = record(await readJson(manifestPath, 'Codex installed plugin manifest'));
    assertProof(manifest !== undefined, 'Codex installed plugin manifest was not a JSON object.');
    const manifestInterface = record(manifest.interface);
    assertProof(manifestInterface !== undefined, 'Codex installed plugin manifest carried no interface block.');
    assertProof(
      manifestInterface.displayName === plugin,
      'Codex installed plugin manifest interface did not carry the plugin display name.',
    );
    const capabilities = manifestInterface.capabilities;
    assertProof(
      Array.isArray(capabilities) && capabilities.every((entry) => typeof entry === 'string'),
      'Codex installed plugin manifest interface carried no string capability list.',
    );
    const interfaceCapabilities = [...capabilities].sort();
    for (const capability of ['hooks', 'mcp', 'skills']) {
      assertProof(
        interfaceCapabilities.includes(capability),
        `Codex installed plugin manifest interface did not advertise ${capability}.`,
      );
    }

    return Object.freeze({
      host: 'codex',
      install: Object.freeze({ state: 'installed', version }),
      manifest: Object.freeze({
        interfaceCapabilities: Object.freeze(interfaceCapabilities),
        interfaceFields: Object.freeze(Object.keys(manifestInterface).sort()),
        path: normalizedRelative(cachePath, manifestPath),
      }),
      proofLevel,
      registration: Object.freeze({
        cachePath: normalizedRelative(codexHome, cachePath),
        state: 'installed, enabled',
        version,
      }),
      skill: normalizedRelative(codexHome, skillPath),
      skillSidecar: Object.freeze({
        matchesBuiltArtifact: true,
        path: normalizedRelative(cachePath, join(cachePath, skillSidecarPath)),
        schema: 'schema-valid',
        sections: Object.freeze(sidecarSections),
      }),
      status: 'passed',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

/**
 * Placement copies the emitted documents; it never resolves the host's own
 * plugin-root variable, because resolution belongs to Cursor at load time.
 * Cursor publishes no non-interactive plugin-loading session surface, so the
 * pinned `${CURSOR_PLUGIN_ROOT}` contract plus schema validity is the honest
 * ceiling here — there is no Cursor equivalent of the Claude session proof.
 */
const assertCursorPluginRootVariable = (input: {
  readonly destination: string;
  readonly hooks: unknown;
  readonly hooksText: string;
  readonly mcp: unknown;
  readonly mcpText: string;
}): readonly string[] => {
  const hooks = record(record(input.hooks)?.hooks);
  const sessionStart = hooks?.sessionStart;
  const firstHook = Array.isArray(sessionStart) ? record(sessionStart[0]) : undefined;
  const command = firstHook?.command;
  assertProof(
    typeof command === 'string' && command.includes(cursorPluginRootVariable),
    `Cursor installed hooks document did not carry an unresolved ${cursorPluginRootVariable} command.`,
  );

  const server = record(record(record(input.mcp)?.mcpServers)?.probe);
  const args = server?.args;
  const firstArgument = Array.isArray(args) ? args[0] : undefined;
  assertProof(
    typeof firstArgument === 'string' && firstArgument.startsWith(`${cursorPluginRootVariable}/`),
    `Cursor installed MCP document did not anchor the probe entry on ${cursorPluginRootVariable}.`,
  );
  const anchor = record(server?.env)?.AGENT_BUNDLE_PLUGIN_ROOT;
  assertProof(
    anchor === cursorPluginRootVariable,
    `Cursor installed MCP document did not carry the ${cursorPluginRootVariable} environment anchor.`,
  );

  for (const [name, text] of [['hooks.json', input.hooksText], ['mcp.json', input.mcpText]] as const) {
    assertProof(
      !text.includes(input.destination),
      `Cursor placement resolved ${cursorPluginRootVariable} into an absolute path inside ${name}.`,
    );
  }
  return Object.freeze([
    'hooks/hooks.json#/hooks/sessionStart/0/command',
    'mcp.json#/mcpServers/probe/args/0',
    'mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
  ]);
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
    const logo = record(pluginDocument)?.logo;
    assertProof(typeof logo === 'string' && logo.length > 0, 'Cursor plugin manifest did not emit a logo path.');
    assertProof(!logo.includes('..'), `Cursor plugin logo ${JSON.stringify(logo)} escapes the deploy tree.`);
    const logoRelative = logo.replace(/^\.\//u, '');
    const logoPath = resolve(destination, logoRelative);
    assertProof(
      isInsideOrEqual(destination, logoPath),
      `Cursor plugin logo ${JSON.stringify(logo)} does not resolve inside the deploy tree.`,
    );
    await access(logoPath).catch(() => fail(`Cursor plugin logo ${JSON.stringify(logo)} is missing from the deploy tree.`));
    const hooksText = await readText(join(destination, 'hooks', 'hooks.json'), 'Cursor hooks document');
    const hooksDocument = parseJson<unknown>(hooksText, 'Cursor hooks document');
    assertProof(cursorHooksValidator(hooksDocument), `Cursor hooks document failed its pinned schema: ${JSON.stringify(cursorHooksValidator.errors)}`);
    const mcpText = await readText(join(destination, 'mcp.json'), 'Cursor MCP document');
    const mcpDocument = parseJson<unknown>(mcpText, 'Cursor MCP document');
    assertProof(cursorMcpValidator(mcpDocument), `Cursor MCP document failed its pinned schema: ${JSON.stringify(cursorMcpValidator.errors)}`);
    const pluginRootLocations = assertCursorPluginRootVariable({
      destination,
      hooks: hooksDocument,
      hooksText,
      mcp: mcpDocument,
      mcpText,
    });

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
      logo: Object.freeze({
        path: logo,
        resolvesInsideDeployTree: true as const,
      }),
      pluginRootVariable: Object.freeze({
        locations: pluginRootLocations,
        resolvedAtInstall: false,
        sessionEvidence: 'unavailable: Cursor exposes no non-interactive plugin-loading session surface',
        spelling: cursorPluginRootVariable,
      }),
      proofLevel,
      skill: normalizedRelative(home, skillPath),
      status: 'passed',
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};

interface SessionMarkers {
  readonly arguments?: string;
  readonly pluginRoot?: string;
  readonly skillRoot?: string;
}

interface CompleteSessionMarkers {
  readonly arguments: string;
  readonly pluginRoot: string;
  readonly skillRoot: string;
}

/** Tolerates surrounding prose: each marker is matched as its own whole line. */
const markerValue = (text: string, marker: string): string | undefined => {
  const matched = new RegExp(`^[^\\S\\n]*${marker}=(.+)$`, 'mu').exec(text)?.[1]?.trim();
  return matched === undefined || matched.length === 0 ? undefined : matched;
};

const sessionMarkers = (text: string): SessionMarkers => Object.freeze({
  ...(markerValue(text, 'ARGS_MARKER') === undefined ? {} : { arguments: markerValue(text, 'ARGS_MARKER') }),
  ...(markerValue(text, 'PLUGIN_ROOT_MARKER') === undefined
    ? {}
    : { pluginRoot: markerValue(text, 'PLUGIN_ROOT_MARKER') }),
  ...(markerValue(text, 'SKILL_DIR_MARKER') === undefined
    ? {}
    : { skillRoot: markerValue(text, 'SKILL_DIR_MARKER') }),
});

const everyMarkerPresent = (markers: SessionMarkers): boolean =>
  markers.arguments !== undefined && markers.pluginRoot !== undefined && markers.skillRoot !== undefined;

const completeMarkers = (markers: SessionMarkers, attempts: number): CompleteSessionMarkers => {
  const { arguments: argumentsMarker, pluginRoot, skillRoot } = markers;
  if (argumentsMarker === undefined || pluginRoot === undefined || skillRoot === undefined) {
    return fail(`Claude session printed no complete marker set after ${String(attempts)} attempt(s).`);
  }
  return Object.freeze({ arguments: argumentsMarker, pluginRoot, skillRoot });
};

/**
 * Resolves a marker the host was expected to substitute, failing on the
 * unresolved spelling instead of accepting it as a path.
 */
const assertResolvedPath = async (
  value: string,
  spelling: string,
  label: string,
): Promise<string> => {
  assertProof(!value.includes(spelling), `Claude left ${label} unresolved as ${spelling}.`);
  assertProof(isAbsolute(value), `Claude ${label} was not an absolute path.`);
  return await realpath(value).catch(() => fail(`Claude ${label} does not exist on disk.`));
};

/**
 * One real `claude -p` turn against the normal home (first-party auth lives
 * there, so an isolated CLAUDE_CONFIG_DIR has no credentials). The bundle is
 * loaded inline with `--plugin-dir`, which registers nothing.
 *
 * Observed against Claude Code 2.1.257: all three canonical Skill tokens are
 * substituted inside the Skill Markdown body — `$ARGUMENTS` from the slash
 * invocation, `${CLAUDE_PLUGIN_ROOT}` as the loaded bundle root, and
 * `${CLAUDE_SKILL_DIR}` as that bundle's `skills/token-probe` directory.
 *
 * Also observed at that version: a real turn rewrites Claude Code's own
 * `.claude.json` session bookkeeping, so the full `normalClaudeHomeUnchanged`
 * digest cannot hold here. The settings and installed-plugin surface is
 * unchanged, and that is what this proof guards.
 */
export const runClaudeTokenSessionProof = async (
  fixture: BuiltHostInstallTokenFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<ClaudeTokenSessionReport> => {
  const environment = packedNativeEnvironment(options.environment);
  const versioned = await run('claude', ['--version'], { cwd: fixture.claudeBundle, environment });
  assertProof(versioned.exitCode === 0, `claude --version failed: ${commandDetail(versioned)}`);
  const claudeVersion = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(versioned.stdout)?.[1];
  assertProof(claudeVersion !== undefined, 'claude --version did not report a semantic version.');

  // Model output is nondeterministic, so the skill invocation gets exactly one
  // retry with an explicit instruction. Two `-p` calls is the hard ceiling.
  const prompts = Object.freeze([
    `/${tokenPlugin}:token-probe ${CLAUDE_SESSION_ARGUMENT}`,
    `Run the ${tokenPlugin} plugin's token-probe skill with the arguments `
    + `${CLAUDE_SESSION_ARGUMENT} and reply with its three marker lines verbatim.`,
  ]);
  let attempts = 0;
  let markers: SessionMarkers = {};
  let last: CommandResult | undefined;
  const session = async (): Promise<void> => {
    for (const prompt of prompts) {
      attempts += 1;
      last = await run('claude', [
        '--plugin-dir',
        fixture.claudeBundle,
        '--model',
        claudeSessionModel,
        '--output-format',
        'text',
        '-p',
        prompt,
      ], { cwd: fixture.claudeBundle, environment, timeout: 300_000 });
      markers = sessionMarkers(last.stdout);
      if (last.exitCode === 0 && everyMarkerPresent(markers)) return;
    }
  };
  const settingsAndPluginsUnchanged = await normalClaudeSettingsAndPluginsUnchanged(
    options.environment,
    session,
  );
  assertProof(last !== undefined, 'The Claude session proof never invoked the host.');
  assertProof(last.exitCode === 0, `Claude session failed: ${commandDetail(last)}`);
  assertProof(
    settingsAndPluginsUnchanged,
    'The real Claude settings or installed-plugin tree changed while the inline --plugin-dir session ran.',
  );
  const { arguments: argumentsMarker, pluginRoot, skillRoot } = completeMarkers(markers, attempts);
  assertProof(
    argumentsMarker === CLAUDE_SESSION_ARGUMENT,
    'Claude did not substitute the invocation arguments into the arguments token.',
  );
  const bundleRoot = await realpath(fixture.claudeBundle);
  const resolvedPluginRoot = await assertResolvedPath(pluginRoot, '${CLAUDE_PLUGIN_ROOT}', 'plugin root');
  assertProof(
    resolvedPluginRoot === bundleRoot,
    'Claude resolved the plugin-root token outside the loaded bundle.',
  );
  const resolvedSkillRoot = await assertResolvedPath(skillRoot, '${CLAUDE_SKILL_DIR}', 'skill root');
  assertProof(
    resolvedSkillRoot === join(bundleRoot, 'skills', 'token-probe'),
    'Claude resolved the skill-root token outside the loaded bundle\'s skill directory.',
  );

  return Object.freeze({
    claudeVersion,
    host: 'claude',
    invocation: Object.freeze({
      attempts,
      mode: 'inline --plugin-dir session',
      model: claudeSessionModel,
      normalHome: Object.freeze({
        sessionBookkeeping: 'rewritten by Claude Code on every real turn',
        settingsAndPlugins: 'unchanged',
      }),
    }),
    markers: Object.freeze({
      arguments: argumentsMarker,
      pluginRoot: normalizedRelative(bundleRoot, resolvedPluginRoot) || '.',
      skillRoot: normalizedRelative(bundleRoot, resolvedSkillRoot),
    }),
    proofLevel,
    qualifier: claudeSessionQualifier(claudeVersion),
    resolved: Object.freeze({
      arguments: 'substituted',
      pluginRoot: 'absolute path that exists and is the loaded bundle root',
      skillRoot: 'absolute path that exists and is the loaded skill directory',
    }),
    status: 'passed',
  });
};
