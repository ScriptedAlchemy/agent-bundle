import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from '@rstest/core';

import { runtimeSpecForFramework } from '../src/framework.ts';
import { UsageError, type TargetName } from '../src/options.ts';
import { assertScaffoldTarget, placeholderName, scaffold } from '../src/scaffold.ts';

const templatesRoot = join(process.cwd(), 'packages', 'create-agent-bundle', 'templates');

const packageTarball = (name: string): Buffer => {
  const manifest = Buffer.from(JSON.stringify({ name }));
  const archive = Buffer.alloc(512 + Math.ceil(manifest.length / 512) * 512 + 1024);
  archive.write('package/package.json', 0, 'utf8');
  archive.write(`${manifest.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  manifest.copy(archive, 512);
  return gzipSync(archive);
};

const scaffoldTemplate = async (
  template: string,
  overrides: Partial<{
    packageName: string;
    pluginName: string;
    targets: readonly TargetName[];
    withRuntimeTarball: boolean;
  }> = {},
): Promise<{ readonly files: readonly string[]; readonly frameworkSpec: string; readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), `create-agent-bundle-${template}-`));
  const frameworkTarball = join(root, 'agent-bundle-0.0.0.tgz');
  const runtimeTarball = join(root, 'agent-bundle-runtime-0.0.0.tgz');
  await writeFile(frameworkTarball, packageTarball('agent-bundle'));
  if (overrides.withRuntimeTarball !== false) {
    await writeFile(runtimeTarball, packageTarball('@agent-bundle/runtime'));
  }
  const frameworkSpec = `file:${frameworkTarball}`;
  const files = await scaffold({
    frameworkSpec,
    packageName: overrides.packageName ?? 'status-plugin',
    pluginName: overrides.pluginName ?? 'status-plugin',
    targetDirectory: join(root, 'project'),
    targets: overrides.targets ?? ['portable', 'codex', 'claude'],
    templateRoot: join(templatesRoot, template),
  });
  await Promise.all([rm(frameworkTarball), rm(runtimeTarball, { force: true })]);
  return { files, frameworkSpec, root: join(root, 'project') };
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
        'src/mcp/status/tools/report-status.tsx',
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

  for (const template of ['minimal', 'cli-tool'] as const) {
    it(`scaffolds the ${template} template without a runtime tarball`, async () => {
      const { root } = await scaffoldTemplate(template, { withRuntimeTarball: false });
      try {
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
          readonly devDependencies: Record<string, string>;
        };
        expect(manifest.devDependencies['agent-bundle']).toMatch(/^file:/u);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }

  it('replaces every placeholder and pins the framework spec', async () => {
    const { files, frameworkSpec, root } = await scaffoldTemplate('cli-tool', {
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
        readonly dependencies?: Record<string, string>;
        readonly devDependencies: Record<string, string>;
        readonly name: string;
      };
      expect(manifest.name).toBe('@scope/status-plugin');
      expect(manifest.devDependencies['agent-bundle']).toBe(frameworkSpec);
      if (files.includes('src/mcp/status/tools/report-status.tsx')) {
        expect(manifest.dependencies?.['@agent-bundle/runtime']).toBe(runtimeSpecForFramework(frameworkSpec));
      }
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

  it('validates local runtime tarballs before writing scaffold files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-validation-'));
    const frameworkTarball = join(root, 'agent-bundle-0.0.0.tgz');
    const targetDirectory = join(root, 'project');
    try {
      await writeFile(frameworkTarball, packageTarball('agent-bundle'));
      await expect(scaffold({
        frameworkSpec: `file:${frameworkTarball}`,
        packageName: 'status-plugin',
        pluginName: 'status-plugin',
        targetDirectory,
        targets: ['portable', 'codex', 'claude'],
        templateRoot: join(templatesRoot, 'mcp-server'),
      })).rejects.toThrow(UsageError);
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  const scaffoldFrameworkOnly = async (
    tarball: Buffer | undefined,
    check: (
      scaffolded: Promise<readonly string[]>,
      targetDirectory: string,
      frameworkSpec: string,
    ) => Promise<void>,
  ): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-framework-only-'));
    const frameworkTarball = join(root, 'agent-bundle-0.0.0.tgz');
    const targetDirectory = join(root, 'project');
    const frameworkSpec = `file:${frameworkTarball}`;
    try {
      if (tarball !== undefined) await writeFile(frameworkTarball, tarball);
      await check(scaffold({
        frameworkSpec,
        packageName: 'status-plugin',
        pluginName: 'status-plugin',
        targetDirectory,
        targets: ['portable', 'codex', 'claude'],
        templateRoot: join(templatesRoot, 'minimal'),
      }), targetDirectory, frameworkSpec);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  };

  it('rejects a missing local framework tarball for a template with no runtime dependency', async () => {
    await scaffoldFrameworkOnly(undefined, async (scaffolded, targetDirectory) => {
      await expect(scaffolded).rejects.toThrow(UsageError);
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects a corrupt local framework tarball for a template with no runtime dependency', async () => {
    await scaffoldFrameworkOnly(Buffer.from('not a gzip archive'), async (scaffolded, targetDirectory) => {
      await expect(scaffolded).rejects.toThrow(UsageError);
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('rejects a misnamed local framework tarball for a template with no runtime dependency', async () => {
    await scaffoldFrameworkOnly(packageTarball('@scope/not-agent-bundle'), async (scaffolded, targetDirectory) => {
      await expect(scaffolded).rejects.toThrow(UsageError);
      await expect(scaffolded).rejects.toThrow('expected agent-bundle');
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('scaffolds a template with no runtime dependency from a valid local framework tarball', async () => {
    await scaffoldFrameworkOnly(packageTarball('agent-bundle'), async (scaffolded, targetDirectory, frameworkSpec) => {
      await expect(scaffolded).resolves.toContain('package.json');
      const manifest = JSON.parse(await readFile(join(targetDirectory, 'package.json'), 'utf8')) as {
        readonly devDependencies: Record<string, string>;
      };
      expect(manifest.devDependencies['agent-bundle']).toBe(frameworkSpec);
    });
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
