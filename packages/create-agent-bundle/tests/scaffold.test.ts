import * as NodeServices from '@effect/platform-node/NodeServices';
import { Cause, Effect, type Exit, FileSystem, Path } from 'effect';
import { expect, layer } from 'effect-rstest';

import { runtimeSpecForFramework } from '../src/framework.ts';
import { UsageError, type TargetName } from '../src/options.ts';
import { assertScaffoldTarget, placeholderName, scaffold } from '../src/scaffold.ts';
import { packageTarball, tamperedPackageTarball } from './support/package-tarball.ts';

const workspaceRoot = process.cwd();
const templateRoot = (path: Path.Path, template: string): string =>
  path.join(workspaceRoot, 'packages', 'create-agent-bundle', 'templates', template);

interface ScaffoldedTemplate {
  readonly files: readonly string[];
  readonly frameworkSpec: string;
  readonly root: string;
}

/**
 * Scaffold one template into a scoped temp directory: the directory, and
 * everything the scaffold wrote under it, is removed when the test's scope
 * closes — no `finally` bookkeeping per test.
 */
const scaffoldTemplate = Effect.fnUntraced(function* (
  template: string,
  overrides: Partial<{
    packageName: string;
    pluginName: string;
    targets: readonly TargetName[];
    withRuntimeTarball: boolean;
  }> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: `create-agent-bundle-${template}-` });
  const frameworkTarball = path.join(root, 'agent-bundle-0.0.0.tgz');
  const runtimeTarball = path.join(root, 'agent-bundle-runtime-0.0.0.tgz');
  yield* fs.writeFile(frameworkTarball, packageTarball('agent-bundle'));
  if (overrides.withRuntimeTarball !== false) {
    yield* fs.writeFile(runtimeTarball, packageTarball('@agent-bundle/runtime'));
  }
  const frameworkSpec = `file:${frameworkTarball}`;
  const files = yield* scaffold({
    frameworkSpec,
    packageName: overrides.packageName ?? 'status-plugin',
    pluginName: overrides.pluginName ?? 'status-plugin',
    targetDirectory: path.join(root, 'project'),
    targets: overrides.targets ?? ['portable', 'codex', 'claude'],
    templateRoot: templateRoot(path, template),
  });
  yield* fs.remove(frameworkTarball);
  yield* fs.remove(runtimeTarball, { force: true });
  const scaffolded: ScaffoldedTemplate = { files, frameworkSpec, root: path.join(root, 'project') };
  return scaffolded;
});

const readJson = <T>(file: string): Effect.Effect<T, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(file)) as T;
  });

const readText = (file: string): Effect.Effect<string, unknown, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file);
  });

layer(NodeServices.layer, { excludeTestServices: true })('scaffold (real filesystem)', (it) => {
  it.effect('emits the documented minimal inventory', () => Effect.gen(function* () {
    const { files } = yield* scaffoldTemplate('minimal');
    expect(files).toEqual([
      '.gitignore',
      'README.md',
      'agent-bundle.config.ts',
      'package.json',
      'src/skills/getting-started/SKILL.md',
      'tests/skill.test.ts',
      'tsconfig.json',
    ]);
  }));

  it.effect('emits the documented mcp-server inventory', () => Effect.gen(function* () {
    const { files } = yield* scaffoldTemplate('mcp-server');
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
  }));

  it.effect('emits the documented cli-tool inventory', () => Effect.gen(function* () {
    const { files } = yield* scaffoldTemplate('cli-tool');
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
  }));

  it.effect('scaffolds publishable package fields for templates with package builds', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const [cliTool, mcpServer] = yield* Effect.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter' }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin' }),
    ], { concurrency: 'unbounded' });
    const cliManifest = yield* readJson<{
      readonly bin: Record<string, string>;
      readonly files: readonly string[];
      readonly scripts: Record<string, string>;
    }>(path.join(cliTool.root, 'package.json'));
    expect(cliManifest.files).toEqual(['dist', 'artifact', 'README.md']);
    expect(cliManifest.bin).toEqual({
      greeter: './dist/bin/greeter.js',
      'greeter-install': './dist/bin/greeter-install.js',
    });
    expect(cliManifest.scripts.prepack).toBe('agent-bundle prepack --json --output artifact');

    const mcpManifest = yield* readJson<{
      readonly bin: Record<string, string>;
      readonly exports: Record<string, { readonly import: string; readonly types: string }>;
      readonly files: readonly string[];
      readonly private: boolean;
      readonly scripts: Record<string, string>;
    }>(path.join(mcpServer.root, 'package.json'));
    expect(mcpManifest.private).toBe(true);
    expect(mcpManifest.files).toEqual(['dist', 'artifact', 'README.md']);
    expect(mcpManifest.bin).toEqual({ 'status-plugin': './dist/bin/status-plugin.js' });
    expect(mcpManifest.exports).toEqual({
      '.': { types: './dist/status.d.ts', import: './dist/status.js' },
    });
    expect(mcpManifest.scripts.prepack).toBe('agent-bundle prepack --json --output artifact');
    expect(yield* readText(path.join(mcpServer.root, 'agent-bundle.config.ts'))).toContain("lib: './src/status.ts'");
  }));

  it.effect('drops generated installer bins when no installable host target is selected', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const [cliTool, mcpServer] = yield* Effect.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter', targets: ['portable'] }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['portable'] }),
    ], { concurrency: 'unbounded' });
    const cliManifest = yield* readJson<{ readonly bin?: Record<string, string> }>(path.join(cliTool.root, 'package.json'));
    expect(cliManifest.bin).toEqual({
      greeter: './dist/bin/greeter.js',
    });

    const mcpManifest = yield* readJson<{ readonly bin?: Record<string, string> }>(path.join(mcpServer.root, 'package.json'));
    expect(mcpManifest.bin).toBeUndefined();
  }));

  it.effect('renders README install instructions for the selected targets', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const [defaults, cursorOnly, pluginOnly, portableOnly, minimal] = yield* Effect.all([
      scaffoldTemplate('cli-tool', { pluginName: 'greeter' }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['cursor'] }),
      scaffoldTemplate('mcp-server', { pluginName: 'status-plugin', targets: ['plugin'] }),
      scaffoldTemplate('cli-tool', { pluginName: 'greeter', targets: ['portable'] }),
      scaffoldTemplate('minimal', { pluginName: 'skills-only', targets: ['portable'] }),
    ], { concurrency: 'unbounded' });
    // Default targets (portable, codex, claude): one line per installable host,
    // in the package build's host order; the template's hard-coded `claude`
    // example never survives as the only instruction (#317 review).
    const defaultReadme = yield* readText(path.join(defaults.root, 'README.md'));
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
    const cursorReadme = yield* readText(path.join(cursorOnly.root, 'README.md'));
    expect(cursorReadme).toContain('npx status-plugin install cursor\n');
    expect(cursorReadme).not.toContain('install claude');
    expect(cursorReadme).not.toContain('install codex');

    // The composite plugin target installs into every host.
    const pluginReadme = yield* readText(path.join(pluginOnly.root, 'README.md'));
    expect(pluginReadme).toContain([
      'npx status-plugin install claude',
      'npx status-plugin install codex',
      'npx status-plugin install cursor',
    ].join('\n'));

    // Portable-only scaffolds ship no installer bin at all.
    const portableReadme = yield* readText(path.join(portableOnly.root, 'README.md'));
    expect(portableReadme).not.toMatch(/^npx \S+ install /mu);
    expect(portableReadme).toContain("no installable host target ('portable')");
    expect(portableReadme).toContain('add `claude`, `codex`, or `cursor` to `targets`');
    // Re-enabling installers needs the dropped package.json bin entry back too,
    // and the README names exactly the mapping the template shipped.
    const templateManifest = yield* readJson<{ readonly bin: Record<string, string> }>(
      path.join(templateRoot(path, 'cli-tool'), 'package_json'),
    );
    const installerBin = `${placeholderName}-install`;
    expect(templateManifest.bin[installerBin]).toBeDefined();
    const droppedEntry = `"greeter-install": "${templateManifest.bin[installerBin]?.replaceAll(placeholderName, 'greeter')}"`;
    expect(portableReadme).toContain(`# ${droppedEntry} to get one`);
    expect(portableReadme).toContain(`restore \`${droppedEntry}\` under \`bin\` in`);
    expect(portableReadme).toContain('never edits the manifest');

    // The skills-only template has no install section and passes through.
    const minimalReadme = yield* readText(path.join(minimal.root, 'README.md'));
    expect(minimalReadme).toBe(
      (yield* readText(path.join(templateRoot(path, 'minimal'), 'README.md'))).replaceAll(placeholderName, 'skills-only'),
    );
  }));

  it.effect('leaves the skills-only template without package-build packaging fields', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const { root } = yield* scaffoldTemplate('minimal');
    const manifest = yield* readJson<{
      readonly bin?: unknown;
      readonly files?: unknown;
      readonly scripts: Record<string, string>;
    }>(path.join(root, 'package.json'));
    expect(manifest.bin).toBeUndefined();
    expect(manifest.files).toBeUndefined();
    expect(manifest.scripts.prepack).toBeUndefined();
  }));

  it.effect('scaffolds the minimal template without a runtime tarball', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const { root } = yield* scaffoldTemplate('minimal', { withRuntimeTarball: false });
    const manifest = yield* readJson<{
      readonly devDependencies: Record<string, string>;
    }>(path.join(root, 'package.json'));
    expect(manifest.devDependencies['agent-bundle']).toMatch(/^file:/u);
  }));

  // Routed commands execute inside the typed Agent request context, so the
  // cli-tool template now pairs the runtime package like mcp-server does.
  it.effect('pins the paired runtime for the routed cli-tool template', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const { frameworkSpec, root } = yield* scaffoldTemplate('cli-tool', { pluginName: 'greeter' });
    const manifest = yield* readJson<{
      readonly dependencies: Record<string, string>;
    }>(path.join(root, 'package.json'));
    expect(manifest.dependencies['@agent-bundle/runtime']).toBe(runtimeSpecForFramework(frameworkSpec));
    expect(manifest.dependencies['zod']).toBeDefined();
  }));

  it.effect('replaces every placeholder and pins the framework spec', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const { files, frameworkSpec, root } = yield* scaffoldTemplate('cli-tool', {
      packageName: '@scope/status-plugin',
      pluginName: 'status-plugin',
    });
    for (const file of files) {
      const contents = yield* readText(path.join(root, file));
      expect(contents).not.toContain(placeholderName);
      expect(contents).not.toContain('workspace:*');
    }
    const manifest = yield* readJson<{
      readonly bin: Record<string, string>;
      readonly dependencies?: Record<string, string>;
      readonly devDependencies: Record<string, string>;
      readonly name: string;
    }>(path.join(root, 'package.json'));
    expect(manifest.name).toBe('@scope/status-plugin');
    expect(manifest.devDependencies['agent-bundle']).toBe(frameworkSpec);
    expect(files).toContain('src/cli/greet.ts');
    expect(manifest.dependencies?.['@agent-bundle/runtime']).toBe(runtimeSpecForFramework(frameworkSpec));
    expect(manifest.bin).toEqual({
      'status-plugin': './dist/bin/status-plugin.js',
      'status-plugin-install': './dist/bin/status-plugin-install.js',
    });
    const config = yield* readText(path.join(root, 'agent-bundle.config.ts'));
    expect(config).toContain("name: 'status-plugin'");
    // Routed CLI: no `scripts` or `bin` entry names the executable; the
    // command graph compiles from src/cli/** by convention.
    expect(config).not.toMatch(/\bscripts:/u);
    expect(config).not.toMatch(/\bbin:/u);
    // The generated help names the scaffolded plugin, and the template's own
    // proof asserts that exact text, so the rename must reach the test.
    expect(yield* readText(path.join(root, 'tests/projection/cli-dispatch.test.ts')))
      .toContain("Run 'status-plugin greet --help' for usage.");
  }));

  for (const template of ['minimal', 'mcp-server', 'cli-tool'] as const) {
    it.effect(`declares the ${template} release version only in package.json`, () => Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root } = yield* scaffoldTemplate(template);
      const manifest = yield* readJson<{ readonly version?: string }>(path.join(root, 'package.json'));
      expect(manifest.version).toBe('0.1.0');
      const config = yield* readText(path.join(root, 'agent-bundle.config.ts'));
      expect(config).not.toMatch(/\bversion:/u);
    }));
  }

  it.effect('writes the selected targets into the config', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const { root } = yield* scaffoldTemplate('minimal', { targets: ['portable', 'cursor'] });
    const config = yield* readText(path.join(root, 'agent-bundle.config.ts'));
    expect(config).toContain("targets: ['portable', 'cursor'],");
    expect(config).not.toContain("'codex'");
  }));

  it.effect('validates local runtime tarballs before writing scaffold files', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-validation-' });
    const frameworkTarball = path.join(root, 'agent-bundle-0.0.0.tgz');
    const targetDirectory = path.join(root, 'project');
    yield* fs.writeFile(frameworkTarball, packageTarball('agent-bundle'));
    const error = yield* Effect.flip(scaffold({
      frameworkSpec: `file:${frameworkTarball}`,
      packageName: 'status-plugin',
      pluginName: 'status-plugin',
      targetDirectory,
      targets: ['portable', 'codex', 'claude'],
      templateRoot: templateRoot(path, 'mcp-server'),
    }));
    expect(error).toBeInstanceOf(UsageError);
    expect(yield* fs.exists(targetDirectory)).toBe(false);
  }));

  const scaffoldFrameworkOnly = Effect.fnUntraced(function* (tarball: Buffer | undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-framework-only-' });
    const frameworkTarball = path.join(root, 'agent-bundle-0.0.0.tgz');
    const targetDirectory = path.join(root, 'project');
    const frameworkSpec = `file:${frameworkTarball}`;
    if (tarball !== undefined) yield* fs.writeFile(frameworkTarball, tarball);
    const outcome: Exit.Exit<readonly string[], unknown> = yield* Effect.exit(scaffold({
      frameworkSpec,
      packageName: 'status-plugin',
      pluginName: 'status-plugin',
      targetDirectory,
      targets: ['portable', 'codex', 'claude'],
      templateRoot: templateRoot(path, 'minimal'),
    }));
    return { frameworkSpec, outcome, targetDirectory };
  });

  const expectUsageFailure = (
    result: { readonly outcome: Exit.Exit<readonly string[], unknown> },
    message?: string,
  ): void => {
    expect(result.outcome._tag).toBe('Failure');
    if (result.outcome._tag !== 'Failure') return;
    const error = Cause.squash(result.outcome.cause);
    expect(error).toBeInstanceOf(UsageError);
    if (message !== undefined) expect((error as Error).message).toContain(message);
  };

  it.effect('rejects a missing local framework tarball for a template with no runtime dependency', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* scaffoldFrameworkOnly(undefined);
    expectUsageFailure(result);
    expect(yield* fs.exists(result.targetDirectory)).toBe(false);
  }));

  it.effect('rejects a corrupt local framework tarball for a template with no runtime dependency', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* scaffoldFrameworkOnly(Buffer.from('not a gzip archive'));
    expectUsageFailure(result);
    expect(yield* fs.exists(result.targetDirectory)).toBe(false);
  }));

  it.effect('rejects a misnamed local framework tarball for a template with no runtime dependency', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* scaffoldFrameworkOnly(packageTarball('@scope/not-agent-bundle'));
    expectUsageFailure(result, 'expected agent-bundle');
    expect(yield* fs.exists(result.targetDirectory)).toBe(false);
  }));

  it.effect('scaffolds a template with no runtime dependency from a valid local framework tarball', () => Effect.gen(function* () {
    const path = yield* Path.Path;
    const result = yield* scaffoldFrameworkOnly(packageTarball('agent-bundle'));
    expect(result.outcome._tag).toBe('Success');
    if (result.outcome._tag !== 'Success') return;
    expect(result.outcome.value).toContain('package.json');
    const manifest = yield* readJson<{
      readonly devDependencies: Record<string, string>;
    }>(path.join(result.targetDirectory, 'package.json'));
    expect(manifest.devDependencies['agent-bundle']).toBe(result.frameworkSpec);
  }));

  it.effect('rejects a local framework tarball with a tampered tar header', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const result = yield* scaffoldFrameworkOnly(tamperedPackageTarball('agent-bundle'));
    expectUsageFailure(result, 'Invalid tar header checksum');
    expect(yield* fs.exists(result.targetDirectory)).toBe(false);
  }));

  it.effect('resolves a relative framework tarball spec against the target directory', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-relative-' });
    yield* fs.writeFile(path.join(root, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle'));
    const targetDirectory = path.join(root, 'project');
    const frameworkSpec = 'file:../agent-bundle-0.0.0.tgz';
    const files = yield* scaffold({
      frameworkSpec,
      packageName: 'status-plugin',
      pluginName: 'status-plugin',
      targetDirectory,
      targets: ['portable'],
      templateRoot: templateRoot(path, 'minimal'),
    });
    expect(files).toContain('package.json');
    const manifest = yield* readJson<{
      readonly devDependencies: Record<string, string>;
    }>(path.join(targetDirectory, 'package.json'));
    expect(manifest.devDependencies['agent-bundle']).toBe(frameworkSpec);
  }));

  it.effect('resolves a relative framework/runtime tarball pair against the target directory', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-relative-pair-' });
    yield* fs.writeFile(path.join(root, 'agent-bundle-0.0.0.tgz'), packageTarball('agent-bundle'));
    yield* fs.writeFile(path.join(root, 'agent-bundle-runtime-0.0.0.tgz'), packageTarball('@agent-bundle/runtime'));
    const targetDirectory = path.join(root, 'project');
    const files = yield* scaffold({
      frameworkSpec: 'file:../agent-bundle-0.0.0.tgz',
      packageName: 'status-plugin',
      pluginName: 'status-plugin',
      targetDirectory,
      targets: ['portable'],
      templateRoot: templateRoot(path, 'mcp-server'),
    });
    expect(files).toContain('package.json');
    const manifest = yield* readJson<{
      readonly dependencies: Record<string, string>;
    }>(path.join(targetDirectory, 'package.json'));
    expect(manifest.dependencies['@agent-bundle/runtime']).toBe('file:../agent-bundle-runtime-0.0.0.tgz');
  }));
});

layer(NodeServices.layer, { excludeTestServices: true })('assertScaffoldTarget (real filesystem)', (it) => {
  it.effect('accepts a missing directory, an empty directory, and a lone .git', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-target-' });
    yield* assertScaffoldTarget(path.join(root, 'absent'), 'absent');
    yield* assertScaffoldTarget(root, 'empty');
    yield* fs.makeDirectory(path.join(root, '.git'));
    yield* assertScaffoldTarget(root, 'git-only');
  }));

  it.effect('rejects a directory with real contents', () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'create-agent-bundle-target-' });
    yield* fs.writeFileString(path.join(root, 'existing.txt'), 'occupied');
    const error = yield* Effect.flip(assertScaffoldTarget(root, 'occupied'));
    expect(error).toBeInstanceOf(UsageError);
  }));
});
