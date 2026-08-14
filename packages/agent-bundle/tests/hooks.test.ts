import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { HookService } from '../src/services/hook-service.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { NormalizationTargetRegistry, NormalizedPlugin } from '../src/core/types.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['codex', 'claude'],
  has: (name) => name === 'portable' || name === 'codex' || name === 'claude',
};

const runPublishedHook = async (wrapper: string, input: string): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wrapper], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stderr }));
    child.stdin.end(input);
  });

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

it('lists and simulates only validated wrappers from a clean copied artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-source-'));
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-service-consumer-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const artifact = join(consumer, 'installed-plugin');
  const model = hookModel(root);
  const service = new HookService();

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'session-start.ts'), "export default (event: { source?: string }) => ({ outcome: 'continue' as const, additionalContext: `start:${event.source}` });\n"),
      writeFile(join(sourceRoot, 'check-command.ts'), [
        'export default (event: { toolInput?: { command?: string } }) => event.toolInput?.command === "blocked"',
        "  ? { outcome: 'deny' as const, reason: 'blocked command' }",
        "  : { outcome: 'continue' as const, updatedInput: { command: 'rewritten' }, additionalContext: 'checked' };",
        '',
      ].join('\n')),
      writeFile(join(sourceRoot, 'record.ts'), "export default () => ({ outcome: 'continue' as const, additionalContext: 'recorded' });\n"),
      writeFile(join(sourceRoot, 'stop.ts'), "export default () => ({ outcome: 'continue' as const });\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });
    await cp(outputRoot, artifact, { recursive: true });

    const listed = await service.list({ artifact });
    expect(listed).toEqual([
      expect.objectContaining({ event: 'afterTool', target: 'claude' }),
      expect.objectContaining({ event: 'beforeTool', target: 'claude' }),
      expect.objectContaining({ event: 'sessionStart', target: 'claude' }),
      expect.objectContaining({ event: 'stop', target: 'claude' }),
      expect.objectContaining({ event: 'afterTool', target: 'codex' }),
      expect.objectContaining({ event: 'beforeTool', target: 'codex' }),
      expect.objectContaining({ event: 'sessionStart', target: 'codex' }),
      expect.objectContaining({ event: 'stop', target: 'codex' }),
    ]);
    expect(listed.find((hook) => hook.id === 'hook:session-start:session-start:7ab7e8a5' && hook.target === 'codex')).toMatchObject({
      path: 'codex/hooks/session-start-session-start-7ab7e8a5.mjs',
    });
    for (const target of ['codex', 'claude'] as const) {
      await expect(service.simulate({
        artifact,
        hook: 'hook:session-start:session-start:7ab7e8a5',
        input: { source: 'startup' },
        target,
      })).resolves.toEqual({ additionalContext: 'start:startup', outcome: 'continue' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:before-tool:check-command:1f5b5818',
        input: { toolInput: { command: 'blocked' }, toolName: 'Bash' },
        target,
      })).resolves.toEqual({ outcome: 'deny', reason: 'blocked command' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:before-tool:check-command:1f5b5818',
        input: { toolInput: { command: 'safe' }, toolName: 'Bash' },
        target,
      })).resolves.toEqual({
        additionalContext: 'checked',
        outcome: 'continue',
        updatedInput: { command: 'rewritten' },
      });
      await expect(service.simulate({
        artifact,
        hook: 'hook:after-tool:record:87785f02',
        input: { toolName: 'Write', toolResponse: 'ok' },
        target,
      })).resolves.toEqual({ additionalContext: 'recorded', outcome: 'continue' });
      await expect(service.simulate({
        artifact,
        hook: 'hook:stop:stop:bb2d7935',
        input: { lastAssistantMessage: 'done', stopHookActive: false },
        target,
      })).resolves.toBeUndefined();
    }

    await writeFile(join(artifact, 'codex', 'hooks', 'session-start-session-start-7ab7e8a5.mjs'), 'broken');
    await expect(service.simulate({
      artifact,
      hook: 'hook:session-start:session-start:7ab7e8a5',
      input: { source: 'tampered' },
      target: 'codex',
    })).rejects.toThrow(/artifact files do not match/i);
  } finally {
    await Promise.all([
      rm(root, { force: true, recursive: true }),
      rm(consumer, { force: true, recursive: true }),
    ]);
  }
}, 15_000);

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

it('rejects malformed native hook input, exports, and handler results concisely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hooks-errors-'));
  const sourceRoot = join(root, 'src', 'hooks');
  const outputRoot = join(root, 'dist');
  const base = hookModel(root);
  const model: NormalizedPlugin = {
    ...base,
    hooks: [
      { ...base.hooks[0]!, id: 'hook:session-start:valid:00000001', name: 'valid-00000001', source: join(sourceRoot, 'valid.ts'), targets: ['codex'] },
      { ...base.hooks[0]!, id: 'hook:session-start:export:00000002', name: 'export-00000002', source: join(sourceRoot, 'no-default.ts'), targets: ['codex'] },
      { ...base.hooks[0]!, id: 'hook:session-start:result:00000003', name: 'result-00000003', source: join(sourceRoot, 'bad-result.ts'), targets: ['codex'] },
    ],
    targets: [base.targets[0]!],
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await Promise.all([
      writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
      writeFile(join(sourceRoot, 'valid.ts'), 'export default () => undefined;\n'),
      writeFile(join(sourceRoot, 'no-default.ts'), 'export const value = true;\n'),
      writeFile(join(sourceRoot, 'bad-result.ts'), "export default () => 'not a result';\n"),
    ]);
    await build({ model, outputRoot, projectRoot: root, registry: createDefaultRegistry() });

    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'valid-00000001.mjs'), '{not json')).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: stdin must contain exactly one JSON value\n',
    });
    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'export-00000002.mjs'), '{}')).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: default export must be a function\n',
    });
    await expect(runPublishedHook(join(outputRoot, 'codex', 'hooks', 'result-00000003.mjs'), '{}')).resolves.toEqual({
      code: 1,
      stderr: 'Agent Bundle hook error: handler must return void or a result object\n',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

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
