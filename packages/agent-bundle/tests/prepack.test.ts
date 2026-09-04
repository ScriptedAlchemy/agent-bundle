import { execFile as executeFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { prepack } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import type { Diagnostic } from '../src/core/diagnostics.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from '../src/build/pack-inventory.ts';

const execFile = promisify(executeFile);
const workspaceNodeModules = join(process.cwd(), 'node_modules');
let cleanupRoot: string;
let projectRoot: string;
let result: Awaited<ReturnType<typeof prepack>>;
let payloadPath: string;
let payloadBytes: string;

beforeAll(async () => {
  cleanupRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-prepack-'));
  projectRoot = join(cleanupRoot, 'project');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await symlink(workspaceNodeModules, join(projectRoot, 'node_modules'), 'dir');
  await Promise.all([
    writeFile(join(projectRoot, 'package.json'), `${JSON.stringify({
      bin: { 'installer-fixture': './dist/bin/installer-fixture.js' },
      files: ['dist', 'host-packs', 'README.md'],
      name: 'installer-fixture',
      type: 'module',
      version: '1.2.3',
    }, null, 2)}\n`),
    writeFile(join(projectRoot, 'README.md'), '# Installer fixture\n'),
    writeFile(join(projectRoot, 'agent-bundle.config.ts'), [
      'export default {',
      '  bin: false,',
      "  lib: './src/index.ts',",
      "  output: { distPath: 'host-packs' },",
      "  plugin: { name: 'installer-fixture' },",
      "  targets: ['cursor'],",
      '};',
      '',
    ].join('\n')),
    writeFile(join(projectRoot, 'src', 'index.ts'), 'export const value = 1;\n'),
  ]);
  result = await prepack({ root: projectRoot });
  payloadPath = join(projectRoot, 'host-packs', 'cursor', 'INSTALL.md');
  payloadBytes = await readFile(payloadPath, 'utf8');
});

afterAll(async () => {
  await rm(cleanupRoot, { force: true, recursive: true });
});

const diagnostics = (
  packOutput: PackOutput = result.pack,
  packerRewritesWorkspaceProtocols = false,
): Promise<readonly Diagnostic[]> =>
  packInventoryDiagnostics({
    artifactRoot: result.build.build.outputRoot,
    model: result.build.model,
    packageBuild: result.build.packageBuild!,
    packOutput,
    packerRewritesWorkspaceProtocols,
    projectRoot,
  });

it('parses npm 11 arrays and npm 12 package-keyed pack output', () => {
  const entry = { filename: 'fixture.tgz', files: [{ path: 'dist/index.js' }] };
  expect(packOutputFromJson(JSON.stringify([entry]))).toEqual(entry);
  expect(packOutputFromJson(JSON.stringify({ 'installer-fixture': entry }))).toEqual(entry);
});

it('selects the intended pack entry by package name when npm lists sibling workspace packages', () => {
  const runtime = { filename: 'agent-bundle-runtime-0.1.0.tgz', files: [{ path: 'dist/runtime.js' }], name: '@agent-bundle/runtime' };
  const bundle = { filename: 'agent-bundle-0.1.0.tgz', files: [{ path: 'dist/index.js' }], name: 'agent-bundle' };
  const scaffolder = { filename: 'create-agent-bundle-0.1.0.tgz', files: [{ path: 'dist/cli.js' }], name: 'create-agent-bundle' };
  const expected = { filename: bundle.filename, files: bundle.files };

  expect(packOutputFromJson(JSON.stringify([runtime, bundle, scaffolder]), 'agent-bundle')).toEqual(expected);
  expect(packOutputFromJson(JSON.stringify({
    '@agent-bundle/runtime': runtime,
    'agent-bundle': bundle,
    'create-agent-bundle': scaffolder,
  }), 'agent-bundle')).toEqual(expected);
  // npm 12 keys the object by name even when entries omit `name`.
  const { name: _name, ...unnamedBundle } = bundle;
  expect(packOutputFromJson(JSON.stringify({ 'agent-bundle': unnamedBundle }), 'agent-bundle')).toEqual(expected);

  expect(() => packOutputFromJson(JSON.stringify([runtime, bundle, scaffolder])))
    .toThrow(/returned 3 entries; expected exactly one/u);
  expect(() => packOutputFromJson(JSON.stringify([runtime, scaffolder]), 'agent-bundle'))
    .toThrow(/0 entries named "agent-bundle".*"@agent-bundle\/runtime", "create-agent-bundle"/u);
  expect(() => packOutputFromJson(JSON.stringify([bundle, bundle]), 'agent-bundle'))
    .toThrow(/2 entries named "agent-bundle"/u);
});

it('prepack validates the complete dry-run inventory', async () => {
  expect(await diagnostics()).toEqual([]);
  expect(result.pack.files.map((file) => file.path)).toContain('dist/bin/installer-fixture.js');
  expect(result.pack.files.map((file) => file.path)).toContain('host-packs/agent-bundle.manifest.json');
});

it('exposes --root, --output, and --json through the prepack command', async () => {
  const calls: unknown[] = [];
  const terminal = captureCliTerminal();
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runCli(
    ['prepack', '--root', projectRoot, '--output', 'host-packs', '--json'],
    terminal.output,
    {
      prepack: async (options) => {
        calls.push(options);
        return result;
      },
    },
  );
  expect(code).toBe(0);
  expect(calls).toEqual([expect.objectContaining({
    output: 'host-packs',
    packageOutputs: true,
    root: projectRoot,
  })]);
  expect(JSON.parse(terminal.stdout())).toMatchObject({
    build: { model: { metadata: { name: 'installer-fixture' } } },
    pack: { files: expect.any(Array) },
  });
});

it('reports missing allowlisted artifacts as AB7010', async () => {
  const pack = {
    ...result.pack,
    files: result.pack.files.filter((file) => file.path !== 'host-packs/cursor/INSTALL.md'),
  };
  expect(await diagnostics(pack)).toContainEqual(expect.objectContaining({ code: 'AB7010' }));
});

it('requires README.md even when the source file is absent', async () => {
  const readme = join(projectRoot, 'README.md');
  await rm(readme);
  try {
    const pack = {
      ...result.pack,
      files: result.pack.files.filter((file) => file.path !== 'README.md'),
    };
    expect(await diagnostics(pack)).toContainEqual(expect.objectContaining({
      code: 'AB7010',
      message: expect.stringContaining('"README.md"'),
    }));
  } finally {
    await writeFile(readme, '# Installer fixture\n');
  }
});

it('reports stale artifact hashes as AB7011', async () => {
  await writeFile(payloadPath, `${payloadBytes}stale\n`);
  try {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7011' }));
  } finally {
    await writeFile(payloadPath, payloadBytes);
  }
});

/** Runs `run` against `package.json` rewritten by `mutate`, restoring the original afterwards. */
const withPackageDocument = async (
  mutate: (document: Record<string, unknown>) => void,
  run: () => Promise<void>,
): Promise<void> => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  mutate(document);
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    await run();
  } finally {
    await writeFile(packagePath, original);
  }
};

const withCode = (reported: readonly Diagnostic[], code: string): readonly Diagnostic[] =>
  reported.filter((diagnostic) => diagnostic.code === code);

it('reports source-relative or unpacked package bins as AB7012', () => withPackageDocument(
  (document) => { document.bin = { 'installer-fixture': './src/cli.ts' }; },
  async () => {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7012' }));
  },
));

it('reports package, model, host, and provenance version disagreement as AB7013', () => withPackageDocument(
  (document) => { document.version = '9.0.0'; },
  async () => {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7013' }));
  },
));

it('reports installed dependencies no packed JavaScript imports as AB7014, per field', () => withPackageDocument(
  (document) => {
    document.dependencies = { zod: '4.5.4', effect: '4.0.0' };
    document.peerDependencies = { react: '19.2.8', 'optional-host': '^1.0.0' };
    document.peerDependenciesMeta = { 'optional-host': { optional: true } };
    document.devDependencies = { 'agent-bundle': 'workspace:*' };
  },
  async () => {
    const reported = withCode(await diagnostics(), 'AB7014');
    // One diagnostic per field; devDependencies never reach a consumer and optional peers are never installed, so
    // nothing has to use optional-host.
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*"effect", "zod"/u),
      expect.stringMatching(/^package\.json peerDependencies .*"react"/u),
    ]);
    expect(reported.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
    expect(reported[0]?.recovery).toContain('devDependencies');
  },
));

it('reports an optional peer only for a protocol npm cannot parse, which fails the install before any fetch', () => withPackageDocument(
  (document) => {
    document.peerDependencies = { 'git-peer': 'github:owner/git-peer', 'workspace-peer': 'workspace:*', 'typo-peer': 'foo:bar' };
    document.peerDependenciesMeta = {
      'git-peer': { optional: true },
      'typo-peer': { optional: true },
      'workspace-peer': { optional: true },
    };
  },
  async () => {
    const [reported] = withCode(await diagnostics(), 'AB7015');
    // npm never fetches an optional peer, so its git source is harmless; it still parses the specifier.
    expect(reported?.message).toMatch(/^package\.json peerDependencies .*"typo-peer" -> "foo:bar", "workspace-peer" -> "workspace:\*"/u);
    expect(reported?.message).not.toContain('"git-peer"');
    expect(reported?.severity).toBe('error');
    expect(withCode(await diagnostics(), 'AB7014')).toHaveLength(0);
    // A packer that rewrites workspace protocols leaves only the typo.
    expect(withCode(await diagnostics(result.pack, true), 'AB7015')[0]?.message).not.toContain('"workspace-peer"');
  },
));

it('accepts a package loaded through a createRequire() binding, literal or computed', () => withPackageDocument(
  (document) => { document.dependencies = { 'driver-package': '^1.0.0', 'never-loaded': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'aliased.mjs');
    await writeFile(consumer, [
      'import { createRequire } from "node:module";',
      'const load = createRequire(import.meta.url);',
      'export const driver = load("driver-package");',
      '',
    ].join('\n'));
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/aliased.mjs' }] };
      const [reported] = withCode(await diagnostics(pack), 'AB7014');
      expect(reported?.message).toContain('"never-loaded"');
      expect(reported?.message).not.toContain('"driver-package"');
      await writeFile(consumer, 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const any = (name) => load(name);\n');
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('reports git, GitHub-shorthand, remote-tarball, and path dependency specifiers as AB7015', () => withPackageDocument(
  (document) => {
    document.dependencies = {
      '@agent-bundle/runtime': 'https://pkg.pr.new/ScriptedAlchemy/agent-bundle/@agent-bundle/runtime@42539ff',
      bashjsast: 'github:woolkingx/bashjsast#131f4b6',
      local: 'file:../local',
      // Registry forms are not reported.
      alias: 'npm:effect@^4.0.0',
      tilde: '~1.2.3',
      versioned: '^1.2.3',
      // npm publishes a workspace protocol verbatim; only pnpm, Yarn, and Bun rewrite it while packing.
      sibling: 'workspace:*',
      // npm embeds bundled dependencies in the tarball; a consumer never fetches their specifier.
      embedded: 'file:../embedded',
    };
    document.bundleDependencies = ['embedded'];
    document.optionalDependencies = { scp: 'git@github.com:owner/repo.git' };
  },
  async () => {
    const reported = withCode(await diagnostics(), 'AB7015');
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"scp" -> "git@github\.com:owner\/repo\.git".*continues without them/u),
    ]);
    // npm survives an optional dependency it cannot fetch, so that entry warns rather than blocks the release.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning']);
    for (const name of ['@agent-bundle/runtime', 'bashjsast', 'local', 'sibling']) {
      expect(reported[0]?.message).toContain(`${JSON.stringify(name)} -> `);
    }
    for (const name of ['alias', 'tilde', 'versioned', 'embedded']) {
      expect(reported[0]?.message).not.toContain(JSON.stringify(name));
    }
    expect(reported[0]?.recovery).toContain('registry');

    const underPnpm = withCode(await diagnostics(result.pack, true), 'AB7015');
    expect(underPnpm[0]?.message).not.toContain('"sibling"');
  },
));

it('withholds AB7014 when packed JavaScript has a computed import() that could load any declared package', () => withPackageDocument(
  (document) => { document.dependencies = { 'chosen-at-runtime': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'computed.mjs');
    await writeFile(consumer, 'export const load = (name) => import(name);\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/computed.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
      // Without that file the same declaration is reported.
      expect(withCode(await diagnostics(), 'AB7014')).toHaveLength(1);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['require()', 'module.exports = (name) => require(name);'],
  ['require.resolve()', 'module.exports = (name) => require.resolve(name);'],
  ['import.meta.resolve()', 'export const where = (name) => import.meta.resolve(name);'],
  ['a direct createRequire()()', 'import { createRequire } from "node:module";\nexport const load = (name) => createRequire(import.meta.url)(name);'],
  ['require() of a literal-prefixed expression', 'module.exports = (variant) => require("chosen-at-runtime/" + variant);'],
  ['require.resolve() of a template literal', 'module.exports = (variant) => require.resolve(`chosen-at-runtime/${variant}`);'],
])('withholds AB7014 for a computed CommonJS %s just as for a computed import()', (_form, source) => withPackageDocument(
  (document) => { document.dependencies = { 'chosen-at-runtime': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', source.startsWith('module.exports') ? 'computed.cjs' : 'computed.mjs');
    await writeFile(consumer, `${source}\n`);
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: relative(projectRoot, consumer) }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('still reports AB7014 when the only non-literal resolve() calls are path or Promise resolution', () => withPackageDocument(
  (document) => { document.dependencies = { 'never-loaded': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'resolvers.mjs');
    await writeFile(consumer, 'import { resolve } from "node:path";\nexport const f = (a, b) => [resolve(a, b), Promise.resolve(a)];\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/resolvers.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')[0]?.message).toContain('"never-loaded"');
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('accepts a dependency reached through a package imports map or run by a consumer install script', () => withPackageDocument(
  (document) => {
    document.dependencies = { 'driver-package': '^1.0.0', 'named-in-script': '^1.0.0', typescript: '^5.0.0' };
    document.imports = { '#driver': { node: 'driver-package/node', default: 'driver-package' } };
    document.scripts = { ...(document.scripts as Record<string, string> | undefined), postinstall: 'named-in-script --init && tsc --version' };
  },
  async () => {
    const consumer = join(projectRoot, 'dist', 'mapped.mjs');
    await writeFile(consumer, 'export { default } from "#driver";\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/mapped.mjs' }] };
      // `#driver` reaches driver-package; the script names named-in-script directly and typescript through its `tsc` bin.
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
      // Without the `#` import the map alone proves nothing.
      const [reported] = withCode(await diagnostics(), 'AB7014');
      expect(reported?.message).toContain('"driver-package"');
      expect(reported?.message).not.toContain('"typescript"');
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('prepack succeeds and surfaces the warning when the only finding is an unresolvable optional dependency', () => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'optional-native': 'github:owner/optional-native' };
    // The build rewrites dist, so the usage evidence lives in an install script rather than a packed module.
    document.scripts = { ...(document.scripts as Record<string, string> | undefined), postinstall: 'optional-native --setup || true' };
  },
  async () => {
    const packed = await prepack({ root: projectRoot });
    expect(packed.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity])).toEqual([['AB7015', 'warning']]);
  },
));

it('accepts a dependency that only packed declaration files reference, including @types for a type directive', () => withPackageDocument(
  (document) => { document.dependencies = { zod: '^4.5.4', '@types/node': '^22.0.0' }; },
  async () => {
    const declaration = join(projectRoot, 'dist', 'consumer.d.ts');
    await writeFile(declaration, [
      '/// <reference types="node" />',
      "import type { ZodType } from 'zod';",
      'export declare const schema: ZodType;',
      'export declare const buffer: Buffer;',
      '',
    ].join('\n'));
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/consumer.d.ts' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(declaration, { force: true });
    }
  },
));

it('accepts a dependency that packed JavaScript imports, requires, or only resolves', () => withPackageDocument(
  (document) => {
    document.dependencies = { 'left-pad': '^1.3.0', '@scope/required': '^2.0.0', 'asset-pkg': '^1.0.0', 'tool-pkg': '^1.0.0' };
  },
  async () => {
    const consumer = join(projectRoot, 'dist', 'consumer.mjs');
    await writeFile(consumer, [
      'import leftPad from "left-pad/lib/index.js";',
      'const { createRequire } = await import("node:module");',
      'const require = createRequire(import.meta.url);',
      'const required = require("@scope/required/subpath");',
      'const asset = require.resolve("asset-pkg/package.json");',
      'const tool = import.meta.resolve("tool-pkg/bin/tool");',
      '// import { Function } from "effect" -- a comment never counts.',
      'export { leftPad, required, asset, tool };',
      '',
    ].join('\n'));
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/consumer.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('installs a real packed tarball and runs its Cursor installer from node_modules', async () => {
  const tarballs = join(cleanupRoot, 'tarballs');
  const consumer = join(cleanupRoot, 'consumer');
  const home = join(cleanupRoot, 'home');
  await Promise.all([
    mkdir(tarballs),
    mkdir(consumer),
    mkdir(join(home, '.cursor'), { recursive: true }),
  ]);
  const { stdout } = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], {
    cwd: projectRoot,
  });
  const packed = packOutputFromJson(stdout);
  await writeFile(join(consumer, 'package.json'), '{"private":true}\n');
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(tarballs, packed.filename)], {
    cwd: consumer,
  });
  const sourceCopy = join(cleanupRoot, 'source-copy');
  await cp(projectRoot, sourceCopy, { recursive: true, filter: (source) => source !== join(projectRoot, 'node_modules') });
  await rm(projectRoot, { force: true, recursive: true });

  const installedBin = join(consumer, 'node_modules', '.bin', 'installer-fixture');
  const installed = await execFile(installedBin, ['install', 'cursor', '--json'], {
    cwd: consumer,
    env: { ...process.env, HOME: home },
  });
  expect(JSON.parse(installed.stdout)).toMatchObject({ host: 'cursor', state: 'installed' });
  await expect(stat(join(home, '.cursor', 'plugins', 'local', 'installer-fixture'))).resolves.toBeDefined();
  expect(await readFile(join(sourceCopy, 'src', 'index.ts'), 'utf8')).toBe('export const value = 1;\n');
});
