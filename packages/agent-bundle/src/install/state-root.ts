import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { isErrno } from '../core/errors.ts';
import { pluginStateRootEnvAnchor } from '../core/types.ts';
import { webPluginDataRoot } from '../web-host/launch.ts';
import type { InstallHost } from './install.ts';
import type {
  InstallReceiptMode,
  InstallReceiptScope,
  InstallReceiptState,
  InstallReceiptStateOwner,
  InstallReceiptStateRoot,
} from './receipt.ts';

export interface InstalledStateRoot {
  readonly root: string;
  readonly source: 'derived' | 'native';
}

export interface InstalledStateLocation {
  readonly root?: string;
  readonly server: string;
  readonly source: 'declared' | 'derived';
  readonly status: 'resolved' | 'unproven';
}

export const stateOwnershipMarkerFile = '.agent-bundle-state-owner.json';

const manifestCandidates = (host: InstallHost): readonly string[] => {
  switch (host) {
    case 'claude':
      return ['.mcp.json'];
    case 'codex':
      return ['.codex-plugin/mcp.json'];
    case 'cursor':
      return ['.cursor-plugin/mcp.json', 'mcp.json'];
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown install host ${String(exhaustive)}.`);
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const safePluginSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

// The CLI cannot load the optional React runtime. Uninstall tests pin this spelling against
// `userDataStateRoot` from @agent-bundle/runtime for real installed roots.
const installedUserDataStateRoot = (
  canonicalRoot: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => {
  const xdgStateHome = environment.XDG_STATE_HOME ?? '';
  const stateHome = isAbsolute(xdgStateHome)
    ? join(xdgStateHome, 'agent-bundle')
    : join(home, '.agent-bundle', 'state');
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  const name = basename(canonicalRoot);
  return join(stateHome, safePluginSegment.test(name) ? `${name}-${digest}` : `plugin-${digest}`);
};

const installedServers = async (
  pluginRoot: string,
  host: InstallHost,
): Promise<readonly { readonly cwd?: string; readonly environment: Readonly<NodeJS.ProcessEnv>; readonly name: string }[]> => {
  for (const relativePath of manifestCandidates(host)) {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(join(pluginRoot, relativePath), 'utf8')) as unknown;
    } catch (error) {
      if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(document) || !isRecord(document['mcpServers'])) continue;
    return Object.entries(document['mcpServers'])
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => ({
        ...(typeof server['cwd'] === 'string' ? { cwd: server['cwd'] } : {}),
        environment: isRecord(server['env'])
          ? Object.fromEntries(Object.entries(server['env']).filter((entry): entry is [string, string] =>
              typeof entry[1] === 'string'))
          : {},
        name,
      }));
  }
  return [];
};

const expandPluginRoot = (value: string, pluginRoot: string): string =>
  value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CURSOR_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${PLUGIN_ROOT}', pluginRoot);

export const resolveInstalledStateRoots = async (
  pluginRoot: string,
  host: InstallHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<readonly InstalledStateLocation[]> => {
  const canonicalRoot = await realpath(pluginRoot).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return resolve(pluginRoot);
    throw error;
  });
  const servers = await installedServers(canonicalRoot, host);
  if (servers.length === 0) {
    return Object.freeze([Object.freeze({
      root: installedUserDataStateRoot(canonicalRoot, environment, home),
      server: 'default',
      source: 'derived' as const,
      status: 'resolved' as const,
    })]);
  }
  return Object.freeze(servers.map((server) => {
    const declared = server.environment[pluginStateRootEnvAnchor];
    if (declared === undefined || declared.trim() === '') {
      return Object.freeze({
        root: installedUserDataStateRoot(canonicalRoot, environment, home),
        server: server.name,
        source: 'derived' as const,
        status: 'resolved' as const,
      });
    }
    const expanded = expandPluginRoot(declared, canonicalRoot);
    if (/\$\{[^}]*\}/u.test(expanded)) {
      return Object.freeze({ server: server.name, source: 'declared' as const, status: 'unproven' as const });
    }
    if (isAbsolute(expanded)) {
      return Object.freeze({
        root: resolve(expanded),
        server: server.name,
        source: 'declared' as const,
        status: 'resolved' as const,
      });
    }
    if (server.cwd === undefined) {
      return Object.freeze({ server: server.name, source: 'declared' as const, status: 'unproven' as const });
    }
    const expandedCwd = expandPluginRoot(server.cwd, canonicalRoot);
    if (/\$\{[^}]*\}/u.test(expandedCwd)) {
      return Object.freeze({ server: server.name, source: 'declared' as const, status: 'unproven' as const });
    }
    const cwd = isAbsolute(expandedCwd) ? resolve(expandedCwd) : resolve(canonicalRoot, expandedCwd);
    return Object.freeze({
      root: resolve(cwd, expanded),
      server: server.name,
      source: 'declared' as const,
      status: 'resolved' as const,
    });
  }));
};

export const resolveInstalledStateRoot = async (
  pluginRoot: string,
  host: InstallHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<InstalledStateRoot> => {
  const locations = await resolveInstalledStateRoots(pluginRoot, host, environment, home);
  const first = locations.find((location) => location.root !== undefined);
  if (first !== undefined && first.root !== undefined) {
    return Object.freeze({ root: first.root, source: first.source === 'derived' ? 'derived' : 'native' });
  }
  const canonicalRoot = await realpath(pluginRoot).catch(() => resolve(pluginRoot));
  return Object.freeze({
    root: installedUserDataStateRoot(canonicalRoot, environment, home),
    source: 'derived',
  });
};

const canonicalPath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return join(await canonicalPath(parent), basename(path));
  }
};

const markerDocument = (owner: InstallReceiptStateOwner): string =>
  `${JSON.stringify({ format: 1, owner }, null, 2)}\n`;

const markerMatches = async (marker: string, owner: InstallReceiptStateOwner): Promise<boolean> => {
  try {
    const document = JSON.parse(await readFile(marker, 'utf8')) as unknown;
    return isRecord(document) &&
      document['format'] === 1 &&
      isRecord(document['owner']) &&
      document['owner']['id'] === owner.id &&
      document['owner']['host'] === owner.host &&
      document['owner']['mode'] === owner.mode &&
      document['owner']['plugin'] === owner.plugin &&
      document['owner']['scope'] === owner.scope &&
      document['owner']['projectRoot'] === owner.projectRoot;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return false;
    throw error;
  }
};

export interface RecordInstalledStateOptions {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly host: InstallHost;
  readonly mode: InstallReceiptMode;
  readonly plugin: string;
  readonly pluginRoot: string;
  readonly previous?: InstallReceiptState;
  readonly projectRoot?: string;
  readonly scope: InstallReceiptScope;
}

export interface RecordedInstalledState {
  readonly rollback: () => Promise<void>;
  readonly state: InstallReceiptState;
}

export interface InstalledStateOwnershipDecision {
  readonly action: 'absent' | 'purge' | 'retain';
  readonly path: string;
  readonly reason?: string;
}

export const inspectInstalledStateOwnership = async (
  state: InstallReceiptState,
  root: InstallReceiptStateRoot,
): Promise<InstalledStateOwnershipDecision> => {
  let metadata;
  try {
    metadata = await lstat(root.root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return Object.freeze({ action: 'absent', path: root.root });
    throw error;
  }
  if (root.ownership.kind === 'unowned') {
    return Object.freeze({ action: 'retain', path: root.root, reason: root.ownership.reason });
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return Object.freeze({ action: 'retain', path: root.root, reason: 'unsupported-entry' });
  }
  if (await realpath(root.root) !== root.canonicalRoot) {
    return Object.freeze({ action: 'retain', path: root.root, reason: 'canonical-path-changed' });
  }
  if (
    root.ownership.kind === 'marker' &&
    (
      root.ownership.marker !== join(root.root, stateOwnershipMarkerFile) ||
      !(await markerMatches(root.ownership.marker, state.owner))
    )
  ) {
    return Object.freeze({ action: 'retain', path: root.root, reason: 'marker-mismatch' });
  }
  return Object.freeze({ action: 'purge', path: root.root });
};

export const recordInstalledState = async (
  options: RecordInstalledStateOptions,
): Promise<RecordedInstalledState> => {
  const owner = Object.freeze({
    host: options.host,
    id: options.previous?.owner.id ?? randomUUID(),
    mode: options.mode,
    plugin: options.plugin,
    ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    scope: options.scope,
  });
  const locations = await resolveInstalledStateRoots(
    options.pluginRoot,
    options.host,
    options.environment,
    options.home,
  );
  const roots = new Map<string, { location: InstalledStateLocation; servers: string[] }>();
  for (const location of locations) {
    if (location.root === undefined) continue;
    const previous = roots.get(location.root);
    if (previous === undefined) roots.set(location.root, { location, servers: [location.server] });
    else previous.servers.push(location.server);
  }
  const created: string[] = [];
  const recorded: InstallReceiptStateRoot[] = [];
  for (const { location, servers } of roots.values()) {
    const root = location.root as string;
    const canonicalRoot = await canonicalPath(root);
    if (location.source === 'derived') {
      recorded.push(Object.freeze({
        canonicalRoot,
        ownership: Object.freeze({ kind: 'derived' as const }),
        root,
        servers: Object.freeze(servers),
        source: 'derived',
      }));
      continue;
    }
    const marker = join(root, stateOwnershipMarkerFile);
    let existed = true;
    try {
      await lstat(root);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      existed = false;
    }
    let ownership: InstallReceiptStateRoot['ownership'];
    if (!existed) {
      await mkdir(dirname(root), { recursive: true });
      try {
        await mkdir(root);
        const handle = await open(marker, 'wx');
        try {
          await handle.writeFile(markerDocument(owner), 'utf8');
        } finally {
          await handle.close();
        }
        created.push(root);
        ownership = Object.freeze({ kind: 'marker' as const, marker });
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        ownership = Object.freeze({ kind: 'unowned' as const, reason: 'pre-existing' as const });
      }
    } else if (await markerMatches(marker, owner)) {
      ownership = Object.freeze({ kind: 'marker' as const, marker });
    } else {
      let markerExists = true;
      try {
        await lstat(marker);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        markerExists = false;
      }
      ownership = Object.freeze({
        kind: 'unowned' as const,
        reason: markerExists ? 'foreign-marker' as const : 'pre-existing' as const,
      });
    }
    recorded.push(Object.freeze({
      canonicalRoot: await canonicalPath(root),
      ownership,
      root,
      servers: Object.freeze(servers),
      source: 'declared',
    }));
  }
  return Object.freeze({
    rollback: async () => {
      for (const root of created.reverse()) {
        await rm(join(root, stateOwnershipMarkerFile), { force: true });
        await rmdir(root).catch((error: unknown) => {
          if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY')) throw error;
        });
      }
    },
    state: Object.freeze({ owner, roots: Object.freeze(recorded) }),
  });
};

export const installedWebDataRoot = (pluginRoot: string, home: string): string =>
  webPluginDataRoot(pluginRoot, home);
