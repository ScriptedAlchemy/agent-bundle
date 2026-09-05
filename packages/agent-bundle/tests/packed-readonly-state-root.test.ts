import { execFile as executeFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { userDataStateRoot } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';

import { rstestWorkerRoot } from '../../../rstest.worker-isolation.ts';
import { exists } from '../src/core/paths.ts';
import { openPackedMcpServer, removeProjectSource } from '../src/test/packed.ts';
import { resolveWebLaunch } from '../src/web-host/launch.ts';
import { readWebManifestDocument } from '../src/web-host/manifest.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/durable-web-surface');
const pluginName = 'durable-web-surface-fixture';
const app = 'journal/status';

/** Every path below `root`, directories marked with a trailing slash and files with their size. */
const treeListing = async (root: string): Promise<readonly string[]> => {
  const listing: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (entry.isDirectory()) {
        listing.push(`${relativePath}/`);
        await walk(path);
      } else {
        listing.push(`${relativePath} ${String((await stat(path)).size)}`);
      }
    }
  };
  await walk(root);
  return listing.sort();
};

const chmodTree = async (root: string, modes: { readonly directory: number; readonly file: number }): Promise<void> => {
  await chmod(root, modes.directory);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await chmodTree(path, modes);
    else await chmod(path, modes.file);
  }
};

const stringEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

interface JournalResult {
  readonly entries: readonly { readonly note: string }[];
  readonly revision: number;
}

/**
 * The regression for #637: a workspace-durable plugin installed read-only.
 *
 * Before the state-root contract every artifact-hosted shell mounted SQLite
 * at `<artifact>/state`, so a plugin with durable `src/state.ts` could not
 * serve its first stateful tool call from an installed artifact nothing may
 * write beneath. The proof here is bytes and processes: the packed tarball
 * is installed into a clean consumer, the artifact is built, the source is
 * removed, the whole artifact tree is made read-only, and the generated MCP
 * entry is launched exactly the way `<plugin> web` launches it — the
 * code-root anchor set, no state env at all. The state must land under the
 * user state home (`XDG_STATE_HOME`, per worker in every pool) and be read
 * back by the artifact CLI bin and by a fresh MCP process, while the artifact
 * listing never changes.
 */
it('serves a state-writing tool from a read-only installed artifact without writing beneath it', async () => {
  const [agentBundle, runtime, markdownStream] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
  ]);
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-readonly-state-'));
  const project = join(consumer, 'project');
  const artifact = join(project, 'artifact');
  const home = join(project, '.home');
  const cursorRoot = join(home, '.cursor');
  const installedRoot = join(cursorRoot, 'plugins', 'local', pluginName);
  let readOnly = false;

  try {
    await cp(fixtureRoot, project, { recursive: true });
    await execFile('npm', ['install', ...cachedNpmInstallArguments,
      agentBundle.tarball,
      runtime.tarball,
      markdownStream.tarball,
      'react@19.2.8',
      'react-dom@19.2.8',
      'zod@4.4.3',
    ], { cwd: project, env: installedEnvironment() });
    const cli = join(project, 'node_modules', '.bin', 'agent-bundle');
    await execFile(cli, ['build', '--root', project, '--output', artifact], {
      cwd: project,
      env: installedEnvironment(),
    });
    const deletedSource = await removeProjectSource({ extraPaths: ['views'], projectRoot: project });
    expect(deletedSource.removed).toEqual(['agent-bundle.config.ts', 'src', 'views']);
    const env = stringEnvironment(installedEnvironment());
    delete env['AGENT_BUNDLE_PLUGIN_ROOT'];
    delete env['AGENT_BUNDLE_STATE_ROOT'];
    env['HOME'] = home;
    await mkdir(cursorRoot, { recursive: true });
    const installer = join(artifact, 'install.mjs');
    expect((await execFile(process.execPath, [installer], { cwd: artifact, env })).stdout)
      .toContain(`Installed ${pluginName}`);

    // An installed artifact a host may own read-only: no shell, worker, or bin
    // spawned below may create anything beneath it.
    await chmodTree(installedRoot, { directory: 0o555, file: 0o444 });
    readOnly = true;
    const listingBefore = await treeListing(installedRoot);
    expect(listingBefore).toEqual(expect.arrayContaining([
      expect.stringMatching(new RegExp(`^bin/${pluginName}\\.mjs \\d+$`, 'u')),
      'mcp/',
    ]));
    expect(listingBefore).not.toContain('state/');

    // No custom state env: the launch inherits the worker's XDG_STATE_HOME
    // (rstest.worker-isolation.ts), so the derived user-data state root stays
    // under the worker root and never touches the developer's home.
    const stateHome = env['XDG_STATE_HOME'];
    if (stateHome === undefined || !stateHome.startsWith(rstestWorkerRoot())) {
      throw new Error(`XDG_STATE_HOME must name a directory under the worker root ${rstestWorkerRoot()}; got ${String(stateHome)}. Is rstest.setup.ts isolating this worker?`);
    }

    // Resolve the launch the way `<plugin> web` does: the manifest's web
    // section names the App and its server, whose `executables.mcpServers[]`
    // launch record holds the artifact-relative entry, and resolveWebLaunch
    // anchors the code root without naming a state root.
    const document = await readWebManifestDocument(join(installedRoot, 'agent-bundle.manifest.json'));
    const declaredApp = document.web?.apps.find((candidate) => candidate.app === app);
    if (declaredApp === undefined) throw new Error(`The artifact manifest exposes no ${app} App: ${JSON.stringify(document.web)}`);
    const serverLaunch = document.launches.get(declaredApp.server);
    if (serverLaunch === undefined) throw new Error(`The artifact manifest has no launch record for ${declaredApp.server}.`);
    const launch = await resolveWebLaunch({ app: declaredApp, env, launch: serverLaunch, pluginRoot: installedRoot });
    expect(launch.command).toBe(process.execPath);
    expect(launch.cwd).toBe(installedRoot);
    expect(launch.env['AGENT_BUNDLE_PLUGIN_ROOT']).toBe(installedRoot);
    expect(launch.env['AGENT_BUNDLE_STATE_ROOT']).toBeUndefined();
    expect(launch.env['XDG_STATE_HOME']).toBe(stateHome);
    const [entry, ...args] = launch.args;
    if (entry === undefined) throw new Error('resolveWebLaunch returned no entry argument.');
    expect(entry.startsWith(join(installedRoot, 'mcp') + '/')).toBe(true);
    const openSession = () => openPackedMcpServer({
      args,
      cwd: launch.cwd,
      deletedSource,
      entry,
      env: launch.env,
      execPath: launch.command,
    });

    const firstSession = await openSession();
    try {
      expect(firstSession.provenance.proofLevel).toBe('packed-deleted-source');
      const tools = await firstSession.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('record');
      for (const [index, note] of ['first', 'second'].entries()) {
        const result = await firstSession.client.callTool({ arguments: { note }, name: 'record' });
        expect(result.isError, `record ${note} failed:\n${JSON.stringify(result.content)}\nserver stderr:\n${firstSession.stderr()}`).not.toBe(true);
        expect(result.structuredContent).toEqual({
          entries: ['first', 'second'].slice(0, index + 1).map((written) => ({ note: written })),
          revision: index + 1,
        });
      }
    } finally {
      await firstSession.close();
    }

    // Nothing landed beneath the read-only artifact; the SQLite kernel sits
    // under the user-data state root the child derived from the same code
    // root and inherited env.
    expect(await treeListing(installedRoot)).toEqual(listingBefore);
    expect(await exists(join(installedRoot, 'state'))).toBe(false);
    const stateRoot = userDataStateRoot(installedRoot, launch.env);
    expect(stateRoot.startsWith(join(stateHome, 'agent-bundle') + '/')).toBe(true);
    expect(await readdir(stateRoot)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.sqlite$/u),
    ]));

    // The artifact CLI bin derives the same code root from its own `bin/`
    // parent — no AGENT_BUNDLE_PLUGIN_ROOT, no state env — and reads the
    // entries the MCP process wrote.
    const bin = join(installedRoot, 'bin', `${pluginName}.mjs`);
    const cliRun = await execFile(process.execPath, [bin, 'entries', '--json'], { cwd: consumer, env });
    expect(JSON.parse(cliRun.stdout) as JournalResult).toEqual({
      entries: [{ note: 'first' }, { note: 'second' }],
      revision: 2,
    });

    // Restart durability: a fresh MCP process sees the CLI-visible state.
    const secondSession = await openSession();
    try {
      const result = await secondSession.client.callTool({ arguments: { note: 'third' }, name: 'record' });
      expect(result.isError, `record third failed:\n${JSON.stringify(result.content)}\nserver stderr:\n${secondSession.stderr()}`).not.toBe(true);
      expect(result.structuredContent).toEqual({
        entries: [{ note: 'first' }, { note: 'second' }, { note: 'third' }],
        revision: 3,
      });
    } finally {
      await secondSession.close();
    }
    expect(await treeListing(installedRoot)).toEqual(listingBefore);
    expect(await exists(join(installedRoot, 'state'))).toBe(false);
    expect(await readFile(join(installedRoot, 'agent-bundle.manifest.json'), 'utf8')).not.toContain('AGENT_BUNDLE_STATE_ROOT');

    await chmodTree(installedRoot, { directory: 0o755, file: 0o644 });
    readOnly = false;
    const kept = await execFile(process.execPath, [installer, '--uninstall', '--keep-data'], { cwd: artifact, env });
    expect(kept.stdout).toContain(`Data (keep): kept`);
    expect(kept.stdout).toContain(stateRoot);
    expect(await exists(stateRoot)).toBe(true);
    const purged = await execFile(
      process.execPath,
      [installer, '--uninstall', '--purge-data', '--confirm-purge'],
      { cwd: artifact, env },
    );
    expect(purged.stdout).toContain(`Data (purge): purged`);
    expect(purged.stdout).toContain(stateRoot);
    expect(await exists(stateRoot)).toBe(false);
  } finally {
    if (readOnly) await chmodTree(installedRoot, { directory: 0o755, file: 0o644 });
    await rm(consumer, { force: true, recursive: true });
  }
}, 300_000);
