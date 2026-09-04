import { join, resolve } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { agent, runAgentRequest } from '../src/agent-request.js';
import { PLUGIN_ROOT_ENV_ANCHOR, resolvePluginRoot } from '../src/plugin-root.js';

describe('resolvePluginRoot (#468)', () => {
  const fallback = '/artifact/claude';

  it('anchors on an expanded AGENT_BUNDLE_PLUGIN_ROOT as the native source, with state one level below', () => {
    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: '/installs/curator' }, fallback });

    expect(resolved).toEqual({
      identity: { source: 'native', state: 'available', value: { root: '/installs/curator', stateRoot: '/installs/curator/state' } },
      root: '/installs/curator',
      source: 'native',
      stateRoot: '/installs/curator/state',
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('makes a relative anchor absolute against the working directory, as Codex hands "./"', () => {
    const resolved = resolvePluginRoot({ env: { [PLUGIN_ROOT_ENV_ANCHOR]: './' }, fallback });

    expect(resolved.root).toBe(resolve('./'));
    expect(resolved.stateRoot).toBe(join(resolve('./'), 'state'));
    expect(resolved.source).toBe('native');
  });

  it('falls back to the shell fallback as the derived source when the anchor is unset or blank', () => {
    for (const env of [{}, { [PLUGIN_ROOT_ENV_ANCHOR]: '' }, { [PLUGIN_ROOT_ENV_ANCHOR]: '   ' }]) {
      const warnings: string[] = [];
      const resolved = resolvePluginRoot({ env, fallback, warn: (message) => warnings.push(message) });
      expect(resolved).toMatchObject({ root: fallback, source: 'derived', stateRoot: `${fallback}/state` });
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

    expect(resolved).toMatchObject({ root: fallback, source: 'derived', stateRoot: `${fallback}/state` });
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
