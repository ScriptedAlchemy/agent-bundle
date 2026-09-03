import { expect, it } from '@rstest/core';

import { pluginAdapter } from '../src/adapters/plugin.ts';
import type { NormalizedHook, NormalizedPlugin } from '../src/core/types.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const hook = (event: NormalizedHook['event'], name: string): NormalizedHook => ({
  event,
  id: `hook:${name}`,
  name,
  provenance: { kind: 'config', sourcePath: configPath },
  source: `/workspace/src/hooks/${name}.ts`,
  targets: ['plugin'],
  tools: [],
});

const model: NormalizedPlugin = {
  extensions: {},
  hooks: [
    hook('afterTool', 'record-write'),
    hook('sessionStart', 'session-start'),
  ],
  mcpServers: [],
  metadata: {
    description: 'Unified bundle hook pointer.',
    id: 'plugin:hook-pointer',
    name: 'hook-pointer',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:plugin',
    name: 'plugin',
    provenance: { kind: 'config', sourcePath: configPath },
  }],
};

it('names hooks/hooks.json on the Claude manifest and bakes host-native event spellings', () => {
  const plan = pluginAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);

  const pluginJson = plan.entries.find((entry) =>
    entry.kind === 'write' && entry.relativePath === '.claude-plugin/plugin.json');
  expect(pluginJson?.kind).toBe('write');
  if (pluginJson?.kind !== 'write') throw new Error('expected Claude plugin.json write entry');
  expect(JSON.parse(pluginJson.content)).toMatchObject({
    hooks: './hooks/hooks.json',
    name: 'hook-pointer',
  });

  const shared = (plan.hookEntries ?? []).find((entry) =>
    entry.event === 'afterTool' && !entry.relativePath.endsWith('.cursor.mjs'));
  const cursor = (plan.hookEntries ?? []).find((entry) =>
    entry.event === 'afterTool' && entry.relativePath.endsWith('.cursor.mjs'));
  expect(shared?.nativeEvent).toBe('PostToolUse');
  expect(cursor?.nativeEvent).toBe('postToolUse');
  expect(shared?.virtualSource).toContain('const nativeEvent = "PostToolUse"');
  expect(cursor?.virtualSource).toContain('const nativeEvent = "postToolUse"');
});
