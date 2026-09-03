import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { runCli as runSourceCli, type CliDependencies } from '../src/cli.ts';
import { cachedNpmInstallArguments, packOutputFromJson } from './support/shared-pack.ts';
import { timeScale } from './support/time-scale.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
const cliPath = join(packageRoot, 'dist/cli.js');
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
  const stderr: string[] = [];
  const stdout: string[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });
  const code = await runSourceCli(args, {
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    stdout: { write: (chunk: string) => stdout.push(chunk) },
  }, dependencies);
  return { code, stderr: stderr.join(''), stdout: stdout.join('') };
};

const createCliProject = async (): Promise<{ readonly output: string; readonly root: string }> => {
  const parent = await mkdtemp(join(tmpdir(), 'agent bundle cli parent-'));
  const root = join(parent, 'project with spaces');
  const output = join(root, 'artifact with spaces');
  await mkdir(join(root, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(root, 'agent-bundle.config.ts'),
      [
        'export default ({ command, mode, projectRoot, selectedTargets }) => ({',
        "  plugin: { name: 'cli-fixture', version: '1.0.0' },",
        "  targets: selectedTargets.length === 0 ? ['portable', 'codex'] : selectedTargets,",
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        '});',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(root, 'src', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
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
  const packed = packOutputFromJson(stdout);
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

    // The JSON form carries the same accounting with the full judgment.
    const json = await runSourceCliWithOutput(['inspect', '--root', project.root, '--target', 'codex', '--json']);
    expect(json).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(json.stdout)).toMatchObject({
      plans: [{
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
  const stderr: string[] = [];
  const stdout: string[] = [];
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, '__AGENT_BUNDLE_VERSION__', { configurable: true, value: 'test' });

  const code = await runSourceCli(
    ['install', 'claude', '--from', '/tmp/example bundle', '--scope', 'project', '--json'],
    {
      stderr: { write: (chunk: string) => stderr.push(chunk) },
      stdout: { write: (chunk: string) => stdout.push(chunk) },
    },
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
  expect(stderr.join('')).toBe('');
  expect(calls).toEqual([{
    from: '/tmp/example bundle',
    host: 'claude',
    scope: 'project',
  }]);
  expect(JSON.parse(stdout.join(''))).toMatchObject({
    host: 'claude',
    plugin: 'fixture',
    state: 'installed',
  });
});
