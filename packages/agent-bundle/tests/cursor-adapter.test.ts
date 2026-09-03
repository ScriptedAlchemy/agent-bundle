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
      dir: '/workspace/src/skills/review',
      frontmatter: { description: 'Review code and explain findings.', name: 'review' },
      id: 'skill:review',
      name: 'review',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/skills/review/SKILL.md' },
      resources: [
        { bytes: 9, relativePath: 'SKILL.md', source: '/workspace/src/skills/review/SKILL.md' },
        { bytes: 8, relativePath: 'references/guide.md', source: '/workspace/src/skills/review/references/guide.md' },
      ],
      source: '/workspace/src/skills/review/SKILL.md',
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
  expect(registry.supports('cursor', 'marketplace')).toBe(true);
  expect(registry.hookContract('cursor')?.commandRoot).toBe('${CURSOR_PLUGIN_ROOT}');
  expect(registry.artifactValidation('cursor').documents).toEqual([
    { path: '.cursor-plugin/marketplace.json', required: false, schema: 'marketplace' },
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
  expect(cursorPluginValidator({
    logo: './assets/docs/media/logo.svg',
    name: 'cursor-review',
    version: '1.2.3',
  })).toBe(true);
});

const withCursorConfig = (value: unknown): NormalizedPlugin => ({
  ...plugin(),
  extensions: {
    cursor: {
      id: 'extension:cursor',
      key: 'cursor',
      provenance: { kind: 'config', sourcePath: configPath },
      target: 'cursor',
      value,
    },
  },
  targets: [
    ...plugin().targets,
    { id: 'target:plugin', name: 'plugin', provenance: { kind: 'config', sourcePath: configPath } },
  ],
});

it('registers the cursor config extension and emits schema-admitted manifest metadata on both Cursor manifests', () => {
  const registry = createDefaultRegistry();
  expect(registry.configExtensions().map((extension) => extension.key)).toContain('cursor');

  const model = withCursorConfig({
    author: { email: 'devtools@example.test', name: 'Example DevTools' },
    category: 'developer-tools',
    homepage: 'https://example.test/cursor-review',
    keywords: ['review', 'cursor'],
    license: 'MIT',
    minClientVersions: { cursor: '3.13.0' },
    publisher: 'Example',
    repository: 'https://github.com/example/cursor-review',
    tags: ['code-review'],
  });
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  const manifest = JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    author: { email: 'devtools@example.test', name: 'Example DevTools' },
    category: 'developer-tools',
    homepage: 'https://example.test/cursor-review',
    keywords: ['review', 'cursor'],
    license: 'MIT',
    minClientVersions: { cursor: '3.13.0' },
    name: 'cursor-review',
    publisher: 'Example',
    repository: 'https://github.com/example/cursor-review',
    tags: ['code-review'],
  });
  expect(cursorPluginValidator(manifest)).toBe(true);
  const manifestEntry = plan.entries.find((entry) => entry.relativePath === '.cursor-plugin/plugin.json');
  expect(manifestEntry?.sourceInputs).toContain(configPath);

  const bundle = pluginAdapter.plan(model);
  expect(bundle.diagnostics).toEqual([]);
  const bundleManifest = JSON.parse(
    (bundle.entries.find((entry) => entry.relativePath === '.cursor-plugin/plugin.json') as { readonly content: string }).content,
  ) as Record<string, unknown>;
  expect(bundleManifest).toMatchObject({ author: { name: 'Example DevTools' }, minClientVersions: { cursor: '3.13.0' }, publisher: 'Example' });
  const claudeManifest = JSON.parse(
    (bundle.entries.find((entry) => entry.relativePath === '.claude-plugin/plugin.json') as { readonly content: string }).content,
  ) as Record<string, unknown>;
  expect(claudeManifest).not.toHaveProperty('publisher');
  expect(claudeManifest).not.toHaveProperty('minClientVersions');
});

it('rejects cursor manifest metadata the pinned schema does not admit and emits no partial metadata', () => {
  const model = withCursorConfig({
    author: { name: 'Example', url: 'https://example.test' },
    homepage: 'ftp://example.test',
    keywords: ['ok', ''],
    license: ' ',
    minClientVersions: { cursor: '3.13' },
    nativeHooks: './hooks.json',
    repository: 'https://github.com/example/cursor-review',
  });
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual([
    'cursor.manifest.author.invalid',
    'cursor.manifest.field.unknown',
    'cursor.manifest.homepage.invalid',
    'cursor.manifest.keywords.invalid',
    'cursor.manifest.license.invalid',
    'cursor.manifest.minClientVersions.invalid',
  ]);
  expect(plan.diagnostics.every((diagnostic) => diagnostic.severity === 'error' && diagnostic.target === 'cursor')).toBe(true);
  const manifest = JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  for (const field of ['author', 'homepage', 'keywords', 'license', 'minClientVersions', 'repository']) {
    expect(manifest).not.toHaveProperty(field);
  }
  expect(pluginAdapter.plan(model).diagnostics.map((diagnostic) => diagnostic.code)).toContain('plugin.cursor.manifest.author.invalid');

  expect(cursorAdapter.plan(withCursorConfig({ minClientVersions: {} })).diagnostics.map((diagnostic) => diagnostic.code))
    .toEqual(['cursor.manifest.minClientVersions.invalid']);
  expect(cursorAdapter.plan(withCursorConfig({})).diagnostics).toEqual([]);
});

it('rejects cursor URLs that new URL() would normalize but the pinned uri format rejects, without a generic schema error', () => {
  const normalizedByUrlParser = [
    ' https://example.test/cursor-review ',
    'https://example.test/cursor review',
    'https://example.test/päth',
    'https://example.test/<review>',
  ];
  for (const url of normalizedByUrlParser) {
    expect(() => new URL(url)).not.toThrow();
    const model = withCursorConfig({ homepage: url, repository: 'https://github.com/example/cursor-review' });
    const plan = cursorAdapter.plan(model);
    expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['cursor.manifest.homepage.invalid']);
    const manifest = JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('homepage');
    expect(manifest).not.toHaveProperty('repository');
  }
  const exact = withCursorConfig({
    homepage: 'https://example.test',
    repository: 'https://EXAMPLE.test/a%2Fb?ref=main#readme',
  });
  const plan = cursorAdapter.plan(exact);
  expect(plan.diagnostics).toEqual([]);
  const manifest = JSON.parse(writeContents(exact)['.cursor-plugin/plugin.json']!) as Record<string, unknown>;
  expect(manifest['homepage']).toBe('https://example.test');
  expect(manifest['repository']).toBe('https://EXAMPLE.test/a%2Fb?ref=main#readme');
});

it('copies plugin.logo into the artifact and references it from plugin.json', () => {
  const model: NormalizedPlugin = {
    ...plugin(),
    metadata: {
      ...plugin().metadata,
      logo: {
        bytes: 12,
        path: 'assets/docs/media/logo.svg',
        source: '/workspace/docs/media/logo.svg',
      },
    },
  };
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  expect(JSON.parse(writeContents(model)['.cursor-plugin/plugin.json']!)).toMatchObject({
    logo: './assets/docs/media/logo.svg',
  });
  expect(plan.entries).toContainEqual(expect.objectContaining({
    bytes: 12,
    kind: 'copy',
    relativePath: 'assets/docs/media/logo.svg',
    source: '/workspace/docs/media/logo.svg',
  }));
});

it('plans a schema-valid Cursor artifact with typeless MCP entries and explicit manifest pointers', () => {
  const model = plugin();
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  expect(plan.hookEntries).toEqual([]);

  const documents = writeContents(model);
  expect(Object.keys(documents).sort()).toEqual([
    '.cursor-plugin/plugin.json',
    'INSTALL.md',
    'install.mjs',
    'mcp.json',
  ]);

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
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/rules/typescript.mdc' },
      source: '/workspace/src/rules/typescript.mdc',
      targets: ['cursor'],
    }, {
      body: 'Keep changes focused.',
      emittedMarkdown: '---\ndescription: Focus changes\nalwaysApply: true\n---\n\nKeep changes focused.',
      frontmatter: { alwaysApply: true, description: 'Focus changes' },
      id: 'rule:focused',
      markdown: '---\ndescription: Focus changes\nalwaysApply: true\ntargets:\n  - cursor\n---\nKeep changes focused.',
      name: 'focused',
      provenance: { kind: 'conventional', sourcePath: '/workspace/src/rules/focused.mdc' },
      source: '/workspace/src/rules/focused.mdc',
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
    '/workspace/src/rules/typescript.mdc',
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
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/review.md' },
        source: '/workspace/src/commands/review.md',
        targets: ['cursor'],
      },
      {
        body: '# Explain\n\nExplain this code.',
        frontmatter: {},
        id: 'command:explain',
        markdown: '# Explain\n\nExplain this code.',
        name: 'explain',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/explain.md' },
        source: '/workspace/src/commands/explain.md',
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
  expect(documents).toEqual(['.cursor-plugin/plugin.json', 'INSTALL.md', 'install.mjs']);
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

it('lowers supported route-only families without exposing config hook names', () => {
  const model = plugin();
  const plan = cursorAdapter.plan({
    ...model,
    hooks: [
      {
        event: 'promptSubmit',
        eventRoute: { event: 'prompt/submit', fallback: 'none', runtime: 'shared' },
        id: 'hook:event-route:prompt-submit',
        name: 'event-route-prompt-submit',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/events/prompt/submit.tsx' },
        source: '/workspace/src/events/prompt/submit.tsx',
        targets: ['cursor'],
        tools: [],
      },
      {
        event: 'sessionEnd',
        eventRoute: { event: 'session/end', fallback: 'none', runtime: 'shared' },
        id: 'hook:event-route:session-end',
        name: 'event-route-session-end',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/events/session/end.tsx' },
        source: '/workspace/src/events/session/end.tsx',
        targets: ['cursor'],
        tools: [],
      },
      {
        event: 'toolFailure',
        eventRoute: { event: 'tool/failure', fallback: 'none', runtime: 'shared' },
        id: 'hook:event-route:tool-failure',
        name: 'event-route-tool-failure',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/events/tool/failure.tsx' },
        source: '/workspace/src/events/tool/failure.tsx',
        targets: ['cursor'],
        tools: [],
      },
      {
        event: 'compactBefore',
        eventRoute: { event: 'compact/before', fallback: 'none', runtime: 'shared' },
        id: 'hook:event-route:compact-before',
        name: 'event-route-compact-before',
        provenance: { kind: 'conventional', sourcePath: '/workspace/src/events/compact/before.tsx' },
        source: '/workspace/src/events/compact/before.tsx',
        targets: ['cursor'],
        tools: [],
      },
    ],
  });

  expect(plan.diagnostics).toEqual([]);
  const documents = Object.fromEntries(plan.entries
    .filter((entry): entry is Extract<typeof entry, { readonly kind: 'write' }> => entry.kind === 'write')
    .map((entry) => [entry.relativePath, entry.content]));
  expect(JSON.parse(documents['hooks/hooks.json']!)).toEqual({
    hooks: {
      beforeSubmitPrompt: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/event-route-prompt-submit.mjs"',
      }],
      sessionEnd: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/event-route-session-end.mjs"',
      }],
      postToolUseFailure: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/event-route-tool-failure.mjs"',
      }],
      preCompact: [{
        command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/event-route-compact-before.mjs"',
      }],
    },
    version: 1,
  });
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
  expect(paths).toContain('.cursor-plugin/marketplace.json');
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
