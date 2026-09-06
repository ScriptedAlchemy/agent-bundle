import { execFile as executeFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { prepack } from '../src/api.ts';
import { packageCompileEvidenceFileName } from '../src/build/compile-evidence.ts';
import { runCli } from '../src/cli.ts';
import { type Diagnostic, DiagnosticError } from '../src/core/diagnostics.ts';
import type { NormalizedPayload } from '../src/core/types.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from '../src/build/pack-inventory.ts';
import type { PackageBuildResult } from '../src/build/package-build.ts';

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
  payloadPath = join(projectRoot, 'dist', 'INSTALL.md');
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

it('reports stale npm-root hashes as AB7011', async () => {
  await writeFile(payloadPath, `${payloadBytes}stale\n`);
  try {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7011' }));
  } finally {
    await writeFile(payloadPath, payloadBytes);
  }
});

it('reports package-only compile evidence drift as AB6039', async () => {
  const path = join(projectRoot, 'dist', packageCompileEvidenceFileName);
  const original = await readFile(path, 'utf8');
  try {
    const evidence = JSON.parse(original) as { policy: { revision: number } };
    evidence.policy.revision += 1;
    await writeFile(path, `${JSON.stringify(evidence)}\n`);
    expect(await diagnostics()).toContainEqual(expect.objectContaining({
      code: 'AB6039',
      generatedPath: packageCompileEvidenceFileName,
    }));
  } finally {
    await writeFile(path, original);
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

it('reports bins missing from the package npm will publish as AB7012', async () => {
  const packagePath = join(projectRoot, 'package.json');
  const original = await readFile(packagePath, 'utf8');
  const document = JSON.parse(original) as Record<string, unknown>;
  document.bin = {
    'installer-fixture': './dist/bin/installer-fixture.js',
    'installer-fixture-install': './dist/bin/installer-fixture-install.js',
  };
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`);
  try {
    await expect(prepack({ root: projectRoot })).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB7012',
        message: expect.stringContaining('"installer-fixture-install" -> "./dist/bin/installer-fixture-install.js"'),
      })],
    });
  } finally {
    await writeFile(packagePath, original);
  }
});

it('reports package, model, host, and provenance version disagreement as AB7013', () => withPackageDocument(
  (document) => { document.version = '9.0.0'; },
  async () => {
    expect(await diagnostics()).toContainEqual(expect.objectContaining({ code: 'AB7013' }));
  },
));

it('reports installed dependencies a consumer never needs as AB7014, per field', () => withPackageDocument(
  (document) => {
    document.dependencies = { zod: '4.5.4', effect: '4.0.0' };
    document.peerDependencies = { react: '19.2.8', 'optional-host': '^1.0.0' };
    document.peerDependenciesMeta = { 'optional-host': { optional: true } };
    document.devDependencies = { 'agent-bundle': 'workspace:*' };
  },
  async () => {
    const reported = withCode(await diagnostics(), 'AB7014');
    // One diagnostic per field; devDependencies never reach a consumer and optional peers are never installed, so
    // nothing has to use optional-host. The generated install bin inlines `effect`, so the compiler's evidence names
    // that bundle; `zod` reached no bundle and is only listed.
    expect(result.build.packageBuild!.evidence.assets.find((asset) => asset.path === 'index.js')?.packages)
      .toEqual([]);
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      'package.json dependencies names packages a consumer never needs installed: no packed declaration file references them, '
        + 'no consumer-side install script names or runs them, and no prebuilt payload declares them in runtimeDependencies: '
        + '"effect", "zod". Nothing packed reaches them at runtime; every consumer installs them for nothing.',
      expect.stringMatching(/^package\.json peerDependencies .*"react"\. If they only constrain the host version/u),
    ]);
    // A required peer nothing imports may be a deliberate host-compatibility contract: a warning, not a refusal.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'warning']);
    expect(reported[0]?.recovery).toBe('Move build-only packages to devDependencies; compiled bundles inline their imports (AB6005). '
      + 'Keep a runtime dependency only for what a packed declaration file references, a consumer install script names or runs, '
      + 'or a prebuilt payload declares in runtimeDependencies (definePrebuilt).');
    expect(reported[1]?.message).toContain('compatibility contract');
    expect(reported[1]?.recovery).toContain('peerDependenciesMeta');
  },
));

/** The shared fixture's package build, with compiler package evidence replaced per package-root path. */
const packageBuildBundling = (bundled: Readonly<Record<string, readonly string[]>>): PackageBuildResult => {
  const packageBuild = result.build.packageBuild!;
  return {
    ...packageBuild,
    evidence: {
      ...packageBuild.evidence,
      assets: packageBuild.evidence.assets.map((asset) => ({ ...asset, packages: bundled[asset.path] ?? [] })),
    },
  };
};

it('reports a dependency only compiled dist bundles inlined as AB7014, naming the bundles', () => withPackageDocument(
  (document) => {
    document.dependencies = { 'left-pad': '^1.3.0', 'never-loaded': '^1.0.0', 'tiny-pkg': '^1.0.0' };
    document.optionalDependencies = { 'optional-extra': '^1.0.0' };
    document.peerDependencies = { react: '19.2.8' };
  },
  async () => {
    const paths = result.build.packageBuild!.files.map((file) => file.path);
    expect(paths).toContain('index.js');
    const reported = withCode(await packInventoryDiagnostics({
      model: result.build.model,
      packageBuild: packageBuildBundling({
        'index.js': ['left-pad', 'react', 'tiny-pkg'],
      }),
      packOutput: result.pack,
      packerRewritesWorkspaceProtocols: false,
      projectRoot,
    }), 'AB7014');
    // Bundled is not used: the names are still reported, and the tail says which bundles inlined them, names in
    // field order and each name's bundles sorted. A peer the build inlined gets the same sentence; a field the
    // compiler never touched gets the plain tail.
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*: "left-pad", "never-loaded", "tiny-pkg"\. The build inlined "left-pad" into index\.js, and "tiny-pkg" into index\.js; every consumer installs them for nothing\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*: "optional-extra"\. Nothing packed reaches them at runtime; every consumer installs them for nothing\.$/u),
      expect.stringMatching(/^package\.json peerDependencies .*: "react"\. The build inlined "react" into index\.js; every consumer installs them for nothing\.$/u),
    ]);
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'error', 'warning']);
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
      // npm skips these five after the failed fetch too — and then postinstall fails on the missing package:
      // `newline-tool` is the first command of postinstall's second line, `setup-tool` the second of the first;
      // `node node_modules/optional-driver/install.js` runs a file of the third directly, reached through `npm test`
      // with no whitespace around the shell operator; `node` preloads the last two, a bare `-r` package behind the
      // valued `--conditions` option and the one a `NODE_OPTIONS=--require=…` assignment on the `node` command names.
      'setup-tool': 'git+https://github.com/owner/setup-tool.git',
      'newline-tool': 'github:owner/newline-tool',
      'optional-driver': 'github:owner/optional-driver',
      'optional-preload': 'github:owner/optional-preload',
      'optional-env-preload': 'github:owner/optional-env-preload',
      // Merely mentioned by the script — an `echo` argument; the operand of `rm -r`, whose `-r` is not Node's
      // preload option; the value of a `--require` after the program, which Node hands to the program as an
      // argument; and the name of a packed file `node` runs, which the gate no longer opens — so npm's skipping
      // them breaks nothing: a warning.
      'optional-mentioned': 'github:owner/optional-mentioned',
      'optional-removed': 'github:owner/optional-removed',
      'optional-argument': 'github:owner/optional-argument',
      'optional-script': 'github:owner/optional-script',
      // npm parses these only to fail, so optional or not, the consumer's install dies.
      'typo-optional': 'foo:bar',
      'tag-optional': 'not a valid spec',
      'url-optional': 'http:%zz',
      'bad name': '^1.0.0',
    };
    document.scripts = {
      ...(document.scripts as Record<string, string> | undefined),
      postinstall: 'echo start\nnewline-tool --init && setup-tool --init'
        + ' && NODE_OPTIONS=--require=optional-env-preload node scripts/optional-script.cjs --require optional-argument && npm test',
      // A `NODE_OPTIONS` that preloads nothing, set through `cross-env`, changes nothing about the command it precedes;
      // a relative `--import=` preload names no package.
      test: 'cross-env NODE_OPTIONS="--max-old-space-size=4096" node "scripts/my install.cjs";node node_modules/optional-driver/install.js&&echo optional-mentioned'
        + ' && rm -r optional-removed && node --conditions react-server -r optional-preload/register --import="./scripts/preload.mjs" .',
    };
  },
  async () => {
    await mkdir(join(projectRoot, 'dist', 'vendor', 'vendored'), { recursive: true });
    await mkdir(join(projectRoot, 'dist', 'vendor', 'bad-manifest'), { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, 'dist', 'vendor', 'vendored', 'package.json'), '{ "name": "vendored", "version": "1.0.0" }\n'),
      writeFile(join(projectRoot, 'dist', 'vendor', 'bad-manifest', 'package.json'), '{\n'),
      writeFile(join(projectRoot, 'dist', 'vendor', 'tarred.tgz'), packageTarball('{ "name": "tarred", "version": "1.0.0" }')),
      writeFile(join(projectRoot, 'dist', 'vendor', 'bad-tarred-manifest.tgz'), packageTarball('not json\n')),
      writeFile(join(projectRoot, 'dist', 'vendor', 'not-archive.tgz'), 'not a tarball\n'),
    ]);
    const pack = { ...result.pack, files: [...result.pack.files,
      { path: 'node_modules/embedded/package.json' },
      { path: 'vendor/vendored/package.json' },
      { path: 'vendor/bad-manifest/package.json' },
      { path: 'vendor/tarred.tgz' },
      { path: 'vendor/bad-tarred-manifest.tgz' },
      { path: 'vendor/not-archive.tgz' },
    ] };
    const reported = withCode(await diagnostics(pack), 'AB7015');
    expect(reported.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringMatching(/^package\.json dependencies .*consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"bad name" -> "\^1\.0\.0", "newline-tool" -> "github:owner\/newline-tool", "optional-driver" -> "github:owner\/optional-driver", "optional-env-preload" -> "github:owner\/optional-env-preload", "optional-preload" -> "github:owner\/optional-preload", "setup-tool" -> "git\+https:\/\/github\.com\/owner\/setup-tool\.git", "tag-optional" -> "not a valid spec", "typo-optional" -> "foo:bar", "url-optional" -> "http:%zz"; consumers cannot install the package\.$/u),
      expect.stringMatching(/^package\.json optionalDependencies .*"optional-argument" -> "github:owner\/optional-argument", "optional-mentioned" -> "github:owner\/optional-mentioned", "optional-removed" -> "github:owner\/optional-removed", "optional-script" -> "github:owner\/optional-script", "scp" -> "git@github\.com:owner\/repo\.git".*continues without them/u),
    ]);
    // npm survives an optional dependency it parsed but cannot fetch, so that entry warns rather than blocks the
    // release; a specifier it cannot parse fails the manifest read and stays fatal, as does a skipped package an
    // install script then runs.
    expect(reported.map((diagnostic) => diagnostic.severity)).toEqual(['error', 'error', 'warning']);
    for (const name of ['scp', 'optional-argument', 'optional-mentioned', 'optional-removed', 'optional-script']) {
      expect(reported[1]?.message).not.toContain(JSON.stringify(name));
    }
    for (const name of ['setup-tool', 'newline-tool', 'optional-driver', 'optional-preload', 'optional-env-preload']) {
      expect(reported[2]?.message).not.toContain(JSON.stringify(name));
    }
    for (const name of ['@agent-bundle/runtime', 'bashjsast', 'local', 'sibling', 'not-embedded', 'not-vendored', 'not-archive', 'bad-manifest', 'bad-tarred-manifest']) {
      expect(reported[0]?.message).toContain(`${JSON.stringify(name)} -> `);
    }
    for (const name of ['alias', 'tilde', 'versioned', 'embedded', 'vendored', 'tarred']) {
      expect(reported[0]?.message).not.toContain(JSON.stringify(name));
    }
    await rm(join(projectRoot, 'dist', 'vendor'), { force: true, recursive: true });
    expect(reported[0]?.recovery).toContain('registry');

    const underPnpm = withCode(await diagnostics(pack, true), 'AB7015');
    expect(underPnpm[0]?.message).not.toContain('"sibling"');
  },
));

it('accepts a dependency a consumer install script names or runs, through delegated scripts and their hooks', () => withPackageDocument(
  (document) => {
    document.dependencies = {
      // Reached only through the manifest's imports map, which no packed declaration file resolves: unused.
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
    // The fixture's node_modules is the workspace's; the manifest is removed again below.
    const wrapper = join(workspaceNodeModules, 'prepack-test-wrapper');
    await mkdir(wrapper, { recursive: true });
    await writeFile(join(wrapper, 'package.json'), JSON.stringify({ name: '@scope/real', version: '1.0.0', bin: 'cli.js' }));
    try {
      // The script names named-in-script directly, typescript through its `tsc` bin, and the alias through `real`,
      // the bin npm derives from the installed manifest's name. `prepare` proves nothing, nor does the map alone.
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
    }
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

it('surfaces a warning when the only finding is an unresolvable optional dependency', () => withPackageDocument(
  (document) => {
    document.optionalDependencies = { 'optional-native': 'github:owner/optional-native' };
  },
  async () => {
    const extras = join(projectRoot, 'dist', 'extras');
    await mkdir(extras, { recursive: true });
    await writeFile(join(extras, 'optional.d.ts'), 'export type { Native } from "optional-native";\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'extras/optional.d.ts' }] };
      expect((await diagnostics(pack)).map((diagnostic) => [diagnostic.code, diagnostic.severity]))
        .toEqual([['AB7015', 'warning']]);
    } finally {
      await rm(extras, { force: true, recursive: true });
    }
  },
));

it('accepts a dependency that only packed declaration files reference, including @types for a type directive', () => withPackageDocument(
  (document) => {
    document.dependencies = { zod: '^4.5.4', '@types/node': '^22.0.0', 'driver-package': '^1.0.0', 'never-loaded': '^1.0.0' };
    document.imports = { '#driver': { node: 'driver-package/node', default: 'driver-package' } };
  },
  async () => {
    const declaration = join(projectRoot, 'dist', 'consumer.d.ts');
    const modern = join(projectRoot, 'dist', 'driver.d.mts');
    await writeFile(declaration, [
      '/// <reference types="node" />',
      "import type { ZodType } from 'zod';",
      'export declare const schema: ZodType;',
      'export declare const buffer: Buffer;',
      // A comment or string is not a reference, and a `declare module` in a module file augments a package.
      '// import { Function } from "effect" -- never counts.',
      'export declare const text: "import x from \\"effect\\"";',
      '',
    ].join('\n'));
    // A `#` specifier reaches the package the imports map names.
    await writeFile(modern, 'export type { Driver } from "#driver";\n');
    try {
      const pack = { ...result.pack, files: [...result.pack.files, { path: 'consumer.d.ts' }, { path: 'driver.d.mts' }] };
      const [reported] = withCode(await diagnostics(pack), 'AB7014');
      expect(reported?.message).toContain('"never-loaded"');
      for (const name of ['zod', '@types/node', 'driver-package']) expect(reported?.message).not.toContain(JSON.stringify(name));
    } finally {
      await rm(declaration, { force: true });
      await rm(modern, { force: true });
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

it('accepts a dependency a prebuilt payload declares in runtimeDependencies: prepack passes, the payload stays opaque', async () => {
  const root = await createSiblingProject('prebuilt-project', {
    dependencies: { 'body-parser': '^2.0.0', cors: '^2.8.5', express: '^5.0.0' },
    files: ['dist', 'host-packs', 'README.md'],
    name: 'prebuilt-fixture',
    type: 'module',
    version: '1.2.3',
  }, [
    "import { definePrebuilt } from 'agent-bundle';",
    '',
    'export default {',
    '  bin: false,',
    "  lib: './src/index.ts',",
    "  mcp: { servers: { timeline: { entry: { prebuilt: './built/runtime/mcp/server.js' }, transport: 'stdio' } } },",
    "  output: { distPath: 'host-packs' },",
    "  payload: { runtime: definePrebuilt({ runtimeDependencies: ['body-parser', 'cors', 'express'], source: './built/runtime' }) },",
    "  plugin: { name: 'prebuilt-fixture' },",
    "  targets: ['cursor'],",
    '};',
  ], {
    // A bare import, a `require()`, and a `require.resolve()` in a module the framework copies rather than compiles:
    // nothing opens the file — AB6005 never walks it, and AB7014 reads no packed JavaScript — so the declaration
    // above is what keeps `express`, `body-parser`, and `cors` out of AB7014.
    'built/runtime/mcp/server.js': [
      'import express from "express";',
      'const body = require("body-parser");',
      'const where = require.resolve("cors");',
      'export default express;',
      'export { body, where };',
      '',
    ].join('\n'),
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

it('installs a real generated tarball and runs its manifest-driven Cursor installer from node_modules', async () => {
  const tarballs = join(cleanupRoot, 'tarballs');
  const consumer = join(cleanupRoot, 'consumer');
  const home = join(cleanupRoot, 'home');
  await Promise.all([
    mkdir(tarballs),
    mkdir(consumer),
    mkdir(join(home, '.cursor'), { recursive: true }),
  ]);
  const { stdout } = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs], {
    cwd: join(projectRoot, 'dist'),
  });
  const packed = packOutputFromJson(stdout);
  await writeFile(join(consumer, 'package.json'), '{"private":true}\n');
  await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(tarballs, packed.filename)], {
    cwd: consumer,
  });
  await rm(projectRoot, { force: true, recursive: true });

  const installer = join(consumer, 'node_modules', 'installer-fixture', 'install.mjs');
  const installed = await execFile(process.execPath, [installer], {
    cwd: consumer,
    env: { ...process.env, HOME: home },
  });
  expect(installed.stdout).toContain('Installed installer-fixture@1.2.3');
  await expect(stat(join(home, '.cursor', 'plugins', 'local', 'installer-fixture'))).resolves.toBeDefined();
});
