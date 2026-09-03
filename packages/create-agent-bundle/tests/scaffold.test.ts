import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { runtimeSpecForFramework } from '../src/framework.ts';
import { UsageError, type TargetName } from '../src/options.ts';
import { assertScaffoldTarget, placeholderName, scaffold } from '../src/scaffold.ts';
import { packageTarball, tamperedPackageTarball } from './support/package-tarball.ts';

const templatesRoot = join(process.cwd(), 'packages', 'create-agent-bundle', 'templates');

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
        'src/skills/getting-started/SKILL.md',
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
        'rstest.projection.config.ts',
        'rstest.route-unit.config.ts',
        'src/mcp/status/tools/report-status.tsx',
        'src/scripts/check-status.ts',
        'src/status.ts',
        'tests/projection/mcp-in-memory.test.ts',
        'tests/route-unit/report-status.test.ts',
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
        'rstest.projection.config.ts',
        'src/cli/greet.ts',
        'src/index.ts',
        'src/scripts/hello.ts',
        'tests/greet.test.ts',
        'tests/projection/cli-dispatch.test.ts',
        'tests/projection/script-dispatch.test.ts',
        'tsconfig.json',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('scaffolds publishable package fields for templates with package builds', async () => {
    const [cliTool, mcpServer] = await Promise.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter' }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin' }),
    ]);
    try {
      const cliManifest = JSON.parse(await readFile(join(cliTool.root, 'package.json'), 'utf8')) as {
        readonly bin: Record<string, string>;
        readonly files: readonly string[];
        readonly scripts: Record<string, string>;
      };
      expect(cliManifest.files).toEqual(['dist', 'artifact', 'README.md']);
      expect(cliManifest.bin).toEqual({
        greeter: './dist/bin/greeter.js',
        'greeter-install': './dist/bin/greeter-install.js',
      });
      expect(cliManifest.scripts.prepack).toBe('agent-bundle prepack --json --output artifact');

      const mcpManifest = JSON.parse(await readFile(join(mcpServer.root, 'package.json'), 'utf8')) as {
        readonly bin: Record<string, string>;
        readonly exports: Record<string, { readonly import: string; readonly types: string }>;
        readonly files: readonly string[];
        readonly private: boolean;
        readonly scripts: Record<string, string>;
      };
      expect(mcpManifest.private).toBe(true);
      expect(mcpManifest.files).toEqual(['dist', 'artifact', 'README.md']);
      expect(mcpManifest.bin).toEqual({ 'status-plugin': './dist/bin/status-plugin.js' });
      expect(mcpManifest.exports).toEqual({
        '.': { types: './dist/status.d.ts', import: './dist/status.js' },
      });
      expect(mcpManifest.scripts.prepack).toBe('agent-bundle prepack --json --output artifact');
      await expect(readFile(join(mcpServer.root, 'agent-bundle.config.ts'), 'utf8'))
        .resolves.toContain("lib: './src/status.ts'");
    } finally {
      await Promise.all([
        rm(cliTool.root, { force: true, recursive: true }),
        rm(mcpServer.root, { force: true, recursive: true }),
      ]);
    }
  });

  it('drops generated installer bins when no installable host target is selected', async () => {
    const [cliTool, mcpServer] = await Promise.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter', targets: ['portable'] }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['portable'] }),
    ]);
    try {
      const cliManifest = JSON.parse(await readFile(join(cliTool.root, 'package.json'), 'utf8')) as {
        readonly bin?: Record<string, string>;
      };
      expect(cliManifest.bin).toEqual({
        greeter: './dist/bin/greeter.js',
      });

      const mcpManifest = JSON.parse(await readFile(join(mcpServer.root, 'package.json'), 'utf8')) as {
        readonly bin?: Record<string, string>;
      };
      expect(mcpManifest.bin).toBeUndefined();
    } finally {
      await Promise.all([
        rm(cliTool.root, { force: true, recursive: true }),
        rm(mcpServer.root, { force: true, recursive: true }),
      ]);
    }
  });

  it('renders README install instructions for the selected targets', async () => {
    const [defaults, cursorOnly, pluginOnly, portableOnly, minimal] = await Promise.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter' }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['cursor'] }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['plugin'] }),
      scaffoldTemplate('cli-tool', { pluginName: 'greeter', targets: ['portable'] }),
      scaffoldTemplate('minimal', { pluginName: 'skills-only', targets: ['portable'] }),
    ]);
    try {
      // Default targets (portable, codex, claude): one line per installable host,
      // in the package build's host order; the template's hard-coded `claude`
      // example never survives as the only instruction (#317 review).
      const defaultReadme = await readFile(join(defaults.root, 'README.md'), 'utf8');
      expect(defaultReadme).toContain([
        '# after publishing/installing the package',
        'npx greeter-install install claude',
        'npx greeter-install install codex',
        '',
      ].join('\n'));
      expect(defaultReadme).not.toContain('install cursor');
      expect(defaultReadme).toContain('The installer accepts the\nselected host targets only: `claude`, `codex`.');

      // A cursor-only scaffold's installer rejects `claude`, so the README must
      // not suggest it.
      const cursorReadme = await readFile(join(cursorOnly.root, 'README.md'), 'utf8');
      expect(cursorReadme).toContain('npx status-plugin install cursor\n');
      expect(cursorReadme).not.toContain('install claude');
      expect(cursorReadme).not.toContain('install codex');

      // The composite plugin target installs into every host.
      const pluginReadme = await readFile(join(pluginOnly.root, 'README.md'), 'utf8');
      expect(pluginReadme).toContain([
        'npx status-plugin install claude',
        'npx status-plugin install codex',
        'npx status-plugin install cursor',
      ].join('\n'));

      // Portable-only scaffolds ship no installer bin at all.
      const portableReadme = await readFile(join(portableOnly.root, 'README.md'), 'utf8');
      expect(portableReadme).not.toMatch(/^npx \S+ install /mu);
      expect(portableReadme).toContain("no installable host target ('portable')");
      expect(portableReadme).toContain('add `claude`, `codex`, or `cursor` to `targets`');
      // Re-enabling installers needs the dropped package.json bin entry back too,
      // and the README names exactly the mapping the template shipped.
      const templateManifest = JSON.parse(
        await readFile(join(templatesRoot, 'cli-tool', 'package_json'), 'utf8'),
      ) as { readonly bin: Record<string, string> };
      const installerBin = `${placeholderName}-install`;
      expect(templateManifest.bin[installerBin]).toBeDefined();
      const droppedEntry = `"greeter-install": "${templateManifest.bin[installerBin]?.replaceAll(placeholderName, 'greeter')}"`;
      expect(portableReadme).toContain(`# ${droppedEntry} to get one`);
      expect(portableReadme).toContain(`restore \`${droppedEntry}\` under \`bin\` in`);
      expect(portableReadme).toContain('never edits the manifest');

      // The skills-only template has no install section and passes through.
      const minimalReadme = await readFile(join(minimal.root, 'README.md'), 'utf8');
      expect(minimalReadme).toBe(
        (await readFile(join(templatesRoot, 'minimal', 'README.md'), 'utf8')).replaceAll(placeholderName, 'skills-only'),
      );
    } finally {
      await Promise.all([defaults, cursorOnly, pluginOnly, portableOnly, minimal].map(
        ({ root }) => rm(root, { force: true, recursive: true }),
      ));
    }
  });

  it('leaves the skills-only template without package-build packaging fields', async () => {
    const { root } = await scaffoldTemplate('minimal');
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        readonly bin?: unknown;
        readonly files?: unknown;
        readonly scripts: Record<string, string>;
      };
      expect(manifest.bin).toBeUndefined();
      expect(manifest.files).toBeUndefined();
      expect(manifest.scripts.prepack).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('scaffolds the minimal template without a runtime tarball', async () => {
    const { root } = await scaffoldTemplate('minimal', { withRuntimeTarball: false });
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        readonly devDependencies: Record<string, string>;
      };
      expect(manifest.devDependencies['agent-bundle']).toMatch(/^file:/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // Routed commands execute inside the typed Agent request context, so the
  // cli-tool template now pairs the runtime package like mcp-server does.
  it('pins the paired runtime for the routed cli-tool template', async () => {
    const { frameworkSpec, root } = await scaffoldTemplate('cli-tool', { pluginName: 'greeter' });
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
        readonly dependencies: Record<string, string>;
      };
      expect(manifest.dependencies['@agent-bundle/runtime']).toBe(runtimeSpecForFramework(frameworkSpec));
      expect(manifest.dependencies['zod']).toBeDefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

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
      expect(files).toContain('src/cli/greet.ts');
      expect(manifest.dependencies?.['@agent-bundle/runtime']).toBe(runtimeSpecForFramework(frameworkSpec));
      expect(manifest.bin).toEqual({
        'status-plugin': './dist/bin/status-plugin.js',
        'status-plugin-install': './dist/bin/status-plugin-install.js',
      });
      const config = await readFile(join(root, 'agent-bundle.config.ts'), 'utf8');
      expect(config).toContain("name: 'status-plugin'");
      // Routed CLI: no `scripts` or `bin` entry names the executable; the
      // command graph compiles from src/cli/** by convention.
      expect(config).not.toMatch(/\bscripts:/u);
      expect(config).not.toMatch(/\bbin:/u);
      // The generated help names the scaffolded plugin, and the template's own
      // proof asserts that exact text, so the rename must reach the test.
      expect(await readFile(join(root, 'tests/projection/cli-dispatch.test.ts'), 'utf8'))
        .toContain("Run 'status-plugin greet --help' for usage.");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  for (const template of ['minimal', 'mcp-server', 'cli-tool'] as const) {
    it(`declares the ${template} release version only in package.json`, async () => {
      const { root } = await scaffoldTemplate(template);
      try {
        const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
          readonly version?: string;
        };
        expect(manifest.version).toBe('0.1.0');
        const config = await readFile(join(root, 'agent-bundle.config.ts'), 'utf8');
        expect(config).not.toMatch(/\bversion:/u);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    });
  }

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

  it('rejects a local framework tarball with a tampered tar header', async () => {
    await scaffoldFrameworkOnly(tamperedPackageTarball('agent-bundle'), async (scaffolded, targetDirectory) => {
      await expect(scaffolded).rejects.toThrow(UsageError);
      await expect(scaffolded).rejects.toThrow('Invalid tar header checksum');
      await expect(readdir(targetDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('resolves a relative framework tarball spec against the target directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-relative-'));
    try {
      await writeFile(join(root, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle'));
      const targetDirectory = join(root, 'project');
      const frameworkSpec = 'file:../agent-bundle-0.0.0.tgz';
      await expect(scaffold({
        frameworkSpec,
        packageName: 'status-plugin',
        pluginName: 'status-plugin',
        targetDirectory,
        targets: ['portable'],
        templateRoot: join(templatesRoot, 'minimal'),
      })).resolves.toContain('package.json');
      const manifest = JSON.parse(await readFile(join(targetDirectory, 'package.json'), 'utf8')) as {
        readonly devDependencies: Record<string, string>;
      };
      expect(manifest.devDependencies['agent-bundle']).toBe(frameworkSpec);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('resolves a relative framework/runtime tarball pair against the target directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'create-agent-bundle-relative-pair-'));
    try {
      await Promise.all([
        writeFile(join(root, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle')),
        writeFile(join(root, 'agent-bundle-runtime-0.0.0.tgz'), packageTarball('@agent-bundle/runtime')),
      ]);
      const targetDirectory = join(root, 'project');
      await expect(scaffold({
        frameworkSpec: 'file:../agent-bundle-0.0.0.tgz',
        packageName: 'status-plugin',
        pluginName: 'status-plugin',
        targetDirectory,
        targets: ['portable'],
        templateRoot: join(templatesRoot, 'mcp-server'),
      })).resolves.toContain('package.json');
      const manifest = JSON.parse(await readFile(join(targetDirectory, 'package.json'), 'utf8')) as {
        readonly dependencies: Record<string, string>;
      };
      expect(manifest.dependencies['@agent-bundle/runtime']).toBe('file:../agent-bundle-runtime-0.0.0.tgz');
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
