import { createRsbuild } from '@rsbuild/core';
import { createRslib } from '@rslib/core';
import { expect, it } from '@rstest/core';
import { init, parse } from 'es-module-lexer';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { composeMcpAppsRsbuildConfig } from '../src/build/mcp-apps.ts';
import { buildWithRslib, composeEntryLibConfig, entryLibId, type RslibEntry } from '../src/build/rslib.ts';
import type { AgentBundleMeta } from '../src/meta.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';

type RslibInspection = Awaited<ReturnType<Awaited<ReturnType<typeof createRslib>>['inspectConfig']>>;

const testMeta: AgentBundleMeta = Object.freeze({
  name: 'self-contained-probe-plugin',
  packageName: 'self-contained-probe-package',
  packageVersion: '1.0.0',
  version: '1.0.0',
});

const probeEntry = (root: string): RslibEntry => ({
  name: 'probe',
  outputRelativePath: 'scripts/probe.mjs',
  source: join(root, 'src', 'entry.ts'),
  sourceInputs: [join(root, 'src', 'entry.ts')],
});

/**
 * A minimal plugin project whose one executable imports a Node builtin (the
 * only kind of module a generated executable may leave external) and a real
 * registry package, `yaml`, so the build has a dependency to inline rather
 * than merely a program to compile. `yaml` ships CommonJS that `require()`s
 * the `buffer` and `process` builtins, which also exercises how a bundled
 * dependency reaches an external builtin. It resolves through this package's
 * own installed dependencies; the workspace root hoists nothing. The MCP App
 * view is only composed and inspected, never built, but Rsbuild still
 * requires the entry to exist on disk.
 */
const selfContainedProject = async (): Promise<{ readonly entry: RslibEntry; readonly root: string; readonly view: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-self-contained-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'views'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await symlink(agentBundleNodeModules, join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'src', 'entry.ts'), [
    "import { basename } from 'node:path';",
    "import { parse } from 'yaml';",
    "console.log(basename('/probe/config.yaml'), parse('probe: true'));",
    '',
  ].join('\n'));
  await writeFile(join(root, 'views', 'dashboard.ts'), "document.title = 'dashboard';\n");
  return { entry: probeEntry(root), root, view: join(root, 'views', 'dashboard.ts') };
};

/**
 * Rspack accepts one external declaration or arbitrarily nested arrays of
 * them; the assertions below judge each declaration on its own.
 */
const externalDeclarations = (externals: unknown): readonly unknown[] => {
  if (externals === undefined) return [];
  return Array.isArray(externals) ? externals.flatMap(externalDeclarations) : [externals];
};

/**
 * The only external declarations a generated executable may carry, exactly
 * the list Rslib itself attaches to a `node` target: a Node builtin by name,
 * the `node:`-scheme pattern, or Yarn PnP's `pnpapi`. Never a function, an
 * object map, or a package name.
 */
const isNodeBuiltinExternal = (external: unknown): boolean => {
  if (typeof external === 'string') return isBuiltin(external) || external === 'pnpapi';
  return external instanceof RegExp && external.source === '^node:';
};

/** Every declaration is a Node builtin, and there is at least one, so the check cannot pass vacuously. */
const expectOnlyNodeBuiltinExternals = (externals: unknown): void => {
  const declarations = externalDeclarations(externals);
  expect(declarations.length).toBeGreaterThan(0);
  expect(declarations.filter((external) => !isNodeBuiltinExternal(external))).toEqual([]);
};

it('composes the executable lib profile with nothing externalized', () => {
  // Composition never touches the filesystem, so no fixture is created.
  const root = join(tmpdir(), 'agent-bundle-self-contained-profile');
  const lib = composeEntryLibConfig(probeEntry(root), { cwd: root, meta: testMeta, outputRoot: join(root, 'dist') });
  expect(lib.bundle).toBe(true);
  expect(lib.splitChunks).toBe(false);
  // Rslib 1.x reads the option under `output`; the deprecated top-level
  // spelling must not creep back in through a merge layer, where it would
  // shadow the profile with Rslib's `true` default.
  expect(lib.output?.autoExternal).toBe(false);
  expect(lib.autoExternal).toBeUndefined();
  expect(lib.output?.externals).toBeUndefined();
});

it('lowers a generated executable with only Node builtins external and inlines its dependencies', async () => {
  const { entry, root } = await selfContainedProject();
  const inspections: RslibInspection[] = [];
  try {
    await buildWithRslib({ cwd: root, entries: [entry], meta: testMeta, outputRoot: join(root, 'dist') }, {
      createRslib: async (options) => {
        const rslib = await createRslib(options);
        return {
          build: (buildOptions) => rslib.build(buildOptions),
          inspectConfig: async (inspectOptions) => {
            const inspection = await rslib.inspectConfig(inspectOptions);
            inspections.push(inspection);
            return inspection;
          },
        };
      },
    });
    expect(inspections).toHaveLength(1);
    const { bundlerConfigs, environmentConfigs } = inspections[0]!.origin;
    expect(bundlerConfigs).toHaveLength(1);
    const bundler = bundlerConfigs[0]!;
    expectOnlyNodeBuiltinExternals(bundler.externals);
    expect(bundler.output?.asyncChunks).toBe(false);
    // Rslib's ESM format layer sets this over Rsbuild's lowering of
    // `splitChunks: false`; it splits only async chunks, of which
    // `asyncChunks: false` leaves none, so the artifact stays one file.
    expect(bundler.optimization?.splitChunks).toEqual({ chunks: 'async' });
    // Rslib's ESM default, deliberately kept: it governs only how the
    // already-external Node builtins are emitted, so a CommonJS `require()`
    // of a builtin inside a bundled dependency becomes the same
    // `createRequire()` shim Rslib 0.x produced.
    expect(bundler.externalsType).toBe('modern-module');

    const environment = environmentConfigs[entryLibId(entry)]!;
    expect(environment.splitChunks).toBe(false);
    // The profile's `output.autoExternal: false` survives normalization; the
    // Node builtin list is Rslib's own `node` target contribution.
    expect(environment.output).toHaveProperty('autoExternal', false);
    expectOnlyNodeBuiltinExternals(environment.output.externals);

    const bundle = await readFile(join(root, 'dist', 'scripts', 'probe.mjs'), 'utf8');
    await init;
    const [imports] = parse(bundle);
    // `import.meta` is reported as a pseudo-import without a specifier.
    const specifiers = imports.filter((record) => record.d !== -2).map((record) => record.n);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => specifier === undefined || !isBuiltin(specifier))).toEqual([]);
    expect(bundle).toContain('YAMLParseError');
    expect(bundle).toMatch(/createRequire\(import\.meta\.url\)/u);
    await expect(readdir(join(root, 'dist'))).resolves.toEqual(['scripts']);
    await expect(readdir(join(root, 'dist', 'scripts'))).resolves.toEqual(['probe.mjs']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

it('composes MCP App views as fully inlined web bundles with nothing externalized', async () => {
  const { root, view } = await selfContainedProject();
  try {
    const config = composeMcpAppsRsbuildConfig(
      [{ name: 'dashboard', source: view }],
      { cwd: root, meta: testMeta, outDir: join(root, 'dist', 'portable') },
    );
    const rsbuild = await createRsbuild({ cwd: root, config });
    const inspection = await rsbuild.inspectConfig({ mode: 'production' });
    const environment = inspection.origin.environmentConfigs.dashboard!;
    expect(environment.splitChunks).toBe(false);
    expect(environment.output.inlineScripts).toBe(true);
    expect(environment.output.inlineStyles).toBe(true);
    // A `web` target has no builtins to leave external, and `autoExternal`
    // is an Rslib concept the browser path never grows.
    expect(externalDeclarations(environment.output.externals)).toEqual([]);
    expect(environment.output).not.toHaveProperty('autoExternal');
    expect(inspection.origin.bundlerConfigs).toHaveLength(1);
    const bundler = inspection.origin.bundlerConfigs[0]!;
    expect(externalDeclarations(bundler.externals)).toEqual([]);
    expect(bundler.output?.asyncChunks).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
