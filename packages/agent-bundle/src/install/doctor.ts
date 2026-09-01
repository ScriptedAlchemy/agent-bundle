import { lstat, readFile, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  freezeDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';
import type {
  BoundedChildProcessRequest,
  BoundedChildProcessResult,
} from '../host-contracts/process.ts';
import { runBoundedChildProcess } from '../host-contracts/process.ts';
import { treeHash, type InstallHost } from './install.ts';

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
  readonly entry?: string;
  readonly manifest?: string;
  readonly name?: string;
  readonly path?: string;
  readonly state: DoctorFindingState;
  readonly version?: string;
}

export interface DoctorInventory {
  readonly findings: readonly DoctorFinding[];
  readonly status: DoctorInventoryStatus;
}

export interface DoctorHostReport {
  readonly bundle?: DoctorFinding & {
    readonly bundleRoot?: string;
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

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

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

const resolveBundleRoot = async (from: string, host: DoctorHost): Promise<string> => {
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

const readInstalledManifest = async (
  root: string,
): Promise<{ readonly manifest: string; readonly name: string; readonly version?: string } | undefined> => {
  for (const manifest of cursorManifestCandidates) {
    try {
      const value = JSON.parse(await readFile(join(root, manifest), 'utf8')) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as { readonly name?: unknown; readonly version?: unknown };
      if (typeof record.name !== 'string') continue;
      if (record.version !== undefined && typeof record.version !== 'string') continue;
      return Object.freeze({
        manifest,
        name: record.name,
        ...(typeof record.version === 'string' ? { version: record.version } : {}),
      });
    } catch (error) {
      if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
};

const cursorInventory = async (
  home: string,
  available: boolean,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly inventory: DoctorInventory }> => {
  if (!available) return { diagnostics: Object.freeze([]), inventory: freezeInventory('skipped') };
  const installRoot = join(home, '.cursor', 'plugins', 'local');
  let entries: readonly string[];
  try {
    entries = (await readdir(installRoot)).sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { diagnostics: Object.freeze([]), inventory: freezeInventory('known') };
    }
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
    findings.push({
      entry,
      manifest: manifest.manifest,
      name: manifest.name,
      path,
      state: 'installed',
      ...(manifest.version === undefined ? {} : { version: manifest.version }),
    });
  }
  return {
    diagnostics: freezeDiagnostics(diagnostics),
    inventory: freezeInventory('known', findings),
  };
};

const unknownInventory = (
  host: Exclude<DoctorHost, 'cursor'>,
): { readonly diagnostics: readonly Diagnostic[]; readonly inventory: DoctorInventory } => ({
  diagnostics: freezeDiagnostics([diagnostic(
    'AB7303',
    `${host} owns its plugin registry and Agent Bundle has no pinned read-only inventory verb.`,
    host === 'claude'
      ? 'Use `claude plugin details <name>` to inspect a known plugin.'
      : 'Use Codex-owned commands to inspect installed plugins.',
    'info',
    host,
  )]),
  inventory: freezeInventory('unknown'),
});

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

const cursorBundle = async (
  identity: PluginIdentity,
  home: string,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] }> => {
  const destination = join(home, '.cursor', 'plugins', 'local', identity.name);
  const base = {
    bundleRoot: identity.bundleRoot,
    name: identity.name,
    path: destination,
    version: identity.version,
  } as const;
  try {
    await treeHash(identity.bundleRoot);
    if (!await exists(destination)) {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7307',
          `${identity.name}@${identity.version} is not installed for Cursor.`,
          'Run `agent-bundle install cursor --from <bundle-dir>` or the bundle\'s `install.mjs`.',
          'info',
          'cursor',
        )]),
        finding: Object.freeze({ ...base, state: 'missing' }),
      };
    }
    const installed = await readInstalledManifest(destination);
    if (installed === undefined) {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7310',
          `Cursor destination ${JSON.stringify(destination)} has no valid loader manifest.`,
          'Remove the corrupt copy manually and reinstall the Cursor plugin.',
          'error',
          'cursor',
        )]),
        finding: Object.freeze({ ...base, state: 'corrupt' }),
      };
    }
    if (installed.version !== undefined && installed.version !== identity.version) {
      return {
        diagnostics: freezeDiagnostics([diagnostic(
          'AB7309',
          `Cursor version collision at ${destination}: found ${installed.version}, expected ${identity.version}.`,
          'Choose the intended version, remove the conflicting copy manually, and reinstall.',
          'warning',
          'cursor',
        )]),
        finding: Object.freeze({ ...base, state: 'conflicted' }),
      };
    }
    const [sourceHash, installedHash] = await Promise.all([
      treeHash(identity.bundleRoot),
      treeHash(destination),
    ]);
    if (sourceHash === installedHash) {
      return { diagnostics: Object.freeze([]), finding: Object.freeze({ ...base, state: 'installed' }) };
    }
    return {
      diagnostics: freezeDiagnostics([diagnostic(
        'AB7308',
        `Cursor plugin ${identity.name}@${identity.version} differs from the current bundle.`,
        'Reinstall the Cursor plugin from the current bundle.',
        'warning',
        'cursor',
      )]),
      finding: Object.freeze({ ...base, state: 'drifted' }),
    };
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

const claudeBundle = async (
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
  const entries = inventory;
  if (!entries.some((entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry as { id?: unknown }).id === `${identity.name}@inline`
  )) {
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
  return { diagnostics: Object.freeze([]), finding: Object.freeze({ ...base, state: 'registered' }) };
};

const codexBundle = (
  identity: PluginIdentity,
): { readonly diagnostics: readonly Diagnostic[]; readonly finding: DoctorHostReport['bundle'] } => ({
  diagnostics: freezeDiagnostics([diagnostic(
    'AB7313',
    'Codex bundle registration is unknown because no read-only inventory verb is pinned.',
    'Use Codex-owned commands to inspect registration; stage 1 intentionally does not guess.',
    'info',
    'codex',
  )]),
  finding: Object.freeze({
    bundleRoot: identity.bundleRoot,
    marketplace: identity.marketplace,
    name: identity.name,
    state: 'unknown',
    version: identity.version,
  }),
});

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
  const findings: DoctorFinding[] = [];
  const diagnostics: Diagnostic[] = [];
  let live = 0;
  let staleLocks = 0;
  let staleSockets = 0;
  const socketEntries = entries.filter((entry) => /^event-.+\.sock$/u.test(entry));
  for (const entry of socketEntries) {
    const path = join(directory, entry);
    try {
      const state = await probeEndpoint(path);
      if (state === 'missing') continue;
      if (state === 'live') {
        live += 1;
        findings.push({ path, state: 'live' });
        continue;
      }
      staleSockets += 1;
      findings.push({ path, state: 'stale-socket' });
      diagnostics.push(diagnostic(
        'AB7314',
        `Runtime socket ${JSON.stringify(path)} refuses connections and is stale.`,
        'Remove the stale socket manually or start the runtime; Doctor never removes it.',
        'warning',
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        'AB7315',
        `Runtime socket ${JSON.stringify(path)} could not be probed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
        'Inspect the socket and directory permissions, then rerun Doctor.',
        'error',
      ));
    }
  }
  for (const entry of entries.filter((candidate) => /^event-.+\.lock$/u.test(candidate))) {
    const path = join(directory, entry);
    const sibling = path.slice(0, -'.lock'.length);
    try {
      const siblingState = await probeEndpoint(sibling);
      if (siblingState === 'live') {
        findings.push({ path, state: 'live' });
        continue;
      }
      let rawOwner: string;
      try {
        rawOwner = await readFile(path, 'utf8');
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue;
        throw error;
      }
      const owner = parseEndpointClaimOwner(rawOwner);
      if (owner === undefined) {
        staleLocks += 1;
        findings.push({ path, state: 'stale-lock' });
        diagnostics.push(diagnostic(
          'AB7314',
          `Runtime claim ${JSON.stringify(path)} has no valid owner record, so the runtime cannot verify it and fails closed.`,
          'After verifying no runtime is starting, remove the lock manually.',
          'warning',
        ));
        continue;
      }
      if (await isEndpointClaimOwnerProvablyDead(owner, platform)) {
        staleLocks += 1;
        findings.push({ path, state: 'stale-lock' });
        diagnostics.push(diagnostic(
          'AB7314',
          `Runtime claim ${JSON.stringify(path)} is orphaned because owner pid ${owner.pid} is provably dead.`,
          'The runtime reclaims provably-dead claims automatically at the next start, or remove the lock manually.',
          'warning',
        ));
        continue;
      }
      findings.push({ path, state: 'live' });
      diagnostics.push(diagnostic(
        'AB7314',
        `Runtime claim ${JSON.stringify(path)} is held by pid ${owner.pid}, which cannot be proven dead, so the runtime fails closed rather than stealing it.`,
        'If runtimes hang at startup, verify the owning process and remove the lock manually only once it is gone.',
        'info',
      ));
    } catch (error) {
      diagnostics.push(diagnostic(
        'AB7315',
        `Runtime claim ${JSON.stringify(path)} could not be inspected: ` +
        `${error instanceof Error ? error.message : String(error)}`,
        'Inspect the claim and directory permissions, then rerun Doctor.',
        'error',
      ));
    }
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
  const inventoried = host === 'cursor'
    ? await cursorInventory(home, probed.probe.status === 'available')
    : unknownInventory(host);
  const diagnostics = [...probed.diagnostics, ...inventoried.diagnostics];
  let bundle: DoctorHostReport['bundle'];
  if (options.from !== undefined) {
    try {
      const identity = await readIdentity(options.from, host);
      const checked = host === 'cursor'
        ? await cursorBundle(identity, home)
        : host === 'claude'
          ? await claudeBundle(identity, probed.probe, run)
          : codexBundle(identity);
      diagnostics.push(...checked.diagnostics);
      bundle = checked.finding;
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
