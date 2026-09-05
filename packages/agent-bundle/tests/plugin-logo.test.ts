import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { cursorAdapter, cursorPluginValidator } from '../src/adapters/cursor.ts';
import { normalizeProject, validateSource } from '../src/config/index.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { AgentBundleConfig, NormalizedPlugin } from '../src/core/types.ts';

const registry = createDefaultRegistry();
const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>\n';
const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { force: true, recursive: true })));
});

const loadedProject = async (
  plugin: AgentBundleConfig['plugin'],
  files: Readonly<Record<string, string>> = {},
): Promise<LoadedConfig> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-plugin-logo-'));
  tempRoots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  return {
    config: { plugin },
    configPath: join(root, 'agent-bundle.config.ts'),
    context: {
      command: 'build',
      mode: 'production',
      projectRoot: root,
      selectedTargets: [],
    },
  };
};

const logoModel = (target: 'cursor'): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  metadata: {
    description: 'Logo fixture',
    id: 'plugin:logo-fixture',
    logo: {
      bytes: Buffer.byteLength(logoSvg),
      path: 'assets/docs/media/logo.svg',
      source: '/workspace/docs/media/logo.svg',
    },
    name: 'logo-fixture',
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
    version: '1.0.0',
  },
  mcpServers: [],
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: `target:${target}`,
    name: target,
    provenance: { kind: 'config', sourcePath: '/workspace/agent-bundle.config.ts' },
  }],
});

it('rejects a missing or invalid plugin.logo with AB4012', async () => {
  const missing = await loadedProject({
    logo: 'docs/media/missing.svg',
    name: 'logo-fixture',
    version: '1.0.0',
  });
  expect(validateSource(missing, { skills: [] }, registry).filter(({ code }) => code === 'AB4012')).toMatchObject([{
    code: 'AB4012',
    severity: 'error',
    sourcePath: missing.configPath,
  }]);

  const empty = await loadedProject({
    logo: '   ',
    name: 'logo-fixture',
    version: '1.0.0',
  });
  expect(validateSource(empty, { skills: [] }, registry).filter(({ code }) => code === 'AB4012')).toMatchObject([{
    code: 'AB4012',
    severity: 'error',
    sourcePath: empty.configPath,
  }]);

  const directory = await loadedProject({
    logo: 'docs/media',
    name: 'logo-fixture',
    version: '1.0.0',
  }, { 'docs/media/.keep': '' });
  expect(validateSource(directory, { skills: [] }, registry).filter(({ code }) => code === 'AB4012')).toMatchObject([{
    code: 'AB4012',
    severity: 'error',
    sourcePath: directory.configPath,
  }]);

  const outside = await loadedProject({
    logo: '../outside.svg',
    name: 'logo-fixture',
    version: '1.0.0',
  });
  expect(validateSource(outside, { skills: [] }, registry).filter(({ code }) => code === 'AB4012')).toMatchObject([{
    code: 'AB4012',
    severity: 'error',
    sourcePath: outside.configPath,
  }]);
});

it('accepts an existing in-project plugin.logo and normalizes it onto metadata', async () => {
  const loaded = await loadedProject({
    description: 'Logo fixture',
    logo: 'docs/media/logo.svg',
    name: 'logo-fixture',
    version: '1.0.0',
  }, { 'docs/media/logo.svg': logoSvg });

  expect(validateSource(loaded, { skills: [] }, registry).filter(({ code }) => code === 'AB4012')).toEqual([]);

  const model = await normalizeProject(loaded, { skills: [] }, registry);
  expect(model.metadata.logo).toEqual({
    bytes: Buffer.byteLength(logoSvg),
    path: 'assets/docs/media/logo.svg',
    source: join(loaded.context.projectRoot, 'docs/media/logo.svg'),
  });
});

it('omits logo from the normalized model when the field is absent', async () => {
  const loaded = await loadedProject({
    name: 'logo-fixture',
    version: '1.0.0',
  });
  const model = await normalizeProject(loaded, { skills: [] }, registry);
  expect(model.metadata).not.toHaveProperty('logo');
});

it('permits a relative logo path on the pinned Cursor plugin schema', () => {
  expect(cursorPluginValidator({
    logo: './assets/docs/media/logo.svg',
    name: 'logo-fixture',
    version: '1.0.0',
  })).toBe(true);
});

it('emits Cursor plugin.json logo and copies the image into the artifact', () => {
  const model = logoModel('cursor');
  const plan = cursorAdapter.plan(model);
  expect(plan.diagnostics).toEqual([]);
  const manifest = JSON.parse(
    (plan.entries.find((entry) => entry.relativePath === '.cursor-plugin/plugin.json') as { readonly content: string }).content,
  ) as Record<string, unknown>;
  expect(manifest.logo).toBe('./assets/docs/media/logo.svg');
  expect(plan.entries).toContainEqual(expect.objectContaining({
    bytes: Buffer.byteLength(logoSvg),
    kind: 'copy',
    relativePath: 'assets/docs/media/logo.svg',
    source: '/workspace/docs/media/logo.svg',
  }));
});
