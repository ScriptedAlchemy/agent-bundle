import { lstat, readFile, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  freezeDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../core/diagnostics.ts';
import { mapConcurrent } from '../core/async.ts';
import { isErrno } from '../core/errors.ts';
import { exists } from '../core/paths.ts';
import { validateClaudePluginFiles } from '../host-contracts/claude-plugin-validation.ts';
import { validateCodexPluginFiles } from '../host-contracts/codex-plugin-validation.ts';
import {
  validateCursorPluginFiles,
  validateCursorPluginSymlinks,
} from '../host-contracts/cursor-plugin-validation.ts';
import { validatePortablePluginFiles } from '../host-contracts/portable-plugin-validation.ts';
import type {
  BoundedChildProcessRequest,
  BoundedChildProcessResult,
} from '../host-contracts/process.ts';
import { runBoundedChildProcess } from '../host-contracts/process.ts';
import { requestEventRuntimeStatus } from '../events/ipc.ts';
import {
  claudePluginRowErrors,
  parsePublicHostInventory,
  publicHostCacheRoot,
  treeHash,
  type InstallHost,
  type PublicHostInventory,
} from './install.ts';
import {
  compareInstalledTree,
  describeContentComparison,
  treeInventory,
  type InstalledTreeComparison,
  type InstalledTreeOwnership,
  type TreeInventory,
} from './receipt.ts';
import {
  inspectCursorAgentPluginsLaunch,
  type CursorAgentPluginsLaunch,
  type CursorAgentPluginsLaunchInspection,
} from './cursor-agent-plugins-launch.ts';
import {
  type CursorHooksRegistration,
  type CursorStagingGit,
  inspectCursorMarketplaceStaging,
  inspectCursorPluginHooks,
} from './cursor-hooks-registration.ts';
import { cursorMarketplacePluginPath, cursorMarketplaceRoot } from './cursor-marketplace.ts';

export type DoctorHost = InstallHost;
export type DoctorHostProbeStatus = 'available' | 'failed' | 'unavailable';
export type DoctorInventoryStatus = 'known' | 'skipped' | 'unknown';
export type DoctorFindingState =
  | 'conflicted'
  | 'corrupt'
  | 'drifted'
  | 'failed'
  | 'installed'
  | 'interrupted-install'
  | 'live'
  | 'missing'
  | 'registered'
  | 'skipped'
  | 'stale-lock'
  | 'stale-socket'
  | 'unknown'
  | 'unregistered';

export type DoctorCommandTermination = 'output-limit' | 'timed-out';
export type DoctorCommandResult = BoundedChildProcessResult<DoctorCommandTermination>;
export type DoctorCommandRunner = (
  request: BoundedChildProcessRequest,
) => Promise<DoctorCommandResult>;

export interface DoctorOptions {
  readonly commandRunner?: DoctorCommandRunner;
  readonly endpointDirectory?: string;
  /** Process environment consulted for host cache roots (`CODEX_HOME`); defaults to `process.env`. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly from?: string;
  readonly home?: string;
  readonly hosts?: readonly DoctorHost[];
  readonly platform?: NodeJS.Platform;
}

export interface DoctorHostProbe {
  readonly evidence?: 'directory';
  readonly status: DoctorHostProbeStatus;
  readonly version?: string;
}

export interface DoctorFinding {
  /** Git commit of a staged Cursor marketplace repository. */
  readonly commit?: string;
  readonly durableState?: DoctorDurableStateReport;
  readonly entry?: string;
  /**
   * The host's own load errors, verbatim (`claude plugin list --json` `errors`);
   * present only when the host refused to load this plugin, which also sets
   * `state: 'failed'`.
   */
  readonly errors?: readonly string[];
  /** Cursor plugin hook registration proof (`.cursor-plugin/plugin.json` installs only). */
  readonly hooks?: CursorHooksRegistration;
  /** Agent Plugins stdio launch proof for Cursor (root `plugin.json` installs with stdio servers only). */
  readonly launch?: CursorAgentPluginsLaunch;
  readonly marketplace?: string;
  readonly manifest?: string;
  readonly name?: string;
  readonly path?: string;
  readonly runtime?: DoctorRuntimeStatus;
  readonly state: DoctorFindingState;
  readonly version?: string;
}

export type DoctorRuntimeStatus =
  | Readonly<{
    readonly artifactEpoch: string;
    readonly availability: 'available' | 'runtime-restarted' | 'runtime-unavailable';
    readonly instanceId: string;
    readonly pid: number;
    readonly startedAt?: string;
    readonly status: 'available';
  }>
  | Readonly<{ readonly status: 'failed' | 'unavailable' | 'unsupported' }>;

export interface DoctorDurableStateStore {
  /** Main database plus any present `-wal` and `-shm` sidecars. */
  readonly bytes: number;
  readonly file: string;
  readonly mtime: string;
  readonly path: string;
}

export interface DoctorDurableStateReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly directory: string;
  readonly findings: readonly DoctorDurableStateStore[];
  readonly status: 'known' | 'warnings';
  readonly summary: {
    readonly bytes: number;
    readonly stores: number;
  };
}

export interface DoctorInventory {
  readonly findings: readonly DoctorFinding[];
  readonly status: DoctorInventoryStatus;
}

export type DoctorInstallComparisonStatus =
  | 'current'
  | 'foreign'
  | 'load-failed'
  | 'not-installed'
  | 'stale'
  | 'unknown'
  | 'version-mismatch';

/**
 * Installed copy versus the built artifact: `current` (same content),
 * `stale` (same version, different content), `version-mismatch`, `foreign`
 * (a directory at the install path that is not an agent-bundle install of
 * this plugin), `load-failed` (the host lists the copy but refused to load
 * it; `errors` carries its message), `not-installed`, or `unknown` when the
 * host inventory could not be read.
 */
export interface DoctorInstallComparison {
  readonly artifactContentHash: string;
  /** Host load errors for a `load-failed` copy, verbatim from `claude plugin list --json`. */
  readonly errors?: readonly string[];
  readonly installedContentHash?: string;
  readonly installedPath?: string;
  readonly installedVersion?: string;
  /** Who owns the installed copy: an agent-bundle receipt, a legacy pre-receipt layout, a foreign directory, or the host's own cache. */
  readonly ownership?: InstalledTreeOwnership | 'host';
  readonly status: DoctorInstallComparisonStatus;
}

export interface DoctorHostReport {
  readonly bundle?: DoctorFinding & {
    readonly bundleRoot?: string;
    readonly comparison?: DoctorInstallComparison;
    readonly marketplace?: string;
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly host: DoctorHost;
  readonly inventory: DoctorInventory;
  readonly probe: DoctorHostProbe;
}

export interface DoctorEndpointReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly directory: string;
  readonly findings: readonly DoctorFinding[];
  readonly status: 'failed' | 'healthy' | 'skipped' | 'warnings';
  readonly summary: {
    readonly live: number;
    readonly staleLocks: number;
    readonly staleSockets: number;
  };
}

export interface DoctorReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly endpoints: DoctorEndpointReport;
  readonly hosts: readonly DoctorHostReport[];
  readonly summary: {
    readonly errors: number;
    readonly infos: number;
    readonly warnings: number;
  };
}

export const doctorEndpointDirectory = (): string => {
  const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  // Keep this derivation paired with events/ipc.ts; the regression test guards drift.
  return join('/tmp', `agent-bundle-${user}`);
};

interface PluginIdentity {
  readonly bundleRoot: string;
  readonly marketplace?: string;
  readonly name: string;
  readonly version: string;
}

const maximumOutputBytes = 1024 * 1024;

const defaultCommandRunner: DoctorCommandRunner = (request) =>
  runBoundedChildProcess(request, {
    labels: { outputLimit: 'output-limit', timedOut: 'timed-out' },
    maxOutputBytes: maximumOutputBytes,
    timeoutMs: request.args[0] === '--version' ? 5_000 : 15_000,
    windowsHide: true,
  });

const diagnostic = (
  code: `AB73${number}`,
  message: string,
  recovery: string,
  severity: DiagnosticSeverity,
  target?: DoctorHost,
): Diagnostic => Object.freeze({
  code,
  message,
  recovery,
  severity,
  ...(target === undefined ? {} : { target }),
});

const versionFrom = (output: string): string | undefined =>
  /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];

const manifestPath = (host: DoctorHost): string => {
  switch (host) {
    case 'claude':
      return '.claude-plugin/plugin.json';
    case 'codex':
      return '.codex-plugin/plugin.json';
    case 'cursor':
      return '.cursor-plugin/plugin.json';
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown Doctor host ${String(exhaustive)}.`);
    }
  }
};

const marketplacePath = (host: Exclude<DoctorHost, 'cursor'>): string =>
  host === 'claude'
    ? '.claude-plugin/marketplace.json'
    : '.agents/plugins/marketplace.json';

const readRecord = async (path: string, kind: string): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new Error(`Cannot read a valid ${kind} at ${JSON.stringify(path)}.`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${kind} at ${JSON.stringify(path)} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  kind: string,
): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${kind} must declare a nonempty ${key}.`);
  }
  return value;
};

interface DoctorStaticValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
}

type DoctorStaticDiagnosticCode = 'AB7319' | 'AB7320';

const staticValidationDiagnostics = (
  code: DoctorStaticDiagnosticCode,
  host: DoctorHost,
  root: string,
  issues: readonly DoctorStaticValidationIssue[],
): readonly Diagnostic[] => freezeDiagnostics(issues.map((issue) => diagnostic(
  code,
  `Static validation of ${host} bytes at ${JSON.stringify(root)} reported ${issue.code}: ${issue.message}`,
  code === 'AB7319'
    ? `Rebuild the ${host} bundle from valid source bytes, then rerun Doctor.`
    : 'Reinstall the Cursor plugin from a freshly validated bundle, then rerun Doctor.',
  issue.severity,
  host,
)));

const validateBundleFiles = async (
  root: string,
  host: DoctorHost,
): Promise<readonly DoctorStaticValidationIssue[]> => {
  switch (host) {
    case 'claude':
      return validateClaudePluginFiles({ pluginDirectory: root, target: host });
    case 'codex':
      return validateCodexPluginFiles({ pluginDirectory: root, target: host });
    case 'cursor':
      return validateCursorPluginFiles({ pluginDirectory: root, target: host });
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown Doctor host ${String(exhaustive)}.`);
    }
  }
};

export const resolveBundleRoot = async (from: string, host: DoctorHost): Promise<string> => {
  const root = resolve(from);
  const manifest = manifestPath(host);
  if (await exists(join(root, manifest))) return root;
  const targetRoot = join(root, host);
  if (await exists(join(targetRoot, manifest))) return targetRoot;
  throw new Error(
    `No ${host} bundle manifest was found in ${JSON.stringify(root)} or its ` +
    `${JSON.stringify(host)} target directory.`,
  );
};

const readIdentity = async (from: string, host: DoctorHost): Promise<PluginIdentity> => {
  const bundleRoot = await resolveBundleRoot(from, host);
  const kind = `${host} plugin manifest`;
  const pluginDocument = await readRecord(join(bundleRoot, manifestPath(host)), kind);
  const name = readString(pluginDocument, 'name', kind);
  const version = readString(pluginDocument, 'version', kind);
  if (
    host === 'cursor' &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(name) || name.length > 64)
  ) {
    throw new Error(`Cursor plugin name ${JSON.stringify(name)} is not a safe local plugin name.`);
  }
  if (host === 'cursor') return Object.freeze({ bundleRoot, name, version });
  const marketplaceKind = `${host} marketplace`;
  const marketplace = await readRecord(join(bundleRoot, marketplacePath(host)), marketplaceKind);
  return Object.freeze({
    bundleRoot,
    marketplace: readString(marketplace, 'name', marketplaceKind),
    name,
    version,
  });
};

const freezeFinding = (finding: DoctorFinding): DoctorFinding =>
  Object.freeze({ ...finding });

const freezeInventory = (
  status: DoctorInventoryStatus,
  findings: readonly DoctorFinding[] = [],
): DoctorInventory => Object.freeze({
  findings: Object.freeze(findings.map(freezeFinding)),
  status,
});

const durableStateReport = (
  directory: string,
  findings: readonly DoctorDurableStateStore[],
  diagnostics: readonly Diagnostic[],
): DoctorDurableStateReport => {
  const frozenDiagnostics = freezeDiagnostics(diagnostics);
  return Object.freeze({
    diagnostics: frozenDiagnostics,
    directory,
    findings: Object.freeze(findings.map((finding) => Object.freeze({ ...finding }))),
    status: frozenDiagnostics.length === 0 ? 'known' : 'warnings',
    summary: Object.freeze({
      bytes: findings.reduce((total, finding) => total + finding.bytes, 0),
      stores: findings.length,
    }),
  });
};

const inspectDurableState = async (
  pluginRoot: string,
  target?: DoctorHost,
): Promise<DoctorDurableStateReport | undefined> => {
  const directory = join(pluginRoot, 'state');
  let entries: readonly string[];
  try {
    entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    const diagnostics = [diagnostic(
      'AB7316',
      `Durable state directory ${JSON.stringify(directory)} could not be read.`,
      'Repair directory permissions and rerun `agent-bundle doctor`; Doctor never opens or repairs state databases.',
      'warning',
      target,
    )];
    return durableStateReport(directory, [], diagnostics);
  }

  const diagnostics: Diagnostic[] = [];
  const findings: DoctorDurableStateStore[] = [];
  for (const file of entries.filter((entry) => entry.endsWith('.sqlite'))) {
    const path = join(directory, file);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) continue;
      let bytes = metadata.size;
      for (const suffix of ['-wal', '-shm'] as const) {
        try {
          const sidecar = await lstat(`${path}${suffix}`);
          if (sidecar.isFile()) bytes += sidecar.size;
        } catch (error) {
          if (isErrno(error, 'ENOENT')) continue;
          throw error;
        }
      }
      findings.push({
        bytes,
        file,
        mtime: metadata.mtime.toISOString(),
        path,
      });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      diagnostics.push(diagnostic(
        'AB7316',
        `Durable state store ${JSON.stringify(path)} could not be inspected.`,
        'Repair file permissions and rerun `agent-bundle doctor`; Doctor never opens or repairs state databases.',
        'warning',
        target,
      ));
    }
  }
  return durableStateReport(directory, findings, diagnostics);
};

const probeBinary = async (
  host: Exclude<DoctorHost, 'cursor'>,
  cwd: string,
  run: DoctorCommandRunner,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly probe: DoctorHostProbe }> => {
  let result: DoctorCommandResult;
  try {
    result = await run(Object.freeze({
      args: Object.freeze(['--version']),
      cwd,
      executable: host,
    }));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7300',
          `The ${host} CLI is not installed or is not on PATH; host CLI checks were skipped.`,
          `Install ${host} and ensure \`${host}\` is on PATH, then rerun \`agent-bundle doctor\`.`,
          'info',
          host,
        )]),
        probe: Object.freeze({ status: 'unavailable' }),
      };
    }
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7301',
        `The ${host} CLI version probe could not be started.`,
        `Verify \`${host} --version\` starts successfully, then rerun \`agent-bundle doctor\`.`,
        'error',
        host,
      )]),
      probe: Object.freeze({ status: 'failed' }),
    };
  }
  if (result.exitCode !== 0 || result.termination !== undefined) {
    const reason = result.termination === 'timed-out'
      ? 'timed out'
      : result.termination === 'output-limit'
        ? 'exceeded its output limit'
        : `exited with code ${result.exitCode ?? 'unknown'}`;
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7301',
        `The ${host} CLI version probe ${reason}.`,
        `Verify \`${host} --version\` completes successfully, then rerun \`agent-bundle doctor\`.`,
        'error',
        host,
      )]),
      probe: Object.freeze({ status: 'failed' }),
    };
  }
  const version = versionFrom(`${result.stdout}\n${result.stderr}`);
  return {
    diagnostics: Object.freeze([]),
    probe: Object.freeze({
      status: 'available',
      ...(version === undefined ? {} : { version }),
    }),
  };
};

const probeCursor = async (
  home: string,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly probe: DoctorHostProbe }> => {
  const cursorRoot = join(home, '.cursor');
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(cursorRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7300',
          `Cursor is not installed in ${JSON.stringify(cursorRoot)}; Cursor checks were skipped.`,
          'Install Cursor for this home directory, then rerun `agent-bundle doctor`.',
          'info',
          'cursor',
        )]),
        probe: Object.freeze({ status: 'unavailable' }),
      };
    }
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7302',
        `Cursor home ${JSON.stringify(cursorRoot)} could not be inspected.`,
        'Repair permissions for the Cursor home directory, then rerun `agent-bundle doctor`.',
        'error',
        'cursor',
      )]),
      probe: Object.freeze({ status: 'failed' }),
    };
  }
  if (!metadata.isDirectory()) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7302',
        `Cursor home ${JSON.stringify(cursorRoot)} is not a directory.`,
        'Move the conflicting entry and restore the Cursor home directory, then rerun Doctor.',
        'error',
        'cursor',
      )]),
      probe: Object.freeze({ status: 'failed' }),
    };
  }
  return {
    diagnostics: Object.freeze([]),
    probe: Object.freeze({ evidence: 'directory', status: 'available' }),
  };
};

const cursorManifestCandidates = Object.freeze([
  '.cursor-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'plugin.json',
]);

/**
 * Static byte lane per pinned loader manifest flavor: the Cursor-native
 * flavor gets Cursor's pinned document contract, a root `plugin.json` that
 * declares an Agent Plugins `$schema` (Cursor loads that format natively,
 * #306 dogfood) gets the pinned Agent Plugins 1.0.0 contract, and every
 * flavor gets Cursor local-root symlink containment.
 */
const installedCursorStaticIssues = async (
  installed: InstalledCursorManifest,
  path: string,
  installRoot: string,
  launch: CursorAgentPluginsLaunchInspection | undefined,
): Promise<readonly DoctorStaticValidationIssue[]> => {
  if (installed.manifest === cursorManifestCandidates[0]) {
    return validateCursorPluginFiles({ containmentRoot: installRoot, pluginDirectory: path, target: 'cursor' });
  }
  const symlinks = validateCursorPluginSymlinks({
    containmentRoot: installRoot,
    pluginDirectory: path,
    target: 'cursor',
  });
  if (!isAgentPluginsManifest(installed)) return symlinks;
  // The Cursor copy of an expanded package is conformant only as the bundle shipped it (AB7325 proves the expansion).
  const documents = launch?.documents;
  const [portable, containment] = await Promise.all([
    validatePortablePluginFiles({
      ...(documents === undefined ? {} : { documents }),
      pluginDirectory: path,
      target: 'portable',
    }),
    symlinks,
  ]);
  return Object.freeze([...portable, ...containment]);
};

interface InstalledCursorManifest {
  readonly manifest: string;
  readonly name: string;
  /** Declared `$schema`, when the manifest carries one (Agent Plugins manifests always do). */
  readonly schema?: string;
  readonly version?: string;
}

const agentPluginsSchemaPrefix = 'https://agent-plugins.org/schemas/';

/** A root `plugin.json` that declares an Agent Plugins schema identifier is an Agent Plugins package. */
const isAgentPluginsManifest = (installed: InstalledCursorManifest): boolean =>
  installed.manifest === cursorManifestCandidates[2] &&
  installed.schema !== undefined &&
  installed.schema.startsWith(agentPluginsSchemaPrefix);

const readInstalledManifest = async (
  root: string,
): Promise<InstalledCursorManifest | undefined> => {
  for (const manifest of cursorManifestCandidates) {
    try {
      const value = JSON.parse(await readFile(join(root, manifest), 'utf8')) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as { readonly $schema?: unknown; readonly name?: unknown; readonly version?: unknown };
      if (typeof record.name !== 'string') continue;
      if (record.version !== undefined && typeof record.version !== 'string') continue;
      return Object.freeze({
        manifest,
        name: record.name,
        ...(typeof record.$schema === 'string' ? { schema: record.$schema } : {}),
        ...(typeof record.version === 'string' ? { version: record.version } : {}),
      });
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
};

/**
 * Read-only git verification for staged marketplaces through the Doctor command runner;
 * `undefined` when git is not installed so the inspection degrades to ref-text checks.
 */
const stagingGit = (run: DoctorCommandRunner): CursorStagingGit => async (args, cwd) => {
  try {
    const result = await run(Object.freeze({ args: Object.freeze([...args]), cwd, executable: 'git' }));
    return { exitCode: result.termination === undefined ? result.exitCode : null, stdout: result.stdout };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
};

const cursorInventory = async (
  home: string,
  available: boolean,
  git: CursorStagingGit,
  platform: NodeJS.Platform,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly inventory: DoctorInventory }> => {
  if (!available) return { diagnostics: Object.freeze([]), inventory: freezeInventory('skipped') };
  const installRoot = join(home, '.cursor', 'plugins', 'local');
  let entries: readonly string[];
  try {
    entries = (await readdir(installRoot)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      entries = Object.freeze([]);
    } else {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7304',
          `Cursor local plugins at ${JSON.stringify(installRoot)} could not be read.`,
          'Repair permissions for the Cursor local plugin directory or reinstall the affected plugin.',
          'error',
          'cursor',
        )]),
        inventory: freezeInventory('unknown'),
      };
    }
  }
  const findings: DoctorFinding[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    const path = join(installRoot, entry);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      diagnostics.push(diagnostic(
        'AB7304',
        `Cursor plugin entry ${JSON.stringify(path)} could not be inspected.`,
        'Repair permissions or reinstall with `install.mjs` or `agent-bundle install cursor`.',
        'error',
        'cursor',
      ));
      findings.push({ entry, path, state: 'corrupt' });
      continue;
    }
    if (metadata.isSymbolicLink()) {
      findings.push({ entry, path, state: 'corrupt' });
      diagnostics.push(diagnostic(
        'AB7304',
        `Cursor plugin entry ${JSON.stringify(path)} is a symbolic link.`,
        'Reinstall the plugin with `install.mjs` or `agent-bundle install cursor`.',
        'error',
        'cursor',
      ));
      continue;
    }
    if (/^\..+\.stage-.+/u.test(entry)) {
      findings.push({ entry, path, state: 'interrupted-install' });
      diagnostics.push(diagnostic(
        'AB7305',
        `Cursor plugin staging directory ${JSON.stringify(path)} was left by an interrupted install.`,
        'After verifying no installer is running, remove the staged directory manually.',
        'warning',
        'cursor',
      ));
      continue;
    }
    if (!metadata.isDirectory()) {
      findings.push({ entry, path, state: 'corrupt' });
      diagnostics.push(diagnostic(
        'AB7304',
        `Cursor plugin entry ${JSON.stringify(path)} is not a directory.`,
        'Remove the invalid entry and reinstall with `install.mjs` or `agent-bundle install cursor`.',
        'error',
        'cursor',
      ));
      continue;
    }
    let manifest;
    try {
      manifest = await readInstalledManifest(path);
    } catch {
      manifest = undefined;
    }
    if (manifest === undefined) {
      findings.push({ entry, path, state: 'corrupt' });
      diagnostics.push(diagnostic(
        'AB7304',
        `Cursor plugin entry ${JSON.stringify(path)} has no valid loader manifest.`,
        'Reinstall the plugin with `install.mjs` or `agent-bundle install cursor`.',
        'error',
        'cursor',
      ));
      continue;
    }
    const launch = isAgentPluginsManifest(manifest)
      ? await inspectCursorAgentPluginsLaunch(path, { caseInsensitivePaths: platform === 'win32' })
      : undefined;
    const staticIssues = await installedCursorStaticIssues(manifest, path, installRoot, launch);
    const staticDiagnostics = staticValidationDiagnostics(
      'AB7320',
      'cursor',
      path,
      staticIssues,
    );
    if (isAgentPluginsManifest(manifest)) {
      diagnostics.push(diagnostic(
        'AB7320',
        `Cursor plugin entry ${JSON.stringify(path)} is a root plugin.json declaring ${JSON.stringify(manifest.schema)}, ` +
          'which Cursor loads as an Agent Plugins package; Doctor validated it against the pinned Agent Plugins 1.0.0 contract' +
          (launch?.documents === undefined ? '.' : ' using the pre-expansion mcp.json its install receipt recorded.'),
        'Rebuild the portable bundle from valid source bytes if the Agent Plugins contract reports errors.',
        'info',
        'cursor',
      ));
    } else if (manifest.manifest !== cursorManifestCandidates[0]) {
      diagnostics.push(diagnostic(
        'AB7320',
        `Cursor plugin entry ${JSON.stringify(path)} uses loader manifest flavor ` +
          `${JSON.stringify(manifest.manifest)}; no Cursor-side pinned static document contract exists for that flavor.`,
        'Use that manifest flavor\'s ecosystem validator when static document proof is required; ' +
          'Doctor still checked Cursor local-root symlink containment.',
        'info',
        'cursor',
      ));
    }
    diagnostics.push(...staticDiagnostics);
    if (launch !== undefined) diagnostics.push(...launch.diagnostics);
    const durableState = await inspectDurableState(path, 'cursor');
    if (durableState !== undefined) diagnostics.push(...durableState.diagnostics);
    const hooks = manifest.manifest === cursorManifestCandidates[0]
      ? await inspectCursorPluginHooks(path, home, { caseInsensitivePaths: platform === 'win32' })
      : undefined;
    if (hooks !== undefined) diagnostics.push(...hooks.diagnostics);
    findings.push({
      ...(durableState === undefined ? {} : { durableState }),
      entry,
      ...(hooks === undefined ? {} : { hooks: hooks.registration }),
      ...(launch?.launch === undefined ? {} : { launch: launch.launch }),
      manifest: manifest.manifest,
      name: manifest.name,
      path,
      // A drifted expansion means Cursor spawns paths that no longer exist: the install is corrupt, not merely stale.
      state: staticDiagnostics.some((entry) => entry.severity === 'error') || launch?.launch?.state === 'drifted'
        ? 'corrupt'
        : 'installed',
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
    });
  }
  const staging = await inspectCursorMarketplaceStaging(home, git);
  diagnostics.push(...staging.diagnostics);
  for (const staged of staging.findings) {
    findings.push({
      ...(staged.commit === undefined ? {} : { commit: staged.commit }),
      entry: staged.entry,
      manifest: '.cursor-plugin/marketplace.json',
      ...(staged.marketplace === undefined ? {} : { marketplace: staged.marketplace }),
      name: staged.name,
      path: staged.path,
      state: staged.state,
      ...(staged.version === undefined ? {} : { version: staged.version }),
    });
  }
  return {
    diagnostics: freezeDiagnostics(diagnostics),
    inventory: freezeInventory('known', findings),
  };
};

/** One `<host> plugin list --json` run: usable JSON text, or the reason it was not. */
type PublicHostListing =
  | { readonly status: 'available'; readonly stdout: string }
  | { readonly detail: string; readonly status: 'unavailable' };

const readPublicHostListing = async (
  host: Exclude<DoctorHost, 'cursor'>,
  run: DoctorCommandRunner,
  cwd: string,
): Promise<PublicHostListing> => {
  let result: DoctorCommandResult;
  try {
    result = await run(Object.freeze({
      args: Object.freeze(['plugin', 'list', '--json']),
      cwd,
      executable: host,
    }));
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), status: 'unavailable' };
  }
  if (result.exitCode !== 0 || result.termination !== undefined) {
    return {
      detail: result.termination ?? (result.stderr.trim() || `exit code ${result.exitCode ?? 'unknown'}`),
      status: 'unavailable',
    };
  }
  return { status: 'available', stdout: result.stdout };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The host's installed-plugin inventory from its pinned `plugin list --json`
 * verb (Claude rows carry `id`/`version`/`scope`/`installPath`; Codex rows
 * carry `pluginId`/`version` and the pinned cache layout supplies the path).
 * An unusable listing is reported honestly as unknown (`AB7303`).
 */
const publicHostInventory = (
  host: Exclude<DoctorHost, 'cursor'>,
  listing: PublicHostListing,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): { readonly diagnostics: readonly Diagnostic[]; readonly inventory: DoctorInventory } => {
  const unknown = (detail: string) => ({
    diagnostics: freezeDiagnostics([diagnostic(
      'AB7303',
      `${host} inventory is unknown: \`${host} plugin list --json\` was unusable (${detail}).`,
      host === 'claude'
        ? 'Use `claude plugin list --json` or `claude plugin details <name>` to inspect installed plugins.'
        : 'Use `codex plugin list --json` to inspect installed plugins.',
      'info',
      host,
    )]),
    inventory: freezeInventory('unknown'),
  });
  if (listing.status === 'unavailable') return unknown(listing.detail);
  let document: unknown;
  try {
    document = JSON.parse(listing.stdout) as unknown;
  } catch {
    return unknown('not JSON');
  }
  const findings: DoctorFinding[] = [];
  if (host === 'claude') {
    if (!Array.isArray(document)) return unknown('not an array');
    for (const row of document) {
      if (
        !isRecord(row) ||
        typeof row['id'] !== 'string' ||
        typeof row['installPath'] !== 'string' ||
        typeof row['scope'] !== 'string' ||
        typeof row['version'] !== 'string'
      ) {
        return unknown('a row lacks id, installPath, scope, or version');
      }
      // A row with `errors` is installed but refused by Claude Code (no hooks, MCP servers, or skills
      // reach the session); the inventory says so instead of listing it as a healthy install.
      const errors = claudePluginRowErrors(row);
      findings.push({
        entry: `${row['id']} (${row['scope']})`,
        ...(errors.length === 0 ? {} : { errors }),
        name: row['id'].slice(0, row['id'].indexOf('@') === -1 ? undefined : row['id'].indexOf('@')),
        path: row['installPath'],
        state: errors.length === 0 ? 'installed' : 'failed',
        version: row['version'],
      });
    }
  } else {
    if (!isRecord(document) || !Array.isArray(document['installed'])) return unknown('no installed array');
    for (const row of document['installed']) {
      if (!isRecord(row) || typeof row['pluginId'] !== 'string' || typeof row['version'] !== 'string') {
        return unknown('a row lacks pluginId or version');
      }
      if (row['installed'] === false) continue;
      const separator = row['pluginId'].indexOf('@');
      const name = separator === -1 ? row['pluginId'] : row['pluginId'].slice(0, separator);
      const marketplace = separator === -1 ? '' : row['pluginId'].slice(separator + 1);
      findings.push({
        entry: row['pluginId'],
        name,
        path: join(publicHostCacheRoot(host, environment, home), marketplace, name, row['version']),
        state: 'installed',
        version: row['version'],
      });
    }
  }
  return { diagnostics: Object.freeze([]), inventory: freezeInventory('known', findings) };
};

const malformedBundle = (
  host: DoctorHost,
  error: unknown,
): {
  readonly diagnostics: readonly Diagnostic[];
  readonly finding: DoctorHostReport['bundle'];
} => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    diagnostics: freezeDiagnostics([diagnostic(
      'AB7306',
      message,
      `Rebuild the ${host} artifact with valid host and marketplace manifests, then rerun Doctor.`,
      'error',
      host,
    )]),
    finding: Object.freeze({ state: 'failed' }),
  };
};

const installComparison = (
  comparison: InstalledTreeComparison,
  installedPath: string,
): DoctorInstallComparison => Object.freeze({
  artifactContentHash: comparison.artifactContentHash,
  installedContentHash: comparison.installedContentHash,
  installedPath,
  ...(comparison.installedVersion === undefined ? {} : { installedVersion: comparison.installedVersion }),
  ownership: comparison.ownership,
  status: comparison.status,
});

/**
 * This plugin's copies in the host's inventory, read through the same parser
 * `agent-bundle install` uses before replacing, from the listing Doctor
 * already ran. Doctor looks across scopes, so a Claude row at any scope counts.
 */
const readPublicHostInventory = (
  host: Exclude<DoctorHost, 'cursor'>,
  identity: PluginIdentity,
  listing: PublicHostListing,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): PublicHostInventory => listing.status === 'unavailable'
  ? { detail: listing.detail, status: 'unavailable' }
  : parsePublicHostInventory(host, listing.stdout, {
    cacheRoot: publicHostCacheRoot(host, environment, home),
    marketplace: identity.marketplace ?? '',
    plugin: identity.name,
  });

const publicHostReplaceRecipe = (host: Exclude<DoctorHost, 'cursor'>, scopeArguments = ''): string => host === 'claude'
  ? `Rerun \`agent-bundle install claude --from <bundle-dir>${scopeArguments}\`; same-version content drift is replaced through ` +
    '`claude plugin uninstall --keep-data` + `claude plugin install` because Claude\'s `plugin update` is version-gated.'
  : 'Rerun `agent-bundle install codex --from <bundle-dir>`; same-version content drift is replaced through ' +
    '`codex plugin remove` + `codex plugin add`.';

/**
 * `AB7325`: the host lists the plugin but refused to load it. The message
 * carries the host's own `errors` verbatim (e.g. Claude Code's "Hook load
 * failed: Duplicate hooks file detected ..."), since that text is the only
 * place the refusal surfaces — `plugin install`, `plugin validate --strict`,
 * and `plugin details` all accept a plugin Claude Code then refuses.
 */
const hostLoadFailureDiagnostic = (
  host: Exclude<DoctorHost, 'cursor'>,
  copy: string,
  errors: readonly string[],
  replaceHint = '',
): Diagnostic => diagnostic(
  'AB7325',
  `${host} refused to load ${copy}: ${errors.join(' | ')}`,
  `Fix the artifact so \`${host} plugin list --json\` reports no \`errors\` for it, rebuild, and rerun ` +
    `\`agent-bundle install ${host} --from <bundle-dir>${replaceHint} --replace\`.`,
  'error',
  host,
);

/**
 * Compares the copy a public host CLI caches for this plugin against the
 * built artifact. Unusable inventories degrade to `unknown` (Doctor never
 * guesses a cache path without the host confirming the install).
 */
const publicHostInstallComparison = async (
  host: Exclude<DoctorHost, 'cursor'>,
  identity: PluginIdentity,
  artifact: TreeInventory,
  inventory: PublicHostInventory,
): Promise<{ readonly comparison: DoctorInstallComparison; readonly diagnostics: readonly Diagnostic[] }> => {
  if (inventory.status === 'unavailable') {
    return {
      comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'unknown' }),
      diagnostics: Object.freeze([]),
    };
  }
  if (inventory.entries.length === 0) {
    return {
      comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'not-installed' }),
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7307',
        `${identity.name}@${identity.version} is not installed for ${host}.`,
        `Run \`agent-bundle install ${host} --from <bundle-dir>\`.`,
        'info',
        host,
      )]),
    };
  }
  // Claude may hold one copy per scope; every copy is compared and the worst one is summarised,
  // so a current user-scoped copy never masks a stale project- or local-scoped one.
  const diagnostics: Diagnostic[] = [];
  const comparisons: DoctorInstallComparison[] = [];
  for (const entry of inventory.entries) {
    const scoped = entry.scope === undefined ? '' : ` (scope ${entry.scope})`;
    const replaceHint = entry.scope === undefined ? '' : ` --scope ${entry.scope}`;
    if (entry.errors !== undefined && entry.errors.length > 0) {
      // The host lists the copy but refused to load it: content comparison is moot because none of the
      // plugin reaches a session. Report the host's own message rather than `current`/`stale` (#464).
      comparisons.push(Object.freeze({
        artifactContentHash: artifact.hash,
        errors: entry.errors,
        installedPath: entry.installPath,
        installedVersion: entry.version,
        ownership: 'host',
        status: 'load-failed',
      }));
      diagnostics.push(hostLoadFailureDiagnostic(host, `${identity.name}@${entry.version} at ${entry.installPath}${scoped}`, entry.errors, replaceHint));
      continue;
    }
    let installed: TreeInventory;
    try {
      installed = await treeInventory(entry.installPath);
    } catch (error) {
      comparisons.push(Object.freeze({
        artifactContentHash: artifact.hash,
        installedPath: entry.installPath,
        installedVersion: entry.version,
        ownership: 'host',
        status: 'unknown',
      }));
      diagnostics.push(diagnostic(
        'AB7310',
        `${host} installed copy at ${JSON.stringify(entry.installPath)}${scoped} could not be compared: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        `Reinstall the ${host} plugin with \`agent-bundle install ${host} --from <bundle-dir>${replaceHint} --replace\`.`,
        'error',
        host,
      ));
      continue;
    }
    const status: 'current' | 'stale' | 'version-mismatch' =
      installed.hash === artifact.hash && entry.version === identity.version
        ? 'current'
        : entry.version !== identity.version
          ? 'version-mismatch'
          : 'stale';
    comparisons.push(Object.freeze({
      artifactContentHash: artifact.hash,
      installedContentHash: installed.hash,
      installedPath: entry.installPath,
      installedVersion: entry.version,
      ownership: 'host',
      status,
    }));
    const detail = describeContentComparison(identity.name, identity.version, {
      artifactContentHash: artifact.hash,
      installedContentHash: installed.hash,
      installedName: identity.name,
      installedVersion: entry.version,
      status,
    });
    switch (status) {
      case 'current':
        break;
      case 'stale':
        diagnostics.push(diagnostic(
          'AB7308',
          `${host} plugin ${identity.name}@${identity.version} at ${entry.installPath}${scoped} is stale ` +
            `(same version, different content): ${detail}.`,
          publicHostReplaceRecipe(host, replaceHint),
          'warning',
          host,
        ));
        break;
      case 'version-mismatch':
        diagnostics.push(diagnostic(
          'AB7309',
          `${host} version collision at ${entry.installPath}${scoped}: ${detail}.`,
          `Rerun \`agent-bundle install ${host} --from <bundle-dir>${replaceHint} --replace\` to replace the installed version.`,
          'warning',
          host,
        ));
        break;
      default: {
        const exhaustive: never = status;
        throw new TypeError(`Unknown install comparison ${String(exhaustive)}.`);
      }
    }
  }
  const severity: Record<DoctorInstallComparisonStatus, number> = {
    current: 0,
    'not-installed': 1,
    unknown: 2,
    stale: 3,
    'version-mismatch': 4,
    foreign: 5,
    'load-failed': 6,
  };
  const worst = comparisons.reduce((left, right) => severity[right.status] > severity[left.status] ? right : left);
  return { comparison: worst, diagnostics: freezeDiagnostics(diagnostics) };
};

/**
 * A bundle delivered with `install cursor --mode marketplace` lives in the
 * staged marketplace repository rather than `plugins/local`; report whether
 * Cursor has imported it (matching copy under `plugins/cache`) or the UI step
 * is still pending.
 */
const cursorStagedBundle = async (
  identity: PluginIdentity,
  home: string,
  base: { readonly bundleRoot: string; readonly name: string; readonly path: string; readonly version: string },
  git: CursorStagingGit,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] } | undefined> => {
  const repoRoot = join(cursorMarketplaceRoot(join(home, '.cursor')), identity.name);
  const pluginDirectory = cursorMarketplacePluginPath(repoRoot, identity.name);
  if (!await exists(repoRoot)) return undefined;
  if (!await exists(pluginDirectory)) {
    // The staged repository is present but its plugin copy is gone: surface the staging inventory's
    // corrupt finding (and its repair step) instead of AB7307 "not installed".
    const staging = await inspectCursorMarketplaceStaging(home, git);
    const entry = staging.findings.find((candidate) => candidate.name === identity.name);
    return {
      diagnostics: freezeDiagnostics(staging.diagnostics.filter((candidate) => candidate.message.includes(repoRoot))),
      finding: Object.freeze({
        ...base,
        ...(entry?.marketplace === undefined ? {} : { marketplace: entry.marketplace }),
        path: repoRoot,
        state: 'corrupt',
      }),
    };
  }
  const [sourceHash, stagedHash] = await Promise.all([treeHash(identity.bundleRoot), treeHash(pluginDirectory)]);
  if (sourceHash !== stagedHash) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7308',
        `Staged Cursor marketplace copy of ${identity.name}@${identity.version} at ${repoRoot} differs from the current bundle.`,
        'Remove the staged marketplace directory and rerun `agent-bundle install cursor --mode marketplace`.',
        'warning',
        'cursor',
      )]),
      finding: Object.freeze({ ...base, path: repoRoot, state: 'drifted' }),
    };
  }
  // The staging inspection also proves the working tree equals committed HEAD, so a source-matching but
  // uncommitted tree cannot be reported as imported.
  const staging = await inspectCursorMarketplaceStaging(home, git);
  const entry = staging.findings.find((candidate) => candidate.name === identity.name);
  return {
    diagnostics: freezeDiagnostics(staging.diagnostics.filter((candidate) => candidate.message.includes(repoRoot) || candidate.message.includes(`${identity.name}@`))),
    finding: Object.freeze({
      ...base,
      ...(entry?.commit === undefined ? {} : { commit: entry.commit }),
      ...(entry?.marketplace === undefined ? {} : { marketplace: entry.marketplace }),
      path: repoRoot,
      state: entry === undefined ? 'unregistered' : entry.state,
    }),
  };
};

const cursorBundle = async (
  identity: PluginIdentity,
  home: string,
  git: CursorStagingGit,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] }> => {
  const destination = join(home, '.cursor', 'plugins', 'local', identity.name);
  const base = {
    bundleRoot: identity.bundleRoot,
    name: identity.name,
    path: destination,
    version: identity.version,
  } as const;
  try {
    const artifact = await treeInventory(identity.bundleRoot);
    if (!await exists(destination)) {
      const staged = await cursorStagedBundle(identity, home, base, git);
      if (staged !== undefined) return staged;
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7307',
          `${identity.name}@${identity.version} is not installed for Cursor.`,
          'Run `agent-bundle install cursor --from <bundle-dir>` or the bundle\'s `install.mjs`.',
          'info',
          'cursor',
        )]),
        finding: Object.freeze({
          ...base,
          comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'not-installed' as const }),
          state: 'missing',
        }),
      };
    }
    // A destination without a loader manifest is not corrupt-but-ours: ownership decides (a receipt
    // naming this plugin still owns it; anything else is foreign).
    const installed = await readInstalledManifest(destination);
    const comparison = await compareInstalledTree({
      artifact,
      destination,
      ...(installed === undefined
        ? {}
        : {
          installedManifest: {
            name: installed.name,
            ...(installed.version === undefined ? {} : { version: installed.version }),
          },
        }),
      plugin: identity.name,
      version: identity.version,
    });
    const detail = describeContentComparison(identity.name, identity.version, comparison);
    const withComparison = (state: DoctorFindingState): DoctorHostReport['bundle'] => Object.freeze({
      ...base,
      comparison: installComparison(comparison, destination),
      state,
    });
    switch (comparison.status) {
      case 'current':
        return { diagnostics: Object.freeze([]), finding: withComparison('installed') };
      case 'version-mismatch':
        return {
          diagnostics: freezeDiagnostics([diagnostic(
            'AB7309',
            `Cursor version collision at ${destination}: ${detail}.`,
            'Choose the intended version; `agent-bundle install cursor --replace` (or `install.mjs --replace`) ' +
              'replaces this agent-bundle install, or remove the conflicting copy manually.',
            'warning',
            'cursor',
          )]),
          finding: withComparison('conflicted'),
        };
      case 'foreign':
        return {
          diagnostics: freezeDiagnostics([diagnostic(
            'AB7321',
            `Cursor destination ${destination} is a foreign install: ${detail}; ` +
              `it is not an agent-bundle install of ${identity.name}.`,
            'Remove the foreign directory manually before installing; `--replace` refuses foreign installs.',
            'warning',
            'cursor',
          )]),
          finding: withComparison('conflicted'),
        };
      case 'stale':
        return {
          diagnostics: freezeDiagnostics([diagnostic(
            'AB7308',
            `Cursor plugin ${identity.name}@${identity.version} at ${destination} is stale ` +
              `(same version, different content): ${detail}.`,
            comparison.ownership === 'receipt'
              ? 'Rerun `agent-bundle install cursor --from <bundle-dir>` or `install.mjs`; ' +
                'same-version content drift of a receipt-managed install is replaced automatically.'
              : 'This copy predates install receipts; rerun `agent-bundle install cursor --from <bundle-dir> --replace` ' +
                '(or `install.mjs --replace`) once to adopt it.',
            'warning',
            'cursor',
          )]),
          finding: withComparison('drifted'),
        };
      default: {
        const exhaustive: never = comparison.status;
        throw new TypeError(`Unknown install comparison ${String(exhaustive)}.`);
      }
    }
  } catch (error) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7310',
        `Cursor bundle comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        'Remove unsafe links or repair unreadable entries, then reinstall the Cursor plugin.',
        'error',
        'cursor',
      )]),
      finding: Object.freeze({ ...base, state: 'corrupt' }),
    };
  }
};

const claudeRegistration = async (
  identity: PluginIdentity,
  probe: DoctorHostProbe,
  run: DoctorCommandRunner,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] }> => {
  const base = {
    bundleRoot: identity.bundleRoot,
    marketplace: identity.marketplace,
    name: identity.name,
    version: identity.version,
  } as const;
  if (probe.status !== 'available') {
    return { diagnostics: Object.freeze([]), finding: Object.freeze({ ...base, state: 'skipped' }) };
  }
  let result: DoctorCommandResult;
  try {
    result = await run(Object.freeze({
      args: Object.freeze(['--plugin-dir', identity.bundleRoot, 'plugin', 'list', '--json']),
      cwd: identity.bundleRoot,
      executable: 'claude',
    }));
  } catch {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7312',
        'Claude registration proof could not be started.',
        `Run \`claude --plugin-dir ${identity.bundleRoot} plugin list --json\` and repair the reported issue.`,
        'error',
        'claude',
      )]),
      finding: Object.freeze({ ...base, state: 'failed' }),
    };
  }
  if (result.exitCode !== 0 || result.termination !== undefined) {
    const detail = result.termination ?? result.stderr.trim();
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7312',
        `Claude registration proof failed: ${detail || `exit code ${result.exitCode ?? 'unknown'}`}.`,
        `Run \`claude --plugin-dir ${identity.bundleRoot} plugin list --json\` and repair the reported issue.`,
        'error',
        'claude',
      )]),
      finding: Object.freeze({ ...base, state: 'failed' }),
    };
  }
  let inventory: unknown;
  try {
    inventory = JSON.parse(result.stdout) as unknown;
  } catch {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7312',
        'Claude registration proof returned output that is not valid JSON.',
        `Inspect \`claude --plugin-dir ${identity.bundleRoot} plugin list --json\` and repair the host setup.`,
        'error',
        'claude',
      )]),
      finding: Object.freeze({ ...base, state: 'failed' }),
    };
  }
  // Pinned registration contract: tests/support/packed-native-smoke.ts
  if (!Array.isArray(inventory)) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7312',
        'Claude registration proof returned output that does not match the documented list shape.',
        `Inspect \`claude --plugin-dir ${identity.bundleRoot} plugin list --json\` and repair the host setup.`,
        'error',
        'claude',
      )]),
      finding: Object.freeze({ ...base, state: 'failed' }),
    };
  }
  const row = inventory.find((entry): entry is Record<string, unknown> =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry as { id?: unknown }).id === `${identity.name}@inline`);
  if (row === undefined) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7311',
        `Claude registration proof did not contain plugin ${JSON.stringify(identity.name)}.`,
        `Inspect \`claude --plugin-dir ${identity.bundleRoot} plugin list --json\` and register the intended bundle.`,
        'error',
        'claude',
      )]),
      finding: Object.freeze({ ...base, state: 'unregistered' }),
    };
  }
  // Claude Code lists a plugin it refused to load (the row keeps `enabled: true`) and reports why under
  // `errors`; that is the only surface where e.g. "Duplicate hooks file detected" appears (#464).
  const errors = claudePluginRowErrors(row);
  if (errors.length > 0) {
    return {
      diagnostics: freezeDiagnostics([hostLoadFailureDiagnostic('claude', `${identity.name}@${identity.version} from ${identity.bundleRoot}`, errors)]),
      finding: Object.freeze({ ...base, errors, state: 'failed' }),
    };
  }
  return { diagnostics: Object.freeze([]), finding: Object.freeze({ ...base, state: 'registered' }) };
};

interface PublicHostContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  /** The host's `plugin list --json` run once per Doctor host pass; shared by inventory and comparison. */
  readonly listing: PublicHostListing;
  readonly run: DoctorCommandRunner;
}

/** Claude: inline registration proof plus the installed cache copy compared against the artifact. */
const claudeBundle = async (
  identity: PluginIdentity,
  probe: DoctorHostProbe,
  context: PublicHostContext,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] }> => {
  const registration = await claudeRegistration(identity, probe, context.run);
  if (probe.status !== 'available' || registration.finding === undefined) return registration;
  const artifact = await treeInventory(identity.bundleRoot);
  const inventory = readPublicHostInventory('claude', identity, context.listing, context.environment, context.home);
  const compared = await publicHostInstallComparison('claude', identity, artifact, inventory);
  return {
    diagnostics: freezeDiagnostics([...registration.diagnostics, ...compared.diagnostics]),
    finding: Object.freeze({ ...registration.finding, comparison: compared.comparison }),
  };
};

/**
 * Codex: `codex plugin list --json` (pinned at 0.147.0 and by the real-host
 * install proof) names installed plugins, so the installed cache copy is
 * compared against the artifact; an unusable inventory stays `unknown`.
 */
const codexBundle = async (
  identity: PluginIdentity,
  probe: DoctorHostProbe,
  context: PublicHostContext,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] }> => {
  const base = {
    bundleRoot: identity.bundleRoot,
    marketplace: identity.marketplace,
    name: identity.name,
    version: identity.version,
  } as const;
  if (probe.status !== 'available') {
    return { diagnostics: Object.freeze([]), finding: Object.freeze({ ...base, state: 'skipped' }) };
  }
  const artifact = await treeInventory(identity.bundleRoot);
  const inventory = readPublicHostInventory('codex', identity, context.listing, context.environment, context.home);
  if (inventory.status === 'unavailable') {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7313',
        `Codex bundle registration is unknown because \`codex plugin list --json\` was unusable: ${inventory.detail}.`,
        'Use Codex-owned commands to inspect registration; Doctor does not guess a cache path.',
        'info',
        'codex',
      )]),
      finding: Object.freeze({
        ...base,
        comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'unknown' as const }),
        state: 'unknown',
      }),
    };
  }
  const compared = await publicHostInstallComparison('codex', identity, artifact, inventory);
  return {
    diagnostics: compared.diagnostics,
    finding: Object.freeze({
      ...base,
      comparison: compared.comparison,
      state: inventory.entries.length === 0 ? 'missing' : 'installed',
    }),
  };
};

type EndpointProbe = 'live' | 'missing' | 'stale';

interface EndpointClaimOwner {
  readonly linuxStartTime?: string;
  readonly pid: number;
}

// Keep claim-owner validation paired with events/ipc.ts endpointClaimOwnerSchema.
const parseEndpointClaimOwner = (raw: string): EndpointClaimOwner | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'pid' && key !== 'linuxStartTime') return undefined;
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    return undefined;
  }
  if (record.linuxStartTime !== undefined) {
    if (typeof record.linuxStartTime !== 'string' || !/^\d+$/u.test(record.linuxStartTime)) {
      return undefined;
    }
  }
  return {
    ...(record.linuxStartTime !== undefined ? { linuxStartTime: record.linuxStartTime } : {}),
    pid: record.pid,
  };
};

const linuxProcessStartTime = async (pid: number): Promise<string> => {
  const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const commEnd = processStat.lastIndexOf(')');
  if (commEnd === -1) throw new Error(`Unable to parse process stat for pid ${pid}.`);
  const fieldsAfterComm = processStat.slice(commEnd + 1).trim().split(/\s+/u);
  const startTime = fieldsAfterComm[19];
  if (startTime === undefined) throw new Error(`Process stat for pid ${pid} has no start time.`);
  return startTime;
};

const isEndpointClaimOwnerProvablyDead = async (
  owner: EndpointClaimOwner,
  platform: NodeJS.Platform,
): Promise<boolean> => {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code !== 'EPERM') return false;
  }
  if (platform !== 'linux' || owner.linuxStartTime === undefined) return false;
  try {
    return await linuxProcessStartTime(owner.pid) !== owner.linuxStartTime;
  } catch {
    return false;
  }
};

const probeEndpoint = (path: string): Promise<EndpointProbe> => new Promise((resolvePromise, reject) => {
  const socket = createConnection(path);
  const cleanup = (): void => {
    socket.removeListener('connect', onConnect);
    socket.removeListener('error', onError);
  };
  const finish = (state: EndpointProbe): void => {
    cleanup();
    socket.destroy();
    resolvePromise(state);
  };
  const onConnect = (): void => { finish('live'); };
  const onError = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'ENOENT') {
      finish('missing');
      return;
    }
    if (error.code === 'ECONNREFUSED') {
      finish('stale');
      return;
    }
    cleanup();
    socket.destroy();
    reject(error);
  };
  socket.once('connect', onConnect);
  socket.once('error', onError);
});

/**
 * Endpoints are probed concurrently, this many at a time, so a directory of
 * listeners that accept connections but never answer (the silent-runtime
 * failure Doctor exists to diagnose) costs roughly one status-probe timeout
 * per batch rather than one per endpoint (#324 review).
 */
export const doctorEndpointProbeConcurrency = 8;
const doctorRuntimeStatusTimeoutMs = 1_000;

interface EndpointInspection {
  readonly diagnostics: readonly Diagnostic[];
  readonly finding?: DoctorFinding;
  readonly live: number;
  readonly staleLocks: number;
  readonly staleSockets: number;
}

const quietInspection: EndpointInspection = Object.freeze({
  diagnostics: Object.freeze([]),
  live: 0,
  staleLocks: 0,
  staleSockets: 0,
});

const inspectSocketEndpoint = async (path: string): Promise<EndpointInspection> => {
  try {
    const state = await probeEndpoint(path);
    if (state === 'missing') return quietInspection;
    if (state === 'live') {
      const diagnostics: Diagnostic[] = [];
      let runtime: DoctorRuntimeStatus;
      try {
        const probed = await requestEventRuntimeStatus({ endpoint: path, timeoutMs: doctorRuntimeStatusTimeoutMs });
        runtime = probed;
        if (probed.status === 'unsupported') {
          diagnostics.push(diagnostic(
            'AB7317',
            `Runtime socket ${JSON.stringify(path)} predates read-only runtime identity introspection.`,
            'Restart the runtime after upgrading Agent Bundle to expose its process-lifetime identity.',
            'info',
          ));
        } else if (probed.status === 'unavailable') {
          diagnostics.push(diagnostic(
            'AB7318',
            `Runtime socket ${JSON.stringify(path)} became unavailable during its status probe.`,
            'Restart the runtime or inspect the socket, then rerun Doctor.',
            'error',
          ));
        }
      } catch (error) {
        runtime = Object.freeze({ status: 'failed' });
        diagnostics.push(diagnostic(
          'AB7318',
          `Runtime socket ${JSON.stringify(path)} status probe failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
          'Inspect the runtime protocol and socket responsiveness, then rerun Doctor.',
          'error',
        ));
      }
      return { ...quietInspection, diagnostics, finding: { path, runtime, state: 'live' }, live: 1 };
    }
    return {
      ...quietInspection,
      diagnostics: [diagnostic(
        'AB7314',
        `Runtime socket ${JSON.stringify(path)} refuses connections and is stale.`,
        'Remove the stale socket manually or start the runtime; Doctor never removes it.',
        'warning',
      )],
      finding: { path, state: 'stale-socket' },
      staleSockets: 1,
    };
  } catch (error) {
    return {
      ...quietInspection,
      diagnostics: [diagnostic(
        'AB7315',
        `Runtime socket ${JSON.stringify(path)} could not be probed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
        'Inspect the socket and directory permissions, then rerun Doctor.',
        'error',
      )],
    };
  }
};

const inspectLockEndpoint = async (path: string, platform: NodeJS.Platform): Promise<EndpointInspection> => {
  const sibling = path.slice(0, -'.lock'.length);
  try {
    const siblingState = await probeEndpoint(sibling);
    if (siblingState === 'live') return { ...quietInspection, finding: { path, state: 'live' } };
    let rawOwner: string;
    try {
      rawOwner = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return quietInspection;
      throw error;
    }
    const owner = parseEndpointClaimOwner(rawOwner);
    if (owner === undefined) {
      return {
        ...quietInspection,
        diagnostics: [diagnostic(
          'AB7314',
          `Runtime claim ${JSON.stringify(path)} has no valid owner record, so the runtime cannot verify it and fails closed.`,
          'After verifying no runtime is starting, remove the lock manually.',
          'warning',
        )],
        finding: { path, state: 'stale-lock' },
        staleLocks: 1,
      };
    }
    if (await isEndpointClaimOwnerProvablyDead(owner, platform)) {
      return {
        ...quietInspection,
        diagnostics: [diagnostic(
          'AB7314',
          `Runtime claim ${JSON.stringify(path)} is orphaned because owner pid ${owner.pid} is provably dead.`,
          'The runtime reclaims provably-dead claims automatically at the next start, or remove the lock manually.',
          'warning',
        )],
        finding: { path, state: 'stale-lock' },
        staleLocks: 1,
      };
    }
    return {
      ...quietInspection,
      diagnostics: [diagnostic(
        'AB7314',
        `Runtime claim ${JSON.stringify(path)} is held by pid ${owner.pid}, which cannot be proven dead, so the runtime fails closed rather than stealing it.`,
        'If runtimes hang at startup, verify the owning process and remove the lock manually only once it is gone.',
        'info',
      )],
      finding: { path, state: 'live' },
    };
  } catch (error) {
    return {
      ...quietInspection,
      diagnostics: [diagnostic(
        'AB7315',
        `Runtime claim ${JSON.stringify(path)} could not be inspected: ` +
        `${error instanceof Error ? error.message : String(error)}`,
        'Inspect the claim and directory permissions, then rerun Doctor.',
        'error',
      )],
    };
  }
};

const scanEndpoints = async (
  directory: string,
  platform: NodeJS.Platform,
): Promise<DoctorEndpointReport> => {
  if (platform === 'win32') {
    const diagnostics = freezeDiagnostics([diagnostic(
      'AB7315',
      'Runtime endpoint scan was skipped because named-pipe enumeration has no pinned contract.',
      'Inspect active Agent Bundle runtime processes with Windows host tools.',
      'info',
    )]);
    return Object.freeze({
      diagnostics,
      directory,
      findings: Object.freeze([]),
      status: 'skipped',
      summary: Object.freeze({ live: 0, staleLocks: 0, staleSockets: 0 }),
    });
  }
  let entries: readonly string[];
  try {
    entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return Object.freeze({
        diagnostics: Object.freeze([]),
        directory,
        findings: Object.freeze([]),
        status: 'healthy',
        summary: Object.freeze({ live: 0, staleLocks: 0, staleSockets: 0 }),
      });
    }
    const diagnostics = freezeDiagnostics([diagnostic(
      'AB7315',
      `Runtime endpoint directory ${JSON.stringify(directory)} could not be read.`,
      'Repair directory permissions, then rerun `agent-bundle doctor`.',
      'error',
    )]);
    return Object.freeze({
      diagnostics,
      directory,
      findings: Object.freeze([]),
      status: 'failed',
      summary: Object.freeze({ live: 0, staleLocks: 0, staleSockets: 0 }),
    });
  }
  // Every endpoint is inspected independently and the per-entry results are
  // stitched back together in directory order, so the report is byte-stable
  // regardless of which probe answers first.
  const socketEntries = entries.filter((entry) => /^event-.+\.sock$/u.test(entry));
  const lockEntries = entries.filter((candidate) => /^event-.+\.lock$/u.test(candidate));
  const socketResults: EndpointInspection[] = new Array<EndpointInspection>(socketEntries.length);
  const lockResults: EndpointInspection[] = new Array<EndpointInspection>(lockEntries.length);
  await mapConcurrent(
    [
      ...socketEntries.map((entry, index) => ({ entry, index, kind: 'socket' as const })),
      ...lockEntries.map((entry, index) => ({ entry, index, kind: 'lock' as const })),
    ],
    doctorEndpointProbeConcurrency,
    async ({ entry, index, kind }) => {
      const path = join(directory, entry);
      switch (kind) {
        case 'socket':
          socketResults[index] = await inspectSocketEndpoint(path);
          break;
        case 'lock':
          lockResults[index] = await inspectLockEndpoint(path, platform);
          break;
        default: {
          const exhaustive: never = kind;
          throw new TypeError(`Unknown endpoint entry kind ${String(exhaustive)}.`);
        }
      }
    },
  );
  const findings: DoctorFinding[] = [];
  const diagnostics: Diagnostic[] = [];
  let live = 0;
  let staleLocks = 0;
  let staleSockets = 0;
  for (const inspection of [...socketResults, ...lockResults]) {
    if (inspection.finding !== undefined) findings.push(inspection.finding);
    diagnostics.push(...inspection.diagnostics);
    live += inspection.live;
    staleLocks += inspection.staleLocks;
    staleSockets += inspection.staleSockets;
  }
  const frozenDiagnostics = freezeDiagnostics(diagnostics);
  return Object.freeze({
    diagnostics: frozenDiagnostics,
    directory,
    findings: Object.freeze(findings.map(freezeFinding)),
    status: frozenDiagnostics.some((entry) => entry.severity === 'error')
      ? 'failed'
      : frozenDiagnostics.some((entry) => entry.severity === 'warning')
        ? 'warnings'
        : 'healthy',
    summary: Object.freeze({ live, staleLocks, staleSockets }),
  });
};

const doctorHost = async (
  host: DoctorHost,
  options: DoctorOptions,
  home: string,
  run: DoctorCommandRunner,
): Promise<DoctorHostReport> => {
  const probed = host === 'cursor'
    ? await probeCursor(home)
    : await probeBinary(host, home, run);
  const environment = options.environment ?? process.env;
  const git = stagingGit(run);
  const listing: PublicHostListing = host === 'cursor' || probed.probe.status !== 'available'
    ? { detail: `${host} is not available`, status: 'unavailable' }
    : await readPublicHostListing(host, run, options.from === undefined ? home : resolve(options.from));
  const inventoried = host === 'cursor'
    ? await cursorInventory(home, probed.probe.status === 'available', git, options.platform ?? process.platform)
    : probed.probe.status !== 'available'
      ? { diagnostics: Object.freeze([]), inventory: freezeInventory('skipped') }
      : publicHostInventory(host, listing, environment, home);
  const diagnostics = [...probed.diagnostics, ...inventoried.diagnostics];
  let bundle: DoctorHostReport['bundle'];
  if (options.from !== undefined) {
    try {
      const identity = await readIdentity(options.from, host);
      const staticDiagnostics = staticValidationDiagnostics(
        'AB7319',
        host,
        identity.bundleRoot,
        await validateBundleFiles(identity.bundleRoot, host),
      );
      const context: PublicHostContext = { environment, home, listing, run };
      const checked = host === 'cursor'
        ? await cursorBundle(identity, home, git)
        : host === 'claude'
          ? await claudeBundle(identity, probed.probe, context)
          : await codexBundle(identity, probed.probe, context);
      diagnostics.push(...staticDiagnostics);
      diagnostics.push(...checked.diagnostics);
      if (checked.finding === undefined) {
        throw new TypeError(`The ${host} bundle check returned no finding.`);
      }
      const durableState = await inspectDurableState(identity.bundleRoot, host);
      if (durableState !== undefined) diagnostics.push(...durableState.diagnostics);
      bundle = Object.freeze({
        ...checked.finding,
        ...(staticDiagnostics.some((entry) => entry.severity === 'error')
          ? { state: 'corrupt' as const }
          : {}),
        ...(durableState === undefined ? {} : { durableState }),
      });
    } catch (error) {
      const malformed = malformedBundle(host, error);
      diagnostics.push(...malformed.diagnostics);
      bundle = malformed.finding;
    }
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(diagnostics),
    host,
    inventory: inventoried.inventory,
    probe: probed.probe,
    ...(bundle === undefined ? {} : { bundle }),
  });
};

export const runDoctor = async (options: DoctorOptions = {}): Promise<DoctorReport> => {
  const home = options.home ?? homedir();
  const run = options.commandRunner ?? defaultCommandRunner;
  const hosts = options.hosts ?? Object.freeze(['claude', 'codex', 'cursor'] as const);
  const uniqueHosts = [...new Set(hosts)];
  const hostReports: DoctorHostReport[] = [];
  for (const host of uniqueHosts) hostReports.push(await doctorHost(host, options, home, run));
  const endpoints = await scanEndpoints(
    options.endpointDirectory ?? doctorEndpointDirectory(),
    options.platform ?? process.platform,
  );
  const diagnostics = freezeDiagnostics([
    ...hostReports.flatMap((report) => report.diagnostics),
    ...endpoints.diagnostics,
  ]);
  return Object.freeze({
    diagnostics,
    endpoints,
    hosts: Object.freeze(hostReports),
    summary: Object.freeze({
      errors: diagnostics.filter((entry) => entry.severity === 'error').length,
      infos: diagnostics.filter((entry) => entry.severity === 'info').length,
      warnings: diagnostics.filter((entry) => entry.severity === 'warning').length,
    }),
  });
};
