import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  cursorAdapter,
  cursorHooksValidator,
  cursorMcpValidator,
  cursorPluginNameError,
  cursorPluginValidator,
  isValidCursorPluginName,
} from '../src/adapters/cursor.ts';
import { pluginAdapter } from '../src/adapters/plugin.ts';
import { readTargetMcpServers } from '../src/services/mcp-runtime.ts';
import { pathTokens, type NormalizedPlugin } from '../src/core/types.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const plugin = (): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  metadata: {
    description: 'Review helpers for Cursor.',
    id: 'plugin:cursor-review',
    name: 'cursor-review',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.2.3',
  },
  mcpServers: [
    {
      args: ['--root', `${pathTokens.pluginRoot}/tools/server.mjs`],
      command: 'node',
      env: { API_TOKEN: '${API_TOKEN}', CACHE_DIR: `${pathTokens.workspaceRoot}/cache` },
      id: 'mcp:status',
      name: 'status',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['cursor'],
      transport: 'stdio',
    },
    {
      headers: { Authorization: 'Bearer literal' },
      id: 'mcp:remote',
      name: 'remote',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['cursor'],
      transport: 'streamable-http',
      url: 'https://mcp.example.test/stream',
    },
  ],
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [
    {
      body: '# Review\n',
      description: 'Review code and explain findings.',
      dir: '/workspace/skills/review',
      frontmatter: { description: 'Review code and explain findings.', name: 'review' },
      id: 'skill:review',
      name: 'review',
      provenance: { kind: 'conventional', sourcePath: '/workspace/skills/review/SKILL.md' },
      resources: [
        { bytes: 9, relativePath: 'SKILL.md', source: '/workspace/skills/review/SKILL.md' },
        { bytes: 8, relativePath: 'references/guide.md', source: '/workspace/skills/review/references/guide.md' },
      ],
      source: '/workspace/skills/review/SKILL.md',
      targets: ['cursor'],
    },
  ],
  targets: [
    { id: 'target:cursor', name: 'cursor', provenance: { kind: 'config', sourcePath: configPath } },
  ],
});

const writeContents = (model: NormalizedPlugin): Record<string, string> => Object.fromEntries(
  cursorAdapter.plan(model).entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]),
);

it('registers cursor as a first-class target with pinned schema validation', () => {
  const registry = createDefaultRegistry();
  expect(registry.names()).toEqual(['portable', 'codex', 'claude', 'cursor', 'plugin']);
  expect(registry.defaultTargetNames()).toEqual(['portable']);
  expect(registry.supports('cursor', 'mcp')).toBe(true);
  expect(registry.supports('cursor', 'rules')).toBe(true);
  expect(registry.supports('cursor', 'skills')).toBe(true);
  expect(registry.supports('cursor', 'hooks')).toBe(true);
  expect(registry.hookContract('cursor')?.commandRoot).toBe('${CURSOR_PLUGIN_ROOT}');
  expect(registry.artifactValidation('cursor').documents).toEqual([
    { path: '.cursor-plugin/plugin.json', required: true, schema: 'plugin' },
    { path: 'hooks/hooks.json', required: false, schema: 'hooks' },
    { path: 'mcp.json', required: false, schema: 'mcp' },
  ]);
  expect(registry.artifactLayout('cursor').commands).toEqual({
    allowedSuffixes: ['.md'],
    directory: 'commands',
  });
  expect(registry.artifactLayout('cursor').rules).toEqual({
    allowedSuffixes: ['.mdc'],
    directory: 'rules',
  });
});

it('holds the 64-character plugin-name bound in both Cursor-producing planners', () => {
  const boundary = 'c'.repeat(64);
  const overLong = 'c'.repeat(65);

  // The pinned official schema (cursor/plugins@0701892) constrains the name's
  // charset but carries no maxLength, so only the planners can hold the bound.
  expect(cursorPluginValidator({ name: overLong, version: '1.2.3' })).toBe(true);
  expect(isValidCursorPluginName(boundary)).toBe(true);
  expect(isValidCursorPluginName(overLong)).toBe(false);

  const model = plugin();
  const named = (name: string): NormalizedPlugin => ({
    ...model,
    metadata: { ...model.metadata, name },
    targets: [
      ...model.targets,
      { id: 'target:plugin', name: 'plugin', provenance: { kind: 'config', sourcePath: configPath } },
    ],
  });

  expect(cursorAdapter.plan(named(overLong)).diagnostics.filter((entry) => entry.code === 'cursor.name')).toEqual([
    { code: 'cursor.name', message: cursorPluginNameError(overLong), severity: 'error', target: 'cursor' },
  ]);
  expect(pluginAdapter.plan(named(overLong)).diagnostics.filter((entry) => entry.code === 'plugin.cursor.name')).toEqual([
    { code: 'plugin.cursor.name', message: cursorPluginNameError(overLong), severity: 'error', target: 'plugin' },
  ]);

  for (const plan of [cursorAdapter.plan(named(boundary)), pluginAdapter.plan(named(boundary))]) {
    expect(plan.diagnostics.filter((entry) => entry.code.endsWith('cursor.name'))).toEqual([]);
  }
});

it('validates Cursor documents against the vendored real-host schemas', () => {
  expect(cursorPluginValidator({
    minClientVersions: { cursor: '3.5.0' },
    name: 'cursor-review',
    publisher: 'Cursor',
    variables: { properties: { API_TOKEN: { type: 'string' } }, type: 'object' },
    version: '1.2.3',
  })).toBe(true);
  expect(cursorPluginValidator({ name: 'Cursor Review' })).toBe(false);
  expect(cursorPluginValidator({ name: 'cursor-review', unknown: true })).toBe(false);

  expect(cursorMcpValidator({
    mcpServers: { status: { args: ['serve'], command: 'node', envFile: '.env', type: 'stdio' } },
  })).toBe(true);
  expect(cursorMcpValidator({ mcpServers: { status: { args: ['serve'] } } })).toBe(false);
  expect(cursorMcpValidator({ mcpservers: {} })).toBe(false);

  expect(cursorHooksValidator({
    hooks: { afterShellExecution: [{ command: 'echo ok', failClosed: true }] },
    version: 1,
  })).toBe(true);
  expect(cursorHooksValidator({ hooks: { afterShellExecutionn: [{ command: 'echo typo' }] }, version: 1 })).toBe(false);
  expect(cursorHooksValidator({ hooks: { stop: [{ timeout: 5 }] }, version: 1 })).toBe(false);
  expect(cursorHooksValidator({ hooks: {}, version: 2 })).toBe(false);
});

it('plans a schema-valid Cursor artifact with typeless MCP entries and explicit manifest pointers', () => {
  const model = plugin();
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.hookEntries).toEqual([]);

  const documents = writeContents(model);
  expect(Object.keys(documents).sort()).toEqual(['.cursor-plugin/plugin.json', 'mcp.json']);

  const manifest = JSON.parse(documents['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(manifest).toEqual({
    description: 'Review helpers for Cursor.',
    displayName: 'cursor-review',
    mcpServers: './mcp.json',
    name: 'cursor-review',
    skills: './skills/',
    variables: {
      properties: { API_TOKEN: { type: 'string' } },
      type: 'object',
    },
    version: '1.2.3',
  });
  for (const field of ['mcpServers', 'skills'] as const) {
    const declaredPath = manifest[field] as string;
    expect(declaredPath.startsWith('/')).toBe(false);
    expect(declaredPath.split('/')).not.toContain('..');
    const artifactPath = declaredPath.replace(/^\.\//u, '').replace(/\/$/u, '');
    expect(plan.entries.some((entry) =>
      entry.relativePath === artifactPath || entry.relativePath.startsWith(`${artifactPath}/`))).toBe(true);
  }

  const mcp = JSON.parse(documents['mcp.json']!) as { readonly mcpServers: Record<string, Record<string, unknown>> };
  expect(mcp.mcpServers['status']).toEqual({
    args: ['--root', '${CURSOR_PLUGIN_ROOT}/tools/server.mjs'],
    command: 'node',
    env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CURSOR_PLUGIN_ROOT}', API_TOKEN: '${API_TOKEN}', CACHE_DIR: '${workspaceFolder}/cache' },
  });
  expect(mcp.mcpServers['remote']).toEqual({
    headers: { Authorization: 'Bearer literal' },
    url: 'https://mcp.example.test/stream',
  });
  expect(mcp.mcpServers['status']).not.toHaveProperty('type');
  expect(mcp.mcpServers['remote']).not.toHaveProperty('type');

  const skillCopies = plan.entries.filter((entry) => entry.kind === 'copy').map((entry) => entry.relativePath);
  expect(skillCopies).toEqual(['skills/review/SKILL.md', 'skills/review/references/guide.md']);
});

it('emits selected rules byte-faithfully and omits the entire surface when rule-free', () => {
  const model = plugin();
  const markdown = '---\r\ndescription: Review TypeScript\r\nglobs: "**/*.ts"\r\n---\r\nCheck types.';
  const withRule: NormalizedPlugin = {
    ...model,
    rules: [{
      body: 'Check types.',
      emittedMarkdown: markdown,
      frontmatter: { description: 'Review TypeScript', globs: '**/*.ts' },
      id: 'rule:typescript',
      markdown,
      name: 'typescript',
      provenance: { kind: 'conventional', sourcePath: '/workspace/rules/typescript.mdc' },
      source: '/workspace/rules/typescript.mdc',
      targets: ['cursor'],
    }, {
      body: 'Keep changes focused.',
      emittedMarkdown: '---\ndescription: Focus changes\nalwaysApply: true\n---\n\nKeep changes focused.',
      frontmatter: { alwaysApply: true, description: 'Focus changes' },
      id: 'rule:focused',
      markdown: '---\ndescription: Focus changes\nalwaysApply: true\ntargets:\n  - cursor\n---\nKeep changes focused.',
      name: 'focused',
      provenance: { kind: 'conventional', sourcePath: '/workspace/rules/focused.mdc' },
      source: '/workspace/rules/focused.mdc',
      targets: ['cursor'],
    }],
  };

  const plan = cursorAdapter.plan(withRule);
  const documents = writeContents(withRule);
  expect(plan.diagnostics).toEqual([]);
  expect(documents['rules/typescript.mdc']).toBe(markdown);
  expect(documents['rules/focused.mdc']).toBe(
    '---\ndescription: Focus changes\nalwaysApply: true\n---\n\nKeep changes focused.',
  );
  expect(documents['rules/focused.mdc']).not.toContain('targets:');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).toMatchObject({
    rules: './rules/',
  });
  expect(plan.entries.find((entry) => entry.relativePath === 'rules/typescript.mdc')?.sourceInputs).toEqual([
    '/workspace/rules/typescript.mdc',
  ]);

  const ruleFree = cursorAdapter.plan(model);
  expect(ruleFree.entries.some((entry) => entry.relativePath.startsWith('rules/'))).toBe(false);
  expect(JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!)).not.toHaveProperty('rules');
});

it('emits Cursor command bodies, strips authored frontmatter, and omits the command-free surface', () => {
  const model = plugin();
  const withCommands: NormalizedPlugin = {
    ...model,
    commands: [
      {
        body: 'Review the staged diff.\r\n',
        frontmatter: { argumentHint: '[path]', description: 'Review changes' },
        id: 'command:review',
        markdown: '---\r\ndescription: Review changes\r\nargumentHint: "[path]"\r\ntargets:\r\n  - cursor\r\n---\r\nReview the staged diff.\r\n',
        name: 'review',
        provenance: { kind: 'conventional', sourcePath: '/workspace/commands/review.md' },
        source: '/workspace/commands/review.md',
        targets: ['cursor'],
      },
      {
        body: '# Explain\n\nExplain this code.',
        frontmatter: {},
        id: 'command:explain',
        markdown: '# Explain\n\nExplain this code.',
        name: 'explain',
        provenance: { kind: 'conventional', sourcePath: '/workspace/commands/explain.md' },
        source: '/workspace/commands/explain.md',
        targets: ['cursor'],
      },
    ],
  };

  const plan = cursorAdapter.plan(withCommands);
  const documents = writeContents(withCommands);
  expect(plan.diagnostics).toEqual([]);
  expect(documents['commands/review.md']).toBe('Review the staged diff.\r\n');
  expect(documents['commands/review.md']).not.toContain('targets:');
  expect(documents['commands/explain.md']).toBe('# Explain\n\nExplain this code.');
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).toMatchObject({ commands: './commands/' });

  const commandFree = cursorAdapter.plan(model);
  expect(commandFree.entries.some((entry) => entry.relativePath.startsWith('commands/'))).toBe(false);
  expect(JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!)).not.toHaveProperty('commands');
});

it('rejects portable Agent Plugin tokens instead of emitting a hybrid Cursor artifact', () => {
  const model = plugin();
  const candidate: NormalizedPlugin = {
    ...model,
    mcpServers: [{
      ...model.mcpServers[0]!,
      env: { PORTABLE_ROOT: '${PLUGIN_ROOT}' },
    }],
  };
  const plan = cursorAdapter.plan(candidate);
  expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toContain('cursor.mcp.token');
  expect(plan.entries.map((entry) => entry.relativePath)).not.toContain('mcp.json');
  const manifest = JSON.parse(writeContents(candidate)['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(manifest).not.toHaveProperty('mcpServers');
  expect(manifest).not.toHaveProperty('variables');
});

it('rejects the plugin-data token and omits the failed server from the document', () => {
  const model = plugin();
  const plan = cursorAdapter.plan({
    ...model,
    mcpServers: [{
      args: [`${pathTokens.pluginData}/state.json`],
      command: 'node',
      id: 'mcp:data',
      name: 'data',
      provenance: { kind: 'config', sourcePath: configPath },
      targets: ['cursor'],
      transport: 'stdio',
    }],
  });
  expect(plan.diagnostics).toEqual([
    expect.objectContaining({ code: 'cursor.mcp.token', severity: 'error', target: 'cursor' }),
  ]);
  const documents = plan.entries.filter((entry) => entry.kind === 'write').map((entry) => entry.relativePath);
  expect(documents).toEqual(['.cursor-plugin/plugin.json']);
  const manifest = JSON.parse(
    (plan.entries.find((entry) => entry.relativePath === '.cursor-plugin/plugin.json') as { readonly content: string }).content,
  ) as Record<string, unknown>;
  expect(manifest).not.toHaveProperty('mcpServers');
});

it('lowers cursor-targeted hooks into the flat versioned document with dedicated wrappers', () => {
  const model = plugin();
  const plan = cursorAdapter.plan({
    ...model,
    hooks: [
      {
        event: 'sessionStart',
        id: 'hook:session-start',
        name: 'session-start',
        provenance: { kind: 'config', sourcePath: configPath },
        source: '/workspace/src/hooks/session-start.ts',
        targets: ['cursor'],
        tools: [],
      },
      {
        event: 'afterTool',
        id: 'hook:record-write',
        name: 'record-write',
        provenance: { kind: 'config', sourcePath: configPath },
        source: '/workspace/src/hooks/record-write.ts',
        targets: ['cursor'],
        timeoutMs: 30_000,
        tools: ['file.write'],
      },
    ],
  });
  expect(plan.diagnostics).toEqual([]);

  const documents = Object.fromEntries(plan.entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]));
  expect(JSON.parse(documents['hooks/hooks.json']!)).toEqual({
    hooks: {
      postToolUse: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/record-write.mjs"',
        matcher: '^Write$',
        timeout: 30,
      }],
      sessionStart: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/session-start.mjs"' }],
    },
    version: 1,
  });
  expect(JSON.parse(documents['.cursor-plugin/plugin.json']!)).toMatchObject({ hooks: './hooks/hooks.json' });

  const wrappers = plan.hookEntries ?? [];
  expect(wrappers.map((entry) => entry.relativePath).sort()).toEqual([
    'hooks/record-write.mjs',
    'hooks/session-start.mjs',
  ]);
  const sessionWrapper = wrappers.find((entry) => entry.relativePath === 'hooks/session-start.mjs');
  expect(sessionWrapper?.virtualSource).toContain('const target = "cursor";');
  expect(sessionWrapper?.virtualSource).toContain('decodeCursorNative');
  expect(sessionWrapper?.virtualSource).toContain('additional_context');
  const toolWrapper = wrappers.find((entry) => entry.relativePath === 'hooks/record-write.mjs');
  expect(toolWrapper?.virtualSource).toContain('tool_output');
});

it('drops hooks scoped to other targets from the plan', () => {
  const model = plugin();
  const plan = cursorAdapter.plan({
    ...model,
    hooks: [{
      event: 'sessionStart',
      id: 'hook:session-start',
      name: 'session-start',
      provenance: { kind: 'config', sourcePath: configPath },
      source: '/workspace/src/hooks/session-start.ts',
      targets: ['claude'],
      tools: [],
    }],
    marketplace: true,
  });
  expect(plan.diagnostics).toEqual([]);
  expect(plan.hookEntries).toEqual([]);
  const paths = plan.entries.map((entry) => entry.relativePath);
  expect(paths).not.toContain('hooks/hooks.json');
  expect(paths.some((path) => path.includes('marketplace'))).toBe(false);
  const manifest = JSON.parse(
    (plan.entries.find((entry) => entry.relativePath === '.cursor-plugin/plugin.json') as { readonly content: string }).content,
  ) as Record<string, unknown>;
  expect(manifest).not.toHaveProperty('hooks');
});

it('reads the emitted shape-discriminated document back through the target MCP runtime', () => {
  const model = plugin();
  const document = JSON.parse(writeContents(model)['mcp.json']!) as unknown;
  const runtime = cursorAdapter.mcpRuntime!;
  expect(runtime.manifestPath).toBe('mcp.json');

  const result = readTargetMcpServers(runtime, document);
  expect(result.status).toBe('found');
  if (result.status !== 'found') throw new Error('unreachable');
  expect(result.servers.map((entry) => [entry.name, entry.server.kind])).toEqual([
    ['remote', 'streamable-http'],
    ['status', 'stdio'],
  ]);

  expect(readTargetMcpServers(runtime, {
    mcpServers: { ambiguous: { command: 'node', url: 'https://mcp.example.test' } },
  })).toEqual({ status: 'invalid' });
  expect(readTargetMcpServers(runtime, {
    mcpServers: { untyped: { headers: { Authorization: 'x' } } },
  })).toEqual({ status: 'invalid' });
});

it('resolves Cursor path tokens and diagnoses foreign standard tokens at runtime', () => {
  const runtime = cursorAdapter.mcpRuntime!;
  const roots = { pluginData: '/data', pluginRoot: '/plugin', workspaceRoot: '/workspace' };

  const resolved = runtime.resolveValue('args', roots, '${CURSOR_PLUGIN_ROOT}/tools/server.mjs');
  expect(resolved).toEqual({ diagnostics: [], value: '/plugin/tools/server.mjs' });
  const workspace = runtime.resolveValue('env', roots, '${workspaceFolder}/cache');
  expect(workspace).toEqual({ diagnostics: [], value: '/workspace/cache' });

  const foreign = runtime.resolveValue('args', roots, '${CLAUDE_PLUGIN_ROOT}/tools/server.mjs');
  expect(foreign.diagnostics).toEqual([
    expect.objectContaining({ code: 'mcp.path-token.unsupported.args', severity: 'error', target: 'cursor' }),
  ]);
});
