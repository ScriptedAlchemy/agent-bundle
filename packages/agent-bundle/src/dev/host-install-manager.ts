import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { Effect, FileSystem } from 'effect';

import { readArtifactManifest } from '../build/manifest-file.ts';
import { reindexArtifactManifest } from '../build/manifest-reindex.ts';
import { stableJson } from '../core/digest.ts';
import { isErrno } from '../core/errors.ts';
import { isPortablePathSegment } from '../core/paths.ts';
import { isPlatformErrno, readFileString, type PlatformRun } from '../effect/platform.ts';
import { platformRunOf } from './platform-run.ts';
import type { DevPlatformRuntime } from './platform-runtime.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import {
  defaultCommandRunner,
  installBundle as defaultInstallBundle,
  publicHostRoot,
  type InstallBundleOptions,
  type InstallCommandRunner,
  type DevInstallHost,
  type InstallResult,
} from '../install/install.ts';
import {
  uninstallBundle as defaultUninstallBundle,
  type UninstallBundleOptions,
} from '../install/uninstall.ts';
import { withCodexAppServer } from './codex-app-server.ts';
import { devProxyServerCommand } from './dev-proxy-command.ts';
import {
  subscribeToEpochAdoption,
  type EpochAdoptionSource,
} from './epoch-adoption-policy.ts';
import type { EpochReference, EpochStore } from './epoch-store.ts';
import type { ProjectEventHub, ProjectEventSubscription } from './events.ts';

export const DEV_INSTALL_MARKER = '.agent-bundle-dev.json';
const DEV_INSTALL_STATE = '.agent-bundle-dev';

interface EpochReferenceSource {
  acquireEpochReference(epochId: string): Promise<Pick<EpochReference, 'close' | 'epoch' | 'root'>>;
}

export interface DevHostInstallManagerOptions {
  readonly adoption?: EpochAdoptionSource;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly epochStore: EpochReferenceSource | Pick<EpochStore, 'acquireEpochReference'>;
  readonly eventHub: ProjectEventHub;
  readonly home?: string;
  readonly hosts: readonly DevInstallHost[];
  readonly installBundle?: (options: InstallBundleOptions) => Promise<InstallResult>;
  readonly projectRoot: string;
  readonly uninstallBundle?: (options: UninstallBundleOptions) => Promise<unknown>;
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
}

interface InstalledDevHost {
  readonly destination: string;
  readonly host: DevInstallHost;
  readonly plugin?: string;
  epochId: string;
}

interface DevInstallMarker {
  readonly epochId: string;
  readonly host: DevInstallHost;
  readonly projectRoot: string;
  readonly schemaVersion: 1;
}

interface PublishedEntriesManifest {
  readonly entries: readonly string[];
  readonly epochId: string;
  readonly schemaVersion: 1;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rewriteMcpDocument = async (
  bundleRoot: string,
  documentPath: string,
  host: DevInstallHost,
  projectRoot: string,
  run: PlatformRun,
): Promise<void> => {
  const path = join(bundleRoot, documentPath);
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
  host: DevInstallHost,
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
  host: DevInstallHost,
  epochId: string,
  projectRoot: string,
  run: PlatformRun,
): Promise<Readonly<{
  readonly cleanup: () => Promise<void>;
  readonly marketplaceDocument?: string;
  readonly root: string;
}>> => {
  const parent = await mkdtemp(join(tmpdir(), `agent-bundle-dev-${host}-`));
  const root = join(parent, 'bundle');
  try {
    await cp(source, root, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
    const manifestRead = await readArtifactManifest(root);
    if (manifestRead.status !== 'ok') {
      throw new Error(`Development install requires a valid artifact manifest at ${manifestRead.path}.`);
    }
    const projection = manifestRead.manifest.projections.find(
      (projection) => projection.builtInHost === host,
    );
    const mcpDocument = projection?.documents.mcp;
    if (mcpDocument !== undefined) {
      await rewriteMcpDocument(root, mcpDocument, host, projectRoot, run);
    }
    await run(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(
      join(root, DEV_INSTALL_MARKER),
      `${stableJson(marker(epochId, host, projectRoot))}\n`,
    )));
    await reindexArtifactManifest(root, {
      added: [{ kind: 'generated', path: DEV_INSTALL_MARKER }],
      ...(mcpDocument === undefined ? {} : { changed: [mcpDocument] }),
    });
    return Object.freeze({
      cleanup: () => rm(parent, { force: true, recursive: true }),
      ...(projection?.documents.marketplace === undefined
        ? {}
        : { marketplaceDocument: projection.documents.marketplace }),
      root,
    });
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};

const stableDevBundle = (projectRoot: string, host: DevInstallHost): string =>
  join(projectRoot, '.agent-bundle', 'dev', host);

const ensureStableDevBundle = async (preparedRoot: string, stableRoot: string): Promise<void> => {
  const temporary = `${stableRoot}.stage-${process.pid}-${crypto.randomUUID()}`;
  const previous = `${stableRoot}.previous-${process.pid}-${crypto.randomUUID()}`;
  try {
    await cp(preparedRoot, temporary, { errorOnExist: true, force: false, recursive: true, verbatimSymlinks: true });
    if (await pathExists(stableRoot)) await rename(stableRoot, previous);
    await rename(temporary, stableRoot);
  } catch (error) {
    if (!await pathExists(stableRoot) && await pathExists(previous)) await rename(previous, stableRoot);
    throw error;
  } finally {
    await rm(temporary, { force: true, recursive: true });
    await rm(previous, { force: true, recursive: true });
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
  join(destination, DEV_INSTALL_STATE, 'generations', epochId);

const publishedEntriesPath = (destination: string): string =>
  join(destination, DEV_INSTALL_STATE, 'published.json');

const entryNames = async (root: string): Promise<readonly string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) {
      throw new TypeError(`Development bundle entry ${JSON.stringify(entry.name)} is not a regular file or directory.`);
    }
    if (entry.name === DEV_INSTALL_STATE) {
      throw new TypeError(`Development bundle entry ${JSON.stringify(entry.name)} is reserved for manager state.`);
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => left.localeCompare(right));
};

const readPublishedEntries = async (destination: string): Promise<PublishedEntriesManifest | undefined> => {
  const path = publishedEntriesPath(destination);
  let document: unknown;
  try {
    if (!(await lstat(path)).isFile()) {
      throw new TypeError(`Development published-entries manifest ${JSON.stringify(path)} is not a regular file.`);
    }
    document = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (
    !isRecord(document) ||
    document.schemaVersion !== 1 ||
    typeof document.epochId !== 'string' ||
    !isPortablePathSegment(document.epochId) ||
    !Array.isArray(document.entries) ||
    !document.entries.every(
      (entry) => typeof entry === 'string' && entry !== DEV_INSTALL_STATE && isPortablePathSegment(entry),
    ) ||
    new Set(document.entries).size !== document.entries.length
  ) {
    return undefined;
  }
  return Object.freeze({
    entries: Object.freeze([...document.entries]),
    epochId: document.epochId,
    schemaVersion: 1,
  });
};

const writePublishedEntries = async (
  destination: string,
  epochId: string,
  entries: readonly string[],
): Promise<void> => {
  const path = publishedEntriesPath(destination);
  const temporary = `${path}.${process.pid}-${crypto.randomUUID()}.tmp`;
  await mkdir(join(destination, DEV_INSTALL_STATE), { recursive: true });
  try {
    await writeFile(temporary, `${stableJson({ entries, epochId, schemaVersion: 1 })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

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
  published: string[] = [],
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
    published.push(entry.name);
  }
};

const reconcilePublishedEntries = async (
  destination: string,
  previous: PublishedEntriesManifest | undefined,
  epochId: string,
  nextEntries: readonly string[],
  publish: ((published: string[]) => Promise<void>) | undefined,
  afterManifest?: () => Promise<void>,
): Promise<void> => {
  const previousEntries = new Set(previous?.entries ?? []);
  const stale = [...previousEntries].filter((entry) => !nextEntries.includes(entry));
  const previousGeneration = previous === undefined ? undefined : generationRoot(destination, previous.epochId);
  const canRepublishPrevious = previousGeneration !== undefined && await pathExists(previousGeneration);
  const needsBackup = !canRepublishPrevious && (
    publish === undefined ? stale.length > 0 : previousEntries.size > 0
  );
  const backup = needsBackup
    ? join(destination, DEV_INSTALL_STATE, `rollback-${process.pid}-${crypto.randomUUID()}`)
    : undefined;
  const backupEntries = backup === undefined
    ? []
    : publish === undefined ? stale : [...previousEntries];
  if (backup !== undefined) await mkdir(backup, { recursive: true });
  const published: string[] = [];
  let manifestPublished = false;
  try {
    for (const entry of canRepublishPrevious ? stale : backupEntries) {
      const path = join(destination, entry);
      if (backup === undefined) {
        await rm(path, { force: true, recursive: true });
      } else {
        try {
          await rename(path, join(backup, entry));
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
    }
    await publish?.(published);
    await writePublishedEntries(destination, epochId, nextEntries);
    manifestPublished = true;
    await afterManifest?.();
  } catch (error) {
    try {
      for (const entry of published) {
        if (backup !== undefined || !previousEntries.has(entry)) {
          await rm(join(destination, entry), { force: true, recursive: true });
        }
      }
      if (canRepublishPrevious && previous !== undefined) {
        await publishInstalledGeneration(destination, previous.epochId);
      } else if (backup !== undefined) {
        for (const entry of backupEntries) {
          const path = join(backup, entry);
          if (await pathExists(path)) await rename(path, join(destination, entry));
        }
      }
      if (manifestPublished) {
        if (previous === undefined) {
          await rm(publishedEntriesPath(destination), { force: true });
        } else {
          await writePublishedEntries(destination, previous.epochId, previous.entries);
        }
      }
      if (backup !== undefined) await rm(backup, { force: true, recursive: true });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Failed to roll back development host publication.', {
        cause: rollbackError,
      });
    }
    throw error;
  }
  if (backup !== undefined) await rm(backup, { force: true, recursive: true }).catch(() => undefined);
};

const pruneGenerations = async (
  destination: string,
  retainedEpochIds: readonly string[],
): Promise<void> => {
  const root = join(destination, DEV_INSTALL_STATE, 'generations');
  const retained = new Set(retainedEpochIds);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !retained.has(entry.name)) {
      await rm(join(root, entry.name), { force: true, recursive: true });
    }
  }
};

const syncDiagnostic = (host: DevInstallHost, epochId: string, error: unknown): Diagnostic => Object.freeze({
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
  readonly #commandRunner: InstallCommandRunner;
  readonly #epochStore: EpochReferenceSource;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #eventHub: ProjectEventHub;
  readonly #home: string | undefined;
  readonly #hosts: readonly DevInstallHost[];
  readonly #installBundle: (options: InstallBundleOptions) => Promise<InstallResult>;
  readonly #installed = new Map<DevInstallHost, InstalledDevHost>();
  readonly #projectRoot: string;
  readonly #run: PlatformRun;
  readonly #uninstallBundle: (options: UninstallBundleOptions) => Promise<unknown>;
  #closed = false;
  #pending: Promise<void> = Promise.resolve();
  #subscription: ProjectEventSubscription | undefined;

  constructor(options: DevHostInstallManagerOptions) {
    this.#adoption = options.adoption;
    this.#environment = Object.freeze({ ...(options.environment ?? process.env) });
    this.#commandRunner = Object.freeze({
      run: (
        command: string,
        args: readonly string[],
        commandOptions: { readonly cwd: string; readonly environment?: Readonly<NodeJS.ProcessEnv> },
      ) => defaultCommandRunner.run(command, args, {
        ...commandOptions,
        environment: this.#environment,
      }),
    });
    this.#epochStore = options.epochStore;
    this.#eventHub = options.eventHub;
    this.#home = options.home ?? homedir();
    this.#hosts = Object.freeze([...new Set(options.hosts)]);
    this.#installBundle = options.installBundle ?? defaultInstallBundle;
    this.#projectRoot = resolve(options.projectRoot);
    this.#run = platformRunOf(options.platformRuntime);
    this.#uninstallBundle = options.uninstallBundle ?? defaultUninstallBundle;
  }

  attached(host: DevInstallHost): Readonly<{ readonly destination: string; readonly epochId: string }> | undefined {
    const installed = this.#installed.get(host);
    return installed === undefined || installed.epochId.length === 0
      ? undefined
      : Object.freeze({ destination: installed.destination, epochId: installed.epochId });
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
    const failures: unknown[] = [];
    for (const host of this.#hosts) {
      if (host === 'cursor' || !this.#installed.has(host)) continue;
      const root = stableDevBundle(this.#projectRoot, host);
      try {
        await this.#uninstallBundle({
          commandRunner: this.#commandRunner,
          environment: this.#environment,
          force: true,
          from: root,
          ...(this.#home === undefined ? {} : { home: this.#home }),
          host,
          scope: 'user',
        });
        await rm(root, { force: true, recursive: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to remove development host installs.');
  }

  async #syncHost(epochRoot: string, epochId: string, host: DevInstallHost): Promise<void> {
    // Every selected host installs from the composite epoch root (#555).
    const prepared = await prepareDevBundle(epochRoot, host, epochId, this.#projectRoot, this.#run);
    try {
      const source = host === 'cursor' ? prepared.root : stableDevBundle(this.#projectRoot, host);
      let installed = this.#installed.get(host);
      if (host !== 'cursor' && (installed === undefined || host === 'codex')) {
        await ensureStableDevBundle(prepared.root, source);
      }
      if (installed === undefined) {
        const result = await this.#installBundle({
          commandRunner: this.#commandRunner,
          environment: this.#environment,
          from: source,
          ...(this.#home === undefined ? {} : { home: this.#home }),
          host,
          ...(host === 'cursor' ? {} : { replace: true }),
          scope: 'user',
        });
        installed = {
          destination: installedDestination(result, this.#home, this.#environment),
          epochId: '',
          host,
          ...(host === 'codex' ? { plugin: result.plugin } : {}),
        };
        this.#installed.set(host, installed);
      }
      const previousEpochId = installed.epochId;
      const previousPublished = await readPublishedEntries(installed.destination);
      const nextEntries = await entryNames(prepared.root);
      let generationPublished = false;
      try {
        let refreshedByAppServer = false;
        if (host === 'codex') {
          refreshedByAppServer = await withCodexAppServer(
            publicHostRoot('codex', this.#environment, this.#home ?? homedir()),
            async (request) => {
              const plugin = installed.plugin;
              const marketplaceDocument = prepared.marketplaceDocument;
              if (plugin === undefined || marketplaceDocument === undefined) {
                throw new TypeError('Cannot refresh a Codex development install with no plugin marketplace identity.');
              }
              await reconcilePublishedEntries(
                installed.destination,
                previousPublished,
                epochId,
                nextEntries,
                undefined,
                async () => {
                  await request('plugin/install', {
                    marketplacePath: join(source, marketplaceDocument),
                    pluginName: plugin,
                  });
                },
              );
              return true;
            },
          ) === true;
        }
        if (!refreshedByAppServer) {
          await installGeneration(installed.destination, prepared.root, epochId);
          await reconcilePublishedEntries(
            installed.destination,
            previousPublished,
            epochId,
            nextEntries,
            (published) => publishInstalledGeneration(installed.destination, epochId, published),
          );
          generationPublished = true;
        }
      } catch (error) {
        if (previousEpochId.length > 0 && await pathExists(generationRoot(installed.destination, previousEpochId))) {
          await publishInstalledGeneration(installed.destination, previousEpochId);
        }
        await rm(generationRoot(installed.destination, epochId), { force: true, recursive: true });
        throw error;
      }
      installed.epochId = epochId;
      if (generationPublished) {
        await pruneGenerations(
          installed.destination,
          previousEpochId.length === 0 ? [epochId] : [previousEpochId, epochId],
        );
      }
    } finally {
      await prepared.cleanup();
    }
  }
}
