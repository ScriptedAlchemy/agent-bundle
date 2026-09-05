import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { prepack } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { type Diagnostic, DiagnosticError } from '../src/core/diagnostics.ts';
import type { NormalizedPayload } from '../src/core/types.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from '../src/build/pack-inventory.ts';

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
  payloadPath = join(projectRoot, 'host-packs', 'INSTALL.md');
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
  expect(result.pack.files.map((file) => file.path)).toContain('index.js');
  expect(result.pack.files.map((file) => file.path)).toContain('agent-bundle.manifest.json');
});

it('exposes --root, --output, and --json through the prepack command', async () => {
  const calls: unknown[] = [];
  const terminal = captureCliTerminal();
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
    files: result.pack.files.filter((file) => file.path !== 'INSTALL.md'),
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
  const sourcePackagePath = join(projectRoot, 'package.json');
  const packagePath = join(projectRoot, 'dist', 'package.json');
  const sourceOriginal = await readFile(sourcePackagePath, 'utf8');
  const original = await readFile(packagePath, 'utf8');
  const sourceDocument = JSON.parse(sourceOriginal) as Record<string, unknown>;
  const document = JSON.parse(original) as Record<string, unknown>;
  mutate(sourceDocument);
  mutate(document);
  await writeFile(sourcePackagePath, `${JSON.stringify(sourceDocument, null, 2)}\n`);
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    await run();
  } finally {
    await writeFile(sourcePackagePath, sourceOriginal);
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

it('accepts a dependency declared by a prebuilt payload runtimeDependencies list', () => withPackageDocument(
  (document) => {
    document.dependencies = { sharp: '^0.33.0', 'never-loaded': '^1.0.0' };
  },
  async () => {
    const payload: NormalizedPayload = {
      files: [],
      id: 'payload:tools',
      name: 'tools',
      provenance: { kind: 'prebuilt', sourcePath: join(projectRoot, 'agent-bundle.config.ts') },
      runtimeDependencies: ['sharp'],
      source: join(projectRoot, 'built', 'tools'),
      targets: ['claude'],
    };
    const reported = withCode(await packInventoryDiagnostics({
      artifactRoot: result.build.build.outputRoot,
      model: { ...result.build.model, payloads: [payload] },
      packageBuild: result.build.packageBuild!,
      packOutput: result.pack,
      packerRewritesWorkspaceProtocols: false,
      projectRoot,
    }), 'AB7014');

    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toContain('"never-loaded"');
    expect(reported[0]?.message).not.toContain('"sharp"');
    expect(reported[0]?.message).toContain('no prebuilt payload declares');
    expect(reported[0]?.recovery).toContain('runtimeDependencies');
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'aliased.mjs' }] };
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
      // Comments between the loader and its parentheses, and around the literal, are trivia — and not a computed argument.
      await writeFile(consumer, 'module.exports = require /* driver */ ( // which\n /* a */ "driver-package" /* b */ );\n');
      const [commented] = withCode(await diagnostics(pack), 'AB7014');
      expect(commented?.message).toContain('"never-loaded"');
      expect(commented?.message).not.toContain('"driver-package"');
      // Comment trivia before a computed argument still leaves the load computed.
      await writeFile(consumer, 'module.exports = (name) => require /* any */ (/* of */ name);\n');
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['a namespace import', 'import * as Module from "node:module";\nexport const driver = Module.createRequire(import.meta.url)("driver-package");'],
  ['the default import', 'import module from "node:module";\nexport const driver = module.createRequire(import.meta.url)("driver-package");'],
  ['require("node:module")', 'module.exports = require("node:module").createRequire(__filename)("driver-package");'],
  ["require('module')", "module.exports = require('module').createRequire(__filename)('driver-package');"],
  ['require("node:module") and .resolve', 'module.exports = require("node:module").createRequire(__filename).resolve("driver-package");'],
  ['a two-level namespace, bound first', 'import * as ns from "node:module";\nconst load = ns.default.createRequire(import.meta.url);\nexport const driver = load("driver-package");'],
])('accepts a package loaded by a createRequire() call qualified through %s, direct or bound', (_form, source) => withPackageDocument(
  (document) => { document.dependencies = { 'driver-package': '^1.0.0', 'never-loaded': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', source.startsWith('import') ? 'qualified.mjs' : 'qualified.cjs');
    await writeFile(consumer, `${source}\n`);
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: relative(join(projectRoot, 'dist'), consumer) }] };
      const [reported] = withCode(await diagnostics(pack), 'AB7014');
      expect(reported?.message).toContain('"never-loaded"');
      expect(reported?.message).not.toContain('"driver-package"');
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['a namespace import', 'import * as Module from "node:module";\nexport const load = (name) => Module.createRequire(import.meta.url)(name);'],
  ['require("node:module")', 'module.exports = (name) => require("node:module").createRequire(__filename)(name);'],
])('withholds AB7014 for a computed direct createRequire()() call qualified through %s', (_form, source) => withPackageDocument(
  (document) => { document.dependencies = { 'chosen-at-runtime': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', source.startsWith('import') ? 'qualified.mjs' : 'qualified.cjs');
    await writeFile(consumer, `${source}\n`);
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: relative(join(projectRoot, 'dist'), consumer) }] };
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
      // A well-formed archive whose `package/package.json` is not JSON: npm fails the install with EJSONPARSE.
      'bad-tarred-manifest': 'file:vendor/bad-tarred-manifest.tgz',
    };
    document.bundleDependencies = ['embedded', 'not-embedded'];
    document.optionalDependencies = {
      scp: 'git@github.com:owner/repo.git',
      // npm skips these ten after the failed fetch too — and then postinstall fails: on the missing commands, and on
      // the missing modules packed files it runs require. `newline-tool` is the first command of postinstall's second
      // line, `setup-tool` the second of the first. The files are reached as `node scripts/install` (Node resolves
      // `scripts/install.js`), as `npm test` running a script whose quoted path contains a space, and as
      // `node scripts/hooks.cjs&&…` with no whitespace around the shell operator; the last loads its dependencies
      // through a wildcard `imports` entry mapped to the package's own file, and through a directory whose packed
      // manifest names its `main`. An inline `node -e` program that requires a package needs it too — its quotes
      // escaped for the shell — as do the modules `node` preloads — a bare `-r` package and a packed `--import=`
      // file, behind the valued `--conditions` option — before running `.`, the root `main`, and the one a
      // `NODE_OPTIONS=--require=…` assignment on the `node` command preloads.
      'setup-tool': 'git+https://github.com/owner/setup-tool.git',
      'newline-tool': 'github:owner/newline-tool',
      'optional-driver': 'github:owner/optional-driver',
      'optional-tester': 'github:owner/optional-tester',
      'optional-hook': 'github:owner/optional-hook',
      'optional-main': 'github:owner/optional-main',
      'optional-inline': 'github:owner/optional-inline',
      'optional-preload': 'github:owner/optional-preload',
      'optional-imported': 'github:owner/optional-imported',
      'optional-root': 'github:owner/optional-root',
      'optional-env-preload': 'github:owner/optional-env-preload',
      // Merely mentioned by the script — an `echo` argument; the operand of `rm -r`, whose `-r` is not Node's
      // preload option; and the value of a `--require` after the program, which Node hands to the program as an
      // argument — so npm's skipping them breaks nothing: a warning.
      'optional-mentioned': 'github:owner/optional-mentioned',
      'optional-removed': 'github:owner/optional-removed',
      'optional-argument': 'github:owner/optional-argument',
      // npm parses these only to fail, so optional or not, the consumer's install dies.
      'typo-optional': 'foo:bar',
      'tag-optional': 'not a valid spec',
      'url-optional': 'http:%zz',
      'bad name': '^1.0.0',
    };
    document.imports = { '#hooks/*': './scripts/*-setup.cjs' };
    document.main = './scripts/root-setup.cjs';
    document.scripts = {
      ...(document.scripts as Record<string, string> | undefined),
      postinstall: 'echo start\nnewline-tool --init && setup-tool --init'
        + ' && NODE_OPTIONS=--require=optional-env-preload node scripts/install --require optional-argument && npm test',
      // A `NODE_OPTIONS` that preloads nothing, set through `cross-env`, changes nothing about the command it precedes.
      test: 'cross-env NODE_OPTIONS="--max-old-space-size=4096" node "scripts/my install.cjs";node scripts/hooks.cjs&&echo optional-mentioned'
        + ' && node -e "require(\\"optional-inline\\")"'
        + ' && rm -r optional-removed && node --conditions react-server -r optional-preload/register --import="./scripts/preload.mjs" .',
    };
  },
  async () => {
    const packageRoot = join(projectRoot, 'dist');
    await mkdir(join(packageRoot, 'scripts', 'lib'), { recursive: true });
    await mkdir(join(packageRoot, 'vendor', 'vendored'), { recursive: true });
    await mkdir(join(packageRoot, 'vendor', 'bad-manifest'), { recursive: true });
    await Promise.all([
      writeFile(join(packageRoot, 'scripts', 'install.js'), 'import "./driver-setup.cjs";\n'),
      writeFile(join(packageRoot, 'scripts', 'driver-setup.cjs'), 'module.exports = require("optional-driver");\n'),
      writeFile(join(packageRoot, 'scripts', 'my install.cjs'), 'require("optional-tester");\n'),
      writeFile(join(packageRoot, 'scripts', 'hooks.cjs'), 'require("#hooks/hook");\nrequire("./lib");\n'),
      writeFile(join(packageRoot, 'scripts', 'hook-setup.cjs'), 'require("optional-hook");\n'),
      writeFile(join(packageRoot, 'scripts', 'lib', 'package.json'), '{ "main": "setup.cjs" }\n'),
      writeFile(join(packageRoot, 'scripts', 'lib', 'setup.cjs'), 'require("optional-main");\n'),
      writeFile(join(packageRoot, 'scripts', 'preload.mjs'), 'import "optional-imported";\n'),
      writeFile(join(packageRoot, 'scripts', 'root-setup.cjs'), 'require("optional-root");\n'),
      writeFile(join(packageRoot, 'vendor', 'vendored', 'package.json'), '{ "name": "vendored", "version": "1.0.0" }\n'),
      writeFile(join(packageRoot, 'vendor', 'bad-manifest', 'package.json'), '{\n'),
      writeFile(join(packageRoot, 'vendor', 'tarred.tgz'), packageTarball('{ "name": "tarred", "version": "1.0.0" }')),
      writeFile(join(packageRoot, 'vendor', 'bad-tarred-manifest.tgz'), packageTarball('not json\n')),
      writeFile(join(packageRoot, 'vendor', 'not-archive.tgz'), 'not a tarball\n'),
    ]);
    const pack = { ...result.pack, files: [...result.pack.files,
      { path: 'node_modules/embedded/package.json' },
      { path: 'vendor/vendored/package.json' },
      { path: 'vendor/bad-manifest/package.json' },
      { path: 'vendor/tarred.tgz' },
      { path: 'vendor/bad-tarred-manifest.tgz' },
      { path: 'vendor/not-archive.tgz' },
      { path: 'scripts/install.js' },
      { path: 'scripts/driver-setup.cjs' },
      { path: 'scripts/my install.cjs' },
      { path: 'scripts/hooks.cjs' },
      { path: 'scripts/hook-setup.cjs' },
      { path: 'scripts/lib/package.json' },
      { path: 'scripts/lib/setup.cjs' },
      { path: 'scripts/preload.mjs' },
      { path: 'scripts/root-setup.cjs' },
    ] };
    const reported = withCode(await diagnostics(pack), 'AB7015');
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"bad name" -> "\^1\.0\.0", "newline-tool" -> "github:owner\/newline-tool", "optional-driver" -> "github:owner\/optional-driver", "optional-env-preload" -> "github:owner\/optional-env-preload", "optional-hook" -> "github:owner\/optional-hook", "optional-imported" -> "github:owner\/optional-imported", "optional-inline" -> "github:owner\/optional-inline", "optional-main" -> "github:owner\/optional-main", "optional-preload" -> "github:owner\/optional-preload", "optional-root" -> "github:owner\/optional-root", "optional-tester" -> "github:owner\/optional-tester", "setup-tool" -> "git\+https:\/\/github\.com\/owner\/setup-tool\.git", "tag-optional" -> "not a valid spec", "typo-optional" -> "foo:bar", "url-optional" -> "http:%zz"; consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"optional-argument" -> "github:owner\/optional-argument", "optional-mentioned" -> "github:owner\/optional-mentioned", "optional-removed" -> "github:owner\/optional-removed", "scp" -> "git@github\.com:owner\/repo\.git".*continues without them/u),
    ]);
    // npm survives an optional dependency it parsed but cannot fetch, so that entry warns rather than blocks the
    // release; a specifier it cannot parse fails the manifest read and stays fatal, as does a skipped package an
    // install script then runs or loads.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'error', 'warning']);
    for (const name of ['scp', 'optional-argument', 'optional-mentioned', 'optional-removed']) {
      expect(reported[1]?.message).not.toContain(JSON.stringify(name));
    }
    for (const name of [
      'setup-tool', 'newline-tool', 'optional-driver', 'optional-tester', 'optional-hook', 'optional-main', 'optional-inline',
      'optional-preload', 'optional-imported', 'optional-root', 'optional-env-preload',
    ]) {
      expect(reported[2]?.message).not.toContain(JSON.stringify(name));
    }
    // To npm, `.` is the working directory (`--prefix .`), not a program: only `node .` runs the root `main`.
    await withPackageDocument(
      (document) => {
        document.scripts = { ...(document.scripts as Record<string, string>), postinstall: 'npm --prefix . run setup', setup: 'echo setup' };
      },
      async () => {
        const survivable = withCode(await diagnostics(pack), 'AB7015').find((diagnostic) => diagnostic.severity === 'warning');
        expect(survivable?.message).toContain('"optional-root"');
      },
    );
    for (const name of ['@agent-bundle/runtime', 'bashjsast', 'local', 'sibling', 'not-embedded', 'not-vendored', 'not-archive', 'bad-manifest', 'bad-tarred-manifest']) {
      expect(reported[0]?.message).toContain(`${JSON.stringify(name)} -> `);
    }
    for (const name of ['alias', 'tilde', 'versioned', 'embedded', 'vendored', 'tarred']) {
      expect(reported[0]?.message).not.toContain(JSON.stringify(name));
    }
    await rm(join(packageRoot, 'scripts'), { force: true, recursive: true });
    await rm(join(packageRoot, 'vendor'), { force: true, recursive: true });
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'computed.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
      // Without that file the same declaration is reported.
      expect(withCode(await diagnostics(), 'AB7014')).toHaveLength(1);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it('withholds AB7014 when packed JavaScript the lexer rejects may hide an import()', () => withPackageDocument(
  (document) => { document.dependencies = { 'chosen-at-runtime': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'unlexable.mjs');
    // An unbalanced call: the lexer throws before reporting any import, so nothing proves the package unused.
    await writeFile(consumer, 'export const load = () => import("chosen-at-runtime"\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'unlexable.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: relative(join(projectRoot, 'dist'), consumer) }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['const load = require;', 'const load = require;\nmodule.exports = load("chosen-at-runtime");'],
  ['fn(require)', 'module.exports = (fn) => fn(require);'],
  ['module.exports = require', 'module.exports = require'],
  ['[require]', 'module.exports = [require];'],
  ['a ? require : b', 'module.exports = typeof require === "function" ? require : null;'],
  ['a createRequire() binding passed on', 'import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nexport const use = (fn) => fn(load);'],
])('withholds AB7014 when a loader is passed on as a value (%s), since it may load anything under another name', (_form, source) => withPackageDocument(
  (document) => { document.dependencies = { 'chosen-at-runtime': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', source.startsWith('import') ? 'alias.mjs' : 'alias.cjs');
    await writeFile(consumer, `${source}\n`);
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: relative(join(projectRoot, 'dist'), consumer) }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['require("…")', 'module.exports = require("node:path");'],
  ['require.resolve("…")', 'module.exports = require.resolve("node:path");'],
  ['typeof require', 'module.exports = typeof require;'],
  ['the string "require"', 'module.exports = "require";'],
  ['prose in comments', '/**\n * Use when a getter may fail, require\n * services, or run asynchronously.\n */\n// factory(module, require)\nmodule.exports = 1;'],
  ['a bundler runtime named like require', 'const load = __webpack_require__;\nmodule.exports = load;'],
])('still reports AB7014 when require is only called, resolved through, type-tested, or named in a string or comment (%s)', (_form, source) => withPackageDocument(
  (document) => { document.dependencies = { 'never-loaded': '^1.0.0' }; },
  async () => {
    const consumer = join(projectRoot, 'dist', 'not-alias.cjs');
    await writeFile(consumer, `${source}\n`);
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'not-alias.cjs' }] };
      const [reported] = withCode(await diagnostics(pack), 'AB7014');
      expect(reported?.message).toContain('"never-loaded"');
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'resolvers.mjs' }] };
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
      // Named by a script that `npm run` and `npm test` only receive as an argument, never run.
      'dormant-only': '^1.0.0',
      // Reached only through npm's direct script commands: `npm t` is `test` (and its `pretest`), `yarn start` is `start`.
      'test-runner': '^1.0.0',
      'server-starter': '^1.0.0',
      // Reached only because `npm restart` without a `restart` script runs `stop` and `start`.
      'server-stopper': '^1.0.0',
    };
    document.imports = { '#driver': { node: 'driver-package/node', default: 'driver-package' } };
    document.scripts = {
      ...(document.scripts as Record<string, string> | undefined),
      // `tsc` and `node-pre-gyp` are reached only through delegated run-scripts and their pre/post hooks, behind
      // options with values (`--prefix .`, `-w pkg`, pnpm's `--filter pkg`) and without (`--silent`), through npm's
      // `rum` alias, after a `--`, and with the script name quoted for the shell. Only the first positional after
      // `run` (or the direct command) is the script: `dormant`, with or without a `--` before it, is an argument.
      postinstall: 'named-in-script --init && npm --silent --prefix . run setup dormant && npm t dormant && npm restart',
      setup: 'echo setup',
      presetup: 'pnpm --filter pkg rum typecheck',
      typecheck: 'tsc --version',
      postsetup: 'npm run -w pkg -- "finish" dormant',
      finish: 'node-pre-gyp install && real --check',
      dormant: 'dormant-only --generate',
      prepare: 'prepare-only --generate',
      pretest: 'yarn start',
      test: 'test-runner --ci',
      start: 'server-starter',
      stop: 'server-stopper',
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'mapped.mjs' }] };
      // `#driver` reaches driver-package; the script names named-in-script directly, typescript through its `tsc` bin,
      // and the alias through `real`, the bin npm derives from the installed manifest's name. `prepare` proves nothing.
      const [withImport] = withCode(await diagnostics(pack), 'AB7014');
      expect(withImport?.message).toContain('"prepare-only"');
      expect(withImport?.message).toContain('"dormant-only"');
      expect(withImport?.message).not.toContain('"driver-package"');
      // Without the `#` import the map alone proves nothing.
      const [reported] = withCode(await diagnostics(), 'AB7014');
      expect(reported?.message).toContain('"driver-package"');
      expect(reported?.message).toContain('"prepare-only"');
      expect(reported?.message).toContain('"dormant-only"');
      expect(reported?.message).not.toContain('"typescript"');
      expect(reported?.message).not.toContain('"@mapbox/node-pre-gyp"');
      expect(reported?.message).not.toContain('"prepack-test-wrapper"');
      expect(reported?.message).not.toContain('"test-runner"');
      expect(reported?.message).not.toContain('"server-starter"');
      expect(reported?.message).not.toContain('"server-stopper"');
      // With a `restart` script present, `npm restart` runs it alone: `stop` is no longer reached (`start` still is,
      // through `yarn start`).
      await withPackageDocument(
        (document) => { (document.scripts as Record<string, string>).restart = 'echo restart'; },
        async () => {
          const [withRestart] = withCode(await diagnostics(), 'AB7014');
          expect(withRestart?.message).toContain('"server-stopper"');
          expect(withRestart?.message).not.toContain('"server-starter"');
        },
      );
    } finally {
      await rm(wrapper, { force: true, recursive: true });
      await rm(consumer, { force: true });
    }
  },
));

it.each([
  ['a literal import()', 'node -e "import(\'optional-driver\')"', 'error'],
  ['an awaited import() in an ES module program', 'node --input-type=module -e "await import(\'optional-driver\')"', 'error'],
  ['a computed import(), which may load any declared package', 'node -e "import(process.argv[1])"', 'error'],
  ['a literal require()', 'node -e "require(\'optional-driver\')"', 'error'],
  ['source the lexer rejects, which may hide an import()', 'node -e "import(\'optional-driver\'"', 'error'],
  ['import.meta, which loads nothing', 'node --input-type=module -p "typeof import.meta"', 'warning'],
  ['the package name in a string', 'node -p "\'optional-driver\'"', 'warning'],
])('an inline node program with %s (%s) leaves a skipped optional dependency at severity %s', (_form, postinstall, severity) => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'optional-driver': 'github:owner/optional-driver' };
    document.scripts = { ...(document.scripts as Record<string, string> | undefined), postinstall };
  },
  async () => {
    const [reported] = withCode(await diagnostics(), 'AB7015');
    expect(reported?.message).toContain('"optional-driver"');
    expect(reported?.severity).toBe(severity);
  },
));

it('reads a dependency whose installed manifest is not JSON as an unknown executable instead of failing the gate', () => withPackageDocument(
  (document) => {
    document.dependencies = { 'broken-dep': '^1.0.0', 'never-loaded': '^1.0.0' };
    document.scripts = { ...(document.scripts as Record<string, string> | undefined), postinstall: 'broken-dep --init' };
  },
  async () => {
    // The fixture's node_modules is the workspace's; the manifest is removed again below.
    const broken = join(workspaceNodeModules, 'broken-dep');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'package.json'), '{ not json');
    try {
      // No throw; the unscoped name stands in for the unreadable manifest's bins, and the script runs it.
      const reported = await diagnostics();
      const [unused] = withCode(reported, 'AB7014');
      expect(unused?.message).toContain('"never-loaded"');
      expect(unused?.message).not.toContain('"broken-dep"');
      expect(withCode(reported, 'AB7015')).toHaveLength(0);
    } finally {
      await rm(broken, { force: true, recursive: true });
    }
  },
));

it('reads an installed manifest as npm does, so the last of duplicate name keys decides a string-form bin', () => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'prepack-test-dup': 'github:owner/prepack-test-dup' };
    document.scripts = { ...(document.scripts as Record<string, string> | undefined), postinstall: 'effective --init' };
  },
  async () => {
    // The fixture's node_modules is the workspace's; the manifest is removed again below. `JSON.stringify` cannot
    // write a duplicate key, so the manifest is spelled out.
    const dup = join(workspaceNodeModules, 'prepack-test-dup');
    await mkdir(dup, { recursive: true });
    await writeFile(join(dup, 'package.json'), '{ "name": "first-name", "name": "@scope/effective", "version": "1.0.0", "bin": "cli.js" }');
    try {
      // npm installs the bin as `effective`, the unscoped last `name`; the script runs it, so the skipped fetch is fatal.
      const reported = await diagnostics();
      const [skipped] = withCode(reported, 'AB7015');
      expect(skipped?.message).toContain('"prepack-test-dup"');
      expect(skipped?.severity).toBe('error');
      expect(withCode(reported, 'AB7014')).toHaveLength(0);
    } finally {
      await rm(dup, { force: true, recursive: true });
    }
  },
));

it('prepack rejects an unused unresolvable optional dependency and retains its fetch warning', () => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'optional-native': 'github:owner/optional-native' };
  },
  async () => {
    await expect(prepack({ root: projectRoot })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'AB7014', severity: 'error' }),
        expect.objectContaining({ code: 'AB7015', severity: 'warning' }),
      ],
    });
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'consumer.d.ts' }] };
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
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'consumer.mjs' }] };
      expect(withCode(await diagnostics(pack), 'AB7014')).toHaveLength(0);
    } finally {
      await rm(consumer, { force: true });
    }
  },
));

/**
 * A sibling project under `cleanupRoot`, laid out like `projectRoot`: the
 * workspace's node_modules, a manifest, a README, a config, and its files.
 * Tests that run a whole `prepack` get their own project so the shared
 * fixture's artifacts and manifest stay untouched.
 */
const createSiblingProject = async (
  name: string,
  packageDocument: Readonly<Record<string, unknown>>,
  configLines: readonly string[],
  files: Readonly<Record<string, string>>,
): Promise<string> => {
  const root = join(cleanupRoot, name);
  await mkdir(join(root, 'src'), { recursive: true });
  await symlink(workspaceNodeModules, join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeFile(join(root, 'package.json'), `${JSON.stringify(packageDocument, null, 2)}\n`),
    writeFile(join(root, 'README.md'), `# ${name}\n`),
    writeFile(join(root, 'agent-bundle.config.ts'), `${configLines.join('\n')}\n`),
    ...Object.entries(files).map(async ([path, content]) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }),
  ]);
  return root;
};

it('accepts a dependency that only a prebuilt payload module imports: prepack passes, AB6005 does not walk prebuilt payloads', async () => {
  const root = await createSiblingProject('prebuilt-project', {
    bin: { 'prebuilt-fixture': './dist/bin/prebuilt-fixture.js' },
    dependencies: { express: '^5.0.0' },
    files: ['dist', 'host-packs', 'README.md'],
    name: 'prebuilt-fixture',
    type: 'module',
    version: '1.2.3',
  }, [
    'export default {',
    '  bin: false,',
    "  lib: './src/index.ts',",
    "  mcp: { servers: { timeline: { entry: { prebuilt: './built/runtime/mcp/server.js' }, transport: 'stdio' } } },",
    "  output: { distPath: 'host-packs' },",
    "  payload: { runtime: './built/runtime' },",
    "  plugin: { name: 'prebuilt-fixture' },",
    "  targets: ['cursor'],",
    '};',
  ], {
    // A bare import in a module the framework copies rather than compiles: AB6005 never walks it, and the
    // import is the usage evidence that keeps `express` out of AB7014.
    'built/runtime/mcp/server.js': 'import express from "express";\nexport default express;\n',
    'src/index.ts': 'export const value = 1;\n',
  });
  const packed = await prepack({ root });
  const reported = [...packed.build.diagnostics, ...packed.diagnostics];
  expect(withCode(reported, 'AB6005')).toHaveLength(0);
  expect(withCode(reported, 'AB7014')).toHaveLength(0);
  // The payload is copied once into the composite root (#555): no `<target>/` partition under `distPath`.
  expect(packed.pack.files.map((file) => file.path)).toContain('runtime/mcp/server.js');
}, 180_000);

it('fails prepack with compile-time AB6005, never AB7014, when only a compiled dist bundle imports a declared dependency', async () => {
  const root = await createSiblingProject('externalized-project', {
    dependencies: { 'left-pad': '^1.3.0' },
    files: ['dist', 'host-packs', 'README.md'],
    name: 'externalized-fixture',
    type: 'module',
    version: '1.2.3',
  }, [
    'export default {',
    '  bin: false,',
    "  lib: { entry: './src/index.ts', dts: false },",
    "  output: { distPath: 'host-packs' },",
    "  plugin: { name: 'externalized-fixture' },",
    "  targets: ['cursor'],",
    '  tools: {',
    '    rspack: (config) => {',
    "      config.externals = [...(Array.isArray(config.externals) ? config.externals : [config.externals]).flat().filter(Boolean), 'left-pad'];",
    '    },',
    '  },',
    '};',
  ], {
    'src/index.ts': "import leftPad from 'left-pad';\nexport const pad = (value: string): string => leftPad(value, 4);\n",
  });
  const failure: unknown = await prepack({ root }).then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(DiagnosticError);
  const reported = (failure as DiagnosticError).diagnostics;
  expect(reported).toContainEqual({
    code: 'AB6005',
    generatedPath: 'dist/index.js',
    message: 'Compiled module "dist/index.js" keeps "left-pad" external (module) from src/index.ts; a generated executable bundles everything but Node built-ins.',
    recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
    severity: 'error',
  });
  expect(withCode(reported, 'AB7014')).toHaveLength(0);
}, 180_000);
