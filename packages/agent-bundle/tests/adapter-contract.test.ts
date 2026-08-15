import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import { validateModel } from '../src/config/validate.ts';

const metadata = Object.freeze({
  adapterRevision: 'test',
  capabilityRevision: 'test',
  capabilitySha256: '0'.repeat(64),
  observedVersion: 'test',
  schemas: Object.freeze([]),
});

it('delegates selected native hook sources through registered adapters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-adapter-contract-'));
  const source = join(root, 'example-hooks.json');
  let calledWithAdapter = false;
  const adapter: TargetAdapter = {
    capabilities: { hooks: true },
    configExtension: { key: 'example' },
    metadata,
    name: 'example',
    nativeHookSource(config) {
      calledWithAdapter = this === adapter;
      const extension = config.example as { readonly nativeHooks?: string } | undefined;
      return extension?.nativeHooks;
    },
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  };
  const registry = new TargetRegistry().register(adapter, { default: true });
  (adapter as { nativeHookSource?: TargetAdapter['nativeHookSource'] }).nativeHookSource = () => undefined;

  await writeFile(source, '{"hooks":{}}\n');
  try {
    const loaded: LoadedConfig = {
      config: {
        example: { nativeHooks: './example-hooks.json' },
        hooks: { stop: './hooks/stop.ts' },
        plugin: { name: 'example-fixture', version: '1.0.0' },
      },
      configPath: join(root, 'agent-bundle.config.ts'),
      context: {
        command: 'build',
        mode: 'production',
        projectRoot: root,
        selectedTargets: [],
      },
    };

    const model = await normalizeProject(loaded, { skills: [] }, registry);

    expect(calledWithAdapter).toBe(true);
    expect(model.extensions.example).toMatchObject({
      key: 'example',
      target: 'example',
      value: { nativeHooks: './example-hooks.json' },
    });
    expect(model.hooks[0]?.targets).toEqual(['example']);
    expect(model.nativeHooks).toEqual([{
      document: { hooks: {} },
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      source,
      target: 'example',
    }]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects malformed native hook source contributions atomically', () => {
  const registry = new TargetRegistry().register({
    capabilities: {},
    metadata,
    name: 'existing',
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  });

  expect(() => registry.register({
    capabilities: {},
    metadata,
    name: 'invalid',
    nativeHookSource: true,
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  } as unknown as TargetAdapter)).toThrow('native hook source');
  expect(registry.names()).toEqual(['existing']);
});

it('normalizes malformed native hook source values into diagnostics without skipping valid targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-source-invalid-'));
  const source = join(root, 'valid-hooks.json');
  const registry = new TargetRegistry()
    .register({
      capabilities: { hooks: true },
      metadata,
      name: 'invalid',
      nativeHookSource: () => null as never,
      plan: () => ({ diagnostics: [], entries: [] }),
      validateModel: () => [],
    })
    .register({
      capabilities: { hooks: true },
      metadata,
      name: 'valid',
      nativeHookSource: () => './valid-hooks.json',
      plan: () => ({ diagnostics: [], entries: [] }),
      validateModel: () => [],
    });

  await writeFile(source, '{"hooks":{}}\n');
  try {
    const loaded: LoadedConfig = {
      config: {
        plugin: { name: 'invalid-source-fixture', version: '1.0.0' },
        targets: ['invalid', 'valid'],
      },
      configPath: join(root, 'agent-bundle.config.ts'),
      context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
    };
    const model = await normalizeProject(loaded, { skills: [] }, registry);

    expect(model.nativeHooks).toContainEqual({
      document: { hooks: {} },
      provenance: { kind: 'config', sourcePath: loaded.configPath },
      source,
      target: 'valid',
    });
    expect(validateModel(model, registry)).toContainEqual({
      code: 'AB4208',
      message: 'Native hook source for target "invalid" must return a string or undefined.',
      severity: 'error',
      sourcePath: loaded.configPath,
      target: 'invalid',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('normalizes thrown native hook sources into diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-native-source-throws-'));
  const registry = new TargetRegistry().register({
    capabilities: { hooks: true },
    metadata,
    name: 'throws',
    nativeHookSource: () => {
      throw new Error('callback failure');
    },
    plan: () => ({ diagnostics: [], entries: [] }),
    validateModel: () => [],
  });
  const loaded: LoadedConfig = {
    config: {
      plugin: { name: 'throwing-source-fixture', version: '1.0.0' },
      targets: ['throws'],
    },
    configPath: join(root, 'agent-bundle.config.ts'),
    context: { command: 'build', mode: 'production', projectRoot: root, selectedTargets: [] },
  };

  try {
    const model = await normalizeProject(loaded, { skills: [] }, registry);

    expect(validateModel(model, registry)).toContainEqual({
      code: 'AB4209',
      message: 'Native hook source for target "throws" failed.',
      severity: 'error',
      sourcePath: loaded.configPath,
      target: 'throws',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
