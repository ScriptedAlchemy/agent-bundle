import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { NormalizationTargetRegistry } from '../src/core/types.ts';
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
