import { execFile as executeFile } from 'node:child_process';
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parse as parseYaml } from 'yaml';

import portableMcpSchema from '../../src/adapters/schemas/portable/mcp.schema.json' with { type: 'json' };
import portablePluginSchema from '../../src/adapters/schemas/portable/plugin.schema.json' with { type: 'json' };
import { codexArtifactPaths, codexInterfaceFields, codexPluginDocumentValidator } from '../../src/adapters/codex.ts';
import {
  cursorArtifactPaths,
  cursorHooksValidator,
  cursorMcpValidator,
  cursorPluginValidator,
} from '../../src/adapters/cursor.ts';
import { createAdapterValidator } from '../../src/adapters/types.ts';
import { reindexArtifactManifest } from '../../src/build/manifest-reindex.ts';
import { isInsideOrEqual } from '../../src/core/paths.ts';
import { validatePortablePluginFiles } from '../../src/host-contracts/portable-plugin-validation.ts';
import { validateCodexOpenaiYaml } from '../../src/schemas/skill-hosts/contract.ts';
import {
  compileTestManifest,
  HOST_INSTALL_PROOF_LEVEL,
  proofLevelLabel,
} from '../../src/test/manifest.ts';
import {
  runInstalledHostContractMatrix,
  type ContractRouteFixture,
  type InstalledHostContractMatrixReport,
} from '../../src/test/contract.ts';
import { openInstalledHostMcpServer } from '../../src/test/installed.ts';
import { DEV_INSTALL_MARKER, DevHostInstallManager } from '../../src/dev/host-install-manager.ts';
import { ProjectEventHub } from '../../src/dev/events.ts';
import type { ArtifactEpoch } from '../../src/dev/types.ts';
import { startDevServer } from '../../src/dev/workbench-server.ts';
import { runDoctor } from '../../src/install/doctor.ts';
import { installBundle, type InstallHost } from '../../src/install/install.ts';
import { readInstallReceipt } from '../../src/install/receipt.ts';
import {
  normalClaudeSettingsAndPluginsUnchanged,
  packedNativeEnvironment,
} from './packed-native-smoke.ts';
import { diffTreeSnapshots, snapshotTree, treesIdentical } from './tree-snapshot.ts';
import { replaceWatchedSource } from './watched-files.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixturesRoot = join(packageRoot, 'tests', 'fixtures');
const cli = join(packageRoot, 'dist', 'cli.js');
const plugin = 'host-install-proof';
const marketplace = 'host-install-proof-marketplace';
const portablePlugin = 'host-install-portable-proof';
const tokenPlugin = 'host-install-token-proof';
const version = '1.0.0';
const proofLevel = proofLevelLabel(HOST_INSTALL_PROOF_LEVEL);
const portableProofLevel =
  'host-install (emitted install.mjs + isolated Cursor home filesystem + pinned Agent Plugins 1.0.0 schemas; NOT IDE plugin-loader evidence)';
const cursorPluginRootVariable = '${CURSOR_PLUGIN_ROOT}';
const portablePluginDataVariable = '${PLUGIN_DATA}';
const portablePluginRootVariable = '${PLUGIN_ROOT}';
const portableMcpSchemaIdentifier =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const portablePluginSchemaIdentifier =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const skillSidecarPath = join('skills', 'probe', 'agents', 'openai.yaml');
const codexManifestPath = codexArtifactPaths.plugin;
const validateCodexPluginManifest = codexPluginDocumentValidator;
const portableSchemaValidator = createAdapterValidator();

/**
 * The `interface` fields the host-install fixture is pinned to emit for Codex,
 * shared by the source-built and packed-tarball proofs so an emission change
 * is re-pinned in exactly one place (#364 changed `logo` and only the proof a
 * lane happened to run locally caught it; #367 repaired the second copy).
 *
 * The proof also checks the installed set against the adapter's own declared
 * `codexInterfaceFields`, so an undeclared field fails before this snapshot
 * does, and against the built artifact, so install fidelity and emission are
 * reported separately.
 */
export const expectedCodexInterfaceFields = Object.freeze([
  'capabilities',
  'category',
  'defaultPrompt',
  'developerName',
  'displayName',
  // The fixture declares `plugin.logo`; Codex projects it as `interface.logo` (#246 / #364).
  'logo',
  'longDescription',
  'shortDescription',
]);
const portableMcpValidator = portableSchemaValidator.compile(portableMcpSchema);
const portablePluginValidator = portableSchemaValidator.compile(portablePluginSchema);

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
  readonly contentHash?: unknown;
  readonly destination?: unknown;
  readonly host?: unknown;
  readonly marketplace?: unknown;
  readonly plugin?: unknown;
  readonly previousContentHash?: unknown;
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
  /**
   * The composite root is the bundle for every selected host: one directory,
   * three host manifests. Keyed by host so install flows read as before.
   */
  readonly bundles: Readonly<Record<'claude' | 'codex' | 'cursor', string>>;
}

export interface BuiltHostInstallTokenFixture extends BuiltFixtureProject {
  readonly claudeBundle: string;
  readonly loweredSkillMarkdown: string;
}

export interface BuiltPortableHostInstallFixture extends BuiltFixtureProject {
  readonly portableBundle: string;
}

export interface DevHostInstallProofReport {
  readonly host: InstallHost;
  readonly hookChanged: true;
  readonly marker: {
    readonly epochId: 'epoch-2';
    readonly host: InstallHost;
    readonly schemaVersion: 1;
  };
  readonly mcpUnchanged: true;
  readonly skillChanged: true;
  readonly spawn: {
    readonly exitCode: 1;
    readonly unavailableDiagnostic: '[AB8025] Development MCP server is unavailable.';
  };
  readonly status: 'passed';
}

export interface HostInstallCommand {
  readonly cwd?: string;
  readonly executable: string;
  readonly prefixArguments?: readonly string[];
}

export interface InstalledHostContractMatrixProofOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly fixtures: Readonly<Record<string, ContractRouteFixture>>;
  readonly host: 'claude' | 'codex' | 'cursor';
  readonly mode: 'adapter-simulator' | 'native-host';
  readonly mutateInstalled?: (installedRoot: string) => Promise<void>;
}

interface HostInstallProofOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly installCommand?: HostInstallCommand;
}

/** The same-version rebuild round trip every host proof performs after its first install. */
export type SameVersionRebuildProof = 'replaced';

export interface ClaudeHostInstallReport {
  readonly host: 'claude';
  readonly install: {
    readonly sameVersionRebuild: SameVersionRebuildProof;
    readonly state: 'installed';
    readonly version: '1.0.0';
  };
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
  readonly install: {
    readonly sameVersionRebuild: SameVersionRebuildProof;
    readonly state: 'installed';
    readonly version: '1.0.0';
  };
  readonly manifest: {
    readonly interfaceCapabilities: readonly string[];
    /** Sorted installed `interface` keys; every one is in the adapter's declared `codexInterfaceFields`. */
    readonly interfaceFields: readonly string[];
    readonly matchesBuiltArtifact: true;
    readonly path: string;
    readonly schema: 'schema-valid';
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
  /** Doctor's read-only registration proof for the installed plugin's manifest hooks (#407). */
  readonly hooksRegistration: {
    readonly events: readonly string[];
    readonly state: 'registered';
    readonly userHooksJson: 'absent';
  };
  readonly host: 'cursor';
  readonly install: {
    readonly first: 'installed';
    readonly sameVersionRebuild: SameVersionRebuildProof;
    readonly second: 'already-installed';
    readonly version: '1.0.0';
  };
  /** The emitted `install.mjs --mode marketplace` staging proof in the same isolated home (#407). */
  readonly marketplace: {
    readonly commit: 'git-sha';
    readonly first: 'staged';
    readonly imported: false;
    readonly manifest: 'marketplace.json lists the plugin';
    readonly repository: string;
    readonly second: 'already-staged';
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
  /**
   * The composite root installed as a Cursor local plugin in its own isolated home: Doctor's
   * static validation must follow the manifest to `.cursor-plugin/hooks.json` and report zero
   * AB7320/AB6027 findings even though a Claude-format `hooks/hooks.json` sits beside it (#438).
   */
  readonly unifiedBundle: {
    readonly hooksDocument: '.cursor-plugin/hooks.json';
    readonly hooksRegistration: 'registered';
    readonly install: 'installed';
    readonly staticFindings: { readonly AB6027: 0; readonly AB7320: 0 };
  };
}

export interface PortableHostInstallReport {
  /** The installed bytes pass the same pinned byte lane `validate --host-validation` and Doctor run. */
  readonly contract: 'agent-plugins-1.0.0 byte lane clean (AB6035–AB6037)';
  readonly destination: string;
  readonly documents: {
    readonly mcp: 'schema-valid';
    readonly plugin: 'schema-valid';
  };
  readonly hooks: 'not-emitted';
  readonly host: 'cursor';
  readonly install: {
    readonly first: 'installed';
    readonly sameVersionRebuild: SameVersionRebuildProof;
    readonly second: 'already-installed';
    readonly version: '1.0.0';
  };
  readonly manifestMetadata: 'author/homepage/repository/license/keywords/extensions emitted from portable config';
  /**
   * The bundle's `mcp.json` is the spec-conformant document (`locations`,
   * `reservedEnvKeys` describe it); the Cursor copy is its install-time
   * expansion, since Cursor 3.18.25 expands no Agent Plugins placeholder (#426).
   */
  readonly pluginVariables: {
    readonly allowedLocations: 'args/env values/cwd only';
    readonly cursorExpansion: {
      readonly doctor: 'AB7326 expanded';
      readonly installedCopy: 'PLUGIN_ROOT/PLUGIN_DATA absolute, cwd = plugin root, PLUGIN_ROOT/PLUGIN_DATA env set, no placeholder left';
      readonly pluginData: string;
      readonly receipt: 'cursorExpansion records the bundle mcp.json verbatim';
    };
    readonly locations: readonly string[];
    readonly reservedEnvKeys: 'absent';
    readonly resolvedAtInstall: true;
    readonly sessionEvidence: 'unavailable: Cursor loads Agent Plugins only at restart or window reload; no non-interactive plugin-loading session surface';
  };
  readonly proofLevel: string;
  readonly proofScope: 'installer+filesystem+pinned-schema conformance against an isolated Cursor home; IDE plugin-loader behavior not observed by this test';
  readonly skill: string;
  readonly specVersion: '1.0.0';
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

/** Runs `install` or `uninstall` through the source-built CLI (`--from <bundle>`) or the packed package bin. */
const runLifecycleCommand = (
  fixture: BuiltHostInstallFixture,
  verb: 'install' | 'uninstall',
  host: 'claude' | 'codex' | 'cursor',
  bundle: string,
  options: HostInstallProofOptions,
  extraArguments: readonly string[] = [],
): Promise<CommandResult> => {
  if (options.installCommand === undefined) {
    return runNodeCli(fixture, [
      verb,
      host,
      '--from',
      bundle,
      ...extraArguments,
      '--json',
    ], { cwd: bundle, environment: isolatedEnvironment(options.environment, {}) });
  }
  return run(options.installCommand.executable, [
    ...(options.installCommand.prefixArguments ?? []),
    verb,
    host,
    ...extraArguments,
    '--json',
  ], {
    cwd: options.installCommand.cwd ?? bundle,
    environment: isolatedEnvironment(options.environment, {}),
    timeout: 180_000,
  });
};

const runInstallCommand = (
  fixture: BuiltHostInstallFixture,
  host: 'claude' | 'codex' | 'cursor',
  bundle: string,
  options: HostInstallProofOptions,
): Promise<CommandResult> => runLifecycleCommand(fixture, 'install', host, bundle, options);

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

/**
 * Isolates a scenario's home. `os.homedir()` follows `HOME` on POSIX but
 * `USERPROFILE` on Windows, so an isolated `HOME` alone would leave a Windows
 * developer's real `~/.cursor/plugins/local` as the install destination.
 */
const isolatedEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  values: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => ({
  ...packedNativeEnvironment(environment),
  ...values,
  ...(values.HOME === undefined ? {} : { USERPROFILE: values.HOME }),
});

const stringEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> => Object.fromEntries(
  Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const assertInstallResult = (
  document: InstallResult,
  host: 'claude' | 'codex' | 'cursor',
  state: 'already-installed' | 'installed' | 'replaced',
): void => {
  assertProof(document.host === host, `${host} install result did not identify the host.`);
  assertProof(document.plugin === plugin, `${host} install result did not identify ${plugin}.`);
  assertProof(document.version === version, `${host} install result did not identify version ${version}.`);
  assertProof(document.state === state, `${host} install result state was not ${state}.`);
  assertProof(
    typeof document.contentHash === 'string' && /^[0-9a-f]{64}$/u.test(document.contentHash),
    `${host} install result carried no artifact content hash.`,
  );
  if (host !== 'cursor') {
    assertProof(document.marketplace === marketplace, `${host} install result did not identify ${marketplace}.`);
  }
};

const sameVersionRebuildMarker = 'REBUILD-SAME-VERSION.md';

/**
 * Same-version rebuild against the real host: one file is added to the built
 * bundle (content changes, `version` does not), the installer runs again and
 * must report `replaced`, the host's cached copy must carry the new file, and
 * a third run must be the `already-installed` no-op. The marker is removed
 * afterwards so the shared built fixture is unchanged for later proofs.
 */
const proveSameVersionRebuild = async (options: {
  readonly bundle: string;
  readonly host: 'claude' | 'codex' | 'cursor';
  readonly install: () => Promise<InstallResult>;
  readonly installedRoot: string;
}): Promise<SameVersionRebuildProof> => {
  const marker = join(options.bundle, sameVersionRebuildMarker);
  await writeFile(marker, '# same-version rebuild\n');
  let indexed = false;
  try {
    await reindexArtifactManifest(options.bundle, {
      added: [{ kind: 'generated', path: sameVersionRebuildMarker }],
    });
    indexed = true;
    const replaced = await options.install();
    assertInstallResult(replaced, options.host, 'replaced');
    assertProof(
      typeof replaced.previousContentHash === 'string' && replaced.previousContentHash !== replaced.contentHash,
      `${options.host} replace did not report the superseded content hash.`,
    );
    await access(join(options.installedRoot, sameVersionRebuildMarker)).catch(() =>
      fail(`${options.host} installed copy was not refreshed by the same-version rebuild.`));
    const again = await options.install();
    assertInstallResult(again, options.host, 'already-installed');
    return 'replaced';
  } finally {
    await rm(marker, { force: true });
    if (indexed) {
      await reindexArtifactManifest(options.bundle, {
        removed: [sameVersionRebuildMarker],
      });
    }
  }
};

/**
 * Builds one fixture project with the workspace's source-built CLI. This proves
 * real-host acceptance of that built bundle; packed provenance remains the
 * separate `packed-stdio` proof level.
 */
const buildFixtureProject = async (options: {
  readonly buildCommand?: 'build' | 'prepack';
  /** Root-relative host documents that prove each selected projection landed. */
  readonly expectedPaths: readonly string[];
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly fixture: string;
  readonly prepareProject?: (projectRoot: string) => Promise<void>;
}): Promise<BuiltFixtureProject> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-${options.fixture}-build-`));
  const project = join(root, 'project');
  const artifactRoot = join(project, 'artifact');
  try {
    await cp(join(fixturesRoot, options.fixture), project, { recursive: true });
    await symlink(join(packageRoot, 'node_modules'), join(project, 'node_modules'), 'dir');
    await options.prepareProject?.(project);
    const result = await run(process.execPath, [
      cli,
      options.buildCommand ?? 'build',
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
    await Promise.all(options.expectedPaths.map((path) => access(join(artifactRoot, path))));
    return Object.freeze({ artifactRoot, cli, root });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
};

export const buildHostInstallFixture = async (options: {
  readonly buildCommand?: 'build' | 'prepack';
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly prepareProject?: (projectRoot: string) => Promise<void>;
}): Promise<BuiltHostInstallFixture> => {
  const built = await buildFixtureProject({
    ...(options.buildCommand === undefined ? {} : { buildCommand: options.buildCommand }),
    environment: options.environment,
    expectedPaths: ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.cursor-plugin/plugin.json'],
    fixture: 'host-install',
    ...(options.prepareProject === undefined ? {} : { prepareProject: options.prepareProject }),
  });
  return Object.freeze({
    ...built,
    bundles: Object.freeze({
      claude: built.artifactRoot,
      codex: built.artifactRoot,
      cursor: built.artifactRoot,
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
    environment: options.environment,
    expectedPaths: ['.claude-plugin/plugin.json'],
    fixture: 'host-install-tokens',
  });
  const claudeBundle = built.artifactRoot;
  return Object.freeze({
    ...built,
    claudeBundle,
    loweredSkillMarkdown: await readFile(join(claudeBundle, 'skills', 'token-probe', 'SKILL.md'), 'utf8'),
  });
};

export const buildPortableHostInstallFixture = async (options: {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
}): Promise<BuiltPortableHostInstallFixture> => {
  const built = await buildFixtureProject({
    environment: options.environment,
    expectedPaths: ['agent-bundle.manifest.json'],
    fixture: 'host-install-portable',
  });
  return Object.freeze({
    ...built,
    portableBundle: built.artifactRoot,
  });
};

export const disposeHostInstallFixture = async (fixture: BuiltFixtureProject): Promise<void> => {
  await rm(fixture.root, { force: true, recursive: true });
};

/** Proves initial host-owned installation followed by direct cache re-sync without another host CLI call. */
export const runDevHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  host: InstallHost,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<DevHostInstallProofReport> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-dev-install-${host}-`));
  const home = join(root, 'home');
  const claudeConfig = join(root, 'claude');
  const codexHome = join(root, 'codex');
  const epoch2Root = join(root, 'epoch-2');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(claudeConfig, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    cp(fixture.artifactRoot, epoch2Root, { recursive: true }),
  ]);
  if (host === 'cursor') await mkdir(join(home, '.cursor'), { recursive: true });
  const environment = isolatedEnvironment(options.environment, {
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
    HOME: home,
  });
  const identity = (id: string, epochRoot: string): ArtifactEpoch => Object.freeze({
    configDigest: `${id}-config`,
    createdAt: '2026-09-02T12:00:00.000Z',
    diagnostics: { errors: 0, infos: 0, warnings: 0 },
    id,
    manifestPath: join(epochRoot, 'manifest.json'),
    modelDigest: `${id}-model`,
    projectRevision: `${id}-source`,
    targetDigests: { [host]: `${id}-target` },
  });
  const roots = new Map([['epoch-1', fixture.artifactRoot], ['epoch-2', epoch2Root]]);
  const eventHub = new ProjectEventHub();
  let hostCommandCalls = 0;
  const manager = new DevHostInstallManager({
    environment,
    epochStore: {
      acquireEpochReference: async (epochId) => {
        const epochRoot = roots.get(epochId);
        if (epochRoot === undefined) throw new Error(`Unknown proof epoch ${epochId}.`);
        return { close: async () => undefined, epoch: identity(epochId, epochRoot), root: epochRoot };
      },
    },
    eventHub,
    home,
    hosts: [host],
    installBundle: async (installOptions) => installBundle({
      ...installOptions,
      commandRunner: {
        run: async (command, args, commandOptions) => {
          hostCommandCalls += 1;
          const result = await run(command, args, {
            cwd: commandOptions.cwd,
            environment,
            timeout: 180_000,
          });
          return { code: result.exitCode, stderr: result.stderr, stdout: result.stdout };
        },
      },
    }),
    projectRoot: fixture.root,
  });
  const marketplaceRoot = host === 'claude' ? claudeConfig : codexHome;
  const destination = host === 'cursor'
    ? join(home, '.cursor', 'plugins', 'local', plugin)
    : join(marketplaceRoot, 'plugins', 'cache', marketplace, plugin, version);
  const mcpPath = hostMcpDocument(host);
  try {
    manager.start();
    const first = identity('epoch-1', fixture.artifactRoot);
    eventHub.publish({
      epochId: first.id,
      payload: { activeEpoch: first, currentSourceRevision: first.projectRevision, state: 'active' },
      type: 'artifact.available',
    });
    await manager.settled();
    const mcpBefore = await readFile(join(destination, mcpPath), 'utf8');
    const mcpDocument = record(parseJson<unknown>(mcpBefore, `${host} development MCP document`));
    const server = record(record(mcpDocument?.mcpServers)?.probe);
    const command = server?.command;
    const args = server?.args;
    assertProof(typeof command === 'string', `${host} development MCP command was not a string.`);
    assertProof(Array.isArray(args) && args.every((value) => typeof value === 'string'), `${host} development MCP args were not strings.`);
    const spawned = await run(command, args as readonly string[], {
      cwd: destination,
      environment,
      timeout: 30_000,
    });
    assertProof(spawned.exitCode === 1, `${host} development proxy did not fail closed with exit code 1: ${commandDetail(spawned)}`);
    assertProof(
      spawned.stderr.includes('[AB8025] Development MCP server is unavailable.'),
      `${host} development proxy did not report AB8025: ${commandDetail(spawned)}`,
    );
    const skillBefore = await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8');
    const hookName = (await readdir(join(epoch2Root, 'hooks'))).find((name) => name.endsWith(`.${host}.mjs`));
    assertProof(hookName !== undefined, `${host} proof epoch contained no generated hook module.`);
    await Promise.all([
      writeFile(join(epoch2Root, 'skills', 'probe', 'SKILL.md'), `${skillBefore}\nDev epoch two.\n`),
      writeFile(join(epoch2Root, 'hooks', hookName), 'export default () => ({ outcome: "continue", additionalContext: "epoch two" });\n'),
    ]);
    const callsAfterInstall = hostCommandCalls;
    const second = identity('epoch-2', epoch2Root);
    eventHub.publish({
      epochId: second.id,
      payload: { activeEpoch: second, currentSourceRevision: second.projectRevision, state: 'active' },
      type: 'artifact.available',
    });
    await manager.settled();
    assertProof(hostCommandCalls === callsAfterInstall, `${host} re-sync invoked the host CLI.`);
    assertProof(await readFile(join(destination, mcpPath), 'utf8') === mcpBefore, `${host} re-sync changed its proxy MCP document.`);
    assertProof((await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).includes('Dev epoch two.'), `${host} skill did not re-sync.`);
    assertProof((await readFile(join(destination, 'hooks', hookName), 'utf8')).includes('epoch two'), `${host} hook did not re-sync.`);
    const markerDocument = parseJson<{ readonly epochId: 'epoch-2'; readonly host: InstallHost; readonly schemaVersion: 1 }>(
      await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8'),
      `${host} dev marker`,
    );
    return Object.freeze({
      hookChanged: true,
      host,
      marker: Object.freeze(markerDocument),
      mcpUnchanged: true,
      skillChanged: true,
      spawn: Object.freeze({
        exitCode: 1,
        unavailableDiagnostic: '[AB8025] Development MCP server is unavailable.' as const,
      }),
      status: 'passed',
    });
  } finally {
    await manager.close();
    await rm(root, { force: true, recursive: true });
  }
};

/**
 * Stages one already-built target, opens its emitted MCP command from the
 * installed location, and runs the shared matrix in that same live session.
 * The adapter-simulator lane is deterministic; native-host mode uses the
 * existing real CLI install machinery before the same installed-layout spawn.
 */
export const runInstalledHostContractMatrixProof = async (
  fixture: BuiltHostInstallFixture,
  options: InstalledHostContractMatrixProofOptions,
): Promise<InstalledHostContractMatrixReport> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-installed-matrix-${options.host}-`));
  const home = join(root, 'home');
  const config = join(root, 'config');
  const codexHome = join(root, 'codex');
  const simulatedRoot = join(root, 'installed');
  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(config, { recursive: true }),
      mkdir(codexHome, { recursive: true }),
    ]);
    const environment = isolatedEnvironment(options.environment, {
      CLAUDE_CONFIG_DIR: config,
      CODEX_HOME: codexHome,
      HOME: home,
    });
    let installedRoot: string;
    let hostBinaryVersion: string | undefined;
    let sessionEvidence: string | undefined;
    if (options.mode === 'adapter-simulator') {
      await cp(fixture.bundles[options.host], simulatedRoot, { recursive: true });
      installedRoot = simulatedRoot;
    } else if (options.host === 'cursor') {
      await mkdir(join(home, '.cursor'), { recursive: true });
      const installed = await runInstallCommand(fixture, 'cursor', fixture.bundles.cursor, {
        environment,
      });
      assertProof(installed.exitCode === 0, `Cursor public install path failed: ${commandDetail(installed)}`);
      const document = parseJson<InstallResult>(installed.stdout, 'Cursor install');
      assertInstallResult(document, 'cursor', 'installed');
      assertProof(typeof document.destination === 'string', 'Cursor install returned no destination.');
      installedRoot = document.destination;
      sessionEvidence = 'unavailable: Cursor exposes no non-interactive plugin-loading session surface; adapter-simulated stdio spawn from isolated installed root';
    } else {
      const versioned = await run(options.host, ['--version'], {
        cwd: fixture.bundles[options.host],
        environment,
      });
      assertProof(versioned.exitCode === 0, `${options.host} --version failed: ${commandDetail(versioned)}`);
      hostBinaryVersion = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(versioned.stdout)?.[1];
      assertProof(hostBinaryVersion !== undefined, `${options.host} --version did not report a semantic version.`);
      const installed = await runInstallCommand(
        fixture,
        options.host,
        fixture.bundles[options.host],
        { environment },
      );
      assertProof(installed.exitCode === 0, `${options.host} public install path failed: ${commandDetail(installed)}`);
      const document = parseJson<InstallResult>(installed.stdout, `${options.host} install`);
      assertInstallResult(document, options.host, 'installed');
      installedRoot = options.host === 'claude'
        ? join(config, 'plugins', 'cache', marketplace, plugin, version)
        : join(codexHome, 'plugins', 'cache', marketplace, plugin, version);
      sessionEvidence = 'host-owned installation and adapter-format stdio spawn from isolated installed root';
    }

    await options.mutateInstalled?.(installedRoot);
    const projectRoot = dirname(fixture.artifactRoot);
    const compiledManifest = await compileTestManifest({ root: projectRoot });
    const manifest = Object.freeze({
      ...compiledManifest,
      routes: Object.freeze({
        ...compiledManifest.routes,
        'tool:probe/echo': Object.freeze({
          config: Object.freeze({}),
          id: 'tool:probe/echo',
          kind: 'tool' as const,
          relativePath: 'src/mcp/probe.ts',
          serverId: 'mcp:probe',
          source: join(projectRoot, 'src', 'mcp', 'probe.ts'),
        }),
      }),
    });
    await using session = await openInstalledHostMcpServer({
      artifactRoot: fixture.artifactRoot,
      env: stringEnvironment(environment),
      host: options.host,
      ...(hostBinaryVersion === undefined ? {} : { hostBinaryVersion }),
      installedRoot,
      manifest,
      server: 'probe',
      ...(sessionEvidence === undefined ? {} : { sessionEvidence }),
    });
    return await runInstalledHostContractMatrix({
      fixtures: options.fixtures,
      manifest,
      server: 'probe',
      session,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export const runClaudeHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  options: HostInstallProofOptions,
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
    const installed = await runInstallCommand(fixture, 'claude', fixture.bundles.claude, {
      ...options,
      environment,
    });
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
    const sameVersionRebuild = await proveSameVersionRebuild({
      bundle: fixture.bundles.claude,
      host: 'claude',
      install: async () => {
        const result = await runInstallCommand(fixture, 'claude', fixture.bundles.claude, { ...options, environment });
        assertProof(result.exitCode === 0, `Claude same-version reinstall failed: ${commandDetail(result)}`);
        return parseJson<InstallResult>(result.stdout, 'Claude reinstall');
      },
      installedRoot: expectedInstallPath,
    });
    return Object.freeze({
      host: 'claude',
      install: Object.freeze({ sameVersionRebuild, state: 'installed', version }),
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
  options: HostInstallProofOptions,
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
    const installed = await runInstallCommand(fixture, 'codex', fixture.bundles.codex, {
      ...options,
      environment,
    });
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

    const manifestPath = join(cachePath, codexManifestPath);
    const installedManifestText = await readText(manifestPath, 'Codex installed plugin manifest');
    const builtManifestText = await readText(
      join(fixture.bundles.codex, codexManifestPath),
      'Codex built plugin manifest',
    );
    assertProof(
      installedManifestText === builtManifestText,
      `Codex install did not copy ${codexManifestPath} byte-identically from the built bundle.`,
    );
    const manifestDocument = parseJson<unknown>(installedManifestText, 'Codex installed plugin manifest');
    const manifest = record(manifestDocument);
    assertProof(manifest !== undefined, 'Codex installed plugin manifest was not a JSON object.');
    const manifestIssues = validateCodexPluginManifest(manifestDocument);
    assertProof(
      manifestIssues.length === 0,
      `Codex installed plugin manifest failed its pinned schema: ${JSON.stringify(manifestIssues)}`,
    );
    const manifestInterface = record(manifest.interface);
    assertProof(manifestInterface !== undefined, 'Codex installed plugin manifest carried no interface block.');
    const interfaceFields = Object.keys(manifestInterface).sort();
    const undeclaredFields = interfaceFields.filter((field) => !codexInterfaceFields.includes(field));
    assertProof(
      undeclaredFields.length === 0,
      `Codex installed plugin manifest interface carried fields the adapter does not declare: ${undeclaredFields.join(', ')}.`,
    );
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
    const sameVersionRebuild = await proveSameVersionRebuild({
      bundle: fixture.bundles.codex,
      host: 'codex',
      install: async () => {
        const result = await runInstallCommand(fixture, 'codex', fixture.bundles.codex, { ...options, environment });
        assertProof(result.exitCode === 0, `Codex same-version reinstall failed: ${commandDetail(result)}`);
        return parseJson<InstallResult>(result.stdout, 'Codex reinstall');
      },
      installedRoot: cachePath,
    });

    return Object.freeze({
      host: 'codex',
      install: Object.freeze({ sameVersionRebuild, state: 'installed', version }),
      manifest: Object.freeze({
        interfaceCapabilities: Object.freeze(interfaceCapabilities),
        interfaceFields: Object.freeze(interfaceFields),
        matchesBuiltArtifact: true,
        path: normalizedRelative(cachePath, manifestPath),
        schema: 'schema-valid',
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
    '.cursor-plugin/hooks.json#/hooks/sessionStart/0/command',
    '.cursor-plugin/mcp.json#/mcpServers/probe/args/0',
    '.cursor-plugin/mcp.json#/mcpServers/probe/env/AGENT_BUNDLE_PLUGIN_ROOT',
  ]);
};

const assertCursorHooksRegistration = async (
  home: string,
  destination: string,
): Promise<CursorHostInstallReport['hooksRegistration']> => {
  await access(join(home, '.cursor', 'hooks.json')).then(
    () => fail('Cursor install must not create ~/.cursor/hooks.json; plugin hooks are manifest-registered.'),
    () => undefined,
  );
  const report = await runDoctor({ home, hosts: ['cursor'] });
  const cursor = report.hosts.find((entry) => entry.host === 'cursor');
  const finding = cursor?.inventory.findings.find((entry) => entry.path === destination);
  assertProof(finding !== undefined, 'Doctor did not inventory the installed Cursor plugin.');
  assertProof(finding.hooks?.state === 'registered', `Doctor reported hooks ${JSON.stringify(finding.hooks)} instead of registered.`);
  assertProof(finding.hooks.events.includes('sessionStart'), 'Doctor did not see the emitted sessionStart hook registration.');
  assertProof(finding.hooks.duplicates.length === 0, 'Doctor reported duplicate user-level hook delivery.');
  const proof = report.diagnostics.filter((entry) => entry.code === 'AB7322');
  assertProof(
    proof.length === 1 && proof[0]?.severity === 'info' && proof[0].message.includes('plugin-scoped hooks'),
    `Doctor did not report AB7322 hook registration proof: ${JSON.stringify(proof)}`,
  );
  return Object.freeze({ events: finding.hooks.events, state: 'registered', userHooksJson: 'absent' });
};

const assertCursorMarketplaceStaging = async (
  fixture: BuiltHostInstallFixture,
  home: string,
  environment: NodeJS.ProcessEnv,
): Promise<CursorHostInstallReport['marketplace']> => {
  const installer = join(fixture.bundles.cursor, 'install.mjs');
  const repository = join(home, '.cursor', 'agent-bundle', 'marketplaces', plugin);
  const stage = async (expected: 'Already staged' | 'Staged'): Promise<string> => {
    const result = await run(process.execPath, [installer, '--mode', 'marketplace'], {
      cwd: fixture.bundles.cursor,
      environment,
    });
    assertProof(result.exitCode === 0, `Cursor emitted installer (marketplace mode) failed: ${commandDetail(result)}`);
    const [summary, marketplaceLine] = result.stdout.split('\n');
    assertProof(
      summary?.startsWith(`${expected} ${plugin}@${version} for cursor (marketplace mode) at ${repository}`) === true,
      `Cursor emitted installer did not report ${expected.toLowerCase()}: ${JSON.stringify(summary)}`,
    );
    const commit = /@ ([0-9a-f]{40})$/u.exec(marketplaceLine ?? '')?.[1];
    assertProof(commit !== undefined, `Cursor emitted installer did not print the marketplace commit: ${JSON.stringify(marketplaceLine)}`);
    assertProof(
      result.stdout.includes('Add Plugins from Local Repository') && result.stdout.includes(repository),
      'Cursor emitted installer did not print the Customize import step.',
    );
    return commit;
  };
  const first = await stage('Staged');
  const manifest = record(await readJson(join(repository, '.cursor-plugin', 'marketplace.json'), 'staged marketplace manifest'));
  const plugins = manifest?.plugins;
  assertProof(
    manifest?.name === `${plugin}-marketplace` &&
      Array.isArray(plugins) &&
      record(plugins[0])?.name === plugin &&
      record(plugins[0])?.source === `plugins/${plugin}` &&
      Object.keys(record(plugins[0]) ?? {}).every((key) => ['description', 'minClientVersions', 'name', 'source'].includes(key)),
    `Staged marketplace manifest did not list the plugin with pinned-schema entry fields only: ${JSON.stringify(manifest)}`,
  );
  const stagedPlugin = record(
    await readJson(join(repository, 'plugins', plugin, '.cursor-plugin', 'plugin.json'), 'staged plugin manifest')
      .catch(() => fail('Staged marketplace repository did not contain the plugin copy.')),
  );
  assertProof(
    stagedPlugin?.name === plugin && stagedPlugin.version === version,
    `Staged plugin copy did not carry the plugin version: ${JSON.stringify(stagedPlugin)}`,
  );
  await access(join(repository, '.git', 'HEAD')).catch(() => fail('Staged marketplace repository is not a git repository.'));
  const second = await stage('Already staged');
  assertProof(first === second, 'Re-running marketplace staging changed the commit.');

  const report = await runDoctor({ from: fixture.bundles.cursor, home, hosts: ['cursor'] });
  const cursor = report.hosts.find((entry) => entry.host === 'cursor');
  const staged = cursor?.inventory.findings.find((entry) => entry.path === repository);
  assertProof(
    staged?.state === 'unregistered' && staged.commit === first && staged.marketplace === `${plugin}-marketplace`,
    `Doctor did not report the staged marketplace as awaiting import: ${JSON.stringify(staged)}`,
  );
  const pending = report.diagnostics.filter((entry) => entry.code === 'AB7324');
  assertProof(
    pending.length > 0 && pending.every((entry) => entry.severity === 'warning' && entry.recovery?.includes('Add Plugins from Local Repository') === true),
    `Doctor did not report AB7324 import guidance: ${JSON.stringify(pending)}`,
  );
  return Object.freeze({
    commit: 'git-sha',
    first: 'staged',
    imported: false,
    manifest: 'marketplace.json lists the plugin',
    repository: normalizedRelative(home, repository),
    second: 'already-staged',
  });
};

/**
 * Installs the composite root as a Cursor local plugin in a fresh isolated home and asks Doctor
 * for the static and registration verdicts. The root carries both `hooks/hooks.json` (Claude
 * format) and `.cursor-plugin/hooks.json` (Cursor format, named by `.cursor-plugin/plugin.json`), so a
 * validator that ignored the manifest would report AB7320/AB6027 against a byte-for-byte install (#438).
 */
const assertUnifiedBundleCursorInstall = async (
  fixture: BuiltHostInstallFixture,
  options: HostInstallProofOptions,
): Promise<CursorHostInstallReport['unifiedBundle']> => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-cursor-unified-'));
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const environment = isolatedEnvironment(options.environment, { HOME: home });
    const result = await runNodeCli(fixture, ['install', 'cursor', '--from', fixture.artifactRoot, '--json'], {
      cwd: fixture.artifactRoot,
      environment,
    });
    assertProof(result.exitCode === 0, `Unified bundle Cursor install failed: ${commandDetail(result)}`);
    const installed = parseJson<InstallResult>(result.stdout, 'unified bundle Cursor install');
    assertInstallResult(installed, 'cursor', 'installed');
    const destination = join(home, '.cursor', 'plugins', 'local', plugin);
    assertProof(installed.destination === destination, 'Unified bundle Cursor install did not report the isolated destination.');

    const manifest = record(await readJson(join(destination, '.cursor-plugin', 'plugin.json'), 'unified bundle Cursor manifest'));
    assertProof(
      manifest?.hooks === './.cursor-plugin/hooks.json',
      `Unified bundle Cursor manifest did not name .cursor-plugin/hooks.json: ${JSON.stringify(manifest?.hooks)}`,
    );
    await access(join(destination, 'hooks', 'hooks.json')).catch(() => fail('Unified bundle install lacks the Claude hooks/hooks.json.'));
    const cursorHooks = parseJson<unknown>(
      await readText(join(destination, '.cursor-plugin', 'hooks.json'), 'unified bundle Cursor hooks document'),
      'unified bundle Cursor hooks document',
    );
    assertProof(cursorHooksValidator(cursorHooks), `Unified bundle Cursor hooks document failed its pinned schema: ${JSON.stringify(cursorHooksValidator.errors)}`);

    // Doctor identifies the bundle from the composite root's manifest alone (#592 step 3): the
    // application identity and the install comparison come from `--from <root>`, never `<root>/cursor`.
    const report = await runDoctor({ from: fixture.artifactRoot, home, hosts: ['cursor'] });
    const bundle = report.hosts.find((entry) => entry.host === 'cursor')?.bundle;
    assertProof(
      bundle?.bundleRoot === fixture.artifactRoot && bundle.version === version && bundle.comparison?.status === 'current',
      `Doctor did not identify the composite root through its manifest: ${JSON.stringify(bundle)}`,
    );
    const staticFindings = report.diagnostics.filter((entry) => entry.code === 'AB7320');
    const schemaFindings = report.diagnostics.filter((entry) => entry.message.includes('AB6027'));
    assertProof(
      staticFindings.length === 0 && schemaFindings.length === 0,
      `Doctor reported static findings against a byte-for-byte unified bundle install: ${JSON.stringify([...staticFindings, ...schemaFindings])}`,
    );
    const cursor = report.hosts.find((entry) => entry.host === 'cursor');
    const finding = cursor?.inventory.findings.find((entry) => entry.path === destination);
    assertProof(finding?.state === 'installed', `Doctor reported the unified bundle install as ${JSON.stringify(finding?.state)} instead of installed.`);
    assertProof(
      finding.hooks?.state === 'registered' && finding.hooks.source === join(destination, '.cursor-plugin', 'hooks.json'),
      `Doctor did not register hooks from .cursor-plugin/hooks.json: ${JSON.stringify(finding.hooks)}`,
    );
    assertProof(finding.hooks.events.includes('sessionStart'), 'Doctor did not see the unified bundle sessionStart hook registration.');
    return Object.freeze({
      hooksDocument: '.cursor-plugin/hooks.json',
      hooksRegistration: 'registered',
      install: 'installed',
      staticFindings: Object.freeze({ AB6027: 0, AB7320: 0 }),
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};

export const runCursorHostInstallProof = async (
  fixture: BuiltHostInstallFixture,
  options: HostInstallProofOptions,
): Promise<CursorHostInstallReport> => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-cursor-'));
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const environment = isolatedEnvironment(options.environment, { HOME: home });
    const install = async (): Promise<InstallResult> => {
      const result = await runInstallCommand(fixture, 'cursor', fixture.bundles.cursor, {
        ...options,
        environment,
      });
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
    const hooksText = await readText(join(destination, '.cursor-plugin', 'hooks.json'), 'Cursor hooks document');
    const hooksDocument = parseJson<unknown>(hooksText, 'Cursor hooks document');
    assertProof(cursorHooksValidator(hooksDocument), `Cursor hooks document failed its pinned schema: ${JSON.stringify(cursorHooksValidator.errors)}`);
    const mcpText = await readText(join(destination, '.cursor-plugin', 'mcp.json'), 'Cursor MCP document');
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
    const sameVersionRebuild = await proveSameVersionRebuild({
      bundle: fixture.bundles.cursor,
      host: 'cursor',
      install,
      installedRoot: destination,
    });

    const hooksRegistration = await assertCursorHooksRegistration(home, destination);
    const marketplace = await assertCursorMarketplaceStaging(fixture, home, environment);
    const unifiedBundle = await assertUnifiedBundleCursorInstall(fixture, options);

    return Object.freeze({
      destination: normalizedRelative(home, destination),
      documents: Object.freeze({
        hooks: 'schema-valid',
        mcp: 'schema-valid',
        plugin: 'schema-valid',
      }),
      hooksRegistration,
      host: 'cursor',
      install: Object.freeze({
        first: 'installed',
        sameVersionRebuild,
        second: 'already-installed',
        version,
      }),
      marketplace,
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
      unifiedBundle,
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};

export const runPortableHostInstallProof = async (
  fixture: BuiltPortableHostInstallFixture,
  options: HostInstallProofOptions,
): Promise<PortableHostInstallReport> => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-host-install-portable-'));
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const environment = isolatedEnvironment(options.environment, { HOME: home });
    const installer = join(fixture.portableBundle, 'install.mjs');
    const install = async (state: 'Already installed' | 'Installed' | 'Replaced'): Promise<void> => {
      const result = await run(process.execPath, [installer], {
        cwd: fixture.portableBundle,
        environment,
      });
      assertProof(
        result.exitCode === 0,
        `Portable emitted installer failed: ${commandDetail(result)}`,
      );
      assertProof(
        result.stdout.trim().startsWith(`${state} ${portablePlugin}@${version} at `),
        `Portable emitted installer did not report ${state.toLowerCase()}.`,
      );
    };

    await install('Installed');
    const destination = join(home, '.cursor', 'plugins', 'local', portablePlugin);
    const pluginData = join(home, '.cursor', 'agent-bundle', 'plugin-data', portablePlugin);
    const pluginDocument = await readJson(
      join(destination, 'plugin.json'),
      'Portable installed plugin manifest',
    );
    assertProof(
      portablePluginValidator(pluginDocument),
      `Portable plugin manifest failed its pinned schema: ${JSON.stringify(portablePluginValidator.errors)}`,
    );
    // The bundle's mcp.json is the spec-conformant document; the Cursor copy is its install-time expansion
    // (Cursor 3.18.25 expands no Agent Plugins placeholder itself), recorded verbatim in the receipt.
    const bundleMcpText = await readFile(join(fixture.portableBundle, 'mcp.json'), 'utf8');
    const mcpDocument = JSON.parse(bundleMcpText) as unknown;
    assertProof(
      portableMcpValidator(mcpDocument),
      `Portable MCP document failed its pinned schema: ${JSON.stringify(portableMcpValidator.errors)}`,
    );
    const receipt = await readInstallReceipt(destination);
    assertProof(receipt !== undefined, 'Portable emitted installer wrote no receipt.');
    assertProof(
      receipt.cursorExpansion !== undefined &&
        receipt.cursorExpansion.pluginRoot === destination &&
        receipt.cursorExpansion.pluginData === pluginData &&
        receipt.cursorExpansion.documents['mcp.json'] === bundleMcpText,
      `Portable receipt did not record the Cursor expansion of the bundle mcp.json: ${JSON.stringify(receipt.cursorExpansion)}`,
    );
    const pluginDataMetadata = await lstat(pluginData).catch(() => fail('Portable installer did not create the PLUGIN_DATA directory.'));
    assertProof(pluginDataMetadata.isDirectory(), 'Portable PLUGIN_DATA is not a directory.');
    const installedMcp = record(await readJson(join(destination, 'mcp.json'), 'Portable installed MCP document'));
    assertProof(installedMcp !== undefined, 'Portable installed MCP document was not a JSON object.');
    const installedServers = record(installedMcp.mcpServers);
    assertProof(installedServers !== undefined, 'Portable installed MCP document had no server map.');
    let expandedStdioServers = 0;
    for (const [serverName, serverValue] of Object.entries(installedServers)) {
      const server = record(serverValue);
      assertProof(server !== undefined, `Portable installed MCP server ${serverName} was not an object.`);
      if (server.type !== 'stdio') continue;
      expandedStdioServers += 1;
      const text = JSON.stringify(server);
      assertProof(
        !text.includes(portablePluginRootVariable) && !text.includes(portablePluginDataVariable),
        `Portable installed MCP server ${serverName} still carries an Agent Plugins placeholder Cursor would not expand.`,
      );
      assertProof(server.cwd === destination, `Portable installed MCP server ${serverName} cwd is not the plugin root.`);
      const environment = record(server.env);
      assertProof(
        environment?.PLUGIN_ROOT === destination && environment.PLUGIN_DATA === pluginData,
        `Portable installed MCP server ${serverName} lacks the expanded PLUGIN_ROOT/PLUGIN_DATA variables.`,
      );
      assertProof(
        environment.AGENT_BUNDLE_PLUGIN_ROOT === destination,
        `Portable installed MCP server ${serverName} AGENT_BUNDLE_PLUGIN_ROOT was not expanded to the plugin root.`,
      );
      for (const argument of Array.isArray(server.args) ? server.args : []) {
        if (typeof argument !== 'string' || !argument.startsWith(`${destination}${sep}`)) continue;
        await access(argument).catch(() => fail(`Portable installed MCP server ${serverName} argument ${argument} does not exist.`));
      }
    }
    assertProof(expandedStdioServers > 0, 'Portable fixture emitted no stdio server to expand.');

    const pluginManifest = record(pluginDocument);
    const mcpManifest = record(mcpDocument);
    assertProof(pluginManifest !== undefined, 'Portable plugin manifest was not a JSON object.');
    assertProof(mcpManifest !== undefined, 'Portable MCP document was not a JSON object.');
    assertProof(
      pluginManifest.$schema === portablePluginSchemaIdentifier,
      'Portable plugin manifest did not declare the canonical Agent Plugins 1.0.0 schema.',
    );
    assertProof(
      mcpManifest.$schema === portableMcpSchemaIdentifier,
      'Portable MCP document did not declare the canonical Agent Plugins 1.0.0 schema.',
    );
    const schemaVersion = (identifier: string): string | undefined =>
      /^https:\/\/agent-plugins\.org\/schemas\/([^/]+)\//u.exec(identifier)?.[1];
    assertProof(
      schemaVersion(pluginManifest.$schema) === schemaVersion(mcpManifest.$schema),
      'Portable plugin and MCP documents declared different Agent Plugins versions.',
    );
    assertProof(
      schemaVersion(pluginManifest.$schema) === version,
      `Portable documents did not declare Agent Plugins ${version}.`,
    );
    assertProof(
      pluginManifest.name === portablePlugin && pluginManifest.version === version,
      'Portable plugin manifest did not carry the fixture identity.',
    );
    assertProof(
      record(pluginManifest.author)?.name === 'Agent Bundle proof harness' &&
        pluginManifest.license === 'MIT' &&
        pluginManifest.homepage === 'https://github.com/ScriptedAlchemy/agent-bundle' &&
        pluginManifest.repository === 'https://github.com/ScriptedAlchemy/agent-bundle' &&
        JSON.stringify(pluginManifest.keywords) === JSON.stringify(['proof', 'agent-plugins']) &&
        record(record(pluginManifest.extensions)?.['com.example.proof'])?.fixture === true,
      'Portable plugin manifest did not carry the authored Agent Plugins §5.4 metadata and §5.6 extensions.',
    );

    const mcpServers = record(mcpManifest.mcpServers);
    assertProof(mcpServers !== undefined, 'Portable MCP document had no server map.');
    for (const [serverName, serverValue] of Object.entries(mcpServers)) {
      const server = record(serverValue);
      assertProof(server !== undefined, `Portable MCP server ${serverName} was not an object.`);
      if (server.type !== 'stdio') continue;
      const serverEnvironment = record(server.env);
      if (serverEnvironment === undefined) continue;
      assertProof(
        !Object.keys(serverEnvironment).some((key) => key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA'),
        `Portable MCP server ${serverName} used an Agent Plugins reserved environment key.`,
      );
    }

    const escapePointerSegment = (segment: string): string =>
      segment.replaceAll('~', '~0').replaceAll('/', '~1');
    const placeholderLocations: string[] = [];
    const visit = (value: unknown, pointer: string, documentName: string): void => {
      if (typeof value === 'string') {
        if (
          value.includes(portablePluginRootVariable)
          || value.includes(portablePluginDataVariable)
        ) {
          assertProof(
            /^\/mcpServers\/[^/]+\/(?:args\/\d+|cwd|env\/[^/]+)$/u.test(pointer),
            `Portable placeholder occurred outside args, environment values, or cwd at ${documentName}#${pointer}.`,
          );
          placeholderLocations.push(`${documentName}#${pointer}`);
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${pointer}/${String(index)}`, documentName));
        return;
      }
      const valueRecord = record(value);
      if (valueRecord === undefined) return;
      for (const [key, entry] of Object.entries(valueRecord)) {
        visit(entry, `${pointer}/${escapePointerSegment(key)}`, documentName);
      }
    };
    visit(pluginDocument, '', 'plugin.json');
    visit(mcpDocument, '', 'mcp.json');
    assertProof(
      placeholderLocations.length > 0,
      'Portable installed documents carried no Agent Plugins path placeholders.',
    );

    const skillsRoot = join(destination, 'skills');
    const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    assertProof(skillDirectories.length > 0, 'Portable install had no immediate Skill directories.');
    const skillPaths: string[] = [];
    for (const directory of skillDirectories) {
      const skillPath = join(skillsRoot, directory.name, 'SKILL.md');
      const metadata = await lstat(skillPath).catch(() =>
        fail(`Portable Skill directory ${directory.name} had no SKILL.md.`));
      assertProof(
        metadata.isFile() && !metadata.isSymbolicLink(),
        `Portable Skill directory ${directory.name} did not contain a regular SKILL.md.`,
      );
      skillPaths.push(normalizedRelative(home, skillPath));
    }
    assertProof(
      skillPaths.length === 1,
      'Portable proof fixture did not install exactly one discovered Skill.',
    );

    for (const hookPath of [join(destination, 'hooks'), join(destination, 'hooks.json')]) {
      const hookMetadata = await lstat(hookPath).catch((error: unknown) => {
        const code = record(error)?.code;
        if (code === 'ENOENT') return undefined;
        throw error;
      });
      assertProof(
        hookMetadata === undefined,
        'Portable artifact emitted a hooks surface that Agent Plugins 1.0.0 does not define.',
      );
    }

    // The byte lane validates the shipped document (the receipt copy), exactly as Doctor does for an expanded install.
    const contractDiagnostics = await validatePortablePluginFiles({
      documents: { 'mcp.json': bundleMcpText },
      pluginDirectory: destination,
      target: 'portable',
    });
    assertProof(
      contractDiagnostics.length === 0,
      `Portable installed bytes failed the pinned Agent Plugins byte lane: ${JSON.stringify(contractDiagnostics)}`,
    );
    const doctorReport = await runDoctor({ home, hosts: ['cursor'] });
    const launchFindings = doctorReport.diagnostics.filter((entry) => entry.code === 'AB7326');
    assertProof(
      launchFindings.length === 1 && launchFindings[0]?.severity === 'info' && launchFindings[0].message.includes('were expanded for Cursor at install'),
      `Doctor did not prove the Cursor expansion (AB7326): ${JSON.stringify(launchFindings)}`,
    );
    assertProof(
      !doctorReport.diagnostics.some((entry) => entry.code === 'AB7320' && entry.severity === 'error'),
      `Doctor reported Agent Plugins contract errors for the expanded install: ${JSON.stringify(doctorReport.diagnostics.filter((entry) => entry.code === 'AB7320'))}`,
    );
    const portableFinding = doctorReport.hosts.find((entry) => entry.host === 'cursor')?.inventory.findings
      .find((entry) => entry.name === portablePlugin);
    assertProof(
      portableFinding?.state === 'installed' && portableFinding.launch?.state === 'expanded',
      `Doctor inventory did not report the portable install as expanded: ${JSON.stringify(portableFinding)}`,
    );

    await install('Already installed');

    // Same-version rebuild through the emitted install.mjs: owned files replaced in place, then a no-op.
    const marker = join(fixture.portableBundle, sameVersionRebuildMarker);
    await writeFile(marker, '# same-version rebuild\n');
    let sameVersionRebuild: SameVersionRebuildProof;
    try {
      await install('Replaced');
      await access(join(destination, sameVersionRebuildMarker)).catch(() =>
        fail('Portable emitted installer did not refresh the installed copy for the same-version rebuild.'));
      await install('Already installed');
      sameVersionRebuild = 'replaced';
    } finally {
      await rm(marker, { force: true });
    }

    return Object.freeze({
      contract: 'agent-plugins-1.0.0 byte lane clean (AB6035–AB6037)',
      destination: normalizedRelative(home, destination),
      documents: Object.freeze({
        mcp: 'schema-valid',
        plugin: 'schema-valid',
      }),
      hooks: 'not-emitted',
      host: 'cursor',
      install: Object.freeze({
        first: 'installed',
        sameVersionRebuild,
        second: 'already-installed',
        version,
      }),
      manifestMetadata: 'author/homepage/repository/license/keywords/extensions emitted from portable config',
      pluginVariables: Object.freeze({
        allowedLocations: 'args/env values/cwd only',
        cursorExpansion: Object.freeze({
          doctor: 'AB7326 expanded',
          installedCopy: 'PLUGIN_ROOT/PLUGIN_DATA absolute, cwd = plugin root, PLUGIN_ROOT/PLUGIN_DATA env set, no placeholder left',
          pluginData: normalizedRelative(home, pluginData),
          receipt: 'cursorExpansion records the bundle mcp.json verbatim',
        }),
        locations: Object.freeze(placeholderLocations),
        reservedEnvKeys: 'absent',
        resolvedAtInstall: true,
        sessionEvidence: 'unavailable: Cursor loads Agent Plugins only at restart or window reload; no non-interactive plugin-loading session surface',
      }),
      proofLevel: portableProofLevel,
      proofScope: 'installer+filesystem+pinned-schema conformance against an isolated Cursor home; IDE plugin-loader behavior not observed by this test',
      skill: skillPaths[0],
      specVersion: version,
      status: 'passed',
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};

export interface DevLiveHostProofReport {
  readonly connection: {
    readonly initialized: 1;
    readonly observations: readonly [string, string];
    readonly toolsListChanged: 1;
  };
  readonly host: InstallHost;
  readonly hostBinaryVersion: string | 'not-required';
  readonly install: {
    readonly commandFromInstalledDocument: true;
    readonly hostCliCommandCount: number;
    readonly hostCliCommandsUnchangedAcrossRebuild: true;
  };
  readonly resync: {
    readonly hook: 'v2';
    readonly markerAdvanced: true;
    readonly skill: 'v2';
  };
  readonly sessionEvidence: string;
  readonly status: 'passed';
}

export interface ClaudeLiveDevSessionReport {
  readonly attempts: 2;
  readonly host: 'claude';
  readonly hostBinaryVersion: string;
  readonly normalHome: {
    readonly settingsAndPlugins: 'unchanged';
  };
  readonly reinstalledAfterRebuild: false;
  readonly sessionMode: 'resumed inline installed-tree session';
  readonly status: 'passed';
  readonly toolOutputs: readonly [string, string];
}

interface LiveHostObservationContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly installedRoot: string;
  readonly version: 'v1' | 'v2';
}

interface LiveHostScenarioResult {
  readonly hostBinaryVersion: string | 'not-required';
  readonly report: DevLiveHostProofReport;
}

const liveMcpSource = (version: 'v1' | 'v2'): string => [
  "import { McpServer } from '@modelcontextprotocol/server';",
  "import { z } from 'zod';",
  '',
  `const version = ${JSON.stringify(version)};`,
  '',
  'export default () => {',
  "  const server = new McpServer({ name: 'host-install-proof', version: '1.0.0' });",
  "  server.registerTool('echo', {",
  "    description: 'Reports the live development epoch.',",
  '    inputSchema: { message: z.string() },',
  '  }, async ({ message }) => ({',
  '    content: [{ text: `${version}:${message}`, type: \'text\' }],',
  '    structuredContent: { message, operationId: \'tool:probe/echo\', version },',
  '  }));',
  '  return server;',
  '};',
  '',
].join('\n');

const liveSkillSource = (version: 'v1' | 'v2'): string => [
  '---',
  'name: probe',
  `description: Live development proof ${version}.`,
  '---',
  '',
  `# Live development proof ${version}`,
  '',
].join('\n');

const liveHookSource = (version: 'v1' | 'v2'): string =>
  `export default () => ({ additionalContext: 'live development proof ${version}', outcome: 'continue' as const });\n`;

const hostMcpDocument = (host: InstallHost): string => {
  switch (host) {
    case 'claude':
      return '.mcp.json';
    case 'codex':
      return codexArtifactPaths.mcp;
    case 'cursor':
      return cursorArtifactPaths.mcp;
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown install host ${String(exhaustive)}.`);
    }
  }
};

const liveHostDestination = (
  host: InstallHost,
  roots: { readonly claudeConfig: string; readonly codexHome: string; readonly home: string },
): string => {
  switch (host) {
    case 'claude':
      return join(roots.claudeConfig, 'plugins', 'cache', marketplace, plugin, version);
    case 'codex':
      return join(roots.codexHome, 'plugins', 'cache', marketplace, plugin, version);
    case 'cursor':
      return join(roots.home, '.cursor', 'plugins', 'local', plugin);
    default: {
      const exhaustive: never = host;
      return fail(`Unsupported live development host ${String(exhaustive)}.`);
    }
  }
};

const textToolResult = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const first = result.content[0];
  return first?.type === 'text'
    ? first.text
    : fail('The installed development MCP tool returned no text content.');
};

const waitFor = async (
  condition: () => Promise<boolean>,
  message: string,
  timeout = 20_000,
): Promise<void> => {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started >= timeout) fail(message);
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 20);
    });
  }
};

const commandLines = async (path: string): Promise<readonly string[]> => {
  const text = await readFile(path, 'utf8').catch((error: unknown) => {
    if (record(error)?.code === 'ENOENT') return '';
    throw error;
  });
  return text.split('\n').filter((line) => line.length > 0);
};

const hostCliInstallCommandCount = async (path: string): Promise<number> =>
  (await commandLines(path)).filter((line) => {
    const args = parseJson<readonly string[]>(line, 'recorded host CLI command');
    return args[0] === 'plugin';
  }).length;

const installHostCommandRecorder = async (
  host: Exclude<InstallHost, 'cursor'>,
  root: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly environment: NodeJS.ProcessEnv; readonly log: string; readonly version: string }> => {
  const versioned = await run(host, ['--version'], { cwd: root, environment });
  assertProof(versioned.exitCode === 0, `${host} --version failed: ${commandDetail(versioned)}`);
  const observedVersion = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(versioned.stdout)?.[1];
  assertProof(observedVersion !== undefined, `${host} --version did not report a semantic version.`);
  const located = await run('which', [host], { cwd: root, environment });
  assertProof(located.exitCode === 0, `Could not resolve the real ${host} binary: ${commandDetail(located)}`);
  const realBinary = located.stdout.trim().split('\n')[0];
  assertProof(realBinary !== undefined && isAbsolute(realBinary), `Resolved ${host} binary was not absolute.`);
  const wrappers = join(root, 'host-command-wrappers');
  const log = join(root, `${host}-commands.jsonl`);
  await mkdir(wrappers, { recursive: true });
  await writeFile(join(wrappers, host), [
    `#!${process.execPath}`,
    "import { appendFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    '',
    "appendFileSync(process.env.AGENT_BUNDLE_HOST_COMMAND_LOG, `${JSON.stringify(process.argv.slice(2))}\\n`);",
    'const result = spawnSync(process.env.AGENT_BUNDLE_REAL_HOST_BINARY, process.argv.slice(2), {',
    '  env: process.env,',
    "  stdio: ['ignore', 'inherit', 'inherit'],",
    '});',
    'process.exit(result.status ?? 1);',
    '',
  ].join('\n'), { mode: 0o755 });
  return Object.freeze({
    environment: {
      ...environment,
      AGENT_BUNDLE_HOST_COMMAND_LOG: log,
      AGENT_BUNDLE_REAL_HOST_BINARY: realBinary,
      PATH: `${wrappers}${delimiter}${environment.PATH ?? ''}`,
    },
    log,
    version: observedVersion,
  });
};

const withProcessEnvironment = async <Value>(
  environment: NodeJS.ProcessEnv,
  action: () => Promise<Value>,
): Promise<Value> => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const runLiveHostScenario = async (
  fixture: BuiltHostInstallFixture,
  host: InstallHost,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
  observe?: (context: LiveHostObservationContext) => Promise<void>,
): Promise<LiveHostScenarioResult> => {
  const scenarioRoot = await mkdtemp(join(tmpdir(), `agent-bundle-dev-live-${host}-`));
  const projectRoot = dirname(fixture.artifactRoot);
  const roots = Object.freeze({
    claudeConfig: join(scenarioRoot, 'claude'),
    codexHome: join(scenarioRoot, 'codex'),
    home: join(scenarioRoot, 'home'),
  });
  await Promise.all([
    mkdir(roots.claudeConfig, { recursive: true }),
    mkdir(roots.codexHome, { recursive: true }),
    mkdir(join(roots.home, '.cursor'), { recursive: true }),
  ]);
  let environment = isolatedEnvironment(options.environment, {
    CLAUDE_CONFIG_DIR: roots.claudeConfig,
    CODEX_HOME: roots.codexHome,
    HOME: roots.home,
  });
  let hostBinaryVersion: string | 'not-required' = 'not-required';
  let commandLog = join(scenarioRoot, 'cursor-no-host-commands.jsonl');
  if (host !== 'cursor') {
    const recorded = await installHostCommandRecorder(host, scenarioRoot, environment);
    environment = recorded.environment;
    commandLog = recorded.log;
    hostBinaryVersion = recorded.version;
  }
  const mcpSource = join(projectRoot, 'src', 'mcp', 'probe.ts');
  const skillSource = join(projectRoot, 'src', 'skills', 'probe', 'SKILL.md');
  const hookSource = join(projectRoot, 'src', 'hooks', 'session-start.ts');
  await Promise.all([
    writeFile(mcpSource, liveMcpSource('v1')),
    writeFile(skillSource, liveSkillSource('v1')),
    writeFile(hookSource, liveHookSource('v1')),
  ]);
  const destination = liveHostDestination(host, roots);
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    return await withProcessEnvironment(environment, async () => {
      server = await startDevServer({ installHosts: [host], open: false, port: 0, root: projectRoot });
      const markerBefore = parseJson<{ readonly epochId: string }>(
        await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8'),
        `${host} initial live development marker`,
      );
      const document = record(parseJson<unknown>(
        await readFile(join(destination, hostMcpDocument(host)), 'utf8'),
        `${host} installed development MCP document`,
      ));
      const declared = record(record(document?.mcpServers)?.probe);
      assertProof(typeof declared?.command === 'string', `${host} installed development MCP command was absent.`);
      assertProof(
        Array.isArray(declared.args) && declared.args.every((argument) => typeof argument === 'string'),
        `${host} installed development MCP arguments were absent.`,
      );
      const transport = new StdioClientTransport({
        args: [...declared.args as readonly string[]],
        command: declared.command,
        cwd: destination,
        env: stringEnvironment(environment),
        stderr: 'pipe',
      });
      client = new Client({ name: 'agent-bundle-live-host-proof', version: '1.0.0' });
      await client.connect(transport);
      let toolsListChanged = 0;
      const changed = Promise.withResolvers<void>();
      client.setNotificationHandler('notifications/tools/list_changed', async () => {
        toolsListChanged += 1;
        changed.resolve();
      });
      const listed = await client.listTools();
      assertProof(listed.tools.some((tool) => tool.name === 'echo'), `${host} live proxy did not list echo.`);
      const first = textToolResult(await client.callTool({ arguments: { message: host }, name: 'echo' }));
      assertProof(first === `v1:${host}`, `${host} live proxy did not observe v1.`);
      await observe?.({ environment, installedRoot: destination, version: 'v1' });
      const installCommandsBeforeRebuild = await hostCliInstallCommandCount(commandLog);
      await Promise.all([
        replaceWatchedSource(projectRoot, mcpSource, liveMcpSource('v2')),
        replaceWatchedSource(projectRoot, skillSource, liveSkillSource('v2')),
        replaceWatchedSource(projectRoot, hookSource, liveHookSource('v2')),
      ]);
      await Promise.race([
        changed.promise,
        new Promise<never>((_resolvePromise, rejectPromise) => {
          setTimeout(() => rejectPromise(new Error(`${host} tools/list_changed timed out.`)), 30_000);
        }),
      ]);
      const second = textToolResult(await client.callTool({ arguments: { message: host }, name: 'echo' }));
      assertProof(second === `v2:${host}`, `${host} live proxy did not observe v2.`);
      await waitFor(async () => {
        const marker = parseJson<{ readonly epochId: string }>(
          await readFile(join(destination, DEV_INSTALL_MARKER), 'utf8'),
          `${host} rebuilt live development marker`,
        );
        return marker.epochId !== markerBefore.epochId;
      }, `${host} installed development marker did not advance.`);
      await waitFor(
        async () => (await readFile(join(destination, 'skills', 'probe', 'SKILL.md'), 'utf8')).includes('proof v2'),
        `${host} installed skill did not re-sync to v2.`,
      );
      const hookName = (await readdir(join(destination, 'hooks'))).find((name) => name.endsWith('.mjs'));
      assertProof(hookName !== undefined, `${host} installed hooks contained no executable module.`);
      await waitFor(
        async () => (await readFile(join(destination, 'hooks', hookName), 'utf8')).includes('proof v2'),
        `${host} installed hook did not re-sync to v2.`,
      );
      const installCommandsAfterRebuild = await hostCliInstallCommandCount(commandLog);
      assertProof(
        installCommandsAfterRebuild === installCommandsBeforeRebuild,
        `${host} rebuild invoked another host CLI install command.`,
      );
      await observe?.({ environment, installedRoot: destination, version: 'v2' });
      const sessionEvidence = host === 'cursor'
        ? 'unavailable: Cursor exposes no non-interactive plugin-loading session surface'
        : host === 'codex'
          ? 'unavailable: Codex exec authenticates non-interactively but exposes no inline plugin loader for the isolated dev install; exact installed proxy observed v1→v2 on one connection'
          : 'host-owned installation and exact installed proxy observed v1→v2 on one connection';
      const report: DevLiveHostProofReport = Object.freeze({
        connection: Object.freeze({
          initialized: 1,
          observations: Object.freeze([first, second] as const),
          toolsListChanged: toolsListChanged === 1
            ? 1
            : fail(`${host} emitted ${String(toolsListChanged)} tools/list_changed notifications.`),
        }),
        host,
        hostBinaryVersion,
        install: Object.freeze({
          commandFromInstalledDocument: true,
          hostCliCommandCount: installCommandsBeforeRebuild,
          hostCliCommandsUnchangedAcrossRebuild: true,
        }),
        resync: Object.freeze({
          hook: 'v2',
          markerAdvanced: true,
          skill: 'v2',
        }),
        sessionEvidence,
        status: 'passed',
      });
      return Object.freeze({ hostBinaryVersion, report });
    });
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(scenarioRoot, { force: true, recursive: true });
  }
};

export const runDevLiveHostProof = async (
  fixture: BuiltHostInstallFixture,
  host: InstallHost,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<DevLiveHostProofReport> => (await runLiveHostScenario(fixture, host, options)).report;

export const runClaudeLiveDevSessionProof = async (
  fixture: BuiltHostInstallFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<ClaudeLiveDevSessionReport> => {
  const sessionId = randomUUID();
  // Captured before runLiveHostScenario swaps process.env.HOME for the isolated
  // scenario home: the spawned claude turn runs against the developer's real
  // home, so the unchanged-state guard must digest that same home.
  const normalHome = homedir();
  const normalEnvironment = { ...packedNativeEnvironment(options.environment) };
  delete normalEnvironment.CLAUDE_CONFIG_DIR;
  const toolOutputs: string[] = [];
  const unchangedTurns: boolean[] = [];
  const scenario = await runLiveHostScenario(
    fixture,
    'claude',
    options,
    async ({ installedRoot, version: liveVersion }) => {
      const expected = `${liveVersion}:claude-session`;
      const prompt = `Invoke the inline host-install-proof plugin's probe MCP echo tool exactly once with message `
        + `"claude-session". Reply with only the tool's text result, which must be ${expected}.`;
      const args = [
        '--plugin-dir',
        installedRoot,
        '--model',
        'sonnet',
        '--output-format',
        'text',
        '--allowedTools',
        'mcp__plugin_host-install-proof_probe__echo',
        ...(liveVersion === 'v1' ? ['--session-id', sessionId] : ['--resume', sessionId]),
        '-p',
        prompt,
      ];
      let result: CommandResult | undefined;
      const settingsAndPluginsUnchanged = await normalClaudeSettingsAndPluginsUnchanged(
        normalEnvironment,
        async () => {
          result = await run('claude', args, {
            cwd: dirname(fixture.artifactRoot),
            environment: normalEnvironment,
            timeout: 300_000,
          });
        },
        { homeDirectory: normalHome },
      );
      assertProof(result !== undefined, `Claude ${liveVersion} inline live development turn did not run.`);
      const rawOutput = result.stdout.trim();
      assertProof(
        result.exitCode === 0,
        `Claude ${liveVersion} inline live development turn failed; stdout=${JSON.stringify(rawOutput)}; `
          + `stderr=${JSON.stringify(result.stderr.trim())}.`,
      );
      assertProof(
        rawOutput.includes(expected),
        `Claude ${liveVersion} inline live development turn returned ${JSON.stringify(rawOutput)} instead of ${expected}.`,
      );
      assertProof(
        settingsAndPluginsUnchanged,
        `The real Claude settings or installed-plugin tree changed during the ${liveVersion} inline turn.`,
      );
      unchangedTurns.push(settingsAndPluginsUnchanged);
      toolOutputs.push(rawOutput);
    },
  );
  assertProof(
    unchangedTurns.length === 2 && unchangedTurns.every(Boolean),
    'The real Claude settings or installed-plugin tree changed during an inline live development turn.',
  );
  assertProof(scenario.hostBinaryVersion !== 'not-required', 'Claude live session recorded no binary version.');
  const [v1Output, v2Output] = toolOutputs;
  assertProof(
    v1Output !== undefined && v1Output.includes('v1:claude-session')
      && v2Output !== undefined && v2Output.includes('v2:claude-session'),
    'Claude live session did not observe both development epochs.',
  );
  return Object.freeze({
    attempts: 2,
    host: 'claude',
    hostBinaryVersion: scenario.hostBinaryVersion,
    normalHome: Object.freeze({
      settingsAndPlugins: 'unchanged',
    }),
    reinstalledAfterRebuild: false,
    sessionMode: 'resumed inline installed-tree session',
    status: 'passed',
    toolOutputs: Object.freeze([v1Output, v2Output] as const),
  });
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

interface UninstallResultDocument {
  readonly data?: { readonly outcome?: unknown; readonly policy?: unknown };
  readonly receipt?: { readonly status?: unknown };
  readonly registrations?: readonly { readonly action?: unknown; readonly kind?: unknown }[];
  readonly remnantReceipt?: unknown;
  readonly state?: unknown;
}

interface DiagnosticDocument {
  readonly code?: unknown;
}

/**
 * Host-owned residue an uninstall cannot and must not remove, classified per
 * host from what the real CLIs leave behind (observed 2026-09-03 against
 * Claude Code 2.1.257 and codex-cli 0.147.0 in isolated homes). Anything
 * outside these classes fails the proof: it would mean Agent Bundle left
 * something of its own behind, or the host changed its bookkeeping.
 */
export type HostResidueClass =
  | 'claude-orphaned-cache-copy'
  | 'claude-plugin-registry-files'
  | 'claude-session-bookkeeping'
  | 'claude-settings'
  | 'codex-empty-config'
  | 'codex-empty-directories';

export interface HostUninstallProofReport {
  /** Entries under the Agent Bundle namespace (`agent-bundle/`) or receipts left behind: always empty. */
  readonly agentBundleResidue: readonly string[];
  readonly homeByteIdentical: boolean;
  readonly host: InstallHost;
  /** Classified host-owned residue after uninstall, relative to the host root; empty when byte-identical. */
  readonly hostResidue: readonly HostResidueClass[];
  readonly keepData: 'kept' | 'retained-by-host' | 'unavailable';
  readonly plan: 'no-op';
  readonly proofLevel: string;
  readonly purgeData: 'purged' | 'removed-by-host';
  readonly refusals: {
    readonly foreignOrMismatch: 'AB7007';
    readonly missingReceipt: 'AB7009';
    readonly unconfirmedPurge: 'AB7008';
  };
  readonly registrations: Readonly<Record<string, 'already-absent' | 'removed'>>;
  readonly rerun: 'not-installed';
  readonly status: 'passed';
}

const parseDiagnostics = (stderr: string, context: string): readonly DiagnosticDocument[] => {
  const document = parseJson<unknown>(stderr, context);
  return Array.isArray(document) ? document as readonly DiagnosticDocument[] : fail(`${context} did not return a diagnostics array.`);
};

const expectRefusal = async (
  attempt: Promise<CommandResult>,
  code: string,
  context: string,
): Promise<void> => {
  const result = await attempt;
  assertProof(result.exitCode !== 0, `${context} was not refused.`);
  const diagnostics = parseDiagnostics(result.stderr, context);
  assertProof(diagnostics.some((entry) => entry.code === code), `${context} was refused without ${code}: ${JSON.stringify(diagnostics)}`);
};

const classifyClaudeResidue = (path: string, plugin: string, marketplace: string): HostResidueClass | undefined => {
  if (path === '.claude.json' || path === '.claude.json.lock' || path === 'backups' || path.startsWith('backups/')) {
    return 'claude-session-bookkeeping';
  }
  if (path === 'settings.json') return 'claude-settings';
  if (
    path === 'plugins' || path === 'plugins/installed_plugins.json' || path === 'plugins/known_marketplaces.json' ||
    path === 'plugins/marketplaces' || path === 'plugins/cache' || path === `plugins/cache/${marketplace}` ||
    path === `plugins/cache/${marketplace}/${plugin}`
  ) {
    return 'claude-plugin-registry-files';
  }
  if (path.startsWith(`plugins/cache/${marketplace}/${plugin}/`)) return 'claude-orphaned-cache-copy';
  return undefined;
};

const classifyCodexResidue = (path: string, marketplace: string): HostResidueClass | undefined => {
  if (path === 'config.toml') return 'codex-empty-config';
  if (
    path === '.tmp' || path === '.tmp/marketplaces' || path === 'plugins' || path === 'plugins/cache' ||
    path === `plugins/cache/${marketplace}`
  ) {
    return 'codex-empty-directories';
  }
  return undefined;
};

const agentBundleResidueOf = (added: readonly string[]): readonly string[] =>
  added.filter((path) => path === 'agent-bundle' || path.startsWith('agent-bundle/') || path.endsWith('/.agent-bundle-install.json'));

/**
 * Proves the receipt-owned uninstall against a real host in an isolated home:
 * install → `--plan` (no-op) → uninstall → the host's own inventory no longer
 * names the plugin or its marketplace → rerun is `not-installed`; then the
 * `--keep-data` / `--purge-data` policy, the missing-receipt and mismatch
 * refusals, and finally a snapshot diff of the host root against the state
 * before the first install. Cursor is byte-identical; Claude and Codex leave
 * only classified host-owned bookkeeping.
 */
export const runHostUninstallProof = async (
  fixture: BuiltHostInstallFixture,
  host: 'claude' | 'codex' | 'cursor',
  options: HostInstallProofOptions,
): Promise<HostUninstallProofReport> => {
  const root = await mkdtemp(join(tmpdir(), `agent-bundle-host-uninstall-${host}-`));
  const home = join(root, 'home');
  const config = join(root, 'config');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(config, { recursive: true })]);
  if (host === 'cursor') await mkdir(join(home, '.cursor'), { recursive: true });
  const environment = isolatedEnvironment(options.environment, {
    ...(host === 'claude' ? { CLAUDE_CONFIG_DIR: config } : {}),
    ...(host === 'codex' ? { CODEX_HOME: config } : {}),
    HOME: home,
  });
  const hostRoot = host === 'cursor' ? home : config;
  const bundle = fixture.bundles[host];
  const lifecycle = (verb: 'install' | 'uninstall', extra: readonly string[] = []): Promise<CommandResult> =>
    runLifecycleCommand(fixture, verb, host, bundle, { ...options, environment }, extra);
  const uninstall = async (extra: readonly string[] = []): Promise<UninstallResultDocument> => {
    const result = await lifecycle('uninstall', extra);
    assertProof(result.exitCode === 0, `${host} uninstall ${extra.join(' ')} failed: ${commandDetail(result)}`);
    return parseJson<UninstallResultDocument>(result.stdout, `${host} uninstall`);
  };
  const install = async (): Promise<void> => {
    const result = await lifecycle('install');
    assertProof(result.exitCode === 0, `${host} install failed: ${commandDetail(result)}`);
  };
  const installedRoot = host === 'cursor'
    ? join(home, '.cursor', 'plugins', 'local', plugin)
    : join(config, 'plugins', 'cache', marketplace, plugin, version);
  const receiptPath = host === 'cursor'
    ? join(installedRoot, '.agent-bundle-install.json')
    : join(config, 'agent-bundle', 'receipts', `${plugin}.${marketplace}.user.json`);
  const stateDirectory = join(installedRoot, 'state');
  try {
    const untouched = await snapshotTree(hostRoot);
    const homeBefore = await snapshotTree(home);

    // Nothing installed yet: an honest no-op. Claude's and Codex's own read-only `plugin list --json` verbs
    // create their session bookkeeping on first contact, so the baseline for the byte-level comparison is
    // taken after this probe; Cursor needs no host verb and stays exactly as it was.
    assertProof((await uninstall()).state === 'not-installed', `${host} uninstall on a fresh home was not a not-installed no-op.`);
    const before = await snapshotTree(hostRoot);
    if (host === 'cursor') {
      assertProof(treesIdentical(untouched, before), 'Cursor uninstall on a fresh home changed the host root.');
    } else {
      for (const path of diffTreeSnapshots(untouched, before).added) {
        const classified = host === 'claude' ? classifyClaudeResidue(path, plugin, marketplace) : classifyCodexResidue(path, marketplace);
        assertProof(classified !== undefined, `${host} read-only inventory probe created an unclassified entry: ${path}`);
      }
    }

    await install();
    await access(receiptPath).catch(() => fail(`${host} install wrote no receipt at ${receiptPath}.`));
    const afterInstall = await snapshotTree(hostRoot);

    // --plan names the exact paths and registrations and writes nothing.
    const plan = await uninstall(['--plan']);
    assertProof(plan.state === 'planned', `${host} uninstall --plan did not report planned.`);
    assertProof(plan.receipt?.status === 'consumed', `${host} uninstall --plan did not find the receipt: ${JSON.stringify(plan.receipt)}`);
    assertProof(treesIdentical(afterInstall, await snapshotTree(hostRoot)), `${host} uninstall --plan changed the host root.`);

    // --purge-data without confirmation is refused before anything changes.
    await expectRefusal(lifecycle('uninstall', ['--purge-data']), 'AB7008', `${host} uninstall --purge-data without --confirm-purge`);
    assertProof(treesIdentical(afterInstall, await snapshotTree(hostRoot)), `${host} refused purge still changed the host root.`);

    const uninstalled = await uninstall();
    assertProof(uninstalled.state === 'uninstalled', `${host} uninstall did not report uninstalled: ${JSON.stringify(uninstalled)}`);
    const registrations: Record<string, 'already-absent' | 'removed'> = {};
    for (const registration of uninstalled.registrations ?? []) {
      assertProof(
        (registration.action === 'removed' || registration.action === 'already-absent') && typeof registration.kind === 'string',
        `${host} uninstall reported an unexpected registration action: ${JSON.stringify(registration)}`,
      );
      registrations[registration.kind] = registration.action;
    }
    await access(receiptPath).then(
      () => fail(`${host} uninstall left the receipt at ${receiptPath}.`),
      () => undefined,
    );
    if (host === 'claude') {
      const listed = await run('claude', ['plugin', 'list', '--json'], { cwd: bundle, environment });
      assertProof(listed.exitCode === 0, `Claude plugin list failed after uninstall: ${commandDetail(listed)}`);
      const rows = parseJson<readonly ClaudePluginRow[]>(listed.stdout, 'Claude plugin list');
      assertProof(!rows.some((row) => row.id === `${plugin}@${marketplace}`), 'Claude still lists the plugin after uninstall.');
      const marketplaces = await run('claude', ['plugin', 'marketplace', 'list', '--json'], { cwd: bundle, environment });
      assertProof(!marketplaces.stdout.includes(marketplace), 'Claude still lists the marketplace after uninstall.');
    } else if (host === 'codex') {
      const listed = await run('codex', ['plugin', 'list', '--json'], { cwd: bundle, environment });
      assertProof(listed.exitCode === 0, `Codex plugin list failed after uninstall: ${commandDetail(listed)}`);
      assertProof(!listed.stdout.includes(`${plugin}@${marketplace}`), 'Codex still lists the plugin after uninstall.');
      const marketplaces = await run('codex', ['plugin', 'marketplace', 'list', '--json'], { cwd: bundle, environment });
      assertProof(!marketplaces.stdout.includes(marketplace), 'Codex still lists the marketplace after uninstall.');
    } else {
      await access(installedRoot).then(
        () => fail('Cursor uninstall left the local plugin directory behind.'),
        () => undefined,
      );
    }
    assertProof((await uninstall()).state === 'not-installed', `${host} uninstall rerun was not a not-installed no-op.`);

    // The host root after uninstall against the host root before install. Nothing that existed before may be
    // removed; every added or rewritten entry must be classified host-owned bookkeeping (Claude rewrites its
    // registries and settings in place), and none of it may be Agent Bundle's.
    const afterUninstall = await snapshotTree(hostRoot);
    const difference = diffTreeSnapshots(before, afterUninstall);
    assertProof(difference.removed.length === 0, `${host} uninstall removed pre-existing entries: ${JSON.stringify(difference)}`);
    const agentBundleResidue = agentBundleResidueOf([...difference.added, ...difference.changed]);
    assertProof(agentBundleResidue.length === 0, `${host} uninstall left Agent Bundle-owned entries behind: ${agentBundleResidue.join(', ')}`);
    const residueClasses = new Set<HostResidueClass>();
    for (const path of [...difference.added, ...difference.changed]) {
      const classified = host === 'claude'
        ? classifyClaudeResidue(path, plugin, marketplace)
        : host === 'codex'
          ? classifyCodexResidue(path, marketplace)
          : undefined;
      assertProof(classified !== undefined, `${host} uninstall left an unclassified entry behind: ${path}`);
      residueClasses.add(classified);
    }
    if (host === 'claude') {
      await access(join(installedRoot, '.orphaned_at')).catch(() =>
        fail('Claude did not mark its retained cache copy as orphaned (.orphaned_at); the residue is not the documented grace-period copy.'));
      const registry = await readJson(join(config, 'plugins', 'installed_plugins.json'), 'Claude installed_plugins.json');
      assertProof(!JSON.stringify(registry).includes(plugin), 'Claude installed_plugins.json still names the plugin.');
      const settings = await readJson(join(config, 'settings.json'), 'Claude settings.json');
      assertProof(!JSON.stringify(settings).includes(`${plugin}@${marketplace}`), 'Claude settings.json still enables the plugin.');
    }
    if (host === 'codex') {
      const configToml = await readText(join(config, 'config.toml'), 'Codex config.toml');
      assertProof(!configToml.includes(plugin) && !configToml.includes(marketplace), 'Codex config.toml still names the plugin or marketplace.');
    }
    // HOME itself (distinct from the host config root for Claude and Codex) is untouched in every case.
    assertProof(treesIdentical(homeBefore, await snapshotTree(home)) || host === 'cursor', `${host} uninstall changed HOME outside the host root.`);
    const homeByteIdentical = treesIdentical(before, afterUninstall);
    assertProof(host !== 'cursor' || homeByteIdentical, `Cursor uninstall did not leave the home byte-identical: ${JSON.stringify(difference)}`);

    // Data policy: --keep-data preserves durable state (or says honestly why it cannot), a confirmed purge removes it.
    await install();
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, 'plugin.sqlite'), 'durable\n');
    const kept = await uninstall(['--keep-data']);
    const keepOutcome = kept.data?.outcome;
    assertProof(
      keepOutcome === 'kept' || keepOutcome === 'retained-by-host' || keepOutcome === 'unavailable',
      `${host} --keep-data reported an unexpected outcome: ${JSON.stringify(kept.data)}`,
    );
    if (keepOutcome !== 'unavailable') {
      await access(join(stateDirectory, 'plugin.sqlite')).catch(() => fail(`${host} --keep-data did not preserve state/plugin.sqlite.`));
    }
    if (host === 'cursor') {
      assertProof(kept.remnantReceipt === receiptPath, 'Cursor --keep-data wrote no remnant receipt beside the preserved state.');
    }
    await install();
    if (host !== 'cursor') {
      // Codex deletes the cache on remove and Claude's reinstall rewrites the cached copy from the bundle, so
      // the host itself discarded the marker; recreate it so the purge run has state to report on.
      await mkdir(stateDirectory, { recursive: true });
      await writeFile(join(stateDirectory, 'plugin.sqlite'), 'durable\n');
    }
    const purged = await uninstall(['--purge-data', '--confirm-purge']);
    const purgeOutcome = purged.data?.outcome;
    assertProof(purgeOutcome === 'purged' || purgeOutcome === 'removed-by-host', `${host} --purge-data reported an unexpected outcome: ${JSON.stringify(purged.data)}`);
    await access(stateDirectory).then(
      () => fail(`${host} --purge-data --confirm-purge left state/ behind.`),
      () => undefined,
    );
    if (host === 'cursor') {
      assertProof(treesIdentical(before, await snapshotTree(hostRoot)), 'Cursor keep→reinstall→purge cycle did not restore the home byte-identically.');
    }

    // Refusals: a missing receipt (AB7009) and a mismatch between the installed copy and the receipt (AB7007).
    await install();
    await rm(receiptPath);
    await expectRefusal(lifecycle('uninstall'), 'AB7009', `${host} uninstall without a receipt`);
    // A receipt-less Cursor copy is the pre-receipt legacy layout (`forced-legacy`); a host-CLI install with no
    // store receipt is `forced-missing`. Both need --force and both remove only what the receipt (or, for the
    // legacy layout, the inventory) proves is this plugin's.
    const forced = await uninstall(['--force']);
    assertProof(
      forced.state === 'uninstalled' && (forced.receipt?.status === 'forced-missing' || forced.receipt?.status === 'forced-legacy'),
      `${host} uninstall --force did not proceed: ${JSON.stringify(forced)}`,
    );
    await install();
    await writeFile(join(installedRoot, 'INSTALL.md'), '# tampered\n');
    await expectRefusal(lifecycle('uninstall'), 'AB7007', `${host} uninstall of a modified copy`);
    const forcedMismatch = await uninstall(['--force']);
    assertProof(forcedMismatch.state === 'uninstalled' && forcedMismatch.receipt?.status === 'forced-mismatch', `${host} uninstall --force after a mismatch did not proceed: ${JSON.stringify(forcedMismatch)}`);

    return Object.freeze({
      agentBundleResidue: Object.freeze(agentBundleResidue),
      homeByteIdentical,
      host,
      hostResidue: Object.freeze([...residueClasses].sort()),
      keepData: keepOutcome,
      plan: 'no-op',
      proofLevel,
      purgeData: purgeOutcome,
      refusals: Object.freeze({ foreignOrMismatch: 'AB7007', missingReceipt: 'AB7009', unconfirmedPurge: 'AB7008' }),
      registrations: Object.freeze(registrations),
      rerun: 'not-installed',
      status: 'passed',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

export interface PortableUninstallProofReport {
  readonly homeByteIdentical: true;
  readonly host: 'cursor';
  readonly installer: 'emitted install.mjs --uninstall';
  readonly keepData: 'kept';
  readonly plan: 'no-op';
  readonly proofLevel: string;
  readonly purgeData: 'purged';
  readonly refusals: { readonly foreign: 'refused'; readonly missingReceipt: 'refused'; readonly unconfirmedPurge: 'refused' };
  readonly rerun: 'not-installed';
  readonly status: 'passed';
}

/** The emitted standalone installer's `--uninstall` against an isolated Cursor home for the Agent Plugins pack. */
export const runPortableUninstallProof = async (
  fixture: BuiltPortableHostInstallFixture,
  options: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): Promise<PortableUninstallProofReport> => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bundle-host-uninstall-portable-'));
  try {
    await mkdir(join(home, '.cursor'), { recursive: true });
    const environment = isolatedEnvironment(options.environment, { HOME: home });
    const installer = join(fixture.portableBundle, 'install.mjs');
    const destination = join(home, '.cursor', 'plugins', 'local', portablePlugin);
    const receiptPath = join(destination, '.agent-bundle-install.json');
    const runInstaller = (args: readonly string[]): Promise<CommandResult> =>
      run(process.execPath, [installer, ...args], { cwd: fixture.portableBundle, environment });
    const expectOk = async (args: readonly string[], prefix: string): Promise<string> => {
      const result = await runInstaller(args);
      assertProof(result.exitCode === 0, `Portable installer ${args.join(' ')} failed: ${commandDetail(result)}`);
      assertProof(result.stdout.startsWith(prefix), `Portable installer ${args.join(' ')} did not report "${prefix}": ${JSON.stringify(result.stdout)}`);
      return result.stdout;
    };
    const before = await snapshotTree(home);
    await expectOk(['--uninstall'], `Not installed ${portablePlugin}@${version}`);
    await expectOk([], `Installed ${portablePlugin}@${version}`);
    const afterInstall = await snapshotTree(home);
    const plan = await expectOk(['--uninstall', '--plan'], `Would uninstall ${portablePlugin}@${version}`);
    assertProof(plan.includes(receiptPath), 'Portable --plan did not name the receipt path.');
    assertProof(treesIdentical(afterInstall, await snapshotTree(home)), 'Portable --plan changed the home.');
    const unconfirmed = await runInstaller(['--uninstall', '--purge-data']);
    assertProof(unconfirmed.exitCode === 2 && unconfirmed.stderr.includes('--confirm-purge'), 'Portable --purge-data without confirmation was not refused.');
    await expectOk(['--uninstall'], `Uninstalled ${portablePlugin}@${version}`);
    assertProof(treesIdentical(before, await snapshotTree(home)), `Portable uninstall did not leave the home byte-identical: ${JSON.stringify(diffTreeSnapshots(before, await snapshotTree(home)))}`);
    await expectOk(['--uninstall'], `Not installed ${portablePlugin}@${version}`);

    await expectOk([], `Installed ${portablePlugin}@${version}`);
    await mkdir(join(destination, 'state'));
    await writeFile(join(destination, 'state', 'plugin.sqlite'), 'durable\n');
    const kept = await expectOk(['--uninstall', '--keep-data'], `Uninstalled ${portablePlugin}@${version}`);
    assertProof(kept.includes('Data (keep): kept'), 'Portable --keep-data did not report kept state.');
    await access(join(destination, 'state', 'plugin.sqlite')).catch(() => fail('Portable --keep-data did not preserve state/.'));
    await expectOk([], `Installed ${portablePlugin}@${version}`);
    const purged = await expectOk(['--uninstall', '--purge-data', '--confirm-purge'], `Uninstalled ${portablePlugin}@${version}`);
    assertProof(purged.includes('Data (purge): purged'), 'Portable confirmed purge did not report purged state.');
    assertProof(treesIdentical(before, await snapshotTree(home)), 'Portable keep→reinstall→purge did not restore the home byte-identically.');

    await expectOk([], `Installed ${portablePlugin}@${version}`);
    await rm(receiptPath);
    const missing = await runInstaller(['--uninstall']);
    assertProof(missing.exitCode === 1 && missing.stderr.includes('predates install receipts'), 'Portable uninstall without a receipt was not refused.');
    await expectOk(['--uninstall', '--force'], `Uninstalled ${portablePlugin}@${version}`);
    await rm(join(home, '.cursor', 'plugins'), { force: true, recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'payload.txt'), 'someone else\n');
    const foreign = await runInstaller(['--uninstall', '--force']);
    assertProof(foreign.exitCode === 1 && foreign.stderr.includes('Refusing to uninstall foreign directory'), 'Portable uninstall of a foreign directory was not refused.');
    await access(join(destination, 'payload.txt')).catch(() => fail('Portable refused uninstall still removed the foreign file.'));

    return Object.freeze({
      homeByteIdentical: true,
      host: 'cursor',
      installer: 'emitted install.mjs --uninstall',
      keepData: 'kept',
      plan: 'no-op',
      proofLevel: portableProofLevel,
      purgeData: 'purged',
      refusals: Object.freeze({ foreign: 'refused', missingReceipt: 'refused', unconfirmedPurge: 'refused' }),
      rerun: 'not-installed',
      status: 'passed',
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
};
