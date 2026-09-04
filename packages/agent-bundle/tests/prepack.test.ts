import { execFile as executeFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

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

/** A gzipped ustar archive in npm's layout: one `package/package.json` entry with the given manifest text. */
const packageTarball = (manifest: string): Buffer => {
  const data = Buffer.from(manifest);
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]));
};
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
    // A required peer nothing imports may be a deliberate host-compatibility contract: a warning, not a refusal.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning']);
    expect(reported[0]?.recovery).toContain('devDependencies');
    expect(reported[1]?.message).toContain('compatibility contract');
    expect(reported[1]?.recovery).toContain('peerDependenciesMeta');
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
      // The factory renamed on import is still a factory.
      'import { createRequire as makeRequire } from "node:module";',
      'const load = makeRequire(import.meta.url);',
      'export const driver = load("driver-package");',
      '',
    ].join('\n'));
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/aliased.mjs' }] };
      const [reported] = withCode(await diagnostics(pack), 'AB7014');
      expect(reported?.message).toContain('"never-loaded"');
      expect(reported?.message).not.toContain('"driver-package"');
      // Namespace-qualified factory, computed argument.
      await writeFile(consumer, 'import * as Module from "node:module";\nconst load = Module.createRequire(import.meta.url);\nexport const any = (name) => load(name);\n');
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
      // Factory chained off a CommonJS load, literal argument.
      await writeFile(consumer, 'const load = require("node:module").createRequire(__filename);\nmodule.exports = load("driver-package");\n');
      const [chained] = withCode(await diagnostics(pack), 'AB7014');
      expect(chained?.message).toContain('"never-loaded"');
      expect(chained?.message).not.toContain('"driver-package"');
      // Loader called inline with a literal.
      await writeFile(consumer, 'import { createRequire } from "node:module";\nexport const driver = createRequire(import.meta.url)("driver-package");\n');
      const [inline] = withCode(await diagnostics(pack), 'AB7014');
      expect(inline?.message).toContain('"never-loaded"');
      expect(inline?.message).not.toContain('"driver-package"');
      // Factory argument with nested calls, literal target.
      await writeFile(consumer, 'import { createRequire } from "node:module";\nexport const driver = createRequire(new URL("./entry.js", import.meta.url))("driver-package");\n');
      const [nested] = withCode(await diagnostics(pack), 'AB7014');
      expect(nested?.message).toContain('"never-loaded"');
      expect(nested?.message).not.toContain('"driver-package"');
      // The same factory argument, computed target: nothing can be called unused.
      await writeFile(consumer, 'import { createRequire } from "node:module";\nexport const any = (name) => createRequire(new URL("./entry.js", import.meta.url))(name);\n');
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
      // Declared bundled but absent from node_modules at pack time: npm silently packs nothing, so the consumer fetches it.
      'not-embedded': 'file:../not-embedded',
      // Shipped inside the tarball, as a directory with a manifest and as a package tarball: npm installs them from
      // the consumer's copy.
      vendored: 'file:vendor/vendored',
      tarred: 'file:vendor/tarred.tgz',
      // Declared as if shipped, but the source is not in the pack — or is packed and not installable: a `.tgz` that
      // is no archive (npm: TAR_BAD_ARCHIVE), a directory whose manifest does not parse.
      'not-vendored': 'file:vendor/not-vendored',
      'not-archive': 'file:vendor/not-archive.tgz',
      'bad-manifest': 'file:vendor/bad-manifest',
    };
    document.bundleDependencies = ['embedded', 'not-embedded'];
    document.optionalDependencies = {
      scp: 'git@github.com:owner/repo.git',
      // npm skips these three after the failed fetch too — and then postinstall fails: on the missing command, and on
      // the missing modules packed files it runs require. The files are reached as `node scripts/install` (Node
      // resolves `scripts/install.js`), and as `npm test` running a script whose quoted path contains a space.
      'setup-tool': 'git+https://github.com/owner/setup-tool.git',
      'optional-driver': 'github:owner/optional-driver',
      'optional-tester': 'github:owner/optional-tester',
      // npm parses these only to fail, so optional or not, the consumer's install dies.
      'typo-optional': 'foo:bar',
      'tag-optional': 'not a valid spec',
      'url-optional': 'http:%zz',
      'bad name': '^1.0.0',
    };
    document.scripts = {
      ...(document.scripts as Record<string, string> | undefined),
      postinstall: 'setup-tool --init && node scripts/install && npm test',
      test: 'node "scripts/my install.cjs"',
    };
  },
  async () => {
    await mkdir(join(projectRoot, 'scripts'), { recursive: true });
    await mkdir(join(projectRoot, 'vendor', 'vendored'), { recursive: true });
    await mkdir(join(projectRoot, 'vendor', 'bad-manifest'), { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, 'scripts', 'install.js'), 'import "./driver-setup.cjs";\n'),
      writeFile(join(projectRoot, 'scripts', 'driver-setup.cjs'), 'module.exports = require("optional-driver");\n'),
      writeFile(join(projectRoot, 'scripts', 'my install.cjs'), 'require("optional-tester");\n'),
      writeFile(join(projectRoot, 'vendor', 'vendored', 'package.json'), '{ "name": "vendored", "version": "1.0.0" }\n'),
      writeFile(join(projectRoot, 'vendor', 'bad-manifest', 'package.json'), '{\n'),
      writeFile(join(projectRoot, 'vendor', 'tarred.tgz'), packageTarball('{ "name": "tarred", "version": "1.0.0" }')),
      writeFile(join(projectRoot, 'vendor', 'not-archive.tgz'), 'not a tarball\n'),
    ]);
    const pack = { ...result.pack, files: [...result.pack.files,
      { path: 'node_modules/embedded/package.json' },
      { path: 'vendor/vendored/package.json' },
      { path: 'vendor/bad-manifest/package.json' },
      { path: 'vendor/tarred.tgz' },
      { path: 'vendor/not-archive.tgz' },
      { path: 'scripts/install.js' },
      { path: 'scripts/driver-setup.cjs' },
      { path: 'scripts/my install.cjs' },
    ] };
    const reported = withCode(await diagnostics(pack), 'AB7015');
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"bad name" -> "\^1\.0\.0", "optional-driver" -> "github:owner\/optional-driver", "optional-tester" -> "github:owner\/optional-tester", "setup-tool" -> "git\+https:\/\/github\.com\/owner\/setup-tool\.git", "tag-optional" -> "not a valid spec", "typo-optional" -> "foo:bar", "url-optional" -> "http:%zz"; consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"scp" -> "git@github\.com:owner\/repo\.git".*continues without them/u),
    ]);
    // npm survives an optional dependency it parsed but cannot fetch, so that entry warns rather than blocks the
    // release; a specifier it cannot parse fails the manifest read and stays fatal, as does a skipped package an
    // install script then runs or loads.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'error', 'warning']);
    expect(reported[1]?.message).not.toContain('"scp"');
    for (const name of ['setup-tool', 'optional-driver', 'optional-tester']) {
      expect(reported[2]?.message).not.toContain(JSON.stringify(name));
    }
    for (const name of ['@agent-bundle/runtime', 'bashjsast', 'local', 'sibling', 'not-embedded', 'not-vendored', 'not-archive', 'bad-manifest']) {
      expect(reported[0]?.message).toContain(`${JSON.stringify(name)} -> `);
    }
    for (const name of ['alias', 'tilde', 'versioned', 'embedded', 'vendored', 'tarred']) {
      expect(reported[0]?.message).not.toContain(JSON.stringify(name));
    }
    await rm(join(projectRoot, 'scripts'), { force: true, recursive: true });
    await rm(join(projectRoot, 'vendor'), { force: true, recursive: true });
    expect(reported[0]?.recovery).toContain('registry');

    const underPnpm = withCode(await diagnostics(pack, true), 'AB7015');
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

it('still reports AB7014 when the only resolve() calls are path or Promise resolution, literal or not', () => withPackageDocument(
  (document) => { document.dependencies = { 'never-loaded': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'resolvers.mjs');
    await writeFile(consumer, [
      'import path, { resolve } from "node:path";',
      'export const f = (a, b) => [resolve(a, b), Promise.resolve(a), path.resolve("never-loaded"), Promise.resolve("never-loaded")];',
      '',
    ].join('\n'));
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
    document.dependencies = {
      'driver-package': '^1.0.0',
      'named-in-script': '^1.0.0',
      typescript: '^5.0.0',
      // Not installed here, so its bin names are unknowable; the unscoped name stands in for npm's default bin.
      '@mapbox/node-pre-gyp': '^1.0.0',
      // A string-form `bin` is one command named after the installed manifest, not the alias.
      'prepack-test-wrapper': 'npm:@scope/real@^1.0.0',
      // npm never runs `prepare` for a registry or tarball install; a package only it names is installed for nothing.
      'prepare-only': '^1.0.0',
      // Reached only through npm's direct script commands: `npm t` is `test` (and its `pretest`), `yarn start` is `start`.
      'test-runner': '^1.0.0',
      'server-starter': '^1.0.0',
    };
    document.imports = { '#driver': { node: 'driver-package/node', default: 'driver-package' } };
    document.scripts = {
      ...(document.scripts as Record<string, string> | undefined),
      // `tsc` and `node-pre-gyp` are reached only through delegated run-scripts and their pre/post hooks, behind
      // options with values (`--prefix .`, `-w .`) and without (`--silent`), through npm's `rum` alias, and with
      // the script name quoted for the shell.
      postinstall: 'named-in-script --init && npm --silent --prefix . run setup && npm t',
      setup: 'echo setup',
      presetup: 'npm rum typecheck',
      typecheck: 'tsc --version',
      postsetup: 'pnpm run -w . "finish"',
      finish: 'node-pre-gyp install && real --check',
      prepare: 'prepare-only --generate',
      pretest: 'yarn start',
      test: 'test-runner --ci',
      start: 'server-starter',
    };
  },
  async () => {
    const consumer = join(projectRoot, 'dist', 'mapped.mjs');
    await writeFile(consumer, 'export { default } from "#driver";\n');
    // The fixture's node_modules is the workspace's; the manifest is removed again below.
    const wrapper = join(workspaceNodeModules, 'prepack-test-wrapper');
    await mkdir(wrapper, { recursive: true });
    await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: '@scope/real', version: '1.0.0', bin: 'cli.js' }));
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'dist/mapped.mjs' }] };
      // `#driver` reaches driver-package; the script names named-in-script directly, typescript through its `tsc` bin,
      // and the alias through `real`, the bin npm derives from the installed manifest's name. `prepare` proves nothing.
      const [withImport] = withCode(await diagnostics(pack), 'AB7014');
      expect(withImport?.message).toContain('"prepare-only"');
      expect(withImport?.message).not.toContain('"driver-package"');
      // Without the `#` import the map alone proves nothing.
      const [reported] = withCode(await diagnostics(), 'AB7014');
      expect(reported?.message).toContain('"driver-package"');
      expect(reported?.message).toContain('"prepare-only"');
      expect(reported?.message).not.toContain('"typescript"');
      expect(reported?.message).not.toContain('"@mapbox/node-pre-gyp"');
      expect(reported?.message).not.toContain('"prepack-test-wrapper"');
      expect(reported?.message).not.toContain('"test-runner"');
      expect(reported?.message).not.toContain('"server-starter"');
    } finally {
      await rm(wrapper, { force: true, recursive: true });
      await rm(consumer, { force: true });
    }
  },
));

it('prepack succeeds and surfaces the warning when the only finding is an unresolvable optional dependency', () => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'optional-native': 'github:owner/optional-native' };
    // The build rewrites dist, so the packed module that loads the optional package lives in its own packed
    // directory; an install script naming it instead would make the failed fetch fatal.
    document.files = [...(document.files as readonly string[]), 'extras'];
  },
  async () => {
    const extras = join(projectRoot, 'extras');
    await mkdir(extras, { recursive: true });
    await writeFile(join(extras, 'optional.mjs'), 'export const native = await import("optional-native").catch(() => undefined);\n');
    try {
      const packed = await prepack({ root: projectRoot });
      expect(packed.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity])).toEqual([['AB7015', 'warning']]);
    } finally {
      await rm(extras, { force: true, recursive: true });
    }
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
    document.dependencies = {
      'left-pad': '^1.3.0',
      '@scope/required': '^2.0.0',
      'asset-pkg': '^1.0.0',
      'tool-pkg': '^1.0.0',
      // Named only through escaped literals, which Node decodes before resolving.
      'hex-pkg': '^1.0.0',
      'unicode-pkg': '^1.0.0',
      // Run as an executable, never loaded: by the `tsc` bin its installed manifest declares.
      typescript: '^5.0.0',
    };
  },
  async () => {
    const consumer = join(projectRoot, 'dist', 'consumer.mjs');
    await writeFile(consumer, [
      'import { execSync, spawnSync } from "node:child_process";',
      'const ran = [spawnSync("tsc", ["--version"]), execSync("tsc --noEmit")];',
      'import leftPad from "left-pad/lib/index.js";',
      'const { createRequire } = await import("node:module");',
      'const require = createRequire(import.meta.url);',
      'const required = require("@scope/required/subpath");',
      'const asset = require.resolve("asset-pkg/package.json");',
      'const tool = import.meta.resolve("tool-pkg/bin/tool");',
      String.raw`const hex = require("\x68ex-pkg");`,
      String.raw`const unicode = require('unicode-pkg\u002fsubpath');`,
      '// import { Function } from "effect" -- a comment never counts.',
      'export { leftPad, required, asset, tool, hex, unicode, ran };',
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
