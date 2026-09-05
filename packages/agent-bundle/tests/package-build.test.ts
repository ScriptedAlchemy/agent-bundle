import { execFile as executeFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from '@rstest/core';

import { build, runMcp } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { DiagnosticError } from '../src/core/diagnostics.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { mcpServerStateDirectory } from '../src/services/mcp-run.ts';

const execFile = promisify(executeFile);
const workspaceNodeModules = join(process.cwd(), 'node_modules');
const roots: string[] = [];

/** Declaration generation resolves `typescript` (and ambient node types) from the consumer project, exactly like a real install. */
const installTypescriptToolchain = async (root: string): Promise<void> => {
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(workspaceNodeModules, 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
  await symlink(join(workspaceNodeModules, '@types'), join(root, 'node_modules', '@types'), 'dir');
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const fixtureRoot = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-package-build-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, contents);
  }
  return root;
};

const conventionFixture = (): Readonly<Record<string, string>> => ({
  'agent-bundle.config.ts': [
    'export default {',
    "  mcp: { servers: { echoer: {} } },",
    "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
    "  targets: ['portable'],",
    '};',
    '',
  ].join('\n'),
  'package.json': '{"name":"package-build-fixture","type":"module","private":true}\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      target: 'es2022',
      types: ['node'],
    },
  }),
  'src/cli.ts': [
    'export const main = async (argv: readonly string[]): Promise<number> => {',
    "  process.stdout.write(`ran:${argv.join(',')}\\n`);",
    "  return argv.includes('--fail') ? 3 : 0;",
    '};',
    '',
  ].join('\n'),
  'src/index.ts': [
    'export interface Answer { readonly value: number }',
    'export const answer: Answer = { value: 42 };',
    '',
  ].join('\n'),
  'src/mcp/echoer.ts': [
    '/** A minimal factory the framework stdio shell can serve. */',
    'export default () => ({',
    '  close() {},',
    '  async connect(transport: { onmessage?: unknown }) { void transport; },',
    '});',
    '',
  ].join('\n'),
});

describe('framework-owned package build', () => {
  it('builds bin, lib, and dts outputs from conventions and stays deterministic', async () => {
    const root = await fixtureRoot(conventionFixture());
    await installTypescriptToolchain(root);
    const result = await build({ output: 'artifact', packageOutputs: true, root });

    expect(result.model.packageBuild).toMatchObject({
      bins: [{ name: 'package-build-fixture', provenance: { kind: 'conventional' } }],
      lib: { dts: true, name: 'index', provenance: { kind: 'conventional' } },
    });
    const packageBuild = result.packageBuild;
    expect(packageBuild).toBeDefined();
    expect(packageBuild!.outputRoot).toBe(join(root, 'dist'));
    const paths = packageBuild!.files.map((file) => file.path);
    expect(paths).toContain('bin/package-build-fixture.js');
    expect(paths).toContain('index.js');
    expect(paths).toContain('index.d.ts');
    for (const file of packageBuild!.files) {
      expect(file.sourceInputs).toEqual([...file.sourceInputs].sort((left, right) => left.localeCompare(right)));
    }

    const binPath = join(root, 'dist', 'bin', 'package-build-fixture.js');
    const binSource = await readFile(binPath, 'utf8');
    expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect((await stat(binPath)).mode & 0o111).not.toBe(0);
    await expect(execFile(binPath, ['alpha', 'beta'])).resolves.toMatchObject({ stdout: 'ran:alpha,beta\n' });
    await expect(execFile(binPath, ['--fail'])).rejects.toMatchObject({ code: 3 });

    const lib = await import(pathToFileURL(join(root, 'dist', 'index.js')).href) as { answer: { value: number } };
    expect(lib.answer.value).toBe(42);
    await expect(readFile(join(root, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('interface Answer');

    const rebuilt = await build({ output: 'artifact', packageOutputs: true, root });
    expect(rebuilt.packageBuild?.files).toEqual(packageBuild!.files);
  }, 120_000);

  it('ships a bin-claimed src/scripts module as both the npm bin and the artifact script (#389)', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': [
        'export default {',
        "  bin: { hauler: './src/scripts/hauler.ts' },",
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"name":"package-build-fixture","type":"module","private":true}\n',
      'src/scripts/hauler.ts': [
        'export const main = async (argv: readonly string[]): Promise<number> => {',
        "  process.stdout.write(`hauled:${argv.join(',')}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n'),
    });
    const result = await build({ output: 'artifact', packageOutputs: true, root });

    // The same entry is visible on both surfaces of the inspect model, and
    // the claim itself raises no diagnostic: this is the intended shape.
    expect(result.diagnostics).toEqual([]);
    expect(result.model.packageBuild).toMatchObject({
      bins: [{ name: 'hauler', provenance: { kind: 'config' }, source: join(root, 'src/scripts/hauler.ts') }],
    });
    expect(result.model.scripts).toMatchObject([
      { name: 'hauler', provenance: { kind: 'conventional' }, source: join(root, 'src/scripts/hauler.ts') },
    ]);

    // Both outputs exist and run.
    expect(result.packageBuild?.files.map((file) => file.path)).toContain('bin/hauler.js');
    await expect(execFile(join(root, 'dist', 'bin', 'hauler.js'), ['alpha'])).resolves.toMatchObject({ stdout: 'hauled:alpha\n' });
    expect(result.build.outputProvenance.map((record) => record.path)).toContain('scripts/hauler.mjs');
    const script = join(root, 'artifact', 'scripts', 'hauler.mjs');
    await expect(execFile(process.execPath, [script, 'beta'])).resolves.toMatchObject({ stdout: 'hauled:beta\n' });
  }, 120_000);

  it('wraps factory-exporting MCP entries in the lifecycle shell and leaves self-connecting entries alone', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        '  bin: false,',
        '  lib: false,',
        '  mcp: { servers: {',
        '    echoer: {},',
        "    plain: { entry: './src/plain.ts' },",
        '  } },',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'src/plain.ts': "process.stderr.write('self-connecting entry ran\\n');\n",
    });
    const result = await build({ output: 'artifact', packageOutputs: true, root });
    expect(result.packageBuild).toBeUndefined();

    const entries = Object.fromEntries(result.build.compiledMcpEntries.map((entry) => [entry.id, entry.output]));
    const wrapped = await readFile(entries['mcp:echoer']!, 'utf8');
    const plain = await readFile(entries['mcp:plain']!, 'utf8');
    expect(wrapped).toContain('stdio heartbeat');
    expect(wrapped).not.toMatch(/from\s*['"]agent-bundle/u);
    expect(plain).not.toContain('stdio heartbeat');

    // The lifecycle shell exits 0 on stdin EOF so clients can respawn.
    const eofRun = execFile(process.execPath, [entries['mcp:echoer']!], { timeout: 15_000 });
    eofRun.child.stdin?.end();
    await expect(eofRun).resolves.toMatchObject({ stdout: '' });
    const plainRun = await execFile(process.execPath, [entries['mcp:plain']!], { timeout: 15_000 });
    expect(plainRun.stderr).toContain('self-connecting entry ran');
  }, 120_000);

  it('applies the tools escape hatch after the profile and before the invariant enforcer', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'let sawAsyncChunks;',
        'export default {',
        '  lib: false,',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '  tools: {',
        "    rsbuild: { source: { define: { __HATCH_DEFINE__: JSON.stringify('hatched') } } },",
        '    rspack: (config) => {',
        '      sawAsyncChunks = config.output.asyncChunks;',
        '      config.output.asyncChunks = true;',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n'),
      'src/cli.ts': [
        'declare const __HATCH_DEFINE__: string;',
        'export const main = async (): Promise<number> => {',
        '  process.stdout.write(`define:${__HATCH_DEFINE__}\\n`);',
        '  return 0;',
        '};',
        '',
      ].join('\n'),
    });
    const result = await build({ output: 'artifact', packageOutputs: true, root });
    const binPath = join(root, 'dist', 'bin', 'package-build-fixture.js');
    // The hatch define reached the bundle, and the framework enforcer ran
    // after the consumer mutator: the build passed its invariant assertions
    // even though the mutator flipped asyncChunks back on.
    await expect(execFile(binPath, [])).resolves.toMatchObject({ stdout: 'define:hatched\n' });
    expect(result.packageBuild?.files.some((file) => file.path === 'bin/package-build-fixture.js')).toBe(true);
  }, 120_000);

  it('fails the package build with AB6005 when the tools hatch keeps a dependency external in a dist bundle', async () => {
    // Every dist bundle is self-contained, exactly like a host pack: the
    // `tools` hatch is no escape from that rule, and a literal dynamic import
    // counts the same as a static one. Neither package is installed — the
    // bundler never resolves an external — and `dts: false` keeps declaration
    // generation (which would need their types) out of the picture.
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        "  lib: { entry: './src/index.ts', dts: false },",
        "  mcp: { servers: { echoer: {} } },",
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  tools: { rsbuild: { output: { externals: ['left-pad', 'right-pad'] } } },",
        '};',
        '',
      ].join('\n'),
      'src/cli.ts': [
        "import leftPad from 'left-pad';",
        '',
        'export const main = async (argv: readonly string[]): Promise<number> => {',
        "  const { default: rightPad } = await import('right-pad');",
        "  process.stdout.write(`${leftPad(argv.join(','), 8)}${rightPad('', 2)}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n'),
      'src/index.ts': [
        "import leftPad from 'left-pad';",
        '',
        'export const padded = (value: string): string => leftPad(value, 8);',
        '',
      ].join('\n'),
    });

    const failure = await build({ output: 'artifact', packageOutputs: true, root }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DiagnosticError);
    const unsupported = (generatedPath: string, specifier: string) => ({
      code: 'AB6005',
      generatedPath,
      message: `Generated JavaScript import from ${JSON.stringify(generatedPath)} uses unsupported specifier ${JSON.stringify(specifier)}.`,
      recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
      severity: 'error',
    });
    const byMessage = (left: { message: string }, right: { message: string }): number => left.message.localeCompare(right.message);
    expect([...(failure as DiagnosticError).diagnostics].sort(byMessage)).toEqual([
      unsupported('dist/bin/package-build-fixture.js', 'left-pad'),
      unsupported('dist/bin/package-build-fixture.js', 'right-pad'),
      unsupported('dist/index.js', 'left-pad'),
    ].sort(byMessage));

    // Nothing is published: no `dist`, and the staged tree is gone too.
    await expect(stat(join(root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((entry) => entry.startsWith('.dist.stage-'))).toEqual([]);
  }, 120_000);

  it('fails the package build with AB6005 when node-commonjs externals reach dist through the createRequire shim', async () => {
    // Under `externalsType: 'node-commonjs'` Rspack reaches an external not
    // through an `import` but through the loader shim it emits into ESM output
    // (`const __rspack_createRequire_require = __rspack_createRequire(import.meta.url)`),
    // so no import record names `left-pad`: the load scan is what holds the line.
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        '  lib: false,',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  tools: { rsbuild: { output: { externals: ['left-pad'] } }, rspack: { externalsType: 'node-commonjs' } },",
        '};',
        '',
      ].join('\n'),
      'src/cli.ts': [
        "import leftPad from 'left-pad';",
        '',
        'export const main = async (argv: readonly string[]): Promise<number> => {',
        "  process.stdout.write(`${leftPad(argv.join(','), 8)}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n'),
    });

    const failure = await build({ output: 'artifact', packageOutputs: true, root }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DiagnosticError);
    expect((failure as DiagnosticError).diagnostics).toEqual([{
      code: 'AB6005',
      generatedPath: 'dist/bin/package-build-fixture.js',
      message: 'Generated JavaScript import from "dist/bin/package-build-fixture.js" uses unsupported specifier "left-pad"'
        + ' in __rspack_createRequire_require("left-pad"), a createRequire(…) loader.',
      recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
      severity: 'error',
    }]);
    await expect(stat(join(root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).filter((entry) => entry.startsWith('.dist.stage-'))).toEqual([]);
  }, 120_000);

  it('fails the package build with AB6005 when source loads a package through createRequire(), literal or computed', async () => {
    // Neither call is an import, so the bundler never resolves `left-pad` (it
    // is not installed) and both reach the emitted bin verbatim; the walk
    // reports the literal one by specifier and the computed one as such, in
    // source order.
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        '  lib: false,',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'src/cli.ts': [
        "import { createRequire } from 'node:module';",
        '',
        'type Pad = (value: string, size: number) => string;',
        '',
        'export const main = async (argv: readonly string[]): Promise<number> => {',
        "  const literal = createRequire(import.meta.url)('left-pad') as Pad;",
        "  const chosen = createRequire(import.meta.url)(argv[0] ?? 'left-pad') as Pad;",
        "  process.stdout.write(`${literal('', 2)}${chosen('', 2)}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n'),
    });

    const failure = await build({ output: 'artifact', packageOutputs: true, root }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DiagnosticError);
    const bin = 'dist/bin/package-build-fixture.js';
    const load = (detail: string) => ({
      code: 'AB6005',
      generatedPath: bin,
      message: `Generated JavaScript import from ${JSON.stringify(bin)} ${detail}`,
      recovery: 'Bundle every JavaScript dependency into the artifact, then rebuild it.',
      severity: 'error',
    });
    expect((failure as DiagnosticError).diagnostics).toEqual([
      load('uses unsupported specifier "left-pad" in createRequire(…)("left-pad").'),
      load('loads a non-literal specifier through createRequire(…)(…).'),
    ]);
    await expect(stat(join(root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('accepts Node built-ins under node: and bare specifiers in dist bundles', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        '  lib: false,',
        "  mcp: { servers: { echoer: {} } },",
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'src/cli.ts': [
        "import { readFileSync } from 'node:fs';",
        "import { createRequire } from 'node:module';",
        "import { join } from 'path';",
        '',
        'export const main = async (): Promise<number> => {',
        '  const requireFromHere = createRequire(import.meta.url);',
        "  // Prose naming require('left-pad') is a comment, never a load.",
        "  const os = requireFromHere('node:os') as { platform(): string };",
        "  process.stdout.write(`${join('built', 'ins')}:${typeof readFileSync}:${typeof requireFromHere.resolve}"
          + ":${typeof os.platform}:${requireFromHere.resolve('fs')}:${import.meta.resolve('node:path')}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n'),
    });
    const result = await build({ output: 'artifact', packageOutputs: true, root });
    expect(result.packageBuild?.files.map((file) => file.path)).toContain('bin/package-build-fixture.js');

    const binPath = join(root, 'dist', 'bin', 'package-build-fixture.js');
    await expect(execFile(binPath, [])).resolves.toMatchObject({ stdout: 'built/ins:function:function:function:fs:node:path\n' });
    // Rspack keeps Node built-ins external, so the emitted module still
    // imports them by specifier — under both spellings — and the walker
    // accepts those imports (and `import.meta.url`) as it does relative ones.
    const binSource = await readFile(binPath, 'utf8');
    expect(binSource).toMatch(/from\s*["']node:fs["']/u);
    expect(binSource).toMatch(/from\s*["']node:module["']/u);
    expect(binSource).toMatch(/from\s*["'](?:node:)?path["']/u);
    expect(binSource).toContain('import.meta.url');
    // The built-in loads reach the emitted bin as written — a bound
    // `createRequire()` loader, its `resolve`, and `import.meta.resolve` —
    // and the walk accepts every one under either spelling, while the comment
    // that names a package is stepped over rather than read as a load.
    expect(binSource).toMatch(/requireFromHere\(["']node:os["']\)/u);
    expect(binSource).toMatch(/requireFromHere\.resolve\(["']fs["']\)/u);
    expect(binSource).toMatch(/import\.meta\.resolve\(["']node:path["']\)/u);
    expect(binSource).toContain("require('left-pad')");
  }, 120_000);

  it('keeps colocated tests out of the declaration program and the package output', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      // Would fail the declaration build if the synthesized program included it.
      'src/answer.test.ts': 'const wrong: number = "not a number";\nvoid wrong;\n',
    });
    await installTypescriptToolchain(root);
    await build({ output: 'artifact', packageOutputs: true, root });
    await expect(readFile(join(root, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('interface Answer');
    await expect(stat(join(root, 'dist', 'answer.test.d.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('reports a failed declaration build as AB4716 carrying the underlying TypeScript diagnostics', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      // An exported factory whose inferred declaration type must name a type
      // its own module does not export. The failure is emit-only: `--noEmit`
      // type checking stays clean, so only declaration generation catches it.
      'src/cli-command.ts': [
        'interface CliCommandDefinition { readonly name: string }',
        '',
        'export const defineCliCommand = (name: string): CliCommandDefinition => ({ name });',
        '',
      ].join('\n'),
      'src/index.ts': [
        "import { defineCliCommand } from './cli-command';",
        '',
        "export const audibleOperations = () => ({ list: defineCliCommand('list') });",
        '',
      ].join('\n'),
    });
    await installTypescriptToolchain(root);

    const terminal = captureCliTerminal();
    const exitCode = await runCli(['build', '--root', root, '--output', 'artifact'], terminal.output);
    expect(exitCode).toBe(1);

    const diagnostics = JSON.parse(terminal.stderr()) as readonly {
      code: string;
      message: string;
      recovery?: string;
      sourcePath?: string;
    }[];
    // The dedicated declaration code, never the AB5000 catch-all that
    // collides with the dev-lock meaning.
    expect(diagnostics.length).toBeGreaterThan(0);
    expect([...new Set(diagnostics.map((diagnostic) => diagnostic.code))]).toEqual(['AB4716']);

    const emitError = diagnostics.find((diagnostic) => diagnostic.message.includes('TS4023'));
    expect(emitError).toBeDefined();
    expect(emitError!.message).toContain('src/index.ts(3,14)');
    expect(emitError!.message).toContain("Exported variable 'audibleOperations'");
    expect(emitError!.message).toContain('CliCommandDefinition');
    expect(emitError!.sourcePath).toBe(join(root, 'src', 'index.ts'));
    expect(emitError!.recovery).toContain('--noEmit');
  }, 120_000);

  it('rejects artifact outputs that overlap the package output directory', async () => {
    const root = await fixtureRoot(conventionFixture());
    await expect(build({ output: 'dist', packageOutputs: true, root })).rejects.toThrow(/overlaps the package build output/u);
    await expect(build({ output: 'dist/artifact', packageOutputs: true, root })).rejects.toThrow(/overlaps the package build output/u);
  }, 120_000);

  it('uses a non-overlapping artifact default when package outputs are requested', async () => {
    const root = await fixtureRoot(conventionFixture());
    await installTypescriptToolchain(root);
    const result = await build({ packageOutputs: true, root });

    expect(result.build.outputRoot).toBe(join(root, 'artifact'));
    expect(result.packageBuild?.outputRoot).toBe(join(root, 'dist'));
  }, 120_000);

  it('keeps programmatic artifact builds free of package outputs', async () => {
    const root = await fixtureRoot(conventionFixture());
    const result = await build({ output: 'artifact', root });
    expect(result.packageBuild).toBeUndefined();
    await expect(stat(join(root, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);
});

describe('mcp run', () => {
  it('resolves the hashed generated entry and launches it in the foreground', async () => {
    const root = await fixtureRoot(conventionFixture());
    const artifact = join(root, 'artifact');
    await build({ output: 'artifact', root });

    const launches: { args: readonly string[]; command: string; cwd: string; env: Readonly<Record<string, string>> }[] = [];
    const child = new EventEmitter() as import('node:child_process').ChildProcess;
    child.kill = () => true;
    const exitCode = runMcp({
      artifact,
      root,
      server: 'echoer',
      spawnProcess: (command, args, options) => {
        launches.push({ args, command, cwd: options.cwd, env: options.env });
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
      target: 'portable',
    });
    await expect(exitCode).resolves.toBe(0);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.command).toBe('node');
    expect(launches[0]!.args[0]).toMatch(/mcp-echoer-[a-f\d]{8}\.mjs$/u);
    expect(launches[0]!.cwd).toBe(artifact);
    await expect(stat(join(launches[0]!.cwd, launches[0]!.args[0]!))).resolves.toMatchObject({});
  }, 120_000);

  it('layers the launch environment: manifest env under .env files under operator process.env', async () => {
    const root = await fixtureRoot({
      ...conventionFixture(),
      'agent-bundle.config.ts': [
        'export default {',
        '  mcp: { servers: { echoer: { env: {',
        "    SHARED: 'manifest',",
        "    STATE_DIR: 'agent-bundle:path:plugin-root/.runtime',",
        '  } } } },',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['codex', 'portable'],",
        '};',
        '',
      ].join('\n'),
      '.env': 'FROM_DOTENV=dotenv\nSHARED=dotenv\nMCP_RUN_BEATEN_BY_PROCESS=dotenv\n',
      '.env.staging': 'FROM_MODE=staging\n',
      'custom.env': 'CUSTOM_ONLY=custom\n',
    });
    const artifact = join(root, 'artifact');
    await build({ output: 'artifact', root });
    const base = { artifact, root, server: 'echoer', target: 'portable' };

    type Launch = { args: readonly string[]; command: string; cwd: string; env: Readonly<Record<string, string>> };
    const captureLaunch = async (options: Parameters<typeof runMcp>[0]): Promise<Launch> => {
      const launches: Launch[] = [];
      const child = new EventEmitter() as import('node:child_process').ChildProcess;
      child.kill = () => true;
      await expect(runMcp({
        ...options,
        spawnProcess: (command, args, spawnOptions) => {
          launches.push({ args, command, cwd: spawnOptions.cwd, env: spawnOptions.env });
          queueMicrotask(() => child.emit('exit', 0, null));
          return child;
        },
      })).resolves.toBe(0);
      expect(launches).toHaveLength(1);
      return launches[0]!;
    };

    // Bare run: .env fills gaps, .env beats manifest env, and the plugin-root
    // env anchors expand to the durable project root — not the artifact.
    const bare = await captureLaunch(base);
    expect(bare.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(root);
    expect(bare.env.STATE_DIR).toBe(join(root, '.runtime'));
    expect(bare.env.FROM_DOTENV).toBe('dotenv');
    expect(bare.env.SHARED).toBe('dotenv');
    // args/cwd stay artifact-rooted: args[0] is the content-hashed bundle.
    expect(bare.args[0]).toMatch(/mcp-echoer-[a-f\d]{8}\.mjs$/u);
    expect(bare.cwd).toBe(artifact);
    // Loading never leaks .env values into the runner's own environment.
    expect(process.env.FROM_DOTENV).toBeUndefined();

    // Operator exports beat both the .env layer and the manifest anchor.
    process.env.MCP_RUN_BEATEN_BY_PROCESS = 'process';
    process.env.AGENT_BUNDLE_PLUGIN_ROOT = '/operator/pin';
    try {
      const exported = await captureLaunch(base);
      expect(exported.env.MCP_RUN_BEATEN_BY_PROCESS).toBe('process');
      expect(exported.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe('/operator/pin');
    } finally {
      delete process.env.MCP_RUN_BEATEN_BY_PROCESS;
      delete process.env.AGENT_BUNDLE_PLUGIN_ROOT;
    }

    // The mode variants of the conventional set participate.
    const staged = await captureLaunch({ ...base, mode: 'staging' });
    expect(staged.env.FROM_MODE).toBe('staging');

    // Explicit env files replace the conventional set; opting out drops the
    // layer without touching the anchor expansion.
    const custom = await captureLaunch({ ...base, envFiles: [join(root, 'custom.env')] });
    expect(custom.env.CUSTOM_ONLY).toBe('custom');
    expect(custom.env.FROM_DOTENV).toBeUndefined();
    // The spawned shell applies its own operator `.env` layer at launch
    // (#469); the operator's explicit choice rides down as AGENT_BUNDLE_ENV_FILE
    // so the shell follows it instead of re-reading the conventional pair.
    expect(custom.env.AGENT_BUNDLE_ENV_FILE).toBe(join(root, 'custom.env'));
    expect(bare.env.AGENT_BUNDLE_ENV_FILE).toBeUndefined();
    const disabled = await captureLaunch({ ...base, loadEnvFiles: false });
    expect(disabled.env.FROM_DOTENV).toBeUndefined();
    expect(disabled.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(root);
    expect(disabled.env.AGENT_BUNDLE_ENV_FILE).toBe('none');

    // pluginRoot restores the byte-faithful artifact-rooted rehearsal.
    const rehearsal = await captureLaunch({ ...base, pluginRoot: artifact });
    expect(rehearsal.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(artifact);
    expect(rehearsal.env.STATE_DIR).toBe(join(artifact, '.runtime'));

    // Codex has no token interpolation — its anchor is a `./` path, so the
    // target's own relative rule must re-anchor it durably too.
    const codex = await captureLaunch({ ...base, target: 'codex' });
    expect(codex.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(root);
    expect(codex.env.STATE_DIR).toBe(join(root, '.runtime'));

    // A named env file that cannot be read is an error, never a silent skip.
    await expect(runMcp({ ...base, envFiles: [join(root, 'missing.env')] }))
      .rejects.toThrow(/Cannot read env file/u);
  }, 120_000);

  it('anchors consumer state at the project root under a bare CLI mcp run', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': [
        'export default {',
        "  mcp: { servers: { pinner: { entry: './src/pin.ts' } } },",
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"name":"package-build-fixture","type":"module","private":true}\n',
      '.env': 'MCP_RUN_TRACKER_COOKIE=secret\n',
      // A consumer trusting the documented anchor exactly as PR #49 intends.
      'src/pin.ts': [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const anchor = process.env.AGENT_BUNDLE_PLUGIN_ROOT ?? '';",
        "mkdirSync(join(anchor, '.runtime'), { recursive: true });",
        "writeFileSync(join(anchor, '.runtime', 'state.json'), JSON.stringify({",
        '  anchor,',
        "  cookie: process.env.MCP_RUN_TRACKER_COOKIE ?? null,",
        '}));',
        '',
      ].join('\n'),
    });
    await build({ output: 'artifact', root });
    const exitCode = await runCli([
      'mcp', 'run',
      '--root', root,
      '--artifact', join(root, 'artifact'),
      '--target', 'portable',
      '--server', 'pinner',
    ]);
    expect(exitCode).toBe(0);
    const state = JSON.parse(await readFile(join(root, '.runtime', 'state.json'), 'utf8')) as {
      anchor: string;
      cookie: string | null;
    };
    expect(state.anchor).toBe(root);
    expect(state.cookie).toBe('secret');
    // Nothing durable may land inside the rebuildable artifact.
    await expect(stat(join(root, 'artifact', '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('rejects --env-file combined with --no-env', async () => {
    const terminal = captureCliTerminal();
    const exitCode = await runCli(
      ['mcp', 'run', '--root', '.', '--artifact', 'artifact', '--target', 'portable', '--server', 's', '--env-file', 'x.env', '--no-env'],
      terminal.output,
    );
    expect(exitCode).toBe(1);
    expect(terminal.stderr()).toContain('Use either --env-file or --no-env, not both.');
  });

  it('runs a built server end to end through the CLI and forwards its exit code', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': [
        'export default {',
        "  mcp: { servers: { exiter: { entry: './src/exit.ts' } } },",
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"name":"package-build-fixture","type":"module","private":true}\n',
      'src/exit.ts': 'process.exitCode = 7;\nexport const marker = true;\n',
    });
    await build({ output: 'artifact', root });
    const exitCode = await runCli([
      'mcp', 'run',
      '--root', root,
      '--artifact', join(root, 'artifact'),
      '--target', 'portable',
      '--server', 'exiter',
    ]);
    expect(exitCode).toBe(7);
  }, 120_000);

  it('contains server state directories to a single safe path segment', () => {
    expect(mcpServerStateDirectory('greeter')).toBe('greeter');
    expect(mcpServerStateDirectory('my.server-2')).toBe('my.server-2');
    for (const hostile of ['../shared', 'a/b', '..', '.hidden', 'trailing.']) {
      expect(mcpServerStateDirectory(hostile)).toMatch(/^server-[a-f\d]{16}$/u);
    }
    expect(mcpServerStateDirectory('../shared')).not.toBe(mcpServerStateDirectory('../other'));
  });

  it('refuses to run remote servers in the foreground', async () => {
    const root = await fixtureRoot({
      'agent-bundle.config.ts': [
        'export default {',
        '  mcp: { servers: { remote: {',
        "    transport: 'streamable-http',",
        "    url: 'https://mcp.example.test/stream',",
        '  } } },',
        "  plugin: { name: 'package-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n'),
      'package.json': '{"name":"package-build-fixture","type":"module","private":true}\n',
    });
    await build({ output: 'artifact', root });
    await expect(runMcp({
      artifact: join(root, 'artifact'),
      root,
      server: 'remote',
      target: 'portable',
    })).rejects.toThrow(/not a stdio server/u);
  }, 120_000);
});
