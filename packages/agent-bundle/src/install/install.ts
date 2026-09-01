import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { Effect } from 'effect';

import { DiagnosticError } from '../core/diagnostics.ts';
import { runPromise } from '../effect/boundary.ts';
import { liftPromise } from '../effect/lift.ts';

export type InstallHost = 'claude' | 'codex' | 'cursor';
export type InstallScope = 'local' | 'project' | 'user';

export interface InstallCommandResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface InstallCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<InstallCommandResult>;
}

export interface InstallBundleOptions {
  readonly commandRunner?: InstallCommandRunner;
  readonly from: string;
  readonly home?: string;
  readonly host: InstallHost;
  readonly scope?: InstallScope;
}

export interface InstallResult {
  readonly bundleRoot: string;
  readonly destination?: string;
  readonly host: InstallHost;
  readonly marketplace?: string;
  readonly plugin: string;
  readonly state: 'already-installed' | 'installed';
  readonly version: string;
}

interface PluginIdentity {
  readonly bundleRoot: string;
  readonly marketplace?: string;
  readonly plugin: string;
  readonly version: string;
}

const failure = (
  code: string,
  message: string,
  target: InstallHost,
): DiagnosticError => new DiagnosticError([{
  code,
  message,
  severity: 'error',
  target,
}]);

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
};

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
      throw new TypeError(`Unknown install host ${String(exhaustive)}.`);
    }
  }
};

const marketplacePath = (host: Exclude<InstallHost, 'cursor'>): string =>
  host === 'claude'
    ? '.claude-plugin/marketplace.json'
    : '.agents/plugins/marketplace.json';

const readRecord = async (
  path: string,
  host: InstallHost,
  kind: string,
): Promise<Record<string, unknown>> => {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw failure('AB7001', `Cannot read a valid ${kind} at ${JSON.stringify(path)}.`, host);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('AB7001', `${kind} at ${JSON.stringify(path)} must be a JSON object.`, host);
  }
  return value as Record<string, unknown>;
};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  host: InstallHost,
  kind: string,
): string => {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw failure('AB7001', `${kind} must declare a nonempty ${key}.`, host);
  }
  return value;
};

const resolveBundleRoot = async (from: string, host: InstallHost): Promise<string> => {
  const root = resolve(from);
  const manifest = hostManifestPath(host);
  if (await exists(join(root, manifest))) return root;
  const targetRoot = join(root, host);
  if (await exists(join(targetRoot, manifest))) return targetRoot;
  throw failure(
    'AB7001',
    `No ${host} bundle manifest was found in ${JSON.stringify(root)} or its ${JSON.stringify(host)} target directory.`,
    host,
  );
};

const readIdentity = async (from: string, host: InstallHost): Promise<PluginIdentity> => {
  const bundleRoot = await resolveBundleRoot(from, host);
  const pluginDocument = await readRecord(join(bundleRoot, hostManifestPath(host)), host, `${host} plugin manifest`);
  const plugin = readString(pluginDocument, 'name', host, `${host} plugin manifest`);
  const version = readString(pluginDocument, 'version', host, `${host} plugin manifest`);
  if (
    host === 'cursor' &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plugin) || plugin.length > 64)
  ) {
    throw failure('AB7001', `Cursor plugin name ${JSON.stringify(plugin)} is not a safe local plugin name.`, host);
  }
  if (host === 'cursor') return { bundleRoot, plugin, version };
  const marketplaceDocument = await readRecord(
    join(bundleRoot, marketplacePath(host)),
    host,
    `${host} marketplace`,
  );
  return {
    bundleRoot,
    marketplace: readString(marketplaceDocument, 'name', host, `${host} marketplace`),
    plugin,
    version,
  };
};

const defaultCommandRunner: InstallCommandRunner = Object.freeze({
  run: (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
  ): Promise<InstallCommandResult> => new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      if (error !== null && isErrno(error, 'ENOENT')) {
        reject(error);
        return;
      }
      resolvePromise({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stderr,
        stdout,
      });
    });
  }),
});

const runHostCommand = async (
  runner: InstallCommandRunner,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  args: readonly string[],
): Promise<void> => {
  let result: InstallCommandResult;
  try {
    result = await runner.run(host, args, { cwd: identity.bundleRoot });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure('AB7002', `${host} is not installed or is not available on PATH.`, host);
    }
    throw error;
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw failure('AB7004', `${host} plugin installation failed: ${detail}`, host);
  }
};

const installPublicCli = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  host: Exclude<InstallHost, 'cursor'>,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (host === 'codex' && scope !== 'user') {
    throw failure('AB7003', `Codex plugin installation supports only user scope, not ${scope}.`, host);
  }
  const marketplace = identity.marketplace;
  if (marketplace === undefined) {
    throw failure('AB7001', `${host} bundle has no marketplace identity.`, host);
  }
  const runner = options.commandRunner ?? defaultCommandRunner;
  await runHostCommand(runner, identity, host, [
    'plugin',
    'marketplace',
    'add',
    identity.bundleRoot,
  ]);
  await runHostCommand(runner, identity, host, host === 'claude'
    ? ['plugin', 'install', `${identity.plugin}@${marketplace}`, '--scope', scope]
    : ['plugin', 'add', `${identity.plugin}@${marketplace}`]);
  return {
    bundleRoot: identity.bundleRoot,
    host,
    marketplace,
    plugin: identity.plugin,
    state: 'installed',
    version: identity.version,
  };
};

const treeHash = async (root: string): Promise<string> => {
  const hash = createHash('sha256');
  const visit = async (relativePath: string): Promise<void> => {
    const path = join(root, relativePath);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error(`Refusing unsupported filesystem entry ${JSON.stringify(relativePath || '.')}.`);
    }
    if (metadata.isDirectory()) {
      for (const name of (await readdir(path)).sort((left, right) => left.localeCompare(right))) {
        await visit(join(relativePath, name));
      }
      return;
    }
    hash.update(relativePath.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  };
  for (const name of (await readdir(root)).sort((left, right) => left.localeCompare(right))) {
    await visit(name);
  }
  return hash.digest('hex');
};

const readInstalledVersion = async (destination: string): Promise<string | undefined> => {
  for (const manifest of ['.cursor-plugin/plugin.json', 'plugin.json']) {
    try {
      const document = JSON.parse(await readFile(join(destination, manifest), 'utf8')) as unknown;
      if (
        document !== null &&
        typeof document === 'object' &&
        !Array.isArray(document) &&
        typeof (document as { readonly version?: unknown }).version === 'string'
      ) {
        return (document as { readonly version: string }).version;
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  }
  return undefined;
};

const installCursor = async (
  options: InstallBundleOptions,
  identity: PluginIdentity,
  scope: InstallScope,
): Promise<InstallResult> => {
  if (scope !== 'user') {
    throw failure('AB7003', `Cursor local plugin installation supports only user scope, not ${scope}.`, 'cursor');
  }
  const cursorRoot = join(options.home ?? homedir(), '.cursor');
  let cursorMetadata: Awaited<ReturnType<typeof lstat>>;
  try {
    cursorMetadata = await lstat(cursorRoot);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw failure('AB7002', `Cursor is not installed in ${JSON.stringify(cursorRoot)}.`, 'cursor');
    }
    throw error;
  }
  if (!cursorMetadata.isDirectory()) {
    throw failure('AB7002', `Cursor home ${JSON.stringify(cursorRoot)} is not a directory.`, 'cursor');
  }
  const installRoot = join(cursorRoot, 'plugins', 'local');
  const destination = join(installRoot, identity.plugin);
  try {
    await treeHash(identity.bundleRoot);
    await mkdir(installRoot, { recursive: true });
    if (await exists(destination)) {
      const currentVersion = await readInstalledVersion(destination);
      if (currentVersion !== undefined && currentVersion !== identity.version) {
        throw failure(
          'AB7005',
          `Refusing version collision at ${destination}: found ${currentVersion}, requested ${identity.version}.`,
          'cursor',
        );
      }
      if (await treeHash(identity.bundleRoot) === await treeHash(destination)) {
        return {
          bundleRoot: identity.bundleRoot,
          destination,
          host: 'cursor',
          plugin: identity.plugin,
          state: 'already-installed',
          version: identity.version,
        };
      }
      throw failure('AB7005', `Refusing content collision at ${destination}.`, 'cursor');
    }
    const stageParent = await mkdtemp(join(installRoot, `.${basename(destination)}.stage-`));
    const stage = join(stageParent, 'bundle');
    try {
      await cp(identity.bundleRoot, stage, {
        errorOnExist: true,
        force: false,
        recursive: true,
        verbatimSymlinks: true,
      });
      await treeHash(stage);
      await rename(stage, destination);
    } finally {
      await rm(stageParent, { force: true, recursive: true });
    }
    return {
      bundleRoot: identity.bundleRoot,
      destination,
      host: 'cursor',
      plugin: identity.plugin,
      state: 'installed',
      version: identity.version,
    };
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw failure(
      'AB7004',
      error instanceof Error ? error.message : String(error),
      'cursor',
    );
  }
};

const installProgram = Effect.fnUntraced(function*(
  options: InstallBundleOptions,
): Effect.fn.Return<InstallResult, unknown> {
  const scope = options.scope ?? 'user';
  const identity = yield* liftPromise(() => readIdentity(options.from, options.host));
  switch (options.host) {
    case 'claude':
      return yield* liftPromise(() => installPublicCli(options, identity, 'claude', scope));
    case 'codex':
      return yield* liftPromise(() => installPublicCli(options, identity, 'codex', scope));
    case 'cursor':
      return yield* liftPromise(() => installCursor(options, identity, scope));
    default: {
      const exhaustive: never = options.host;
      return yield* Effect.fail(failure('AB7000', `Unsupported install host ${String(exhaustive)}.`, options.host));
    }
  }
});

export const installBundle = (
  options: InstallBundleOptions,
): Promise<InstallResult> => runPromise(installProgram(options));
