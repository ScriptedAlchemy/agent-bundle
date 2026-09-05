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
import {
  validateClaudePlugin,
  validateClaudePluginFiles,
  type ClaudePluginValidationReport,
} from '../host-contracts/claude-plugin-validation.ts';
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
import { OPERATOR_ENV_FILE_NAMES, parseOperatorEnv } from '../launch-env.ts';
import {
  claudePluginRowErrors,
  parsePublicHostInventory,
  publicHostCacheRoot,
  publicHostRoot,
  treeHash,
  type InstallHost,
  type PublicHostInstalledEntry,
  type PublicHostInventory,
} from './install.ts';
import {
  compareInstalledTree,
  describeContentComparison,
  installReceiptFile,
  installReceiptFormat,
  installReceiptStoreDirectory,
  isPreservedRuntimeRoot,
  isRemnantReceipt,
  isRuntimeStateRemnant,
  readInstallReceipt,
  readInstallReceiptFile,
  treeInventory,
  type InstalledTreeComparison,
  type InstalledTreeOwnership,
  type InstallReceipt,
  type InstallReceiptMode,
  type InstallReceiptScope,
  type InstallRegistration,
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
import { readBundleIdentity, type PluginIdentity } from './identity.ts';

export type DoctorHost = InstallHost;
export type DoctorHostProbeStatus = 'available' | 'failed' | 'unavailable';
export type DoctorInventoryStatus = 'known' | 'skipped' | 'unknown';
export type DoctorFindingState =
  | 'conflicted'
  | 'corrupt'
  | 'disabled'
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

/** The install receipt an inventoried Cursor local copy carries, as read (a format/1 receipt is reported as migrated). */
export interface DoctorReceiptSummary {
  readonly contentHash: string;
  readonly format: string;
  readonly installedAt: string;
  readonly migratedFrom?: string;
  readonly mode: InstallReceiptMode;
  readonly scope: InstallReceiptScope;
  readonly updatedAt: string;
}

export interface DoctorFinding {
  /** Git commit of a staged Cursor marketplace repository. */
  readonly commit?: string;
  readonly durableState?: DoctorDurableStateReport;
  /** The operator `.env` layer the installed pack's shells read at launch (#469); names and counts only, never values. */
  readonly operatorEnv?: DoctorOperatorEnvReport;
  /**
   * Claude only: the row's `enabled` flag from `claude plugin list --json`.
   * `false` sets `state: 'disabled'` — the copy is installed but switched off,
   * so none of it reaches a session until `claude plugin enable` runs.
   */
  readonly enabled?: boolean;
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
  /** The in-tree install receipt of a Cursor local copy, when it carries one. */
  readonly receipt?: DoctorReceiptSummary;
  readonly runtime?: DoctorRuntimeStatus;
  readonly state: DoctorFindingState;
  readonly version?: string;
}

/**
 * One lifecycle observation. `observed` carries the host evidence that made it
 * true or false; `unavailable` names why no pinned read-only surface exposes it
 * — Doctor never guesses an activation state.
 */
export type DoctorLifecycleObservation =
  | Readonly<{ readonly evidence: string; readonly status: 'observed'; readonly value: boolean }>
  | Readonly<{ readonly reason: string; readonly status: 'unavailable' }>;

/** The furthest lifecycle stage observed true (`unknown` when placement itself is unobservable). */
export type DoctorLifecycleStage = 'absent' | 'active' | 'enabled' | 'placed' | 'registered' | 'unknown';

/**
 * placed (bytes at the host's install location) → registered (the host's
 * registry names the plugin) → enabled (the host reports it enabled/trusted) →
 * active (loaded by a live host process), each observed or typed unavailable
 * per host (#101).
 */
export interface DoctorLifecycle {
  readonly active: DoctorLifecycleObservation;
  readonly enabled: DoctorLifecycleObservation;
  readonly placed: DoctorLifecycleObservation;
  readonly registered: DoctorLifecycleObservation;
  readonly stage: DoctorLifecycleStage;
}

/**
 * A store receipt (`<host root>/agent-bundle/receipts/*.json`) and whether the
 * host still holds the registration it records: `consistent`, `orphaned` (the
 * host no longer lists the plugin or the staged repository is gone), or
 * `unknown` (the host inventory was unusable).
 */
export interface DoctorReceiptFinding {
  readonly contentHash: string;
  readonly format: string;
  readonly installedAt: string;
  readonly migratedFrom?: string;
  readonly mode: InstallReceiptMode;
  readonly path: string;
  readonly plugin: string;
  readonly registrations: readonly InstallRegistration[];
  readonly scope: InstallReceiptScope;
  readonly state: 'consistent' | 'orphaned' | 'unknown';
  readonly updatedAt: string;
  readonly version: string;
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

/** One operator env file of an installed pack: present (with its variable count) or absent. */
export interface DoctorOperatorEnvFile {
  readonly path: string;
  readonly state: 'absent' | 'present' | 'unreadable';
  /** The number of variables the file declares; never their names or values. */
  readonly variables?: number;
}

export interface DoctorOperatorEnvReport {
  readonly diagnostics: readonly Diagnostic[];
  readonly files: readonly DoctorOperatorEnvFile[];
  readonly status: 'absent' | 'present' | 'warnings';
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
  /** Claude only: `false` when the host lists the compared copy as disabled (`AB7327`). */
  readonly enabled?: boolean;
  /** Host load errors for a `load-failed` copy, verbatim from `claude plugin list --json`. */
  readonly errors?: readonly string[];
  readonly installedContentHash?: string;
  readonly installedPath?: string;
  readonly installedVersion?: string;
  /** Who owns the installed copy: an agent-bundle receipt, a legacy pre-receipt layout, a foreign directory, or the host's own cache. */
  readonly ownership?: InstalledTreeOwnership | 'host';
  readonly status: DoctorInstallComparisonStatus;
}

/**
 * One `claude plugin validate` pass (the same runner `validate --artifact`
 * uses: `plugin.json` then `marketplace.json`, `--strict`, `--json` on
 * 2.1.259+) over the built bundle or one installed copy of it.
 */
export interface DoctorHostValidation extends ClaudePluginValidationReport {
  /** `bundle`: the `--from` bundle root; `installed`: a copy the host lists for this plugin. */
  readonly copy: 'bundle' | 'installed';
  readonly pluginDirectory: string;
  /** Claude install scope of an `installed` copy. */
  readonly scope?: string;
}

export interface DoctorHostReport {
  readonly bundle?: DoctorFinding & {
    readonly bundleRoot?: string;
    readonly comparison?: DoctorInstallComparison;
    /** Claude only: host validator reports for the bundle and every installed copy, when `claude` is available. */
    readonly hostValidation?: readonly DoctorHostValidation[];
    readonly lifecycle?: DoctorLifecycle;
    readonly marketplace?: string;
  };
  readonly diagnostics: readonly Diagnostic[];
  readonly host: DoctorHost;
  readonly inventory: DoctorInventory;
  readonly probe: DoctorHostProbe;
  /** Agent Bundle store receipts under the host root, cross-checked against the host's inventory. */
  readonly receipts: readonly DoctorReceiptFinding[];
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

/** The cwd for `plugin list --json`: the resolved host bundle root under `--from`, else the given directory, else home. */
const listingDirectory = async (from: string | undefined, host: DoctorHost, home: string): Promise<string> => {
  if (from === undefined) return home;
  try {
    return (await readBundleIdentity(from, host)).bundleRoot;
  } catch {
    return resolve(from);
  }
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

/**
 * The `PLUGIN_DATA` directory a remnant receipt still guards, reported only when it is real: the path
 * `uninstall` itself would treat as this home's (`<cursor root>/agent-bundle/plugin-data/<plugin>` for a
 * plugin root at `<cursor root>/plugins/local/<plugin>`) and an existing real directory holding something.
 * A recorded path elsewhere (a remnant moved between homes) or one since removed by hand is not preserved
 * state, and `uninstall` would not touch it either.
 */
const preservedPluginData = async (pluginRoot: string, receipt: InstallReceipt | undefined): Promise<string | undefined> => {
  const recorded = receipt?.cursorExpansion?.pluginData;
  if (receipt === undefined || recorded === undefined) return undefined;
  const cursorRoot = resolve(pluginRoot, '..', '..', '..');
  if (recorded !== join(cursorRoot, 'agent-bundle', 'plugin-data', receipt.plugin)) return undefined;
  for (const directory of [join(cursorRoot, 'agent-bundle'), join(cursorRoot, 'agent-bundle', 'plugin-data'), recorded]) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(directory);
    } catch {
      return undefined;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
  }
  try {
    return (await readdir(recorded)).length === 0 ? undefined : recorded;
  } catch {
    return undefined;
  }
};

/**
 * AB7307 for a Cursor directory that holds no plugin but was left by `uninstall --keep-data`.
 * A remnant receipt (owning no files) may also guard unowned entries the uninstall retained, so
 * the message reports those extras instead of calling the directory state-only.
 */
const remnantDiagnostic = async (subject: string, path: string, receipt: InstallReceipt | undefined): Promise<Diagnostic> => {
  const allEntries = (await readdir(path)).filter((name) => name !== installReceiptFile);
  const extras = allEntries.filter((name) => !isPreservedRuntimeRoot(name)).sort((left, right) => left.localeCompare(right));
  // Preserved state is what `uninstall` would still keep: a state/ that holds something (an emptied one is pruned on
  // the next run, like the remnant itself) and this home's real, non-empty PLUGIN_DATA directory. Nothing is
  // assumed: a remnant whose preserved data has since gone is reported as exactly that.
  const stateRoots = allEntries.filter(isPreservedRuntimeRoot);
  let stateHeld = false;
  for (const name of stateRoots) {
    try {
      if ((await readdir(join(path, name))).length > 0) stateHeld = true;
    } catch {
      stateHeld = true;
    }
  }
  const pluginData = await preservedPluginData(path, receipt);
  const preserved = [
    ...(stateHeld ? ['state/'] : []),
    ...(pluginData === undefined ? [] : [`the PLUGIN_DATA directory ${pluginData}`]),
  ];
  const preservedText = preserved.join(' and ');
  return diagnostic(
    'AB7307',
    extras.length === 0
      ? preserved.length === 0
        ? `${subject} holds only the remnant receipt of an earlier \`uninstall --keep-data\` whose preserved runtime state has since ` +
          'been removed; no plugin is installed there.'
        : `${subject} holds only preserved runtime state (${preservedText}) from an earlier \`uninstall --keep-data\`; ` +
          'no plugin is installed there.'
      : `${subject} holds no plugin: an earlier \`uninstall\` retained the unowned ` +
        `${extras.length === 1 ? 'entry' : 'entries'} ${extras.map((name) => JSON.stringify(name)).join(', ')}` +
        `${preserved.length === 0 ? '' : ` beside preserved runtime state (${preservedText})`}.`,
    extras.length === 0
      ? preserved.length === 0
        ? 'Run `agent-bundle uninstall cursor` (or the bundle\'s `install.mjs --uninstall`) to consume the remnant, or reinstall the plugin.'
        : 'Reinstall the plugin to use the preserved state, or run `agent-bundle uninstall cursor --purge-data --confirm-purge` to remove it.'
      : 'Reinstall the plugin, or move the retained entries out and remove the directory by hand; `uninstall` never removes unowned entries.',
    'info',
    'cursor',
  );
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

/**
 * Whether an installed pack carries the operator `.env` layer its shells read
 * at launch (#469). Doctor reports the files and how many variables each
 * declares — the pack's credentials are configured, or not — and never a name
 * or a value. Both files absent is the common case and produces no diagnostic.
 */
const inspectOperatorEnv = async (
  pluginRoot: string,
  target?: DoctorHost,
): Promise<DoctorOperatorEnvReport> => {
  const files: DoctorOperatorEnvFile[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const name of OPERATOR_ENV_FILE_NAMES) {
    const path = join(pluginRoot, name);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        files.push({ path, state: 'absent' });
        continue;
      }
      files.push({ path, state: 'unreadable' });
      diagnostics.push(diagnostic(
        'AB7331',
        `Operator env file ${JSON.stringify(path)} exists but could not be read; the pack's shells skip it at launch.`,
        'Repair the file permissions so the installed pack can read its operator configuration, then rerun `agent-bundle doctor`.',
        'warning',
        target,
      ));
      continue;
    }
    const variables = Object.keys(parseOperatorEnv(contents)).length;
    files.push({ path, state: 'present', variables });
    diagnostics.push(diagnostic(
      'AB7331',
      `Operator env file ${JSON.stringify(path)} is present and declares ${String(variables)} variable${variables === 1 ? '' : 's'}; ` +
        'the pack\'s MCP servers, hook wrappers, and CLI read it at launch to fill variables the host did not set.',
      'Nothing to do; remove the file to stop the pack from reading it. Doctor never reads variable names or values.',
      'info',
      target,
    ));
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(diagnostics),
    files: Object.freeze(files),
    status: diagnostics.some((entry) => entry.severity === 'warning')
      ? 'warnings'
      : files.some((file) => file.state === 'present') ? 'present' : 'absent',
  });
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
  // The Cursor copy of an expanded package is conformant only as the bundle shipped it (AB7326 proves the expansion).
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
      // `uninstall --keep-data` leaves preserved runtime state (and a remnant receipt owning no files) behind:
      // not a corrupt plugin, an uninstalled one whose durable state was kept on purpose.
      let remnantReceipt: InstallReceipt | undefined;
      try {
        remnantReceipt = await readInstallReceipt(path);
      } catch {
        remnantReceipt = undefined;
      }
      const stateOnly = await isRuntimeStateRemnant(path);
      const remnant = stateOnly || (remnantReceipt !== undefined && isRemnantReceipt(remnantReceipt));
      if (remnant) {
        const durableState = await inspectDurableState(path, 'cursor');
        if (durableState !== undefined) diagnostics.push(...durableState.diagnostics);
        diagnostics.push(await remnantDiagnostic(`Cursor plugin entry ${JSON.stringify(path)}`, path, remnantReceipt));
        findings.push({
          ...(durableState === undefined ? {} : { durableState }),
          entry,
          ...(remnantReceipt === undefined ? {} : { name: remnantReceipt.plugin, receipt: receiptSummary(remnantReceipt), version: remnantReceipt.version }),
          path,
          state: 'missing',
        });
        continue;
      }
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
    const operatorEnv = await inspectOperatorEnv(path, 'cursor');
    diagnostics.push(...operatorEnv.diagnostics);
    const hooks = manifest.manifest === cursorManifestCandidates[0]
      ? await inspectCursorPluginHooks(path, home, { caseInsensitivePaths: platform === 'win32' })
      : undefined;
    if (hooks !== undefined) diagnostics.push(...hooks.diagnostics);
    // The in-tree receipt is read-only evidence here: a pre-lifecycle receipt is diagnosed, never rewritten.
    let receipt: InstallReceipt | undefined;
    try {
      receipt = await readInstallReceipt(path);
    } catch {
      receipt = undefined;
    }
    if (receipt?.migratedFrom !== undefined) {
      diagnostics.push(migratedReceiptDiagnostic('cursor', join(path, installReceiptFile), receipt));
    }
    findings.push({
      ...(durableState === undefined ? {} : { durableState }),
      entry,
      ...(hooks === undefined ? {} : { hooks: hooks.registration }),
      operatorEnv,
      ...(launch?.launch === undefined ? {} : { launch: launch.launch }),
      manifest: manifest.manifest,
      name: manifest.name,
      path,
      ...(receipt === undefined ? {} : { receipt: receiptSummary(receipt) }),
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
      // `enabled: false` is a copy the user switched off (`claude plugin disable`): installed, but no
      // hooks, MCP servers, or skills reach a session until it is enabled again (#476).
      const enabled = typeof row['enabled'] === 'boolean' ? row['enabled'] : undefined;
      findings.push({
        ...(enabled === undefined ? {} : { enabled }),
        entry: `${row['id']} (${row['scope']})`,
        ...(errors.length === 0 ? {} : { errors }),
        name: row['id'].slice(0, row['id'].indexOf('@') === -1 ? undefined : row['id'].indexOf('@')),
        path: row['installPath'],
        state: errors.length > 0 ? 'failed' : enabled === false ? 'disabled' : 'installed',
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
      `Rebuild the composite root (agent-bundle build) so agent-bundle.manifest.json declares a valid ${host} projection, then rerun Doctor.`,
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

const observed = (value: boolean, evidence: string): DoctorLifecycleObservation =>
  Object.freeze({ evidence, status: 'observed', value });

const unavailable = (reason: string): DoctorLifecycleObservation => Object.freeze({ reason, status: 'unavailable' });

const lifecycleStages = Object.freeze(['placed', 'registered', 'enabled', 'active'] as const);

/** The furthest stage observed true; an observed-false placement is `absent`, an unobservable one `unknown`. */
const lifecycleOf = (observations: Omit<DoctorLifecycle, 'stage'>): DoctorLifecycle => {
  let stage: DoctorLifecycleStage = observations.placed.status === 'unavailable' ? 'unknown' : 'absent';
  for (const name of lifecycleStages) {
    const observation = observations[name];
    if (observation.status !== 'observed' || !observation.value) break;
    stage = name;
  }
  return Object.freeze({ ...observations, stage });
};

const noLiveHostSurface = (host: DoctorHost): string => {
  switch (host) {
    case 'claude':
      return 'Claude Code 2.1.257 exposes no read-only verb that reports which plugins a live session has loaded; `claude plugin list --json` reports registration and enablement only.';
    case 'codex':
      return 'Codex 0.147.0 exposes no read-only verb that reports which plugins a live session has loaded, and skips plugin hooks until the user trusts them in the hook browser (no read-only trust verb).';
    case 'cursor':
      return 'Cursor exposes no non-interactive plugin-loading surface; whether a live window loaded the plugin is not observable read-only.';
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown Doctor host ${String(exhaustive)}.`);
    }
  }
};

const cursorEnabledUnavailable =
  'Cursor keeps enabled-plugin state as server-assigned ids in state.vscdb (2026-09-03 audit, #407) and gates plugin import and ' +
  'plugin hooks on its thirdPartyExtensibilityEnabled / enable_cc_plugin_import flags (observed 3.18.25); no pinned read-only surface exposes either.';

/**
 * Lifecycle for a public host CLI copy: placement is the cache path the host
 * reported, registration and enablement come from `plugin list --json`, and
 * live activation has no read-only surface on either host.
 */
const publicHostLifecycle = async (
  host: Exclude<DoctorHost, 'cursor'>,
  inventory: PublicHostInventory,
): Promise<DoctorLifecycle> => {
  if (inventory.status === 'unavailable') {
    const reason = `\`${host} plugin list --json\` was unusable (${inventory.detail}).`;
    return lifecycleOf({
      active: unavailable(noLiveHostSurface(host)),
      enabled: unavailable(reason),
      placed: unavailable(reason),
      registered: unavailable(reason),
    });
  }
  if (inventory.entries.length === 0) {
    const evidence = `\`${host} plugin list --json\` lists no copy of the plugin.`;
    return lifecycleOf({
      active: unavailable(noLiveHostSurface(host)),
      enabled: observed(false, evidence),
      placed: observed(false, evidence),
      registered: observed(false, evidence),
    });
  }
  // Claude may list the plugin at several scopes (user, project, local) and Codex reports one row; the lifecycle
  // aggregates every row, and a stage holds only when it holds for every listed copy — a disabled or unplaced
  // copy at any scope is reported, never hidden behind the row Claude happened to list first.
  const label = (entry: PublicHostInstalledEntry): string => entry.scope === undefined ? 'the row' : `scope ${entry.scope}`;
  const placements: { readonly entry: PublicHostInstalledEntry; readonly placed: boolean }[] = [];
  for (const entry of inventory.entries) {
    let placed = false;
    try {
      placed = (await lstat(entry.installPath)).isDirectory();
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTDIR')) throw error;
    }
    placements.push({ entry, placed });
  }
  const unplaced = placements.filter((placement) => !placement.placed);
  const flagless = inventory.entries.filter((entry) => entry.enabled === undefined);
  const disabled = inventory.entries.filter((entry) => entry.enabled === false);
  const scopes = inventory.entries.map(label).join(', ');
  return lifecycleOf({
    active: unavailable(noLiveHostSurface(host)),
    enabled: flagless.length > 0
      ? unavailable(`the \`${host} plugin list --json\` row for ${flagless.map(label).join(', ')} carries no enabled flag.`)
      : observed(
        disabled.length === 0,
        disabled.length === 0
          ? `\`${host} plugin list --json\` reports enabled: true for ${scopes}.`
          : `\`${host} plugin list --json\` reports enabled: false for ${disabled.map(label).join(', ')}` +
            `${disabled.length === inventory.entries.length ? '' : ` (enabled: true for the other listed ${inventory.entries.length - disabled.length === 1 ? 'scope' : 'scopes'})`}.`,
      ),
    placed: observed(
      unplaced.length === 0,
      unplaced.length === 0
        ? `${host} reports the ${placements.length === 1 ? 'copy' : 'copies'} at ${[...new Set(placements.map((placement) => placement.entry.installPath))].join(', ')}.`
        : `${host} reports ${unplaced.map((placement) => `${placement.entry.installPath} (${label(placement.entry)})`).join(', ')}, which ${unplaced.length === 1 ? 'is' : 'are'} not ${unplaced.length === 1 ? 'a directory' : 'directories'}.`,
    ),
    registered: observed(true, `\`${host} plugin list --json\` lists the plugin${inventory.entries.some((entry) => entry.scope !== undefined) ? ` at ${scopes}` : ''}.`),
  });
};

const cursorLocalLifecycle = (destination: string, placed: boolean): DoctorLifecycle => lifecycleOf({
  active: unavailable(noLiveHostSurface('cursor')),
  enabled: unavailable(cursorEnabledUnavailable),
  placed: observed(placed, placed ? `${destination} exists.` : `${destination} does not exist.`),
  registered: observed(
    placed,
    'Cursor loads every directory under ~/.cursor/plugins/local at window reload; the directory is the registration.',
  ),
});

const cursorStagedLifecycle = (repoRoot: string, imported: boolean): DoctorLifecycle => lifecycleOf({
  active: unavailable(noLiveHostSurface('cursor')),
  enabled: unavailable(cursorEnabledUnavailable),
  placed: observed(true, `Staged marketplace repository ${repoRoot} exists.`),
  registered: observed(
    imported,
    imported
      ? 'Cursor holds a completed (.cache-complete) copy from this staging under ~/.cursor/plugins/cache.'
      : 'No completed copy from this staging exists under ~/.cursor/plugins/cache; the Customize import step is pending.',
  ),
});

const describeObservation = (observation: DoctorLifecycleObservation): string =>
  observation.status === 'observed' ? (observation.value ? 'yes' : 'no') : 'unavailable';

const lifecycleDiagnostic = (host: DoctorHost, name: string, version: string, lifecycle: DoctorLifecycle): Diagnostic => {
  const unavailableStages = lifecycleStages.filter((stage) => lifecycle[stage].status === 'unavailable');
  const detail = unavailableStages.length === 0
    ? ''
    : ` Unavailable: ${unavailableStages.map((stage) => {
      const observation = lifecycle[stage];
      return `${stage} (${observation.status === 'unavailable' ? observation.reason : ''})`;
    }).join('; ')}`;
  const recovery = lifecycle.stage === 'placed' && lifecycle.registered.status === 'observed'
    ? host === 'cursor'
      ? 'Complete the Cursor Customize import (marketplace mode), or reload the window (local mode).'
      : `Register the plugin with \`agent-bundle install ${host} --from <bundle-dir>\`.`
    : lifecycle.stage === 'registered' && lifecycle.enabled.status === 'observed'
      ? host === 'claude'
        ? 'Enable the plugin with `claude plugin enable <plugin>@<marketplace>`.'
        : host === 'codex'
          ? 'Enable the plugin with `/plugins` in Codex or by editing `[plugins."<plugin>@<marketplace>"] enabled` in config.toml.'
          : 'Enable the plugin in Cursor Customize -> Plugins.'
      : 'No action needed; stages marked unavailable have no pinned read-only host surface and are never guessed.';
  return diagnostic(
    'AB7330',
    `${name}@${version} lifecycle on ${host}: stage ${lifecycle.stage}` +
      ` (placed ${describeObservation(lifecycle.placed)}, registered ${describeObservation(lifecycle.registered)}, ` +
      `enabled ${describeObservation(lifecycle.enabled)}, active ${describeObservation(lifecycle.active)}).${detail}`,
    recovery,
    'info',
    host,
  );
};

const receiptSummary = (receipt: InstallReceipt): DoctorReceiptSummary => Object.freeze({
  contentHash: receipt.contentHash,
  format: receipt.migratedFrom ?? installReceiptFormat,
  installedAt: receipt.installedAt,
  ...(receipt.migratedFrom === undefined ? {} : { migratedFrom: receipt.migratedFrom }),
  mode: receipt.mode,
  scope: receipt.scope,
  updatedAt: receipt.updatedAt,
});

const migratedReceiptDiagnostic = (host: DoctorHost, path: string, receipt: InstallReceipt): Diagnostic => diagnostic(
  'AB7329',
  `Install receipt ${JSON.stringify(path)} predates lifecycle receipts (read as ${receipt.migratedFrom ?? 'an older format'}): ` +
    `mode, scope, registrations, and host directories were synthesized (${receipt.mode}, ${receipt.scope}, ` +
    `${receipt.registrations.map((registration) => registration.kind).join(', ')}, none).`,
  'Rerun `agent-bundle install` (or the bundle\'s `install.mjs`) once; an identical copy rewrites the receipt as ' +
    `${installReceiptFormat} without changing plugin files. \`uninstall\` accepts the migrated receipt as is.`,
  'info',
  host,
);

/** Whether the host's listing still names the plugin registration a store receipt records. */
const receiptRegistrationState = (
  host: Exclude<DoctorHost, 'cursor'>,
  receipt: InstallReceipt,
  listing: PublicHostListing,
): DoctorReceiptFinding['state'] => {
  if (listing.status === 'unavailable') return 'unknown';
  const registration = receipt.registrations.find((candidate) => candidate.kind === `${host}-plugin`);
  if (registration?.id === undefined) return 'unknown';
  let document: unknown;
  try {
    document = JSON.parse(listing.stdout) as unknown;
  } catch {
    return 'unknown';
  }
  const rows = host === 'claude'
    ? document
    : isRecord(document) ? document['installed'] : undefined;
  if (!Array.isArray(rows)) return 'unknown';
  const present = rows.some((row) => isRecord(row) && (host === 'claude'
    ? row['id'] === registration.id && (registration.scope === undefined || row['scope'] === registration.scope)
    : row['pluginId'] === registration.id && row['installed'] !== false));
  return present ? 'consistent' : 'orphaned';
};

const receiptFinding = (path: string, receipt: InstallReceipt, state: DoctorReceiptFinding['state']): DoctorReceiptFinding =>
  Object.freeze({
    contentHash: receipt.contentHash,
    format: receipt.migratedFrom ?? installReceiptFormat,
    installedAt: receipt.installedAt,
    ...(receipt.migratedFrom === undefined ? {} : { migratedFrom: receipt.migratedFrom }),
    mode: receipt.mode,
    path,
    plugin: receipt.plugin,
    registrations: receipt.registrations,
    scope: receipt.scope,
    state,
    updatedAt: receipt.updatedAt,
    version: receipt.version,
  });

/**
 * Inventories the Agent Bundle store receipts under a host root and
 * cross-checks each against the host: an orphaned receipt (the registration it
 * records is gone) is `AB7328`, a pre-lifecycle receipt is `AB7329`. Unreadable
 * receipt files are reported, never thrown.
 */
const inspectStoreReceipts = async (
  host: DoctorHost,
  hostRoot: string,
  stateOf: (receipt: InstallReceipt) => Promise<DoctorReceiptFinding['state']>,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly receipts: readonly DoctorReceiptFinding[] }> => {
  const directory = installReceiptStoreDirectory(hostRoot);
  let entries: readonly string[];
  try {
    entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return { diagnostics: Object.freeze([]), receipts: Object.freeze([]) };
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7328',
        `Agent Bundle receipt store ${JSON.stringify(directory)} could not be read.`,
        'Repair permissions for the receipt store, then rerun `agent-bundle doctor`.',
        'warning',
        host,
      )]),
      receipts: Object.freeze([]),
    };
  }
  const diagnostics: Diagnostic[] = [];
  const receipts: DoctorReceiptFinding[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json'))) {
    const path = join(directory, entry);
    let receipt: InstallReceipt | undefined;
    try {
      receipt = await readInstallReceiptFile(path);
    } catch (error) {
      diagnostics.push(diagnostic(
        'AB7328',
        `Agent Bundle receipt ${JSON.stringify(path)} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        'Remove or repair the receipt file; `agent-bundle uninstall <host> --force` removes the install it described.',
        'warning',
        host,
      ));
      continue;
    }
    if (receipt === undefined) {
      diagnostics.push(diagnostic(
        'AB7328',
        `Agent Bundle receipt ${JSON.stringify(path)} is not a valid install receipt (unknown format or missing fields).`,
        'Reinstall the plugin to rewrite its receipt, or remove the file if the install is gone.',
        'warning',
        host,
      ));
      continue;
    }
    const state = await stateOf(receipt);
    receipts.push(receiptFinding(path, receipt, state));
    if (receipt.migratedFrom !== undefined) diagnostics.push(migratedReceiptDiagnostic(host, path, receipt));
    if (state === 'orphaned') {
      diagnostics.push(diagnostic(
        'AB7328',
        `Agent Bundle receipt ${JSON.stringify(path)} records ${receipt.plugin}@${receipt.version} (${receipt.mode}, scope ${receipt.scope}) ` +
          `but ${host} no longer holds the registration it describes.`,
        `Run \`agent-bundle uninstall ${host} --from <bundle-dir>${receipt.mode === 'marketplace' ? ' --mode marketplace' : ''}\` to consume the ` +
          'orphaned receipt, or reinstall the plugin.',
        'warning',
        host,
      ));
    }
  }
  return { diagnostics: freezeDiagnostics(diagnostics), receipts: Object.freeze(receipts) };
};

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
    plugin: identity.plugin,
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
 * `AB7327`: Claude lists this copy with `enabled: false`. The bytes may be
 * current, but a disabled plugin contributes no hooks, MCP servers, or skills
 * to a session, and no install or rebuild changes that — only
 * `claude plugin enable` does (plugins-reference §plugin enable).
 */
const disabledInstallDiagnostic = (
  identity: PluginIdentity,
  version: string,
  installPath: string,
  scope: string | undefined,
): Diagnostic => diagnostic(
  'AB7327',
  `claude lists ${identity.plugin}@${version} at ${installPath}${scope === undefined ? '' : ` (scope ${scope})`} ` +
    'as disabled (`enabled: false`): the copy is installed but none of it loads in a session.',
  `Run \`claude plugin enable ${identity.plugin}${identity.marketplace === undefined ? '' : `@${identity.marketplace}`}` +
    `${scope === undefined ? '' : ` --scope ${scope}`}\` (or \`/plugin\` in a session), then rerun Doctor; ` +
    'reinstalling does not enable a disabled plugin.',
  'warning',
  'claude',
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
        `${identity.plugin}@${identity.version} is not installed for ${host}.`,
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
    const enabledField = entry.enabled === undefined ? {} : { enabled: entry.enabled };
    if (entry.enabled === false) {
      // Installed and possibly current, yet switched off: the content comparison still runs (a stale
      // disabled copy is both), but the report must not read as a healthy install (#476).
      diagnostics.push(disabledInstallDiagnostic(identity, entry.version, entry.installPath, entry.scope));
    }
    if (entry.errors !== undefined && entry.errors.length > 0) {
      // The host lists the copy but refused to load it: content comparison is moot because none of the
      // plugin reaches a session. Report the host's own message rather than `current`/`stale` (#464).
      comparisons.push(Object.freeze({
        artifactContentHash: artifact.hash,
        ...enabledField,
        errors: entry.errors,
        installedPath: entry.installPath,
        installedVersion: entry.version,
        ownership: 'host',
        status: 'load-failed',
      }));
      diagnostics.push(hostLoadFailureDiagnostic(host, `${identity.plugin}@${entry.version} at ${entry.installPath}${scoped}`, entry.errors, replaceHint));
      continue;
    }
    let installed: TreeInventory;
    try {
      installed = await treeInventory(entry.installPath);
    } catch (error) {
      comparisons.push(Object.freeze({
        artifactContentHash: artifact.hash,
        ...enabledField,
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
      ...enabledField,
      installedContentHash: installed.hash,
      installedPath: entry.installPath,
      installedVersion: entry.version,
      ownership: 'host',
      status,
    }));
    const detail = describeContentComparison(identity.plugin, identity.version, {
      artifactContentHash: artifact.hash,
      installedContentHash: installed.hash,
      installedName: identity.plugin,
      installedVersion: entry.version,
      status,
    });
    switch (status) {
      case 'current':
        break;
      case 'stale':
        diagnostics.push(diagnostic(
          'AB7308',
          `${host} plugin ${identity.plugin}@${identity.version} at ${entry.installPath}${scoped} is stale ` +
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
  const repoRoot = join(cursorMarketplaceRoot(join(home, '.cursor')), identity.plugin);
  const pluginDirectory = cursorMarketplacePluginPath(repoRoot, identity.plugin);
  if (!await exists(repoRoot)) return undefined;
  if (!await exists(pluginDirectory)) {
    // The staged repository is present but its plugin copy is gone: surface the staging inventory's
    // corrupt finding (and its repair step) instead of AB7307 "not installed".
    const staging = await inspectCursorMarketplaceStaging(home, git);
    const entry = staging.findings.find((candidate) => candidate.name === identity.plugin);
    return {
      diagnostics: freezeDiagnostics(staging.diagnostics.filter((candidate) => candidate.message.includes(repoRoot))),
      finding: Object.freeze({
        ...base,
        lifecycle: cursorStagedLifecycle(repoRoot, false),
        ...(entry?.marketplace === undefined ? {} : { marketplace: entry.marketplace }),
        path: repoRoot,
        state: 'corrupt',
      }),
    };
  }
  const [sourceHash, stagedHash] = await Promise.all([treeHash(identity.bundleRoot), treeHash(pluginDirectory)]);
  // The staging inspection also proves the working tree equals committed HEAD, so a source-matching but
  // uncommitted tree cannot be reported as imported. It is read for a drifted staging too: a bundle rebuilt
  // after Cursor imported the staged commit is still imported, and the lifecycle must say so.
  const staging = await inspectCursorMarketplaceStaging(home, git);
  const entry = staging.findings.find((candidate) => candidate.name === identity.plugin);
  if (sourceHash !== stagedHash) {
    const imported = entry?.state === 'registered';
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7308',
        `Staged Cursor marketplace copy of ${identity.plugin}@${identity.version} at ${repoRoot} differs from the current bundle` +
          `${imported ? '; Cursor has imported the staged copy, so the imported plugin is the older content' : ''}.`,
        imported
          ? 'Run `agent-bundle uninstall cursor --mode marketplace` (the imported copy is Cursor-owned; it lists the Customize step), ' +
            'rerun `agent-bundle install cursor --mode marketplace`, then re-import the plugin in Cursor.'
          : 'Remove the staged marketplace directory and rerun `agent-bundle install cursor --mode marketplace`.',
        'warning',
        'cursor',
      )]),
      finding: Object.freeze({
        ...base,
        ...(entry?.commit === undefined ? {} : { commit: entry.commit }),
        lifecycle: cursorStagedLifecycle(repoRoot, imported),
        ...(entry?.marketplace === undefined ? {} : { marketplace: entry.marketplace }),
        path: repoRoot,
        state: 'drifted',
      }),
    };
  }
  return {
    diagnostics: freezeDiagnostics(staging.diagnostics.filter((candidate) => candidate.message.includes(repoRoot) || candidate.message.includes(`${identity.plugin}@`))),
    finding: Object.freeze({
      ...base,
      ...(entry?.commit === undefined ? {} : { commit: entry.commit }),
      lifecycle: cursorStagedLifecycle(repoRoot, entry?.state === 'registered'),
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
  const destination = join(home, '.cursor', 'plugins', 'local', identity.plugin);
  const base = {
    bundleRoot: identity.bundleRoot,
    name: identity.plugin,
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
          `${identity.plugin}@${identity.version} is not installed for Cursor.`,
          'Run `agent-bundle install cursor --from <bundle-dir>` or the bundle\'s `install.mjs`.',
          'info',
          'cursor',
        )]),
        finding: Object.freeze({
          ...base,
          comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'not-installed' as const }),
          lifecycle: cursorLocalLifecycle(destination, false),
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
      plugin: identity.plugin,
      version: identity.version,
    });
    const detail = describeContentComparison(identity.plugin, identity.version, comparison);
    const withComparison = (state: DoctorFindingState): DoctorHostReport['bundle'] => Object.freeze({
      ...base,
      comparison: installComparison(comparison, destination),
      lifecycle: cursorLocalLifecycle(destination, true),
      ...(comparison.receipt === undefined ? {} : { receipt: receiptSummary(comparison.receipt) }),
      state,
    });
    // `uninstall --keep-data` left state/ (with a remnant receipt owning no files) and possibly unowned entries it
    // retained: not installed, state kept. The remnant receipt alone does not prove the directory is state-only.
    const stateOnly = (comparison.ownership === 'receipt' || comparison.ownership === 'foreign') &&
      await isRuntimeStateRemnant(destination);
    const remnant = stateOnly ||
      (comparison.ownership === 'receipt' && comparison.receipt !== undefined && isRemnantReceipt(comparison.receipt));
    if (remnant) {
      return {
        diagnostics: freezeDiagnostics([await remnantDiagnostic(
          `Cursor destination ${destination} (${identity.plugin}@${identity.version})`,
          destination,
          comparison.receipt,
        )]),
        finding: Object.freeze({
          ...base,
          comparison: Object.freeze({ artifactContentHash: artifact.hash, status: 'not-installed' as const }),
          lifecycle: cursorLocalLifecycle(destination, false),
          ...(comparison.receipt === undefined ? {} : { receipt: receiptSummary(comparison.receipt) }),
          state: 'missing',
        }),
      };
    }
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
              `it is not an agent-bundle install of ${identity.plugin}.`,
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
            `Cursor plugin ${identity.plugin}@${identity.version} at ${destination} is stale ` +
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
    name: identity.plugin,
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
    (entry as { id?: unknown }).id === `${identity.plugin}@inline`);
  if (row === undefined) {
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7311',
        `Claude registration proof did not contain plugin ${JSON.stringify(identity.plugin)}.`,
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
      diagnostics: freezeDiagnostics([hostLoadFailureDiagnostic('claude', `${identity.plugin}@${identity.version} from ${identity.bundleRoot}`, errors)]),
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

/**
 * The Claude developer validator over one directory, through the same runner
 * `validate --artifact` uses (`plugin.json` run, then `marketplace.json`;
 * `--strict`; `--json` on 2.1.259+). Findings keep their `AB6019`–`AB6022`
 * codes; the message names which copy they were found in, since Doctor
 * validates the `--from` bundle and every installed copy the host lists (#476).
 */
const claudeHostValidation = async (
  copy: DoctorHostValidation['copy'],
  pluginDirectory: string,
  scope: string | undefined,
  probe: DoctorHostProbe,
  run: DoctorCommandRunner,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly validation: DoctorHostValidation }> => {
  // Doctor already holds the load verdicts (`claudeRegistration` for the bundle, the inventory
  // rows' `errors[]` → AB7325 for installed copies) and the probed version, so the runner
  // neither lists nor probes again.
  const report = await validateClaudePlugin({
    loadCheck: false,
    pluginDirectory,
    run,
    target: 'claude',
    ...(probe.version === undefined ? {} : { version: probe.version }),
  });
  const location = copy === 'bundle'
    ? `Bundle at ${JSON.stringify(pluginDirectory)}`
    : `Installed copy at ${JSON.stringify(pluginDirectory)}${scope === undefined ? '' : ` (scope ${scope})`}`;
  return {
    diagnostics: freezeDiagnostics(report.diagnostics.map((entry) => Object.freeze({
      ...entry,
      message: `${location}: ${entry.message}`,
    }))),
    validation: Object.freeze({ ...report, copy, pluginDirectory, ...(scope === undefined ? {} : { scope }) }),
  };
};

/**
 * Claude: inline registration proof, the installed cache copy compared against
 * the artifact, and `claude plugin validate` over the bundle and each installed
 * copy. Doctor stays read-only: the validator only reads the named files.
 */
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
  const validated = [await claudeHostValidation('bundle', identity.bundleRoot, undefined, probe, context.run)];
  if (inventory.status === 'available') {
    for (const entry of inventory.entries) {
      validated.push(await claudeHostValidation('installed', entry.installPath, entry.scope, probe, context.run));
    }
  }
  return {
    diagnostics: freezeDiagnostics([
      ...registration.diagnostics,
      ...compared.diagnostics,
      ...validated.flatMap((entry) => entry.diagnostics),
    ]),
    finding: Object.freeze({
      ...registration.finding,
      comparison: compared.comparison,
      hostValidation: Object.freeze(validated.map((entry) => entry.validation)),
      lifecycle: await publicHostLifecycle('claude', inventory),
    }),
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
    name: identity.plugin,
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
        lifecycle: await publicHostLifecycle('codex', inventory),
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
      lifecycle: await publicHostLifecycle('codex', inventory),
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
  // Claude `project` / `local` registrations are keyed by the cwd the host verbs ran in, and install runs them
  // from the composite `--from` root (the host manifest sits directly under it), so the listing the bundle
  // comparison and lifecycle use is taken from that same root; `--from` without a manifest for this host falls
  // back to the given directory and the bundle step reports the missing manifest.
  const listingCwd = await listingDirectory(options.from, host, home);
  const listing: PublicHostListing = host === 'cursor' || probed.probe.status !== 'available'
    ? { detail: `${host} is not available`, status: 'unavailable' }
    : await readPublicHostListing(host, run, listingCwd);
  // Claude `project` / `local` registrations live in the project's own `.claude/settings*.json`, so a
  // receipt that records a project root is cross-checked against `plugin list --json` run from that root
  // (once per root), never against the listing taken here: a valid install elsewhere is not an orphan.
  // A root that cannot be listed (gone, or the host failed there) leaves the state unknown.
  const projectListings = new Map<string, Promise<PublicHostListing>>();
  const listingFor = (receipt: InstallReceipt): Promise<PublicHostListing> => {
    if (host === 'cursor' || listing.status === 'unavailable' || (receipt.scope !== 'project' && receipt.scope !== 'local')) {
      return Promise.resolve(listing);
    }
    if (receipt.projectRoot === undefined) {
      return Promise.resolve({ detail: `the ${receipt.scope}-scope receipt records no project root`, status: 'unavailable' });
    }
    const projectRoot = resolve(receipt.projectRoot);
    if (projectRoot === listingCwd) return Promise.resolve(listing);
    let pending = projectListings.get(projectRoot);
    if (pending === undefined) {
      pending = readPublicHostListing(host, run, projectRoot);
      projectListings.set(projectRoot, pending);
    }
    return pending;
  };
  const inventoried = host === 'cursor'
    ? await cursorInventory(home, probed.probe.status === 'available', git, options.platform ?? process.platform)
    : probed.probe.status !== 'available'
      ? { diagnostics: Object.freeze([]), inventory: freezeInventory('skipped') }
      : publicHostInventory(host, listing, environment, home);
  const diagnostics = [...probed.diagnostics, ...inventoried.diagnostics];
  // Store receipts are lifecycle evidence Agent Bundle itself wrote, so the store is inventoried from
  // the filesystem whether or not the host can be probed: malformed and migrated receipts are always
  // reported. The host cross-check that separates `consistent` from `orphaned` needs the host's
  // inventory; without it the registration state is `unknown`, never guessed.
  const receipts = host === 'cursor'
    ? await inspectStoreReceipts(host, join(home, '.cursor'), async (receipt) => receipt.mode === 'marketplace'
      ? (await exists(join(cursorMarketplaceRoot(join(home, '.cursor')), receipt.plugin)) ? 'consistent' : 'orphaned')
      : 'unknown')
    : await inspectStoreReceipts(
      host,
      publicHostRoot(host, environment, home),
      async (receipt) => receiptRegistrationState(host, receipt, await listingFor(receipt)),
    );
  diagnostics.push(...receipts.diagnostics);
  let bundle: DoctorHostReport['bundle'];
  if (options.from !== undefined) {
    try {
      const identity = await readBundleIdentity(options.from, host);
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
      if (checked.finding.lifecycle !== undefined) {
        diagnostics.push(lifecycleDiagnostic(host, identity.plugin, identity.version, checked.finding.lifecycle));
      }
      const durableState = await inspectDurableState(identity.bundleRoot, host);
      if (durableState !== undefined) diagnostics.push(...durableState.diagnostics);
      const operatorEnv = await inspectOperatorEnv(identity.bundleRoot, host);
      diagnostics.push(...operatorEnv.diagnostics);
      bundle = Object.freeze({
        ...checked.finding,
        ...(staticDiagnostics.some((entry) => entry.severity === 'error')
          ? { state: 'corrupt' as const }
          : {}),
        ...(durableState === undefined ? {} : { durableState }),
        operatorEnv,
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
    receipts: receipts.receipts,
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
