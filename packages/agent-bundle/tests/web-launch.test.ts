import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { pluginStateSegment } from '@agent-bundle/runtime';
import { afterEach, describe, expect, it } from '@rstest/core';

import { exists } from '../src/core/paths.ts';
import { pathTokens, pluginRootEnvAnchor } from '../src/core/types.ts';
import { installedWebDataRoot } from '../src/install/state-root.ts';
import { resolveWebLaunch, WebLaunchError, webPluginDataDirectory } from '../src/web-host/launch.ts';
import type { ArtifactManifestLaunch, WebManifestApp } from '../src/web-host/manifest.ts';

const roots: string[] = [];

const artifactRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-launch-')));
  roots.push(root);
  await mkdir(join(root, 'mcp'), { recursive: true });
  await writeFile(join(root, 'mcp', 'mcp-status-073c1634.mjs'), 'export {};\n');
  await writeFile(join(root, 'status.json'), '{}\n');
  return root;
};

const homeRoot = async (): Promise<string> => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-home-')));
  roots.push(home);
  return home;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }));
});

const app: WebManifestApp = {
  allow: [],
  app: 'status/status',
  name: 'status',
  resourceUri: 'ui://status/status.html',
  server: 'status',
};

const launchRecord = (overrides: Partial<ArtifactManifestLaunch> = {}): ArtifactManifestLaunch => ({
  args: [],
  entry: 'mcp/mcp-status-073c1634.mjs',
  env: {},
  ...overrides,
});

describe('resolveWebLaunch', () => {
  it('runs the artifact-relative entry under this Node from the plugin root', async () => {
    const root = await artifactRoot();
    const launch = await resolveWebLaunch({ app, env: {}, launch: launchRecord(), pluginRoot: root });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([join(root, 'mcp', 'mcp-status-073c1634.mjs')]);
    expect(launch.cwd).toBe(root);
    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch.env)).toBe(true);
  });

  it('passes the launch arguments after the entry: artifact paths under the root, literals with tokens expanded', async () => {
    const root = await artifactRoot();
    const home = await homeRoot();
    const launch = await resolveWebLaunch({
      app,
      env: {},
      home,
      launch: launchRecord({
        args: [
          { kind: 'literal', value: '--config' },
          { kind: 'artifact', path: 'status.json' },
          { kind: 'literal', value: `--cache=${pathTokens.pluginData}/cache` },
          { kind: 'literal', value: './looks/like/a/path' },
        ],
      }),
      pluginRoot: root,
    });
    expect(launch.args).toEqual([
      join(root, 'mcp', 'mcp-status-073c1634.mjs'),
      '--config',
      join(root, 'status.json'),
      `--cache=${webPluginDataDirectory(root, 'status', home)}/cache`,
      './looks/like/a/path',
    ]);
  });

  it.each([
    ['artifact argument', { args: [{ kind: 'artifact', path: '../outside.json' }] }, 'entry-outside-root', '"../outside.json"'],
    ['artifact argument', { args: [{ kind: 'artifact', path: 'missing.json' }] }, 'entry-missing', join('missing.json')],
    ['worker', { worker: '../worker.mjs' }, 'entry-outside-root', '"../worker.mjs"'],
    ['worker', { worker: 'mcp/missing-flight.mjs' }, 'entry-missing', join('mcp', 'missing-flight.mjs')],
  ] as const)('holds a %s to the same containment as the entry', async (_role, overrides, code, detail) => {
    const root = await artifactRoot();
    const failure = await resolveWebLaunch({ app, env: {}, launch: launchRecord(overrides), pluginRoot: root })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WebLaunchError);
    if (!(failure instanceof WebLaunchError)) throw failure;
    expect(failure.code).toBe(code);
    expect(failure.message).toContain(detail);
  });

  it('normalizes the plugin root before anchoring anything on it', async () => {
    const root = await artifactRoot();
    const launch = await resolveWebLaunch({ app, env: {}, launch: launchRecord(), pluginRoot: `${root}/mcp/..` });
    expect(launch.cwd).toBe(root);
    expect(launch.args).toEqual([join(root, 'mcp', 'mcp-status-073c1634.mjs')]);
    expect(launch.env[pluginRootEnvAnchor]).toBe(root);
  });

  describe('entry containment', () => {
    it.each([
      ['../outside.mjs'],
      ['mcp/../../outside.mjs'],
      ['/etc/passwd'],
      ['..'],
      [''],
    ])('refuses entry %j, which cannot be a file of this artifact', async (entry) => {
      const root = await artifactRoot();
      const failure = await resolveWebLaunch({ app, env: {}, launch: launchRecord({ entry }), pluginRoot: root })
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WebLaunchError);
      if (!(failure instanceof WebLaunchError)) throw failure;
      expect(failure.code).toBe('entry-outside-root');
      expect(failure.message).toContain(JSON.stringify(entry));
      expect(failure.message).toContain('status/status');
      expect(failure.message).toContain(root);
    });

    it('refuses an entry the artifact does not contain instead of letting the spawn fail', async () => {
      const root = await artifactRoot();
      const failure = await resolveWebLaunch({
        app,
        env: {},
        launch: launchRecord({ entry: 'mcp/mcp-status-deadbeef.mjs' }),
        pluginRoot: root,
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WebLaunchError);
      if (!(failure instanceof WebLaunchError)) throw failure;
      expect(failure.code).toBe('entry-missing');
      expect(failure.message).toContain(join(root, 'mcp', 'mcp-status-deadbeef.mjs'));
      expect(failure.message).toContain('rebuild');
    });
  });

  describe('path tokens in declared env', () => {
    it('expands plugin-root, plugin-data, and workspace-root, and creates the per-server data directory outside the artifact', async () => {
      const root = await artifactRoot();
      const home = await homeRoot();
      const launch = await resolveWebLaunch({
        app,
        env: {},
        home,
        launch: launchRecord({
          env: {
            CACHE: `${pathTokens.pluginData}/cache`,
            HOME_DIR: pathTokens.pluginRoot,
            MIXED: `${pathTokens.pluginRoot}:${pathTokens.workspaceRoot}`,
            PLAIN: 'kept as is',
          },
        }),
        pluginRoot: root,
      });
      const data = webPluginDataDirectory(root, 'status', home);
      expect(data.startsWith(join(home, '.agent-bundle', 'web-data') + '/')).toBe(true);
      expect(data.startsWith(root)).toBe(false);
      expect(data.endsWith('/status')).toBe(true);
      expect(launch.env['CACHE']).toBe(`${data}/cache`);
      expect(launch.env['HOME_DIR']).toBe(root);
      expect(launch.env['MIXED']).toBe(`${root}:${process.cwd()}`);
      expect(launch.env['PLAIN']).toBe('kept as is');
      expect((await stat(data)).isDirectory()).toBe(true);
      expect(await exists(join(root, '.agent-bundle'))).toBe(false);
    });

    it('keys the state on the resolved plugin root, so two installs never share it', async () => {
      const home = await homeRoot();
      const first = await artifactRoot();
      const second = await artifactRoot();
      expect(webPluginDataDirectory(first, 'status', home)).not.toBe(webPluginDataDirectory(second, 'status', home));
      expect(webPluginDataDirectory(first, 'status', home)).toBe(webPluginDataDirectory(`${first}/mcp/..`, 'status', home));
    });

    it('shares web-data derivation with uninstall through a symlinked plugin root', async () => {
      const home = await homeRoot();
      const root = await artifactRoot();
      const link = `${root}-link`;
      roots.push(link);
      await symlink(root, link, 'dir');
      expect(installedWebDataRoot(link, home))
        .toBe(dirname(webPluginDataDirectory(link, 'status', home)));
    });

    it('keys the web data directory on the same segment the runtime keys the state root on', async () => {
      // web-host/launch.ts never loads the optional `@agent-bundle/runtime`
      // peer, so its segment is a separate implementation of the runtime's
      // `pluginStateSegment`; this pins the two spellings together for a safe
      // basename (`<name>-<digest16>`) and an unsafe one (`plugin-<digest16>`).
      const home = await homeRoot();
      const safe = await artifactRoot();
      const unsafe = join(safe, '.un safe');
      await mkdir(unsafe);
      for (const root of [safe, unsafe]) {
        expect(webPluginDataDirectory(root, 'status', home))
          .toBe(join(home, '.agent-bundle', 'web-data', pluginStateSegment(root), 'status'));
      }
      expect(pluginStateSegment(safe)).toMatch(/^agent-bundle-web-launch-[^/]+-[0-9a-f]{16}$/u);
      expect(pluginStateSegment(unsafe)).toMatch(/^plugin-[0-9a-f]{16}$/u);
    });

    it('creates no data directory when no declared value names plugin-data', async () => {
      const root = await artifactRoot();
      const home = await homeRoot();
      await resolveWebLaunch({ app, env: {}, home, launch: launchRecord({ env: { HOME_DIR: pathTokens.pluginRoot } }), pluginRoot: root });
      expect(await exists(join(root, '.agent-bundle'))).toBe(false);
      expect(await exists(join(home, '.agent-bundle'))).toBe(false);
    });

    it('keeps a hostile server name inside the data root', async () => {
      const root = await artifactRoot();
      const home = await homeRoot();
      const data = webPluginDataDirectory(root, '../shared', home);
      expect(data.startsWith(join(home, '.agent-bundle', 'web-data') + '/')).toBe(true);
      expect(data).not.toContain('..');
    });

    it('launches from a read-only artifact when the server declares plugin-data state', async () => {
      const root = await artifactRoot();
      const home = await homeRoot();
      await chmod(root, 0o555);
      try {
        const launch = await resolveWebLaunch({
          app,
          env: {},
          home,
          launch: launchRecord({ env: { CACHE: `${pathTokens.pluginData}/cache` } }),
          pluginRoot: root,
        });
        const data = webPluginDataDirectory(root, 'status', home);
        expect(launch.env['CACHE']).toBe(`${data}/cache`);
        expect((await stat(data)).isDirectory()).toBe(true);
        expect(await readdir(root)).toEqual(['mcp', 'status.json']);
      } finally {
        await chmod(root, 0o755);
      }
    });
  });

  describe('environment precedence', () => {
    it('inherits string values only, lets declared entries win, and injects the plugin-root anchor', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app,
        env: { INHERITED: 'yes', SHARED: 'inherited', UNSET: undefined },
        launch: launchRecord({ env: { SHARED: 'declared', STATUS_TOKEN: 'from-manifest' } }),
        pluginRoot: root,
      });
      expect(launch.env).toEqual({
        [pluginRootEnvAnchor]: root,
        INHERITED: 'yes',
        SHARED: 'declared',
        STATUS_TOKEN: 'from-manifest',
      });
      expect(Object.hasOwn(launch.env, 'UNSET')).toBe(false);
    });

    it('lets a declared plugin-root anchor win over the injected one, tokens expanded', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app,
        env: { [pluginRootEnvAnchor]: '/somewhere/else' },
        launch: launchRecord({ env: { [pluginRootEnvAnchor]: `${pathTokens.pluginRoot}/nested` } }),
        pluginRoot: root,
      });
      expect(launch.env[pluginRootEnvAnchor]).toBe(`${root}/nested`);
    });

    it('overrides an exported variable with the declared one, as a host launch does', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app,
        env: { [pluginRootEnvAnchor]: 'exported-root' },
        launch: launchRecord({ env: { [pluginRootEnvAnchor]: 'declared-root' } }),
        pluginRoot: root,
      });
      expect(launch.env[pluginRootEnvAnchor]).toBe('declared-root');
    });
  });
});
