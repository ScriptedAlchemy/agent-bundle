import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { exists } from '../src/core/paths.ts';
import { pathTokens, pluginRootEnvAnchor } from '../src/core/types.ts';
import { resolveWebLaunch, WebLaunchError, webPluginDataDirectory } from '../src/web-host/launch.ts';
import type { WebManifestApp } from '../src/web-host/manifest.ts';

const roots: string[] = [];

const artifactRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-launch-')));
  roots.push(root);
  await mkdir(join(root, 'mcp'), { recursive: true });
  await writeFile(join(root, 'mcp', 'mcp-status-073c1634.mjs'), 'export {};\n');
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const app = (overrides: Partial<WebManifestApp> = {}): WebManifestApp => ({
  allow: [],
  app: 'status/status',
  entry: 'mcp/mcp-status-073c1634.mjs',
  env: {},
  name: 'status',
  resourceUri: 'ui://status/status.html',
  server: 'status',
  ...overrides,
});

describe('resolveWebLaunch', () => {
  it('runs the artifact-relative entry under this Node from the plugin root', async () => {
    const root = await artifactRoot();
    const launch = await resolveWebLaunch({ app: app(), env: {}, pluginRoot: root });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual([join(root, 'mcp', 'mcp-status-073c1634.mjs')]);
    expect(launch.cwd).toBe(root);
    expect(Object.isFrozen(launch)).toBe(true);
    expect(Object.isFrozen(launch.env)).toBe(true);
  });

  it('normalizes the plugin root before anchoring anything on it', async () => {
    const root = await artifactRoot();
    const launch = await resolveWebLaunch({ app: app(), env: {}, pluginRoot: `${root}/mcp/..` });
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
      const failure = await resolveWebLaunch({ app: app({ entry }), env: {}, pluginRoot: root }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WebLaunchError);
      if (!(failure instanceof WebLaunchError)) throw failure;
      expect(failure.code).toBe('entry-outside-root');
      expect(failure.message).toContain(JSON.stringify(entry));
      expect(failure.message).toContain('status/status');
      expect(failure.message).toContain(root);
    });

    it('refuses an entry the artifact does not contain instead of letting the spawn fail', async () => {
      const root = await artifactRoot();
      const failure = await resolveWebLaunch({ app: app({ entry: 'mcp/mcp-status-deadbeef.mjs' }), env: {}, pluginRoot: root })
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(WebLaunchError);
      if (!(failure instanceof WebLaunchError)) throw failure;
      expect(failure.code).toBe('entry-missing');
      expect(failure.message).toContain(join(root, 'mcp', 'mcp-status-deadbeef.mjs'));
      expect(failure.message).toContain('rebuild');
    });
  });

  describe('path tokens in declared env', () => {
    it('expands plugin-root, plugin-data, and workspace-root, and creates the per-server data directory', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app: app({
          env: {
            CACHE: `${pathTokens.pluginData}/cache`,
            HOME_DIR: pathTokens.pluginRoot,
            MIXED: `${pathTokens.pluginRoot}:${pathTokens.workspaceRoot}`,
            PLAIN: 'kept as is',
          },
        }),
        env: {},
        pluginRoot: root,
      });
      const data = webPluginDataDirectory(root, 'status');
      expect(data).toBe(join(root, '.agent-bundle', 'web', 'status'));
      expect(launch.env['CACHE']).toBe(`${data}/cache`);
      expect(launch.env['HOME_DIR']).toBe(root);
      expect(launch.env['MIXED']).toBe(`${root}:${process.cwd()}`);
      expect(launch.env['PLAIN']).toBe('kept as is');
      expect((await stat(data)).isDirectory()).toBe(true);
    });

    it('creates no data directory when no declared value names plugin-data', async () => {
      const root = await artifactRoot();
      await resolveWebLaunch({ app: app({ env: { HOME_DIR: pathTokens.pluginRoot } }), env: {}, pluginRoot: root });
      expect(await exists(join(root, '.agent-bundle'))).toBe(false);
    });

    it('keeps a hostile server name inside the data root', async () => {
      const root = await artifactRoot();
      const data = webPluginDataDirectory(root, '../shared');
      expect(data.startsWith(join(root, '.agent-bundle', 'web') + '/')).toBe(true);
      expect(data).not.toContain('..');
    });
  });

  describe('environment precedence', () => {
    it('inherits string values only, lets declared entries win, and injects the plugin-root anchor', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app: app({ env: { SHARED: 'declared', STATUS_TOKEN: 'from-manifest' } }),
        env: { INHERITED: 'yes', SHARED: 'inherited', UNSET: undefined },
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
        app: app({ env: { [pluginRootEnvAnchor]: `${pathTokens.pluginRoot}/nested` } }),
        env: { [pluginRootEnvAnchor]: '/somewhere/else' },
        pluginRoot: root,
      });
      expect(launch.env[pluginRootEnvAnchor]).toBe(`${root}/nested`);
    });

    it('overrides an exported variable with the declared one, as a host launch does', async () => {
      const root = await artifactRoot();
      const launch = await resolveWebLaunch({
        app: app({ env: { [pluginRootEnvAnchor]: 'declared-root' } }),
        env: { [pluginRootEnvAnchor]: 'exported-root' },
        pluginRoot: root,
      });
      expect(launch.env[pluginRootEnvAnchor]).toBe('declared-root');
    });
  });
});
