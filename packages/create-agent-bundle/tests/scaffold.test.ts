import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { UsageError, type TargetName } from '../src/options.ts';
import { assertScaffoldTarget, placeholderName, scaffold } from '../src/scaffold.ts';

const templatesRoot = join(process.cwd(), 'packages', 'create-agent-bundle', 'templates');

const scaffoldTemplate = async (
  template: string,
  overrides: Partial<{ packageName: string; pluginName: string; targets: readonly TargetName[] }> = {},
): Promise<{ readonly files: readonly string[]; readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), `create-agent-bundle-${template}-`));
  const files = await scaffold({
    frameworkSpec: 'file:/tmp/agent-bundle-0.0.0.tgz',
    packageName: overrides.packageName ?? 'status-plugin',
    pluginName: overrides.pluginName ?? 'status-plugin',
    targetDirectory: join(root, 'project'),
    targets: overrides.targets ?? ['portable', 'codex', 'claude'],
    templateRoot: join(templatesRoot, template),
  });
  return { files, root: join(root, 'project') };
};

describe('scaffold', () => {
  it('emits the documented minimal inventory', async () => {
    const { files, root } = await scaffoldTemplate('minimal');
    try {
      expect(files).toEqual([
        '.gitignore',
        'README.md',
        'agent-bundle.config.ts',
        'package.json',
        'skills/getting-started/SKILL.md',
        'tests/skill.test.ts',
        'tsconfig.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('emits the documented mcp-server inventory', async () => {
    const { files, root } = await scaffoldTemplate('mcp-server');
    try {
      expect(files).toEqual([
        '.gitignore',
        'README.md',
        'agent-bundle.config.ts',
        'package.json',
        'src/mcp/status.ts',
        'src/scripts/check-status.ts',
        'src/status.ts',
        'tests/status.test.ts',
        'tsconfig.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('emits the documented cli-tool inventory', async () => {
    const { files, root } = await scaffoldTemplate('cli-tool');
    try {
      expect(files).toEqual([
        '.gitignore',
        'README.md',
        'agent-bundle.config.ts',
        'package.json',
        'src/cli.ts',
        'src/index.ts',
        'tests/cli.test.ts',
        'tsconfig.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('replaces every placeholder and pins the framework spec', async () => {
    const { files, root } = await scaffoldTemplate('cli-tool', {
      packageName: '@scope/status-plugin',
      pluginName: 'status-plugin',
    });
    try {
      for (const file of files) {
        const contents = await readFile(join(root, file), 'utf8');
        expect(contents).not.toContain(placeholderName);
        expect(contents).not.toContain('workspace:*');
      }
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        readonly bin: Record<string, string>;
        readonly devDependencies: Record<string, string>;
        readonly name: string;
      };
      expect(manifest.name).toBe('@scope/status-plugin');
      expect(manifest.devDependencies['agent-bundle']).toBe('file:/tmp/agent-bundle-0.0.0.tgz');
      expect(manifest.bin).toEqual({ 'status-plugin': './dist/bin/status-plugin.js' });
      const config = await readFile(join(root, 'agent-bundle.config.ts'), 'utf8');
      expect(config).toContain("name: 'status-plugin'");
      expect(config).toContain("'status-plugin': './src/cli.ts'");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('writes the selected targets into the config', async () => {
    const { root } = await scaffoldTemplate('minimal', { targets: ['portable', 'cursor'] });
    try {
      const config = await readFile(join(root, 'agent-bundle.config.ts'), 'utf8');
      expect(config).toContain("targets: ['portable', 'cursor'],");
      expect(config).not.toContain("'codex'");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('assertScaffoldTarget', () => {
  it('accepts a missing directory, an empty directory, and a lone .git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-target-'));
    try {
      await expect(assertScaffoldTarget(join(root, 'absent'), 'absent')).resolves.toBeUndefined();
      await expect(assertScaffoldTarget(root, 'empty')).resolves.toBeUndefined();
      await mkdir(join(root, '.git'));
      await expect(assertScaffoldTarget(root, 'git-only')).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects a directory with real contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-target-'));
    try {
      await writeFile(join(root, 'existing.txt'), 'occupied');
      await expect(assertScaffoldTarget(root, 'occupied')).rejects.toThrow(UsageError);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
