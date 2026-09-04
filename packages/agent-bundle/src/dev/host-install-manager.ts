import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { Effect, FileSystem } from 'effect';

import { stableJson } from '../core/digest.ts';
import { isPlatformErrno, readFileString, type PlatformRun } from '../effect/platform.ts';
import { platformRunOf } from './platform-run.ts';
import type { DevPlatformRuntime } from './platform-runtime.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import {
  installBundle as defaultInstallBundle,
  type InstallBundleOptions,
  type InstallHost,
  type InstallResult,
} from '../install/install.ts';
import { devProxyServerCommand } from './dev-proxy-command.ts';
import {
  subscribeToEpochAdoption,
  type EpochAdoptionSource,
} from './epoch-adoption-policy.ts';
import type { EpochReference, EpochStore } from './epoch-store.ts';
import type { ProjectEventHub, ProjectEventSubscription } from './events.ts';

export const DEV_INSTALL_MARKER = '.agent-bundle-dev.json';

interface EpochReferenceSource {
  acquireEpochReference(epochId: string): Promise<Pick<EpochReference, 'close' | 'epoch' | 'root'>>;
}

export interface DevHostInstallManagerOptions {
  readonly adoption?: EpochAdoptionSource;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly epochStore: EpochReferenceSource | Pick<EpochStore, 'acquireEpochReference'>;
  readonly eventHub: ProjectEventHub;
  readonly home?: string;
  readonly hosts: readonly InstallHost[];
  readonly installBundle?: (options: InstallBundleOptions) => Promise<InstallResult>;
  readonly projectRoot: string;
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
}

interface InstalledDevHost {
  readonly destination: string;
  readonly host: InstallHost;
  epochId: string;
}

interface DevInstallMarker {
  readonly epochId: string;
  readonly host: InstallHost;
  readonly projectRoot: string;
  readonly schemaVersion: 1;
}

const mcpDocumentPath = (host: InstallHost): string => {
  switch (host) {
    case 'claude':
    case 'codex':
      return '.mcp.json';
    case 'cursor':
      return 'mcp.json';
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unsupported development install host ${String(exhaustive)}.`);
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rewriteMcpDocument = async (
  bundleRoot: string,
  host: InstallHost,
  projectRoot: string,
  run: PlatformRun,
): Promise<void> => {
  const path = join(bundleRoot, mcpDocumentPath(host));
  let document: unknown;
  try {
    document = JSON.parse(await run(readFileString(path))) as unknown;
  } catch (error) {
    if (isPlatformErrno(error, 'ENOENT')) return;
    throw error;
  }
  if (!isRecord(document) || !isRecord(document.mcpServers)) {
    throw new TypeError(`Development ${host} MCP configuration must contain an mcpServers object.`);
  }
  const mcpServers = Object.fromEntries(await Promise.all(
    Object.keys(document.mcpServers)
      .sort((left, right) => left.localeCompare(right))
      .map(async (serverName) => [
        serverName,
        {
          ...(host === 'cursor' ? {} : { type: 'stdio' }),
          ...await devProxyServerCommand(projectRoot, serverName, host),
        },
      ] as const),
  ));
  await run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, `${stableJson({ ...document, mcpServers })}\n`)));
};

const marker = (
  epochId: string,
  host: InstallHost,
  projectRoot: string,
): DevInstallMarker => Object.freeze({
  epochId,
  host,
  projectRoot,
  schemaVersion: 1,
});

/**
 * Stays on `node:fs` for the staging copy: `cp` with `verbatimSymlinks` and
 * `errorOnExist` has no `FileSystem.copy` equivalent, and the parent's
 * ownership transfers to the returned `cleanup`, so it is not a bracket.
 */
const prepareDevBundle = async (
  source: string,
  host: InstallHost,
  epochId: string,
  projectRoot: string,
  run: PlatformRun,
): Promise<Readonly<{ readonly cleanup: () => Promise<void>; readonly root: string }>> => {
  const parent = await mkdtemp(join(tmpdir(), `agent-bundle-dev-${host}-`));
  const root = join(parent, 'bundle');
  try {
    await cp(source, root, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
    await rewriteMcpDocument(root, host, projectRoot, run);
    await run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(
      join(root, DEV_INSTALL_MARKER),
      `${stableJson(marker(epochId, host, projectRoot))}\n`,
    )));
    return Object.freeze({
      cleanup: () => rm(parent, { force: true, recursive: true }),
      root,
    });
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};

const installedDestination = (
  result: InstallResult,
  home: string | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
): string => {
  if (result.destination !== undefined) return result.destination;
  const userHome = home ?? homedir();
  const cacheRoot = result.host === 'claude'
    ? join(environment.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'), 'plugins', 'cache')
    : result.host === 'codex'
      ? join(environment.CODEX_HOME ?? join(userHome, '.codex'), 'plugins', 'cache')
      : undefined;
  if (cacheRoot === undefined || result.marketplace === undefined) {
    throw new TypeError(`Cannot resolve the installed ${result.host} development bundle.`);
  }
  return join(cacheRoot, result.marketplace, result.plugin, result.version);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const generationRoot = (destination: string, epochId: string): string =>
  join(destination, '.agent-bundle-dev', 'generations', epochId);

const installGeneration = async (
  destination: string,
  bundleRoot: string,
  epochId: string,
): Promise<void> => {
  const generation = generationRoot(destination, epochId);
  await rm(generation, { force: true, recursive: true });
  await mkdir(generation, { recursive: true });
  for (const entry of await readdir(bundleRoot, { withFileTypes: true })) {
    await cp(join(bundleRoot, entry.name), join(generation, entry.name), {
      errorOnExist: true,
      force: false,
      recursive: entry.isDirectory(),
      verbatimSymlinks: true,
    });
  }
};

const publishDirectoryPointer = async (
  destination: string,
  entryName: string,
  epochId: string,
): Promise<void> => {
  const path = join(destination, entryName);
  const target = relative(destination, join(generationRoot(destination, epochId), entryName));
  const temporary = join(destination, `.${basename(entryName)}.dev-link-${process.pid}-${crypto.randomUUID()}`);
  const movedAside = join(destination, `.${basename(entryName)}.dev-previous-${process.pid}-${crypto.randomUUID()}`);
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  let moved = false;
  try {
    const metadata = await lstat(path).catch(() => undefined);
    if (metadata !== undefined && !metadata.isSymbolicLink()) {
      await rename(path, movedAside);
      moved = true;
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      if (moved) await rename(movedAside, path);
      throw error;
    }
    if (moved) await rm(movedAside, { force: true, recursive: true });
  } finally {
    await rm(temporary, { force: true, recursive: true });
    await rm(movedAside, { force: true, recursive: true });
  }
};

const publishFile = async (
  destination: string,
  source: string,
  entryName: string,
): Promise<void> => {
  const temporary = join(destination, `.${basename(entryName)}.dev-file-${process.pid}-${crypto.randomUUID()}`);
  await cp(source, temporary, { errorOnExist: true, force: false });
  try {
    await rename(temporary, join(destination, entryName));
  } finally {
    await rm(temporary, { force: true });
  }
};

/**
 * Publishes each top-level artifact entry independently. Directories are
 * immutable epoch generations selected by an atomic symlink rename; files are
 * complete sibling copies selected by an atomic file rename.
 */
const publishInstalledGeneration = async (
  destination: string,
  epochId: string,
): Promise<void> => {
  const generation = generationRoot(destination, epochId);
  const entries = await readdir(generation, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      await publishDirectoryPointer(destination, entry.name, epochId);
    } else if (entry.isFile()) {
      await publishFile(destination, join(generation, entry.name), entry.name);
    } else {
      throw new TypeError(`Development bundle entry ${JSON.stringify(entry.name)} is not a regular file or directory.`);
    }
  }
};

const publishDevGeneration = async (
  destination: string,
  bundleRoot: string,
  epochId: string,
): Promise<void> => {
  await installGeneration(destination, bundleRoot, epochId);
  await publishInstalledGeneration(destination, epochId);
};

const pruneGenerations = async (
  destination: string,
  retainedEpochIds: readonly string[],
): Promise<void> => {
  const root = join(destination, '.agent-bundle-dev', 'generations');
  const retained = new Set(retainedEpochIds);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !retained.has(entry.name)) {
      await rm(join(root, entry.name), { force: true, recursive: true });
    }
  }
};

const syncDiagnostic = (host: InstallHost, epochId: string, error: unknown): Diagnostic => Object.freeze({
  code: 'AB7202',
  message: `Failed to sync ${host} development install to epoch ${epochId}: ${
    error instanceof Error ? error.message : String(error)
  }`,
  severity: 'error',
  target: host,
});

/** Owns opt-in host development installs for one foreground dev session. */
export class DevHostInstallManager {
  readonly #adoption: EpochAdoptionSource | undefined;
  readonly #epochStore: EpochReferenceSource;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #eventHub: ProjectEventHub;
  readonly #home: string | undefined;
  readonly #hosts: readonly InstallHost[];
  readonly #installBundle: (options: InstallBundleOptions) => Promise<InstallResult>;
  readonly #installed = new Map<InstallHost, InstalledDevHost>();
  readonly #projectRoot: string;
  readonly #run: PlatformRun;
  #closed = false;
  #pending: Promise<void> = Promise.resolve();
  #subscription: ProjectEventSubscription | undefined;

  constructor(options: DevHostInstallManagerOptions) {
    this.#adoption = options.adoption;
    this.#epochStore = options.epochStore;
    this.#environment = options.environment ?? process.env;
    this.#eventHub = options.eventHub;
    this.#home = options.home;
    this.#hosts = Object.freeze([...new Set(options.hosts)]);
    this.#installBundle = options.installBundle ?? defaultInstallBundle;
    this.#projectRoot = resolve(options.projectRoot);
    this.#run = platformRunOf(options.platformRuntime);
  }

  start(): void {
    if (this.#subscription !== undefined || this.#closed) return;
    this.#subscription = subscribeToEpochAdoption(
      this.#adoption,
      this.#eventHub,
      (epochId) => this.sync(epochId),
    );
  }

  sync(epochId: string): void {
    if (this.#closed) return;
    this.#pending = this.#pending.then(async () => {
      const reference = await this.#epochStore.acquireEpochReference(epochId);
      try {
        for (const host of this.#hosts) {
          if (this.#installed.get(host)?.epochId === epochId) continue;
          try {
            await this.#syncHost(reference.root, epochId, host);
            this.#eventHub.publish({
              epochId,
              payload: Object.freeze({
                diagnostics: Object.freeze([]),
                epochId,
                host,
                state: 'succeeded' as const,
              }),
              type: 'dev.host.sync',
            });
          } catch (error) {
            this.#eventHub.publish({
              epochId,
              payload: Object.freeze({
                diagnostics: Object.freeze([syncDiagnostic(host, epochId, error)]),
                epochId,
                host,
                state: 'failed' as const,
              }),
              type: 'dev.host.sync',
            });
          }
        }
      } finally {
        await reference.close();
      }
    }).catch((error: unknown) => {
      for (const host of this.#hosts) {
        this.#eventHub.publish({
          epochId,
          payload: Object.freeze({
            diagnostics: Object.freeze([syncDiagnostic(host, epochId, error)]),
            epochId,
            host,
            state: 'failed' as const,
          }),
          type: 'dev.host.sync',
        });
      }
    });
  }

  settled(): Promise<void> {
    return this.#pending;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    await this.#pending;
  }

  async #syncHost(epochRoot: string, epochId: string, host: InstallHost): Promise<void> {
    const prepared = await prepareDevBundle(join(epochRoot, host), host, epochId, this.#projectRoot, this.#run);
    try {
      let installed = this.#installed.get(host);
      if (installed === undefined) {
        const result = await this.#installBundle({
          from: prepared.root,
          ...(this.#home === undefined ? {} : { home: this.#home }),
          host,
          scope: 'user',
        });
        installed = {
          destination: installedDestination(result, this.#home, this.#environment),
          epochId: '',
          host,
        };
        this.#installed.set(host, installed);
      }
      const previousEpochId = installed.epochId;
      try {
        await publishDevGeneration(installed.destination, prepared.root, epochId);
      } catch (error) {
        if (previousEpochId.length > 0 && await pathExists(generationRoot(installed.destination, previousEpochId))) {
          await publishInstalledGeneration(installed.destination, previousEpochId);
        }
        await rm(generationRoot(installed.destination, epochId), { force: true, recursive: true });
        throw error;
      }
      installed.epochId = epochId;
      await pruneGenerations(
        installed.destination,
        previousEpochId.length === 0 ? [epochId] : [previousEpochId, epochId],
      );
    } finally {
      await prepared.cleanup();
    }
  }
}
