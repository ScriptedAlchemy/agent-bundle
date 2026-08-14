import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { NormalizationTargetRegistry, NormalizedPlugin } from '../src/core/types.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['codex', 'claude'],
  has: (name) => name === 'portable' || name === 'codex' || name === 'claude',
};

it('normalizes a shorthand session-start hook into a frozen stable record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-normalize-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const loaded: LoadedConfig = {
    config: {
      hooks: { sessionStart: './src/hooks/session-start.ts' },
      plugin: { name: 'review-tools', version: '1.0.0' },
    },
    configPath,
    context: {
      command: 'build',
      mode: 'production',
      projectRoot: root,
      selectedTargets: [],
    },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, registry);
    const hooks = Reflect.get(model, 'hooks');

    expect(hooks).toEqual([
      {
        event: 'sessionStart',
        id: 'hook:session-start:session-start:7ab7e8a5',
        name: 'session-start-session-start-7ab7e8a5',
        provenance: { kind: 'config', sourcePath: configPath },
        source: join(root, 'src', 'hooks', 'session-start.ts'),
        targets: ['claude', 'codex'],
        tools: [],
      },
    ]);
    expect(Object.isFrozen(hooks)).toBe(true);
    expect(Object.isFrozen((hooks as readonly unknown[])[0]!)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('compiles each native hook through a virtual Rslib entry without sibling chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-build-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const model = hookModel(root);
  const names = model.hooks.map((hook) => hook.name).sort();

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'shared.ts'), "export const context = 'compiled from local TypeScript';\n"),
      ...model.hooks.map((hook) => writeFile(
        hook.source,
        [
          "import { context } from './shared.ts';",
          'export default (event: Record<string, unknown>) => ({',
          "  additionalContext: `${context}:${String(event.hookEventName ?? '')}` ,",
          "  outcome: 'continue' as const,",
          '});',
          '',
        ].join('\n'),
      )),
    ]);

    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    for (const target of ['codex', 'claude']) {
      const hooksRoot = join(outputRoot, target, 'hooks');
      expect((await readdir(hooksRoot)).filter((name) => name.endsWith('.mjs')).sort()).toEqual(
        names.map((name) => `${name}.mjs`),
      );
      for (const name of names) {
        const wrapper = await readFile(join(hooksRoot, `${name}.mjs`), 'utf8');
        expect(wrapper).toContain('compiled from local TypeScript');
        expect(wrapper).not.toMatch(/from\s+['"](?:agent-bundle|@rstackjs\/|@rspack\/)[^'"]*['"]/);
      }
    }
    expect(await readdir(join(root, 'src', 'hooks'))).toEqual([
      'check-command.ts',
      'record.ts',
      'session-start.ts',
      'shared.ts',
      'stop.ts',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const hookModel = (root: string): NormalizedPlugin => ({
  hooks: [
    {
      event: 'sessionStart',
      id: 'hook:session-start:session-start:7ab7e8a5',
      name: 'session-start-session-start-7ab7e8a5',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'session-start.ts'),
      targets: ['claude', 'codex'],
      tools: [],
    },
    {
      event: 'beforeTool',
      id: 'hook:before-tool:check-command:1f5b5818',
      name: 'before-tool-check-command-1f5b5818',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'check-command.ts'),
      targets: ['claude', 'codex'],
      timeout: 7,
      tools: ['shell'],
    },
    {
      event: 'afterTool',
      id: 'hook:after-tool:record:87785f02',
      name: 'after-tool-record-87785f02',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'record.ts'),
      targets: ['claude', 'codex'],
      tools: ['file.write'],
    },
    {
      event: 'stop',
      id: 'hook:stop:stop:bb2d7935',
      name: 'stop-stop-bb2d7935',
      provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
      source: join(root, 'src', 'hooks', 'stop.ts'),
      targets: ['claude', 'codex'],
      tools: [],
    },
  ],
  mcpServers: [],
  metadata: {
    id: 'plugin:review-tools',
    name: 'review-tools',
    provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
    version: '1.0.0',
  },
  scripts: [],
  skills: [],
  targets: [
    { id: 'target:codex', name: 'codex', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
    { id: 'target:claude', name: 'claude', provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') } },
  ],
});

it('plans deterministic Codex and Claude hook configurations from the same model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-plan-'));

  try {
    const model = hookModel(root);
    const registry = createDefaultRegistry();
    const codex = registry.get('codex').plan(model);
    const claude = registry.get('claude').plan(model);
    const writes = (entries: readonly { readonly kind: string; readonly relativePath: string; readonly content?: string }[]) =>
      Object.fromEntries(entries.flatMap((entry) => entry.kind === 'write' ? [[entry.relativePath, entry.content]] : []));

    expect(JSON.parse(writes(codex.entries)['.codex-plugin/plugin.json']!)).toMatchObject({
      hooks: './hooks/hooks.json',
    });
    expect(JSON.parse(writes(claude.entries)['.claude-plugin/plugin.json']!)).toMatchObject({
      hooks: './hooks/hooks.json',
    });
    expect(JSON.parse(writes(codex.entries)['hooks/hooks.json']!)).toEqual({
      hooks: {
        PostToolUse: [{
          hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/after-tool-record-87785f02.mjs"', type: 'command' }],
          matcher: '^(?:apply_patch|Edit|Write)$',
        }],
        PreToolUse: [{
          hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/before-tool-check-command-1f5b5818.mjs"', timeout: 7, type: 'command' }],
          matcher: '^Bash$',
        }],
        SessionStart: [{ hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/session-start-session-start-7ab7e8a5.mjs"', type: 'command' }] }],
        Stop: [{ hooks: [{ command: 'node "${PLUGIN_ROOT}/hooks/stop-stop-bb2d7935.mjs"', type: 'command' }] }],
      },
    });
    expect(JSON.parse(writes(claude.entries)['hooks/hooks.json']!)).toMatchObject({
      hooks: {
        PostToolUse: [{ matcher: '^(?:Write|Edit)$' }],
        PreToolUse: [{ matcher: '^Bash$' }],
      },
    });
    expect(Reflect.get(codex, 'hookEntries')).toMatchObject([
      { relativePath: 'hooks/session-start-session-start-7ab7e8a5.mjs' },
      { relativePath: 'hooks/before-tool-check-command-1f5b5818.mjs' },
      { relativePath: 'hooks/after-tool-record-87785f02.mjs' },
      { relativePath: 'hooks/stop-stop-bb2d7935.mjs' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('normalizes a mixed hook fixture and reports malformed hook declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-contract-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  const loaded: LoadedConfig = {
    config: {
      hooks: {
        afterTool: {
          handler: './src/hooks/record.ts',
          tools: ['file.write', 'shell', 'file.write'],
        },
        beforeTool: [
          { handler: './src/hooks/check-command.ts', targets: ['codex', 'claude', 'codex'], timeout: 7, tools: ['shell', 'shell'] },
          { handler: './src/hooks/check-command.ts', targets: ['claude', 'codex'], timeout: 7, tools: ['shell'] },
        ],
        sessionStart: './src/hooks/session-start.ts',
        stop: './src/hooks/stop.ts',
      },
      plugin: { name: 'review-tools', version: '1.0.0' },
    },
    configPath,
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };
  const invalid: LoadedConfig = {
    ...loaded,
    config: {
      ...loaded.config,
      hooks: {
        afterTool: { handler: './src/hooks/record.ts', tools: ['unknown-tool'] },
        beforeTool: { handler: './src/hooks/check-command.ts', targets: ['portable', ''] },
        sessionStart: { tools: ['shell'] } as unknown as { handler: string },
      },
    },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, registry);

    expect(model.hooks.map((hook) => ({
      event: hook.event,
      name: hook.name,
      targets: hook.targets,
      timeout: hook.timeout,
      tools: hook.tools,
    }))).toEqual([
      {
        event: 'sessionStart',
        name: 'session-start-session-start-7ab7e8a5',
        targets: ['claude', 'codex'],
        timeout: undefined,
        tools: [],
      },
      {
        event: 'beforeTool',
        name: 'before-tool-check-command-1f5b5818',
        targets: ['claude', 'codex'],
        timeout: 7,
        tools: ['shell'],
      },
      {
        event: 'beforeTool',
        name: 'before-tool-check-command-1f5b5818',
        targets: ['claude', 'codex'],
        timeout: 7,
        tools: ['shell'],
      },
      {
        event: 'afterTool',
        name: 'after-tool-record-87785f02',
        targets: ['claude', 'codex'],
        timeout: undefined,
        tools: ['file.write', 'shell'],
      },
      {
        event: 'stop',
        name: 'stop-stop-bb2d7935',
        targets: ['claude', 'codex'],
        timeout: undefined,
        tools: [],
      },
    ]);
    expect(validateModel(model, registry).map((diagnostic) => diagnostic.code)).toContain('AB4101');
    expect(validateSource(invalid, { skills: [] }).map((diagnostic) => diagnostic.code)).toEqual([
      'AB4200',
      'AB4201',
      'AB4204',
      'AB4203',
      'AB4202',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
