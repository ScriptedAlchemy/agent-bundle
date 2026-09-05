import { execFile as executeFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { runCli as runSourceCli, type CliDependencies } from '../src/cli.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';
import { cachedNpmInstallArguments, packOutputFromJson } from './support/shared-pack.ts';
import { timeScale } from './support/time-scale.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
const cliPath = join(packageRoot, 'dist/cli.js');
const recorderPath = join(packageRoot, 'tests/support/record-module-loads.mjs');
let buildPackage: Promise<void> | undefined;

const buildCliPackage = async (): Promise<void> => {
  if (process.env['AGENT_BUNDLE_PACKAGE_PREBUILT'] === '1') return;
  buildPackage ??= execFile('pnpm', ['build'], { cwd: workspaceRoot }).then(() => undefined);
  await buildPackage;
};

const runExecutable = async (executable: string, root: string, args: readonly string[]) => {
  try {
    const result = await execFile(process.execPath, [executable, ...args], { cwd: root });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    const failure = error as Error & { readonly code?: number; readonly stderr?: string; readonly stdout?: string };
    return {
      code: failure.code ?? 1,
      stderr: failure.stderr ?? '',
      stdout: failure.stdout ?? '',
    };
  }
};

const runCli = (root: string, args: readonly string[]) => runExecutable(cliPath, root, args);

const runSourceCliWithOutput = async (
  args: string[],
  dependencies: CliDependencies = {},
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> => {
  const terminal = captureCliTerminal();
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runSourceCli(args, terminal.output, dependencies);
  return { code, stderr: terminal.stderr(), stdout: terminal.stdout() };
};

/**
 * Deterministic text gzip cannot shrink much (a sha256 hex chain). A real App
 * view carries hundreds of KiB of runtime, so the fixture view embeds enough
 * of this to keep both its raw and gzip sizes above 1 KiB — the size line's
 * units are KiB/MiB.
 */
const incompressibleText = (length: number): string => {
  let text = '';
  for (let seed = 'agent-bundle cli fixture'; text.length < length;) {
    seed = createHash('sha256').update(seed).digest('hex');
    text += seed;
  }
  return text.slice(0, length);
};

const createCliProject = async (
  options: Readonly<{
    /** Also declare one local MCP server with a `dashboard` App view compiled for `portable` (#572). */
    readonly mcpApp?: boolean;
  }> = {},
): Promise<{ readonly output: string; readonly root: string }> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent bundle cli parent-'));
  const root = join(parent, 'project with spaces');
  const output = join(root, 'artifact with spaces');
  const mcpApp = options.mcpApp === true;
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  if (mcpApp) await mkdir(join(root, 'views'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ command, mode, projectRoot, selectedTargets }) => ({',
        "  plugin: { name: 'cli-fixture', version: '1.0.0' },",
        "  targets: selectedTargets.length === 0 ? ['portable', 'codex'] : selectedTargets,",
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        ...(mcpApp ? [
          '  mcp: { servers: { fixture: {',
          "    apps: { dashboard: { entry: './views/dashboard.ts', resourceUri: 'ui://cli-fixture/dashboard.html', targets: ['portable'] } },",
          "    entry: './src/server.ts',",
          '  } } },',
        ] : []),
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
    ...(mcpApp ? [
      writeFile(join(root, 'src', 'server.ts'), 'export {};\n'),
      writeFile(
        join(root, 'views', 'dashboard.ts'),
        `document.body.textContent = ${JSON.stringify(`dashboard ${incompressibleText(16 * 1024)}`)};\n`,
      ),
    ] : []),
  ]);
  return { output, root };
};

const createServiceProject = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent bundle service parent-'));
  const root = join(parent, 'project with spaces');
  await mkdir(join(root, 'src'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ selectedTargets }) => ({',
        "  plugin: { name: 'service-fixture', version: '1.0.0' },",
        "  targets: selectedTargets.length === 0 ? ['codex', 'claude'] : selectedTargets,",
        "  hooks: { sessionStart: { handler: './src/hook.ts' } },",
        "  mcp: { servers: { fixture: { entry: './src/server.ts' } } },",
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'hook.ts'),
      "export default (event: { source?: string }) => event.source === 'void' ? undefined : ({ additionalContext: `hook:${event.source}`, outcome: 'continue' as const });\n",
    ),
    writeFile(
      join(root, 'src', 'server.ts'),
      [
        "let buffer = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        '  buffer += chunk;',
        "  for (let newline; (newline = buffer.indexOf('\\n')) >= 0;) {",
        '    const line = buffer.slice(0, newline).trim();',
        '    buffer = buffer.slice(newline + 1);',
        '    if (!line) continue;',
        '    const request = JSON.parse(line);',
        "    const send = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\\n`);",
        "    if (request.method === 'initialize') send({ capabilities: { tools: {} }, protocolVersion: request.params.protocolVersion, serverInfo: { name: 'cli-fixture', version: '1.0.0' } });",
        "    if (request.method === 'tools/list') send({ tools: [{ description: 'Inspects a fixture', inputSchema: { properties: {}, type: 'object' }, name: 'inspect' }] });",
        "    if (request.method === 'tools/call') send({ content: [{ text: 'inspected', type: 'text' }], structuredContent: { invoked: true } });",
        '  }',
        '});',
        '',
      ].join('\n'),
    ),
  ]);
  return root;
};

const createPackedConsumer = async (): Promise<{ readonly cli: string; readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-cli-'));
  const { stdout } = await execFile(
    'npm', ['pack', '--json', '--pack-destination', root], { cwd: packageRoot },
  );
  const packed = packOutputFromJson(stdout, 'agent-bundle');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await execFile(
    'npm', ['install', ...cachedNpmInstallArguments, join(root, packed.filename)],
    { cwd: root },
  );
  return { cli: join(root, 'node_modules', '.bin', 'agent-bundle'), root };
};

it('parses the nested development proxy command', async () => {
  let received: Parameters<NonNullable<CliDependencies['runHostMcpProxy']>>[0] | undefined;
  const result = await runSourceCliWithOutput([
    'dev',
    'proxy',
    '--root',
    '/tmp/plugin project',
    '--server',
    'fixture',
    '--url',
    'http://127.0.0.1:4312',
  ], {
    runHostMcpProxy: async (options) => {
      received = options;
      return 0;
    },
  });

  expect(result).toMatchObject({ code: 0, stderr: '', stdout: '' });
  expect(received).toMatchObject({
    projectRoot: '/tmp/plugin project',
    serverName: 'fixture',
    url: 'http://127.0.0.1:4312',
  });
});

it('describes the operation-specific artifact default in build and prepack help', async () => {
  // Both CLI commands build with package outputs, so their artifact default is
  // `artifact/` (the npm package build owns `dist/`); the API-level `dist`
  // default must not leak into --help (#319 review).
  for (const command of ['build', 'prepack']) {
    const result = await runSourceCliWithOutput([command, '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/--output <path>[\s\S]*default artifact/u);
    expect(result.stdout).not.toContain('default dist');
  }
});

it('requires a server name for the nested development proxy command', async () => {
  const result = await runSourceCliWithOutput(['dev', 'proxy', '--root', '/tmp/plugin']);

  expect(result.code).toBe(2);
  expect(result.stderr).toContain("required option '--server <server>' not specified");
});

it('builds a selected target through the built executable from a path containing spaces', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  try {
    const { stdout, stderr } = await execFile(process.execPath, [
      cliPath,
      'build',
      '--root', project.root,
      '--output', project.output,
      '--target', 'portable',
      '--target', 'codex',
      '--json',
    ], { cwd: project.root });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      build: { outputRoot: resolve(project.output) },
      model: {
        metadata: { name: 'cli-fixture' },
        targets: [{ name: 'portable' }, { name: 'codex' }],
      },
    });
    expect(JSON.parse(await readFile(join(project.output, 'agent-bundle.manifest.json'), 'utf8'))).toMatchObject({
      targets: [{ name: 'codex' }, { name: 'portable' }],
    });
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

/**
 * Runs the built CLI under the module-load recorder and returns the process
 * result plus every non-builtin module URL the invocation resolved.
 */
const runCliRecordingModuleLoads = async (
  args: readonly string[],
): Promise<{ readonly code: number; readonly modules: readonly string[]; readonly stderr: string; readonly stdout: string }> => {
  const recordRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-module-loads-'));
  const recordPath = join(recordRoot, 'modules.txt');
  try {
    const child = spawn(process.execPath, ['--import', pathToFileURL(recorderPath).href, cliPath, ...args], {
      cwd: workspaceRoot,
      env: { ...process.env, AGENT_BUNDLE_RECORD_MODULE_LOADS: recordPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const code = await new Promise<number>((settle, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => settle(exitCode ?? 1));
    });
    const modules = (await readFile(recordPath, 'utf8')).split('\n').filter((line) => line.length > 0);
    return { code, modules, stderr, stdout };
  } finally {
    await rm(recordRoot, { force: true, recursive: true });
  }
};

const effectModulePattern = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:effect|@effect\/platform-node-shared)\//u;

it('answers --version, --help, and an argv error without loading the Effect terminal runtime', async () => {
  // The Effect module graph (`effect`, `effect/Terminal`, the
  // platform-node-shared layers) measured ≈250 ms of module loading on
  // rc.112 — more than the rest of the CLI's startup — so the trivial
  // invocations must never reach it. Real commands build the runtime on
  // their first write (checked last, so the recorder itself is proven).
  await buildCliPackage();

  const version = await runCliRecordingModuleLoads(['--version']);
  expect(version).toMatchObject({ code: 0, stderr: '' });
  expect(version.stdout).toMatch(/^\d+\.\d+\.\d+.*\n$/u);
  expect(version.modules.filter((url) => effectModulePattern.test(url))).toEqual([]);

  const help = await runCliRecordingModuleLoads(['--help']);
  expect(help).toMatchObject({ code: 0, stderr: '' });
  expect(help.stdout).toContain('Usage: agent-bundle');
  expect(help.modules.filter((url) => effectModulePattern.test(url))).toEqual([]);

  const argvError = await runCliRecordingModuleLoads(['mcp', 'list', '--server', 'fixture']);
  expect(argvError).toMatchObject({ code: 2, stdout: '' });
  expect(argvError.stderr).toContain("required option '--target <target>' not specified");
  expect(argvError.modules.filter((url) => effectModulePattern.test(url))).toEqual([]);

  const command = await runCliRecordingModuleLoads(['hooks', 'list', '--artifact', join(workspaceRoot, 'missing artifact'), '--json']);
  expect(command).toMatchObject({ code: 1, stdout: '' });
  expect(JSON.parse(command.stderr)).toMatchObject([{ code: 'AB6000', severity: 'error' }]);
  expect(command.modules.some((url) => effectModulePattern.test(url))).toBe(true);
}, 30_000 * timeScale);

it('runs MCP and hook operations from a packed consumer with explicit and temporary artifacts', async () => {
  await buildCliPackage();
  const source = await createServiceProject();
  const consumer = await createPackedConsumer();
  const artifact = join(source, 'artifact');
  try {
    const built = await runExecutable(consumer.cli, consumer.root, [
      'build', '--root', source, '--output', artifact, '--json',
    ]);
    expect(built).toMatchObject({ code: 0, stderr: '' });

    const listedMcp = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--artifact', artifact, '--server', 'fixture', '--target', 'codex', '--json',
    ]);
    expect(listedMcp).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(listedMcp.stdout)).toMatchObject({ tools: [{ name: 'inspect' }] });

    const invokedMcp = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'invoke', '--artifact', artifact, '--server', 'fixture', '--target', 'codex',
      '--tool', 'inspect', '--input', '{"question":"ready"}', '--json',
    ]);
    expect(invokedMcp).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(invokedMcp.stdout)).toMatchObject({ result: { structuredContent: { invoked: true } } });

    const inputFile = join(consumer.root, 'mcp-input.json');
    await writeFile(inputFile, '{"question":"from-file"}\n');
    const invokedFromFile = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'invoke', '--artifact', artifact, '--server', 'fixture', '--target', 'codex',
      '--tool', 'inspect', '--input-file', inputFile, '--json',
    ]);
    expect(invokedFromFile).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(invokedFromFile.stdout)).toMatchObject({ result: { structuredContent: { invoked: true } } });

    const unsupportedTarget = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--artifact', artifact, '--server', 'fixture', '--target', 'unsupported', '--json',
    ]);
    expect(unsupportedTarget.code).toBe(1);
    expect(unsupportedTarget.stdout).toBe('');
    expect(JSON.parse(unsupportedTarget.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);

    const missingTarget = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--artifact', artifact, '--server', 'fixture', '--json',
    ]);
    expect(missingTarget).toMatchObject({ code: 2, stdout: '' });
    const missingServer = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--artifact', artifact, '--target', 'codex', '--json',
    ]);
    expect(missingServer).toMatchObject({ code: 2, stdout: '' });

    const listedHooks = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'list', '--artifact', artifact, '--target', 'codex', '--json',
    ]);
    expect(listedHooks).toMatchObject({ code: 0, stderr: '' });
    const [hook] = JSON.parse(listedHooks.stdout) as Array<{ readonly id: string }>;

    const listedAllHooks = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'list', '--artifact', artifact, '--json',
    ]);
    expect(JSON.parse(listedAllHooks.stdout)).toMatchObject([
      { target: 'claude' },
      { target: 'codex' },
    ]);
    expect((JSON.parse(listedAllHooks.stdout) as readonly unknown[])).toHaveLength(2);

    const unsupportedHookTarget = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'list', '--artifact', artifact, '--target', 'unsupported', '--json',
    ]);
    expect(unsupportedHookTarget.code).toBe(1);
    expect(unsupportedHookTarget.stdout).toBe('');
    expect(JSON.parse(unsupportedHookTarget.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);

    const simulatedHook = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'simulate', '--artifact', artifact, '--target', 'codex', '--hook', hook!.id,
      '--input', '{"cwd":"/workspace","sessionId":"session-packed","source":"packed","transcriptPath":"/workspace/transcript.json"}', '--json',
    ]);
    expect(simulatedHook).toEqual({
      code: 0,
      stderr: '',
      stdout: '{"additionalContext":"hook:packed","outcome":"continue"}\n',
    });

    const voidHook = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'simulate', '--artifact', artifact, '--target', 'codex', '--hook', hook!.id,
      '--input', '{"cwd":"/workspace","sessionId":"session-packed","source":"void","transcriptPath":"/workspace/transcript.json"}', '--json',
    ]);
    expect(voidHook).toEqual({ code: 0, stderr: '', stdout: 'null\n' });

    const before = new Set((await (await import('node:fs/promises')).readdir(tmpdir())).filter((name) => name.startsWith('agent-bundle-artifact-')));
    const temporary = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--root', source, '--server', 'fixture', '--target', 'codex', '--json',
    ]);
    expect(temporary).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(temporary.stdout)).toMatchObject({ tools: [{ name: 'inspect' }] });

    const failedTemporary = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'list', '--root', source, '--server', 'missing', '--target', 'codex', '--json',
    ]);
    expect(failedTemporary.code).toBe(1);
    expect(failedTemporary.stdout).toBe('');
    expect(JSON.parse(failedTemporary.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);
    const after = new Set((await (await import('node:fs/promises')).readdir(tmpdir())).filter((name) => name.startsWith('agent-bundle-artifact-')));
    expect(after).toEqual(before);

    const invalidInput = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'invoke', '--root', source, '--server', 'fixture', '--target', 'codex',
      '--tool', 'inspect', '--input', '[]', '--json',
    ]);
    expect(invalidInput.code).toBe(1);
    expect(invalidInput.stdout).toBe('');
    expect(JSON.parse(invalidInput.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);

    const ambiguousInput = await runExecutable(consumer.cli, consumer.root, [
      'mcp', 'invoke', '--root', source, '--server', 'fixture', '--target', 'codex',
      '--tool', 'inspect', '--input', '{}', '--input-file', inputFile, '--json',
    ]);
    expect(ambiguousInput.code).toBe(1);
    expect(ambiguousInput.stdout).toBe('');
    expect(JSON.parse(ambiguousInput.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);

    const missingHook = await runExecutable(consumer.cli, consumer.root, [
      'hooks', 'simulate', '--artifact', artifact, '--target', 'codex', '--input', '{}', '--json',
    ]);
    expect(missingHook).toMatchObject({ code: 2, stdout: '' });
  } finally {
    await Promise.all([
      rm(join(source, '..'), { force: true, recursive: true }),
      rm(consumer.root, { force: true, recursive: true }),
    ]);
  }
}, 60_000 * timeScale);

it('keeps inspect JSON stable and validates only the supplied artifact', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  try {
    const inspectArgs = ['inspect', '--root', project.root, '--json'];
    const [firstInspection, secondInspection] = await Promise.all([
      runCli(project.root, inspectArgs),
      runCli(project.root, inspectArgs),
    ]);
    expect(firstInspection).toEqual(secondInspection);
    expect(firstInspection).toMatchObject({ code: 0, stderr: '' });
    const firstInspectionDocument = JSON.parse(firstInspection.stdout) as {
      readonly plans: readonly unknown[];
    };
    expect(firstInspectionDocument).toMatchObject({
      model: {
        metadata: { name: 'cli-fixture' },
        targets: [{ name: 'portable' }, { name: 'codex' }],
      },
      plans: [{ target: 'portable' }, { target: 'codex' }],
      state: 'ready',
    });
    expect(firstInspectionDocument.plans).toHaveLength(2);

    const filteredInspection = await runCli(project.root, [
      'inspect', '--root', project.root, '--target', 'portable', '--json',
    ]);
    expect(filteredInspection).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(filteredInspection.stdout)).toMatchObject({
      model: { targets: [{ name: 'portable' }, { name: 'codex' }] },
      plans: [{ target: 'portable' }],
    });
    expect((JSON.parse(filteredInspection.stdout) as { readonly plans: readonly unknown[] }).plans).toHaveLength(1);

    const built = await runCli(project.root, [
      'build', '--root', project.root, '--output', project.output, '--json',
    ]);
    expect(built).toMatchObject({ code: 0, stderr: '' });

    await writeFile(join(project.root, 'agent-bundle.config.ts'), 'this source must not be loaded\n');
    const artifactValidation = await runCli(project.root, [
      'validate', '--root', project.root, '--artifact', project.output, '--no-host-validation', '--json',
    ]);
    expect(artifactValidation).toEqual({
      code: 0,
      stderr: '',
      stdout: '{"diagnostics":[]}\n',
    });

    const humanValidation = await runCli(project.root, [
      'validate', '--root', project.root, '--artifact', project.output, '--no-host-validation',
    ]);
    expect(humanValidation).toEqual({ code: 0, stderr: '', stdout: 'Validation succeeded\n' });
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('build requests the Claude host validator by default, opts out under --no-host-validation, and fails under --strict (#476)', async () => {
  const calls: unknown[] = [];
  const build = async (options: unknown) => {
    calls.push(options);
    const strict = (options as { strict?: boolean }).strict === true;
    const skipped = (options as { hostValidation?: boolean }).hostValidation === false;
    const diagnostics = skipped
      ? []
      : [{ code: 'AB6020', message: 'Claude plugin validation warning.', severity: strict ? 'error' as const : 'warning' as const }];
    return {
      build: { compiledMcpApps: [], outputRoot: '/artifact' },
      diagnostics,
      ...(skipped ? {} : {
        hostValidation: [{ diagnostics, host: 'claude', load: { status: 'loaded' }, status: strict ? 'failed' : 'warnings', target: 'claude', version: '2.1.259' }],
      }),
      model: { metadata: { name: 'fixture' } },
    };
  };

  const human = await runSourceCliWithOutput(['build', '--root', '/project'], { build: build as never });
  expect(human).toEqual({
    code: 0,
    stderr: '',
    stdout: 'AB6020 (warning): Claude plugin validation warning.\nBuilt fixture to /artifact\nHost validation (claude): warnings (Claude Code 2.1.259), load check loaded\n',
  });

  const skipped = await runSourceCliWithOutput(['build', '--root', '/project', '--no-host-validation'], { build: build as never });
  expect(skipped).toEqual({ code: 0, stderr: '', stdout: 'Built fixture to /artifact\n' });

  const strict = await runSourceCliWithOutput(['build', '--root', '/project', '--strict', '--json'], { build: build as never });
  expect(strict.code).toBe(1);
  expect(strict.stderr).toContain('AB6020');

  expect(calls).toEqual([
    expect.objectContaining({ hostValidation: true, packageOutputs: true, root: '/project', strict: undefined }),
    expect.objectContaining({ hostValidation: false, packageOutputs: true, root: '/project' }),
    expect.objectContaining({ hostValidation: true, strict: true }),
  ]);
});

it('build lists every compiled MCP App view with its measured size after the Built line (#572)', async () => {
  // Sizes chosen off the whole-unit boundary so the expected text does not
  // depend on how a formatter renders an exact `.0`.
  const build = async () => ({
    build: {
      compiledMcpApps: [
        { name: 'status', size: { bytes: 1_363_149, gzipBytes: 437_350 }, target: 'portable' },
        { name: 'dashboard', size: { bytes: 437_350, gzipBytes: 104_550 }, target: 'portable' },
        { name: 'dashboard', size: { bytes: 437_350, gzipBytes: 104_550 }, target: 'codex' },
      ],
      diagnostics: [],
      outputRoot: '/artifact',
    },
    diagnostics: [],
    model: { metadata: { name: 'fixture' } },
  });

  const human = await runSourceCliWithOutput(['build', '--root', '/project', '--no-host-validation'], { build: build as never });

  // Sorted by target, then App name; 1024-based, one decimal.
  expect(human).toEqual({
    code: 0,
    stderr: '',
    stdout: [
      'Built fixture to /artifact',
      'MCP App dashboard (codex): mcp-apps/dashboard.html 427.1 KiB (102.1 KiB gzip)',
      'MCP App dashboard (portable): mcp-apps/dashboard.html 427.1 KiB (102.1 KiB gzip)',
      'MCP App status (portable): mcp-apps/status.html 1.3 MiB (427.1 KiB gzip)',
      '',
    ].join('\n'),
  });
});

it('build compiles a declared MCP App view and reports its document and measured size (#572)', async () => {
  const project = await createCliProject({ mcpApp: true });
  try {
    // `--json` serializes the whole build result, so the measured sizes and
    // the compiler's non-fatal diagnostics ride along without a bespoke shape.
    const json = await runSourceCliWithOutput([
      'build', '--root', project.root, '--output', project.output, '--no-host-validation', '--json',
    ]);
    expect(json).toMatchObject({ code: 0, stderr: '' });
    const document = JSON.parse(json.stdout) as {
      readonly build: {
        readonly compiledMcpApps: readonly {
          readonly name: string;
          readonly size: { readonly bytes: number; readonly gzipBytes: number };
          readonly target: string;
        }[];
        readonly diagnostics: readonly unknown[];
      };
      readonly diagnostics: readonly unknown[];
    };
    expect(document.build.compiledMcpApps).toMatchObject([{ name: 'dashboard', target: 'portable' }]);
    const size = document.build.compiledMcpApps[0]!.size;
    expect(size.bytes).toBeGreaterThan(0);
    expect(size.gzipBytes).toBeGreaterThan(0);
    expect(size.gzipBytes).toBeLessThanOrEqual(size.bytes);
    expect(Array.isArray(document.build.diagnostics)).toBe(true);
    expect(Array.isArray(document.diagnostics)).toBe(true);

    const human = await runSourceCliWithOutput([
      'build', '--root', project.root, '--output', project.output, '--no-host-validation',
    ]);
    expect(human).toMatchObject({ code: 0, stderr: '' });
    expect(human.stdout).toContain(`Built cli-fixture to ${project.output}\n`);
    expect(human.stdout).toMatch(
      /^MCP App dashboard \(portable\): mcp-apps\/dashboard\.html \d+(?:\.\d)? [KM]iB \(\d+(?:\.\d)? [KM]iB gzip\)$/mu,
    );
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 60_000 * timeScale);

it('enables bounded host validation for built artifacts and promotes warnings only under --strict', async () => {
  const calls: unknown[] = [];
  const validate = async (options: unknown) => {
    calls.push(options);
    return {
      diagnostics: [{
        code: 'AB6020',
        message: 'Claude plugin validation warning.',
        severity: (options as { strict?: boolean }).strict === true ? 'error' as const : 'warning' as const,
      }],
    };
  };

  const normal = await runSourceCliWithOutput([
    'validate', '--root', '/project', '--artifact', '/artifact', '--json',
  ], { validate });
  expect(normal).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(normal.stdout)).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB6020', severity: 'warning' })],
  });

  const strict = await runSourceCliWithOutput([
    'validate', '--root', '/project', '--artifact', '/artifact', '--strict', '--json',
  ], { validate });
  expect(strict.code).toBe(1);
  expect(calls).toEqual([
    expect.objectContaining({ artifact: '/artifact', hostValidation: true, strict: undefined }),
    expect.objectContaining({ artifact: '/artifact', hostValidation: true, strict: true }),
  ]);
});

it('prints a complete invalid inspection on JSON and human output', async () => {
  const project = await createCliProject();
  try {
    const ready = await runSourceCliWithOutput(['inspect', '--root', project.root, '--json']);
    expect(ready).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(ready.stdout)).toMatchObject({ state: 'ready' });

    await writeFile(join(project.root, 'agent-bundle.config.ts'), "throw new Error('opaque cli inspect sentinel');\n");

    const json = await runSourceCliWithOutput(['inspect', '--root', project.root, '--json']);
    expect(json).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(json.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7000', recovery: expect.any(String) })],
      plans: [],
      state: 'invalid',
    });
    expect(json.stdout).not.toContain('opaque cli inspect sentinel');

    const human = await runSourceCliWithOutput(['inspect', '--root', project.root]);
    expect(human).toMatchObject({ code: 1, stderr: '' });
    expect(human.stdout).toContain('AB7000');
    expect(human.stdout).toContain('Unable to load project source.');
    expect(human.stdout).toContain('Recovery:');
    expect(human.stdout).not.toContain('opaque cli inspect sentinel');
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('explains selected and omitted components per target on human inspect output', async () => {
  const project = await createCliProject();
  try {
    // A conventional rule is a Cursor-only surface: portable and codex omit it
    // with their pinned capability judgment, while the skill ships everywhere.
    await mkdir(join(project.root, 'src', 'rules'), { recursive: true });
    await writeFile(
      join(project.root, 'src', 'rules', 'shared.mdc'),
      '---\ndescription: Shared rule\n---\nShared guidance.\n',
    );

    const human = await runSourceCliWithOutput(['inspect', '--root', project.root]);
    expect(human).toMatchObject({ code: 0, stderr: '' });
    expect(human.stdout).toContain('Inspected cli-fixture: portable, codex\n');
    expect(human.stdout).toContain('portable: 1 component(s) selected, 1 omitted\n');
    expect(human.stdout).toContain('codex: 1 component(s) selected, 1 omitted\n');
    expect(human.stdout).toMatch(/^ {2}omitted rule shared: rules unavailable — .+$/mu);
    expect(human.stdout).not.toContain('omitted skill review');
    // A feature the host cannot express is reported on the shipped component
    // (#100 feature sets): select Cursor too and add one command with a field
    // Cursor's frontmatter-free commands surface drops.
    const originalConfig = await readFile(join(project.root, 'agent-bundle.config.ts'), 'utf8');
    await mkdir(join(project.root, 'src', 'commands'), { recursive: true });
    await Promise.all([
      writeFile(join(project.root, 'src', 'commands', 'deploy.md'), '---\nargumentHint: <env>\n---\nDeploy.\n'),
      writeFile(join(project.root, 'agent-bundle.config.ts'), originalConfig.replace("['portable', 'codex']", "['portable', 'codex', 'cursor']")),
    ]);
    const withCursor = await runSourceCliWithOutput(['inspect', '--root', project.root, '--target', 'cursor']);
    expect(withCursor).toMatchObject({ code: 0, stderr: '' });
    expect(withCursor.stdout).toMatch(/^ {2}command deploy omits argumentHint: commands\.argumentHint unavailable — .*frontmatter-free.*$/mu);
    await Promise.all([
      rm(join(project.root, 'src', 'commands'), { force: true, recursive: true }),
      writeFile(join(project.root, 'agent-bundle.config.ts'), originalConfig),
    ]);
    // The canonical kind matrix names every kind a host cannot emit, even
    // kinds this project never declares (#100).
    expect(human.stdout).toContain(
      '  kinds this host cannot emit: agent (unavailable), command (unavailable), hook (unavailable), lsp (unavailable), '
      + 'native-diagnostics (unavailable), native-extension (unavailable), rule (unavailable)\n',
    );
    expect(human.stdout).toMatch(
      /^ {2}kinds this host cannot emit: agent \(unavailable\), command \(unavailable\), lsp \(unavailable\), native-diagnostics \(unavailable\), native-extension \(unavailable\), rule \(unavailable\)$/mu,
    );

    // The JSON form carries the same accounting with the full judgment.
    const json = await runSourceCliWithOutput(['inspect', '--root', project.root, '--target', 'codex', '--json']);
    expect(json).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(json.stdout)).toMatchObject({
      plans: [{
        kinds: expect.arrayContaining([
          { capability: { evidence: { observedVersion: '0.147.0', target: 'codex' }, name: 'skills', state: 'supported' }, kind: 'skill', selected: 1, skipped: 0 },
          { capability: { name: 'rules', reason: expect.any(String), state: 'unavailable' }, kind: 'rule', selected: 0, skipped: 1 },
          { capability: { name: 'lsp', reason: expect.stringContaining('no LSP server surface'), state: 'unavailable' }, kind: 'lsp', selected: 0, skipped: 0 },
          { capability: { name: 'nativeExtension', reason: expect.any(String), state: 'unavailable' }, kind: 'native-extension', selected: 0, skipped: 0 },
        ]),
        selected: [expect.objectContaining({ capability: expect.objectContaining({ name: 'skills', state: 'supported' }), kind: 'skill', name: 'review' })],
        skipped: [expect.objectContaining({
          capability: { name: 'rules', reason: expect.any(String), state: 'unavailable' },
          kind: 'rule',
          name: 'shared',
          reason: 'unsupported-capability',
        })],
        target: 'codex',
      }],
      state: 'ready',
    });
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('reports an unselected inspect target on JSON and human output', async () => {
  const project = await createCliProject();
  try {
    const ready = await runSourceCliWithOutput([
      'inspect', '--root', project.root, '--target', 'portable', '--json',
    ]);
    expect(ready).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(ready.stdout)).toMatchObject({
      plans: [expect.objectContaining({ target: 'portable' })],
      state: 'ready',
    });

    const json = await runSourceCliWithOutput([
      'inspect', '--root', project.root, '--target', 'portabl', '--json',
    ]);
    expect(json).toMatchObject({ code: 1, stderr: '' });
    expect(JSON.parse(json.stdout)).toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'AB7004', recovery: expect.any(String), target: 'portabl' })],
      plans: [],
      state: 'invalid',
    });

    const human = await runSourceCliWithOutput([
      'inspect', '--root', project.root, '--target', 'portabl',
    ]);
    expect(human).toMatchObject({ code: 1, stderr: '' });
    expect(human.stdout).toContain('AB7004');
    expect(human.stdout).toContain('portabl');
    expect(human.stdout).toContain('Recovery:');
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('dumps the synthesized bundler configuration with inspect --bundler', async () => {
  const project = await createCliProject();
  try {
    await mkdir(join(project.root, 'src'), { recursive: true });
    await writeFile(
      join(project.root, 'agent-bundle.config.ts'),
      [
        'export default {',
        "  plugin: { name: 'cli-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        "  scripts: { tool: './src/tool.ts' },",
        "  tools: { rspack: { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } } },",
        '};',
        '',
      ].join('\n'),
    );
    await writeFile(join(project.root, 'src', 'tool.ts'), 'export const main = async () => 0;\n');

    const json = await runSourceCliWithOutput(['inspect', '--root', project.root, '--bundler', '--json']);
    expect(json).toMatchObject({ code: 0, stderr: '' });
    const document = JSON.parse(json.stdout) as {
      readonly selected: {
        readonly bundler: {
          readonly entries: readonly {
            readonly config: { readonly tools: { readonly rspack: readonly unknown[] } };
            readonly kind: string;
            readonly name: string;
          }[];
        };
      };
    };
    const script = document.selected.bundler.entries.find((entry) => entry.kind === 'script');
    expect(script).toMatchObject({
      config: {
        output: { distPath: { root: '<output>/portable' } },
        tools: {
          rspack: [
            { resolve: { extensionAlias: { '.js': ['.js', '.ts'] } } },
            '[function enforceInvariants]',
          ],
        },
      },
      name: 'tool',
    });

    const repeated = await runSourceCliWithOutput(['inspect', '--root', project.root, '--bundler', '--json']);
    expect(repeated.stdout).toBe(json.stdout);

    const human = await runSourceCliWithOutput(['inspect', '--root', project.root, '--bundler']);
    expect(human).toMatchObject({ code: 0, stderr: '' });
    expect(human.stdout).toContain('"kind": "script"');
    expect(human.stdout).toContain('[function enforceInvariants]');

    const ambiguous = await runSourceCliWithOutput(['inspect', '--root', project.root, '--bundler', '--skills']);
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('reports source validation diagnostics on stderr before staging an artifact', async () => {
  await buildCliPackage();
  const project = await createCliProject();
  const output = join(project.root, 'must remain untouched');
  try {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'sentinel.txt'), 'keep\n');
    await writeFile(
      join(project.root, 'agent-bundle.config.ts'),
      "export default { plugin: { version: '1.0.0' } };\n",
    );

    const result = await runCli(project.root, [
      'build', '--root', project.root, '--output', output, '--json',
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject([{ code: 'AB4000', severity: 'error' }]);
    expect(await readFile(join(output, 'sentinel.txt'), 'utf8')).toBe('keep\n');

    const validation = await runCli(project.root, [
      'validate', '--root', project.root, '--json',
    ]);
    expect(validation.code).toBe(1);
    expect(validation.stdout).toBe('');
    expect(JSON.parse(validation.stderr)).toMatchObject([{ code: 'AB4000', severity: 'error' }]);
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('reports a generated Flight worker collision before compiling scripts', async () => {
  const project = await createCliProject();
  try {
    await mkdir(join(project.root, 'src', 'scripts'), { recursive: true });
    await Promise.all([
      writeFile(
        join(project.root, 'src', 'scripts', 'report.tsx'),
        'export default async function Report() { return null; }\n',
      ),
      writeFile(
        join(project.root, 'src', 'scripts', 'report-flight.ts'),
        'export const main = async () => 0;\n',
      ),
    ]);

    const result = await runSourceCliWithOutput([
      'build',
      '--root', project.root,
      '--output', project.output,
      '--target', 'portable',
      '--json',
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject([{
      code: 'AB5000',
      message: 'Duplicate compiled script destination "scripts/report-flight.mjs".',
      severity: 'error',
    }]);
  } finally {
    await rm(resolve(project.root, '..'), { force: true, recursive: true });
  }
}, 30_000 * timeScale);

it('dispatches the install command through the native installer surface', async () => {
  const terminal = captureCliTerminal();
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });

  const code = await runSourceCli(
    ['install', 'claude', '--from', '/tmp/example bundle', '--scope', 'project', '--json'],
    terminal.output,
    {
      installBundle: async (options: unknown) => {
        calls.push(options);
        return {
          bundleRoot: '/tmp/example bundle',
          host: 'claude',
          marketplace: 'fixture-marketplace',
          plugin: 'fixture',
          state: 'installed',
          version: '1.0.0',
        };
      },
    } as unknown as Parameters<typeof runSourceCli>[2],
  );

  expect(code).toBe(0);
  expect(terminal.stderr()).toBe('');
  expect(calls).toEqual([{
    from: '/tmp/example bundle',
    host: 'claude',
    replace: false,
    scope: 'project',
  }]);
  expect(JSON.parse(terminal.stdout())).toMatchObject({
    host: 'claude',
    plugin: 'fixture',
    state: 'installed',
  });
});

it('maps serve-app argv onto serveApp, prints the served URL, and closes the host once on a termination signal', async () => {
  const calls: unknown[] = [];
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removed: NodeJS.Signals[] = [];
  let closeCalls = 0;
  const closedGate = Promise.withResolvers<void>();
  const result = await runSourceCliWithOutput([
    'serve-app', 'hauler/dashboard',
    '--root', '/project', '--artifact', 'artifact', '--target', 'claude',
    '--tool', 'hauler_status', '--input', '{"scope":"all"}', '--port', '4941', '--profile', 'claude',
    '--allow', 'call-tool', '--allow', 'open-external-link', '--open', '--env-file', '.env.dashboard', '--plugin-root', '/state',
  ], {
    serveApp: async (options) => {
      calls.push(options);
      return {
        close: async () => {
          closeCalls += 1;
          closedGate.resolve();
        },
        closed: closedGate.promise,
        resourceUri: 'ui://cargo-hauler/dashboard.html',
        sandboxOrigin: 'http://127.0.0.1:4942',
        server: 'hauler',
        tool: 'hauler_status',
        url: 'http://127.0.0.1:4941/',
      };
    },
    signals: {
      once: (signal, listener) => { handlers.set(signal, listener); },
      removeListener: (signal) => { removed.push(signal); },
    },
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toBe('MCP App hauler/dashboard at http://127.0.0.1:4941/ (tool hauler_status; Ctrl-C stops the server)\n');
  expect(calls).toEqual([{
    app: 'hauler/dashboard',
    artifact: 'artifact',
    autoApprove: ['call-tool', 'open-external-link'],
    envFiles: ['.env.dashboard'],
    input: { scope: 'all' },
    mode: 'production',
    open: true,
    pluginRoot: '/state',
    port: 4941,
    profile: 'claude',
    root: '/project',
    target: 'claude',
    tool: 'hauler_status',
  }]);

  handlers.get('SIGINT')?.();
  handlers.get('SIGTERM')?.();
  await closedGate.promise;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  expect(closeCalls).toBe(1);
  expect(removed).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
});

it('reports the bound server exiting on its own as one diagnostic and releases the serve-app signal listeners', async () => {
  const handlers = new Map<NodeJS.Signals, () => void>();
  const removed: NodeJS.Signals[] = [];
  let closeCalls = 0;
  const serverExit = Promise.withResolvers<void>();
  const terminal = captureCliTerminal();
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runSourceCli(['serve-app', 'status/status', '--root', '/project', '--no-open'], terminal.output, {
    serveApp: async () => ({
      close: async () => { closeCalls += 1; },
      closed: serverExit.promise,
      resourceUri: 'ui://mcp-app-example/status.html',
      sandboxOrigin: 'http://127.0.0.1:4102',
      server: 'status',
      tool: 'show-status',
      url: 'http://127.0.0.1:4101/',
    }),
    signals: {
      once: (signal, listener) => { handlers.set(signal, listener); },
      removeListener: (signal) => { removed.push(signal); },
    },
  });
  expect(code).toBe(0);
  expect(handlers.size).toBe(2);

  serverExit.resolve();
  for (let attempt = 0; attempt < 20 && closeCalls === 0; attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }

  expect(closeCalls).toBe(1);
  expect(removed).toEqual(expect.arrayContaining(['SIGINT', 'SIGTERM']));
  expect(JSON.parse(terminal.stderr())).toEqual([{
    code: 'AB5000',
    message: 'The MCP server behind status/status exited; the MCP App host closed.',
    severity: 'error',
  }]);
});

it('rejects serve-app argv that cannot be served before anything launches', async () => {
  const launched: unknown[] = [];
  const dependencies: CliDependencies = {
    serveApp: async (options) => {
      launched.push(options);
      throw new Error('unreachable');
    },
  };
  const missingApp = await runSourceCliWithOutput(['serve-app', '--root', '/project'], dependencies);
  expect(missingApp.code).toBe(2);
  expect(missingApp.stderr).toContain("missing required argument 'app'");
  const badInput = await runSourceCliWithOutput(['serve-app', 'status/status', '--root', '/project', '--input', '[1]'], dependencies);
  expect(badInput.code).toBe(1);
  expect(JSON.parse(badInput.stderr)).toEqual([{ code: 'AB5000', message: 'Input must be a JSON object.', severity: 'error' }]);
  const bothEnv = await runSourceCliWithOutput(['serve-app', 'status/status', '--root', '/project', '--no-env', '--env-file', '.env'], dependencies);
  expect(bothEnv.code).toBe(1);
  expect(JSON.parse(bothEnv.stderr)).toEqual([{ code: 'AB5000', message: 'Use either --env-file or --no-env, not both.', severity: 'error' }]);
  const badProfile = await runSourceCliWithOutput(['serve-app', 'status/status', '--root', '/project', '--profile', 'cursor'], dependencies);
  expect(badProfile.code).toBe(2);
  expect(badProfile.stderr).toContain('MCP App profile must be portable, claude, or chatgpt.');
  const badCapability = await runSourceCliWithOutput(['serve-app', 'status/status', '--root', '/project', '--allow', 'camera'], dependencies);
  expect(badCapability.code).toBe(2);
  expect(badCapability.stderr).toContain('Consent capability must be call-tool, download-file, open-external-link, or request-display-mode.');
  const badPort = await runSourceCliWithOutput(['serve-app', 'status/status', '--root', '/project', '--port', '70000'], dependencies);
  expect(badPort.code).toBe(1);
  expect(JSON.parse(badPort.stderr)).toEqual([{ code: 'AB5000', message: 'Port must be a TCP port number.', severity: 'error' }]);
  expect(launched).toEqual([]);
});
