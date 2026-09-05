import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { agent, runAgentRequest } from '../src/agent-request.js';
import {
  PLUGIN_ROOT_ENV_ANCHOR,
  PLUGIN_STATE_ROOT_ENV_ANCHOR,
  pluginStateSegment,
  resolvePluginRoot,
  userDataStateRoot,
  userStateHome,
} from '../src/plugin-root.js';

const digest16 = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 16);

describe('resolvePluginRoot (#468)', () => {
  const fallback = '/artifact/claude';

  it('anchors on an expanded AGENT_BUNDLE_PLUGIN_ROOT as the native source, with state one level below', () => {
    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator' }, fallback });

    expect(resolved).toEqual({
      identity: { source: 'native', state: 'available', value: { root: '/installs/curator', stateRoot: '/installs/curator/state' } },
      root: '/installs/curator',
      source: 'native',
      stateSource: 'derived',
      stateRoot: '/installs/curator/state',
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('takes the configured path exactly as written, whitespace included', () => {
    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: '/opt/curator ' }, fallback });

    expect(resolved.root).toBe('/opt/curator ');
    expect(resolved.stateRoot).toBe(join('/opt/curator ', 'state'));
    expect(resolved.source).toBe('native');
    expect(resolved.stateSource).toBe('derived');
  });

  it('makes a relative anchor absolute against the working directory, as Codex hands "./"', () => {
    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: './' }, fallback });

    expect(resolved.root).toBe(resolve('./'));
    expect(resolved.stateRoot).toBe(join(resolve('./'), 'state'));
    expect(resolved.source).toBe('native');
    expect(resolved.stateSource).toBe('derived');
  });

  it('falls back to the shell fallback as the derived source when the anchor is unset or blank', () => {
    for (const env of [{}, { [PLUGIN_ROOT_ENV_ANCHOR]: '' }, { [PLUGIN_ROOT_ENV_ANCHOR]: '   ' }]) {
      const warnings: string[] = [];
      const resolved = resolvePluginRoot({ env, fallback, warn: (message) => warnings.push(message) });
      expect(resolved).toMatchObject({
        root: fallback,
        source: 'derived',
        stateRoot: `${fallback}/state`,
        stateSource: 'derived',
      });
      expect(resolved.identity).toEqual({ source: 'derived', state: 'available', value: { root: fallback, stateRoot: `${fallback}/state` } });
      expect(warnings).toEqual([]);
    }
  });

  it('treats an unexpanded host token as unset, reports it once, and never joins it into a path', () => {
    const warnings: string[] = [];
    const resolved = resolvePluginRoot({
      env: { [PLUGIN_ROOT_ENV_ANCHOR]: '${CLAUDE_PLUGIN_ROOT}' },
      fallback,
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toMatchObject({
      root: fallback,
      source: 'derived',
      stateRoot: `${fallback}/state`,
      stateSource: 'derived',
    });
    expect(resolved.stateRoot).not.toContain('${');
    expect(warnings).toEqual([
      `[agent-bundle] AGENT_BUNDLE_PLUGIN_ROOT is the unexpanded token "\${CLAUDE_PLUGIN_ROOT}"; anchoring the plugin on ${fallback} instead.`,
    ]);
  });

  it('reads process.env by default', () => {
    const previous = process.env[PLUGIN_ROOT_ENV_ANCHOR];
    process.env[PLUGIN_ROOT_ENV_ANCHOR] = '/from/process/env';
    try {
      expect(resolvePluginRoot({ fallback }).root).toBe('/from/process/env');
    } finally {
      if (previous === undefined) delete process.env[PLUGIN_ROOT_ENV_ANCHOR];
      else process.env[PLUGIN_ROOT_ENV_ANCHOR] = previous;
    }
  });

  it('uses AGENT_BUNDLE_STATE_ROOT as an independent native state root', () => {
    const declaredStateRoot = './framework state ';
    const resolved = resolvePluginRoot({
      env: {
        [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator',
        [PLUGIN_STATE_ROOT_ENV_ANCHOR]: declaredStateRoot,
      },
      fallback,
    });

    expect(resolved).toMatchObject({
      root: '/installs/curator',
      source: 'native',
      stateRoot: resolve(declaredStateRoot),
      stateSource: 'native',
    });
  });

  it('treats a blank AGENT_BUNDLE_STATE_ROOT as unset', () => {
    for (const declared of ['', '   ']) {
      const resolved = resolvePluginRoot({
        env: {
          [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator',
          [PLUGIN_STATE_ROOT_ENV_ANCHOR]: declared,
        },
        fallback,
      });

      expect(resolved).toMatchObject({
        root: '/installs/curator',
        source: 'native',
        stateRoot: '/installs/curator/state',
        stateSource: 'derived',
      });
    }
  });

  it('reports an unexpanded state-root token once and derives the state root', () => {
    const warnings: string[] = [];
    const resolved = resolvePluginRoot({
      env: {
        [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator',
        [PLUGIN_STATE_ROOT_ENV_ANCHOR]: '${PLUGIN_STATE}',
      },
      fallback,
      warn: (message) => warnings.push(message),
    });

    expect(resolved).toMatchObject({
      root: '/installs/curator',
      source: 'native',
      stateRoot: '/installs/curator/state',
      stateSource: 'derived',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AGENT_BUNDLE_STATE_ROOT');
    expect(warnings[0]).toContain('${PLUGIN_STATE}');
  });

  it('derives user-data state below an explicit home', () => {
    const root = '/installs/curator';
    const home = '/users/tester';
    const segment = `curator-${digest16(resolve(root))}`;

    expect(userStateHome({}, home)).toBe(join(home, '.agent-bundle', 'state'));
    expect(userDataStateRoot(root, {}, home)).toBe(join(home, '.agent-bundle', 'state', segment));
    expect(resolvePluginRoot({
      env: { [PLUGIN_ROOT_ENV_ANCHOR]: root },
      fallback,
      home,
      stateAnchor: 'user-data',
    })).toMatchObject({
      root,
      stateRoot: join(home, '.agent-bundle', 'state', segment),
      stateSource: 'derived',
    });
  });

  it('uses a non-blank XDG_STATE_HOME and ignores a blank one', () => {
    const root = '/installs/curator';
    const home = '/users/tester';
    const segment = `curator-${digest16(resolve(root))}`;

    expect(userStateHome({ XDG_STATE_HOME: '/xdg/state' }, home)).toBe('/xdg/state/agent-bundle');
    expect(userDataStateRoot(root, { XDG_STATE_HOME: '/xdg/state' }, home)).toBe(
      join('/xdg/state', 'agent-bundle', segment),
    );
    expect(userStateHome({ XDG_STATE_HOME: '   ' }, home)).toBe(join(home, '.agent-bundle', 'state'));
  });

  it('uses plugin as the segment name when the root basename is unsafe', () => {
    const root = '/installs/unsafe name';
    expect(pluginStateSegment(root)).toBe(`plugin-${digest16(resolve(root))}`);
  });

  it('digests real roots canonically and missing roots by their resolved spelling', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-bundle-plugin-root-'));
    try {
      const root = join(directory, 'curator');
      const link = join(directory, 'curator-link');
      mkdirSync(root);
      symlinkSync(root, link, 'dir');

      const canonical = realpathSync(root);
      const expectedRealSegment = `${basename(canonical)}-${digest16(canonical)}`;
      expect(pluginStateSegment(root)).toBe(expectedRealSegment);
      expect(pluginStateSegment(link)).toBe(expectedRealSegment);

      const missing = join(directory, 'missing', '..', 'ghost');
      const resolvedMissing = resolve(missing);
      expect(pluginStateSegment(missing)).toBe(`${basename(resolvedMissing)}-${digest16(resolvedMissing)}`);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe('the plugin request axis (#468)', () => {
  it('is unavailable("not-provided") when the scope supplies none, and the resolved identity when it does', async () => {
    const absent = await runAgentRequest({ invocation: { kind: 'tool' } }, async () => (await agent()).plugin);
    expect(absent).toEqual({ reason: 'not-provided', state: 'unavailable' });

    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator' }, fallback: '/unused' });
    const present = await runAgentRequest(
      { invocation: { kind: 'tool' }, plugin: resolved.identity },
      async () => (await agent()).plugin,
    );
    expect(present).toEqual({
      source: 'native',
      state: 'available',
      value: { root: '/installs/curator', stateRoot: '/installs/curator/state' },
    });
    expect(Object.isFrozen(present)).toBe(true);
  });
});
