import { execFile as executeFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from '@rstest/core';

import { build, runMcp } from '../src/api.ts';
import { runCli } from '../src/cli.ts';
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

    const stderr: string[] = [];
    const exitCode = await runCli(
      ['build', '--root', root, '--output', 'artifact'],
      { stderr: { write: (chunk: string) => stderr.push(chunk) }, stdout: { write: () => undefined } },
    );
    expect(exitCode).toBe(1);

    const diagnostics = JSON.parse(stderr.join('')) as readonly {
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
    expect(launches[0]!.cwd).toBe(join(artifact, 'portable'));
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
    expect(bare.cwd).toBe(join(artifact, 'portable'));
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
    const disabled = await captureLaunch({ ...base, loadEnvFiles: false });
    expect(disabled.env.FROM_DOTENV).toBeUndefined();
    expect(disabled.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(root);

    // pluginRoot restores the byte-faithful artifact-rooted rehearsal.
    const rehearsal = await captureLaunch({ ...base, pluginRoot: join(artifact, 'portable') });
    expect(rehearsal.env.AGENT_BUNDLE_PLUGIN_ROOT).toBe(join(artifact, 'portable'));
    expect(rehearsal.env.STATE_DIR).toBe(join(artifact, 'portable', '.runtime'));

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
    await expect(stat(join(root, 'artifact', 'portable', '.runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('rejects --env-file combined with --no-env', async () => {
    const stderr: string[] = [];
    const exitCode = await runCli(
      ['mcp', 'run', '--root', '.', '--artifact', 'artifact', '--target', 'portable', '--server', 's', '--env-file', 'x.env', '--no-env'],
      { stderr: { write: (chunk: string) => stderr.push(chunk) }, stdout: { write: () => undefined } },
    );
    expect(exitCode).toBe(1);
    expect(stderr.join('')).toContain('Use either --env-file or --no-env, not both.');
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
