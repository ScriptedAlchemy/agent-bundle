import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { compositeHookContract, compositeMcpRuntime } from '../adapters/composite.ts';
import { artifactManifestName } from '../build/emit.ts';
import { parseArtifactHookIndex, type ArtifactHook } from '../build/hook-index.ts';
import { parseArtifactManifest } from '../build/manifest.ts';
import { digest, sha256Hex } from '../core/digest.ts';
import { eventRuntimeEndpoint } from '../events/ipc.ts';
import { cursorDefaultHooksPath, resolveCursorHooksSource } from '../host-contracts/cursor-plugin-validation.ts';
import { resolveBundleRoot } from '../install/doctor.ts';
import type { InstallHost } from '../install/install.ts';
import { AgentTestError } from './errors.ts';
import {
  HOST_INSTALL_PROOF_LEVEL,
  SIMULATED_PROOF_LEVEL,
  proofLevelLabel,
  type AgentBundleTestManifest,
  type AgentTestProofLevel,
} from './manifest.ts';

export type InstalledHostCheckName =
  | 'component-paths'
  | 'hook-commands'
  | 'manifest-schema'
  | 'mcp-command'
  | 'resources'
  | 'version-digests'
  | 'version-quadruple';

export interface InstalledHostCheckOutcome {
  readonly reason?: string;
  readonly status: 'failed' | 'passed';
}

export interface InstalledHostVersionQuadruple {
  readonly builtArtifact: string;
  readonly installedArtifact: string;
  readonly runningProcess: string;
  readonly source: string;
}

export type InstalledHostBinaryVersion =
  | { readonly status: 'observed'; readonly value: string }
  | { readonly reason: string; readonly status: 'unavailable' };

export interface InstalledHostEvidenceMetadata {
  readonly adapterRevision: string;
  readonly frameworkVersion: string;
  readonly hostBinaryVersion: InstalledHostBinaryVersion;
  readonly manifestSchemaDigest: string;
}

export interface InstalledHostObservation {
  readonly checks: Readonly<Record<InstalledHostCheckName, InstalledHostCheckOutcome>>;
  readonly host: InstallHost;
  readonly metadata: InstalledHostEvidenceMetadata;
  readonly proofLevel: string;
  readonly sessionEvidence: string;
  readonly versions: InstalledHostVersionQuadruple;
}

export interface InstalledHostMcpProvenance {
  /** Installed-root-relative command entry, never an absolute host path. */
  readonly entry: string;
  readonly host: InstallHost;
  readonly pid: number | undefined;
  readonly proofLevel: typeof HOST_INSTALL_PROOF_LEVEL | typeof SIMULATED_PROOF_LEVEL;
}

export interface InstalledHostMcpSession extends AsyncDisposable {
  readonly client: Client;
  readonly close: () => Promise<void>;
  /** Raw read-only status socket for the installed generated event runtime. */
  readonly eventRuntimeEndpoint?: string;
  readonly observation: InstalledHostObservation;
  readonly provenance: InstalledHostMcpProvenance;
  readonly stderr: () => string;
}

export interface OpenInstalledHostMcpServerOptions {
  /** Root containing `agent-bundle.manifest.json` and target directories. */
  readonly artifactRoot: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly host: InstallHost;
  /** Version observed from the real host binary, when that lane invoked one. */
  readonly hostBinaryVersion?: string;
  /** Host-owned installed plugin root, not the build target directory. */
  readonly installedRoot: string;
  readonly manifest: AgentBundleTestManifest;
  readonly server?: string;
  readonly sessionEvidence?: string;
}

interface RawMcpServer {
  readonly args?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly type?: unknown;
}

interface Failure {
  readonly check: InstalledHostCheckName;
  readonly reason: string;
}

const maxStderrCharacters = 16_000;

const hostManifestPath = (host: InstallHost): string => {
  switch (host) {
    case 'claude':
      return '.claude-plugin/plugin.json';
    case 'codex':
      return '.codex-plugin/plugin.json';
    case 'cursor':
      return '.cursor-plugin/plugin.json';
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown installed host ${String(exhaustive)}.`);
    }
  }
};

/**
 * The MCP document the installed host reads. A root that projects several
 * hosts relocates some of them (#555: Codex beside Claude Code reads
 * `.codex-plugin/mcp.json`), so the built artifact's target list decides;
 * without a manifest the host's conventional document applies.
 */
const hostMcpPath = (host: InstallHost, targets: readonly string[] | undefined): string =>
  (targets === undefined ? undefined : compositeMcpRuntime(targets, host)?.manifestPath)
    ?? (host === 'cursor' ? 'mcp.json' : '.mcp.json');

/**
 * The hook document the installed host loads. Claude Code reads the pinned
 * `hooks/hooks.json`; Codex reads the same unless it shares the root with
 * Claude Code, where its `.codex-plugin/plugin.json` points at
 * `.codex-plugin/hooks.json` (#555); Cursor reads whatever the installed
 * `.cursor-plugin/plugin.json` `hooks` field names (`hooks/hooks-cursor.json`
 * beside another host, #438), falling back to `hooks/hooks.json` folder
 * discovery when the field is absent.
 */
const hostHookPath = (
  host: InstallHost,
  installedManifest: Readonly<Record<string, unknown>>,
  targets: readonly string[] | undefined,
): string => {
  switch (host) {
    case 'claude':
    case 'codex':
      return (targets === undefined ? undefined : compositeHookContract(targets, host)?.manifestPath) ?? 'hooks/hooks.json';
    case 'cursor': {
      const source = resolveCursorHooksSource(installedManifest);
      return source.kind === 'file' ? source.path : cursorDefaultHooksPath;
    }
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown installed host ${String(exhaustive)}.`);
    }
  }
};

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;

const requiredString = (
  value: unknown,
  check: InstalledHostCheckName,
  label: string,
  failures: Failure[],
): string => {
  if (typeof value === 'string' && value.length > 0) return value;
  failures.push({ check, reason: `${label} was not observable` });
  return '';
};

const readJsonRecord = async (
  path: string,
  check: InstalledHostCheckName,
  label: string,
  failures: Failure[],
): Promise<Readonly<Record<string, unknown>>> => {
  try {
    const value = record(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (value !== undefined) return value;
  } catch {
    // The single finding below deliberately avoids leaking the absolute path.
  }
  failures.push({ check, reason: `${label} was not readable canonical JSON` });
  return Object.freeze({});
};

const fileHash = async (path: string): Promise<string | undefined> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    return sha256Hex(await readFile(path));
  } catch {
    return undefined;
  }
};

const relativePath = (root: string, path: string): string =>
  relative(root, path).split(sep).join('/');

const installedFailure = (
  failures: readonly Failure[],
  proofLevel: AgentTestProofLevel,
): AgentTestError => new AgentTestError(
  'contract-violation',
  `Installed-host contract matrix reported ${String(failures.length)} violation(s) at the ${proofLevel} proof level.`,
  {
    details: failures.map((failure) =>
      `- installed-host / ${failure.check}: ${failure.reason} (${proofLevelLabel(proofLevel)})`),
    recovery: 'Rebuild, reinstall into a clean host root, and rerun runInstalledHostContractMatrix.',
  },
);

const commandStrings = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.flatMap(commandStrings);
  const object = record(value);
  if (object === undefined) return [];
  return Object.entries(object).flatMap(([key, nested]) =>
    key === 'command' && typeof nested === 'string' ? [nested] : commandStrings(nested));
};

const expandHostPath = (value: string, host: InstallHost, installedRoot: string): string => {
  switch (host) {
    case 'claude':
      return value.replaceAll('${CLAUDE_PLUGIN_ROOT}', installedRoot);
    case 'codex':
      return value;
    case 'cursor':
      return value
        .replaceAll('${CURSOR_PLUGIN_ROOT}', installedRoot)
        .replaceAll('${workspaceFolder}', installedRoot);
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown installed host ${String(exhaustive)}.`);
    }
  }
};

const stringEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> => Object.fromEntries(
  Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

const resolvedCommandPath = (value: string, cwd: string): string =>
  isAbsolute(value) ? value : resolve(cwd, value);

const discoveredServer = (
  document: Readonly<Record<string, unknown>>,
  requested: string | undefined,
  failures: Failure[],
): { readonly name: string; readonly server: RawMcpServer } => {
  const servers = record(document.mcpServers);
  const names = Object.keys(servers ?? {}).sort();
  const name = requested ?? (names.length === 1 ? names[0] : undefined);
  if (name === undefined || record(servers?.[name]) === undefined) {
    failures.push({
      check: 'mcp-command',
      reason: requested === undefined
        ? `installed MCP document exposed ${String(names.length)} servers; exactly one is required`
        : `installed MCP document did not expose server ${JSON.stringify(requested)}`,
    });
    return { name: requested ?? '', server: {} };
  }
  return { name, server: record(servers?.[name]) as RawMcpServer };
};

const outcomes = (failures: readonly Failure[]): Readonly<Record<InstalledHostCheckName, InstalledHostCheckOutcome>> => {
  const names: readonly InstalledHostCheckName[] = [
    'component-paths',
    'hook-commands',
    'manifest-schema',
    'mcp-command',
    'resources',
    'version-digests',
    'version-quadruple',
  ];
  return Object.freeze(Object.fromEntries(names.map((name) => {
    const matching = failures.filter((failure) => failure.check === name);
    return [name, matching.length === 0
      ? Object.freeze({ status: 'passed' as const })
      : Object.freeze({ reason: matching.map((failure) => failure.reason).join('; '), status: 'failed' as const })];
  })) as unknown as Readonly<Record<InstalledHostCheckName, InstalledHostCheckOutcome>>);
};

/**
 * Discovers an emitted MCP command from a host-owned installed layout, checks
 * the artifact/install boundary, then opens a real stdio client session.
 *
 * The running-process version is read only from the live initialize result.
 * The helper also derives the installed generated event-runtime socket so the
 * shared matrix can read WarmRuntimeIdentity without crossing into source.
 */
export const openInstalledHostMcpServer = async (
  options: OpenInstalledHostMcpServerOptions,
): Promise<InstalledHostMcpSession> => {
  const artifactRoot = resolve(options.artifactRoot);
  const installedRoot = resolve(options.installedRoot);
  const proofLevel = options.sessionEvidence === undefined
    ? SIMULATED_PROOF_LEVEL
    : HOST_INSTALL_PROOF_LEVEL;
  const failures: Failure[] = [];
  let artifactBytes = '';
  let artifactManifest: ReturnType<typeof parseArtifactManifest> | undefined;
  try {
    artifactBytes = await readFile(join(artifactRoot, artifactManifestName), 'utf8');
    artifactManifest = parseArtifactManifest(artifactBytes);
  } catch {
    failures.push({ check: 'manifest-schema', reason: 'built artifact manifest was unavailable or invalid' });
  }
  const target = artifactManifest?.targets.find((candidate) => candidate.name === options.host);
  const rootTargets = artifactManifest?.targets.map((candidate) => candidate.name);
  if (target === undefined) {
    failures.push({ check: 'manifest-schema', reason: `artifact manifest did not declare target ${options.host}` });
  }
  const builtRoot = await resolveBundleRoot(artifactRoot, options.host).catch(() => {
    failures.push({ check: 'manifest-schema', reason: `Doctor could not discover the built ${options.host} bundle root` });
    return artifactRoot;
  });

  // Every projected host reads the same plugin root (#555), so the manifest's
  // files are the host's component files.
  const targetFiles = artifactManifest?.files ?? [];
  if (targetFiles.length === 0) {
    failures.push({ check: 'component-paths', reason: `artifact manifest declared no ${options.host} component files` });
  }
  for (const file of targetFiles) {
    const targetRelative = file.path;
    const [builtHash, installedHash] = await Promise.all([
      fileHash(join(artifactRoot, file.path)),
      fileHash(join(installedRoot, targetRelative)),
    ]);
    if (builtHash !== file.sha256) {
      failures.push({ check: 'version-digests', reason: `built file ${targetRelative} disagreed with its artifact digest` });
    }
    if (installedHash !== file.sha256) {
      failures.push({ check: 'version-digests', reason: `installed file ${targetRelative} disagreed with its artifact digest` });
    }
    if (installedHash === undefined) {
      failures.push({ check: 'component-paths', reason: `installed component ${targetRelative} was missing` });
    }
  }

  const resourceFiles = targetFiles.filter((file) =>
    file.path.startsWith('assets/') || file.path.startsWith('skills/') || file.path.startsWith('commands/'));
  for (const resource of resourceFiles) {
    const path = resource.path;
    if (await fileHash(join(installedRoot, path)) === undefined) {
      failures.push({ check: 'resources', reason: `installed resource ${path} was missing` });
    }
  }

  const installedManifest = await readJsonRecord(
    join(installedRoot, hostManifestPath(options.host)),
    'manifest-schema',
    'installed host manifest',
    failures,
  );
  const builtManifest = await readJsonRecord(
    join(builtRoot, hostManifestPath(options.host)),
    'manifest-schema',
    'built host manifest',
    failures,
  );
  const installedVersion = requiredString(
    installedManifest.version,
    'version-quadruple',
    'installed artifact version',
    failures,
  );
  const sourceVersion = requiredString(
    options.manifest.plugin.packageVersion ?? options.manifest.plugin.version,
    'version-quadruple',
    'source version',
    failures,
  );
  const builtVersion = requiredString(
    builtManifest.version,
    'version-quadruple',
    'built artifact version',
    failures,
  );

  let installedHooks: readonly ArtifactHook[] | undefined;
  try {
    const hookIndex = parseArtifactHookIndex(
      await readFile(join(artifactRoot, 'agent-bundle.hooks.json'), 'utf8'),
    );
    if (hookIndex === undefined) {
      failures.push({ check: 'hook-commands', reason: 'artifact hook index was unavailable or invalid' });
    } else {
      installedHooks = hookIndex.hooks.filter((hook) => hook.target === options.host);
    }
  } catch {
    failures.push({ check: 'hook-commands', reason: 'artifact hook index was unavailable or invalid' });
  }
  if (installedHooks !== undefined && installedHooks.length > 0) {
    const hookDocument = await readJsonRecord(
      join(installedRoot, hostHookPath(options.host, installedManifest, rootTargets)),
      'hook-commands',
      'installed hook document',
      failures,
    );
    const hooks = commandStrings(hookDocument);
    if (hooks.length === 0) {
      failures.push({ check: 'hook-commands', reason: 'installed hook document exposed no commands' });
    }
    for (const hook of installedHooks) {
      const path = hook.path;
      if (await fileHash(join(installedRoot, path)) === undefined) {
        failures.push({ check: 'hook-commands', reason: `installed hook command target ${path} was missing` });
      }
    }
  }

  const mcpDocument = await readJsonRecord(
    join(installedRoot, hostMcpPath(options.host, rootTargets)),
    'mcp-command',
    'installed MCP document',
    failures,
  );
  const discovered = discoveredServer(mcpDocument, options.server, failures);
  const command = requiredString(discovered.server.command, 'mcp-command', 'installed MCP command', failures);
  const rawArgs = Array.isArray(discovered.server.args)
    && discovered.server.args.every((argument) => typeof argument === 'string')
    ? discovered.server.args as readonly string[]
    : [];
  if (!Array.isArray(discovered.server.args)) {
    failures.push({ check: 'mcp-command', reason: 'installed MCP command exposed no argument vector' });
  }
  const rawCwd = typeof discovered.server.cwd === 'string' ? discovered.server.cwd : installedRoot;
  const expandedCwd = expandHostPath(rawCwd, options.host, installedRoot);
  const cwd = resolvedCommandPath(expandedCwd, installedRoot);
  const expandedCommand = expandHostPath(command, options.host, installedRoot);
  const args = rawArgs.map((argument) => expandHostPath(argument, options.host, installedRoot));
  const entryArgument = args.find((argument) => /\.mjs$/u.test(argument));
  const resolvedEntry = entryArgument === undefined
    ? undefined
    : resolvedCommandPath(entryArgument, cwd);
  if (resolvedEntry === undefined || await fileHash(resolvedEntry) === undefined) {
    failures.push({ check: 'mcp-command', reason: 'installed MCP entry argument did not resolve to an installed file' });
  }
  const declaredEnvironment = record(discovered.server.env);
  const expandedDeclaredEnvironment = Object.fromEntries(
    Object.entries(declaredEnvironment ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([key, value]) => [key, expandHostPath(value, options.host, installedRoot)] as const),
  );
  const env = {
    ...stringEnvironment(process.env),
    ...(options.env ?? {}),
    ...expandedDeclaredEnvironment,
  };

  const eventRuntimeEndpointPath = artifactManifest === undefined || resolvedEntry === undefined
    ? undefined
    : eventRuntimeEndpoint(
      `${artifactManifest.project.revision}:${options.host}:${dirname(dirname(resolvedEntry))}`,
    );
  if (eventRuntimeEndpointPath === undefined && failures.length === 0) {
    failures.push({ check: 'mcp-command', reason: 'installed event runtime endpoint could not be derived' });
  }
  if (failures.length > 0) throw installedFailure(failures, proofLevel);
  if (eventRuntimeEndpointPath === undefined) {
    throw installedFailure(
      [{ check: 'mcp-command', reason: 'installed event runtime endpoint could not be derived' }],
      proofLevel,
    );
  }
  const client = new Client({ name: 'agent-bundle-installed-host-proof', version: '1.0.0' });
  const transport = new StdioClientTransport({
    args: [...args],
    command: expandedCommand,
    cwd,
    env,
    stderr: 'pipe',
  });
  let captured = '';
  transport.stderr?.on('data', (chunk: unknown) => {
    if (captured.length >= maxStderrCharacters) return;
    captured = `${captured}${String(chunk)}`.slice(0, maxStderrCharacters);
  });
  try {
    await client.connect(transport);
  } catch {
    failures.push({
      check: 'mcp-command',
      reason: `installed MCP command could not initialize${captured === '' ? '' : `: ${captured}`}`,
    });
    throw installedFailure(failures, proofLevel);
  }

  const runningVersion = requiredString(
    client.getServerVersion()?.version,
    'version-quadruple',
    'running process version from initialize serverInfo',
    failures,
  );
  const versions: InstalledHostVersionQuadruple = Object.freeze({
    builtArtifact: builtVersion,
    installedArtifact: installedVersion,
    runningProcess: runningVersion,
    source: sourceVersion,
  });
  if (new Set(Object.values(versions)).size !== 1 || Object.values(versions).some((value) => value.length === 0)) {
    failures.push({
      check: 'version-quadruple',
      reason: `source=${sourceVersion || 'missing'}, builtArtifact=${builtVersion || 'missing'}, installedArtifact=${installedVersion || 'missing'}, runningProcess=${runningVersion || 'missing'}`,
    });
  }
  const metadata: InstalledHostEvidenceMetadata = Object.freeze({
    adapterRevision: target?.adapterRevision ?? 'unavailable',
    frameworkVersion: artifactManifest?.producer.version ?? 'unavailable',
    hostBinaryVersion: options.hostBinaryVersion === undefined
      ? Object.freeze({
        reason: 'adapter simulator does not invoke a host binary',
        status: 'unavailable' as const,
      })
      : Object.freeze({ status: 'observed' as const, value: options.hostBinaryVersion }),
    manifestSchemaDigest: digest({
      manifest: sha256Hex(artifactBytes),
      schemas: target?.schemas ?? [],
    }),
  });
  const observation: InstalledHostObservation = Object.freeze({
    checks: outcomes(failures),
    host: options.host,
    metadata,
    proofLevel: proofLevelLabel(proofLevel),
    sessionEvidence: options.sessionEvidence
      ?? 'adapter-simulated discovery and stdio spawn from an isolated installed root',
    versions,
  });
  if (failures.length > 0) {
    await client.close();
    throw installedFailure(failures, proofLevel);
  }

  const provenance: InstalledHostMcpProvenance = Object.freeze({
    entry: entryArgument === undefined ? discovered.name : relativePath(installedRoot, resolvedCommandPath(entryArgument, cwd)),
    host: options.host,
    pid: transport.pid ?? undefined,
    proofLevel,
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await client.close();
  };
  return Object.freeze({
    client,
    close,
    eventRuntimeEndpoint: eventRuntimeEndpointPath,
    observation,
    provenance,
    stderr: () => captured,
    [Symbol.asyncDispose]: close,
  });
};
