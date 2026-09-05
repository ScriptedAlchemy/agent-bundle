import { execFile as executeFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import { build, parseArtifactManifest, validate } from '../src/api.ts';
import { reindexArtifactManifest } from '../src/build/manifest-reindex.ts';
import type { ArtifactManifest } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { runDoctor } from '../src/install/doctor.ts';
import { webPluginDataDirectory } from '../src/web-host/launch.ts';
import { createProjectFixture, removeProjectFixture } from './helpers/project-fixture.ts';
import { awaitStdoutLine, runBin } from './support/bin-process.ts';

const execFile = promisify(executeFile);
const fixtureName = 'manifest-combined-proof';
const fixtureVersion = '1.0.0';
const payloadDependency = 'zod';
const targets = ['claude', 'portable'] as const;
const manifestName = 'agent-bundle.manifest.json';
const replacementMarker = 'REBUILD-SAME-VERSION.md';
const manifestPathKeys = new Set([
  'configPath',
  'entry',
  'hooks',
  'instructions',
  'marketplace',
  'mcp',
  'module',
  'path',
  'plugin',
  'script',
  'source',
  'worker',
]);

let projectRoot = '';
let artifactRoot = '';
let relocatedPackageRoot = '';
let relocatedArtifact = '';
let isolatedHome = '';
let manifestBytes = '';
let manifest: ArtifactManifest;

const exists = async (path: string): Promise<boolean> =>
  access(path).then(() => true, () => false);

const isolatedEnvironment = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  AGENT_BUNDLE_NO_UPDATE_NOTIFIER: '1',
  HOME: home,
  USERPROFILE: home,
});

const unavailableHostCommand = async (): Promise<never> => {
  const error = new Error('host binary unavailable') as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
};

const packageBin = async (): Promise<string> => {
  const packageDocument = JSON.parse(await readFile(join(relocatedPackageRoot, 'package.json'), 'utf8')) as {
    readonly bin: Readonly<Record<string, string>>;
  };
  const entry = packageDocument.bin[fixtureName];
  if (entry === undefined) throw new Error(`package.json does not declare the ${fixtureName} bin.`);
  return resolve(relocatedPackageRoot, entry);
};

const expectInside = (parent: string, child: string): void => {
  const path = relative(parent, child);
  expect(path === '' || (!path.startsWith('..') && !isAbsolute(path))).toBe(true);
};

const collectManifestPaths = (value: unknown, key?: string, paths: string[] = []): readonly string[] => {
  if (typeof value === 'string') {
    if (key !== undefined && manifestPathKeys.has(key)) paths.push(value);
    return paths;
  }
  if (Array.isArray(value)) {
    if (key === 'sourceInputs') {
      for (const entry of value) {
        if (typeof entry === 'string') paths.push(entry);
      }
      return paths;
    }
    for (const entry of value) collectManifestPaths(entry, undefined, paths);
    return paths;
  }
  if (value !== null && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectManifestPaths(child, childKey, paths);
    }
  }
  return paths;
};

describe('the authoritative manifest combined proof', () => {
  beforeAll(async () => {
    const project = await createProjectFixture({
      config: [
        "import { defineConfig, definePrebuilt } from 'agent-bundle/config';",
        '',
        'export default defineConfig({',
        '  mcp: { servers: {',
        '    proof: {',
        '      apps: {',
        "        status: { entry: './views/status.ts', resourceUri: 'ui://manifest-combined-proof/status.html', template: './views/status.html' },",
        '      },',
        "      env: { COMBINED_STATE: '${agent-bundle:path:plugin-data}/state' },",
        "      targets: ['claude', 'portable'],",
        '    },',
        '    runtime: {',
        "      entry: { prebuilt: './built/runtime/server.js' },",
        "      transport: 'stdio',",
        '    },',
        '  } },',
        "  payload: { runtime: definePrebuilt({ source: './built/runtime', runtimeDependencies: ['zod'] }) },",
        "  plugin: { description: 'The authoritative manifest combined proof.', name: 'manifest-combined-proof', version: '1.0.0' },",
        '  routes: { mcpCommands: true },',
        "  targets: ['claude', 'portable'],",
        "  web: { apps: [{ allow: ['call-tool'], app: 'proof/status', tool: 'show-status' }] },",
        '});',
        '',
      ].join('\n'),
      files: {
        'package.json': `${JSON.stringify({
          bin: { [fixtureName]: `./artifact/bin/${fixtureName}.mjs` },
          dependencies: {
            '@agent-bundle/runtime': 'workspace:*',
            react: '19.2.8',
            [payloadDependency]: '4.4.3',
          },
          name: fixtureName,
          type: 'module',
          version: fixtureVersion,
        }, null, 2)}\n`,
        'built/runtime/server.js': [
          "import { z } from 'zod';",
          "process.stdout.write(z.string().parse('prebuilt-runtime'));",
          '',
        ].join('\n'),
        'src/events/tool/before.preflight.ts': [
          'export default () => ({ outcome: \'continue\' });',
          '',
        ].join('\n'),
        'src/events/tool/before.tsx': [
          "import { Agent } from '@agent-bundle/runtime';",
          "export { default as preflight } from './before.preflight.js';",
          "export const config = { providers: ['stateProbe'], runtime: 'standalone', targets: ['claude'] };",
          'export default async function BeforeTool() {',
          "  return <Agent.Result value={{ outcome: 'continue' }} />;",
          '}',
          '',
        ].join('\n'),
        'src/mcp/proof/tools/show-status.cli.ts': [
          'export const config = {',
          "  command: ['status'],",
          '  flags: {',
          "    message: { default: 'manifest-default', description: 'Status message.' },",
          '  },',
          '  positionals: [],',
          '};',
          'export const mapInput = (input) => input;',
          '',
        ].join('\n'),
        'src/mcp/proof/tools/show-status.tsx': [
          "import { Agent } from '@agent-bundle/runtime';",
          "import { z } from 'zod';",
          "export const config = { annotations: { readOnlyHint: true }, description: 'Show combined proof status.', _meta: { ui: { resourceUri: 'ui://manifest-combined-proof/status.html' } } };",
          'export const inputSchema = z.object({ message: z.string().min(1) }).strict();',
          'export const resultSchema = z.object({ message: z.string() }).strict();',
          'export default async function ShowStatus({ input }) {',
          '  return <Agent.Result value={{ message: input.message }}><Agent.Text>{input.message}</Agent.Text></Agent.Result>;',
          '}',
          '',
        ].join('\n'),
        'src/providers/state-probe.ts': [
          "export default async function stateProbe() { return { ready: true }; }",
          '',
        ].join('\n'),
        'views/status.html': '<!doctype html><html><body><main id="status">Combined proof</main></body></html>\n',
        'views/status.ts': "document.body.dataset.ready = 'true';\n",
      },
      prefix: 'agent-bundle-manifest-combined-project-',
    });
    projectRoot = project.root;
    await symlink(
      join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'),
      join(projectRoot, 'node_modules'),
      'dir',
    );
    artifactRoot = join(projectRoot, 'artifact');

    const sourceValidation = await validate({ root: projectRoot });
    expect(sourceValidation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const built = await build({ output: artifactRoot, root: projectRoot, targets: [...targets] });
    expect(built.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    manifestBytes = await readFile(join(artifactRoot, manifestName), 'utf8');
    manifest = parseArtifactManifest(manifestBytes);

    relocatedPackageRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-combined-relocated-'));
    relocatedArtifact = join(relocatedPackageRoot, 'artifact');
    await cp(artifactRoot, relocatedArtifact, { recursive: true });
    await cp(join(projectRoot, 'package.json'), join(relocatedPackageRoot, 'package.json'));
    isolatedHome = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-combined-home-'));
    await mkdir(join(isolatedHome, '.cursor'), { recursive: true });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([
      projectRoot === '' ? Promise.resolve() : removeProjectFixture(projectRoot),
      relocatedPackageRoot === '' ? Promise.resolve() : rm(relocatedPackageRoot, { force: true, recursive: true }),
      isolatedHome === '' ? Promise.resolve() : rm(isolatedHome, { force: true, recursive: true }),
    ]);
  });

  it('builds every contract row into one path-clean manifest', () => {
    const command = manifest.routes.cli?.commands?.find((candidate) => candidate.routeId === 'tool:proof/show-status');
    expect(command).toMatchObject({
      mcp: { confirm: false, server: 'proof', tool: 'show-status' },
      options: [
        expect.objectContaining({
          key: 'message',
          kind: 'string',
          option: 'message',
          repeated: false,
          required: false,
        }),
      ],
      path: ['status'],
      projection: {
        defaults: { message: 'manifest-default' },
        mapInput: true,
        module: 'src/mcp/proof/tools/show-status.cli.ts',
      },
      routeId: 'tool:proof/show-status',
    });

    const eventRow = manifest.routes.events.find((route) => route.id === 'event:tool/before');
    expect(eventRow).toMatchObject({
      event: 'tool/before',
      execution: {
        fallback: 'none',
        preflight: 'src/events/tool/before.preflight.ts',
        providers: ['stateProbe'],
        runtime: 'standalone',
      },
      id: 'event:tool/before',
      source: 'src/events/tool/before.tsx',
    });

    const eventHooks = manifest.executables.hooks.filter((hook) => hook.routeId === 'event:tool/before');
    expect(eventHooks.map((hook) => hook.host)).toEqual(['claude']);
    for (const hook of eventHooks) {
      expect(hook).toMatchObject({
        event: 'beforeTool',
        kind: 'event-route',
        routeId: 'event:tool/before',
      });
    }

    const server = manifest.executables.mcpServers.find((candidate) => candidate.name === 'proof');
    expect(server).toMatchObject({
      apps: [expect.objectContaining({ resourceUri: 'ui://manifest-combined-proof/status.html' })],
      hosts: ['claude', 'portable'],
      kind: 'compiled',
      name: 'proof',
      transport: 'stdio',
    });
    // integrator: assert the compiled server launch block once its lane lands.

    expect(manifest.web?.apps).toEqual([
      expect.objectContaining({
        allow: ['call-tool'],
        app: 'proof/status',
        server: 'proof',
        tool: 'show-status',
      }),
    ]);
    expect(manifest.distribution.payloads).toEqual([
      { hosts: [...targets], name: 'runtime', runtimeDependencies: [payloadDependency] },
    ]);
    expect(manifest.files.filter((file) => file.kind === 'prebuilt')).toEqual([
      expect.objectContaining({ kind: 'prebuilt', path: 'runtime/server.js' }),
    ]);

    expect(manifestBytes).not.toContain(projectRoot);
    expect(manifestBytes).not.toContain(artifactRoot);
    for (const path of collectManifestPaths(manifest)) {
      expect(isAbsolute(path), path).toBe(false);
      expect(path).not.toContain(projectRoot);
    }
  });

  it('revalidates and inspects a source-free relocated copy', async () => {
    expect((await validateArtifact({ artifactRoot: relocatedArtifact }))
      .filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(await readFile(join(relocatedArtifact, manifestName), 'utf8')).toBe(manifestBytes);
    expect(await exists(join(relocatedPackageRoot, 'src'))).toBe(false);
    expect(await exists(join(relocatedPackageRoot, 'node_modules'))).toBe(false);

    const doctor = await runDoctor({
      commandRunner: unavailableHostCommand,
      endpointDirectory: join(isolatedHome, 'endpoints'),
      from: relocatedArtifact,
      home: isolatedHome,
      hosts: ['claude'],
    });
    expect(doctor.hosts.find((host) => host.host === 'claude')?.bundle).toMatchObject({
      name: fixtureName,
      version: fixtureVersion,
    });
    expect(doctor.web).toMatchObject({ apps: 1, plugin: fixtureName });

    const inspected = await execFile(process.execPath, [
      join(process.cwd(), 'packages/agent-bundle/dist/cli.js'),
      'inspect',
      '--artifact',
      relocatedArtifact,
      '--json',
    ]);
    expect(inspected.stderr).toBe('');
    const inspectedDocument = JSON.parse(inspected.stdout);
    expect(JSON.stringify(inspectedDocument)).toContain('proof');
    expect(JSON.stringify(inspectedDocument)).toContain('event:tool/before');
    expect(JSON.stringify(inspectedDocument)).toContain('status');
    expect(JSON.stringify(inspectedDocument)).toContain('runtime');
  });

  it('runs install, same-version replace, doctor, and uninstall from the relocated copy', async () => {
    const environment = isolatedEnvironment(isolatedHome);
    const installer = join(relocatedArtifact, 'install.mjs');
    const destination = join(isolatedHome, '.cursor', 'plugins', 'local', fixtureName);
    const pluginData = join(isolatedHome, '.cursor', 'agent-bundle', 'plugin-data', fixtureName);
    const install = (args: readonly string[] = []) =>
      execFile(process.execPath, [installer, ...args], { cwd: relocatedArtifact, env: environment });

    const first = await install();
    expect(first.stderr).toBe('');
    expect(first.stdout).toMatch(new RegExp(`^Installed ${fixtureName}@${fixtureVersion} at `, 'u'));
    expect(first.stdout).not.toMatch(/collision|daemon version mismatch/iu);
    expect(await readFile(join(destination, manifestName), 'utf8')).toBe(
      await readFile(join(relocatedArtifact, manifestName), 'utf8'),
    );
    await expect(stat(pluginData)).resolves.toMatchObject({});
    expectInside(isolatedHome, pluginData);
    expectInside(isolatedHome, destination);
    expectInside(relocatedArtifact, installer);
    expect(relative(destination, pluginData).startsWith('..')).toBe(true);
    expect(relative(relocatedArtifact, pluginData).startsWith('..')).toBe(true);

    await writeFile(join(relocatedArtifact, replacementMarker), '# same-version replacement\n');
    await reindexArtifactManifest(relocatedArtifact, {
      added: [{ kind: 'generated', path: replacementMarker }],
    });
    const replacementManifestBytes = await readFile(join(relocatedArtifact, manifestName), 'utf8');
    const replaced = await install();
    expect(replaced.stderr).toBe('');
    expect(replaced.stdout).toMatch(new RegExp(`^Replaced ${fixtureName}@${fixtureVersion} at `, 'u'));
    expect(replaced.stdout).not.toMatch(/collision|daemon version mismatch/iu);
    expect(await readFile(join(destination, manifestName), 'utf8')).toBe(replacementManifestBytes);
    await access(join(destination, replacementMarker));

    const doctor = await runDoctor({
      commandRunner: unavailableHostCommand,
      endpointDirectory: join(isolatedHome, 'endpoints'),
      from: destination,
      home: isolatedHome,
      hosts: ['claude'],
    });
    expect(doctor.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(doctor.hosts.find((host) => host.host === 'claude')?.bundle).toMatchObject({
      name: fixtureName,
      version: fixtureVersion,
    });

    const uninstalled = await install(['--uninstall']);
    expect(uninstalled.stderr).toBe('');
    expect(uninstalled.stdout).toMatch(new RegExp(`^Uninstalled ${fixtureName}@${fixtureVersion}`, 'u'));
    expect(uninstalled.stdout).not.toMatch(/collision|daemon version mismatch/iu);
    expect(await exists(destination)).toBe(false);
    expect(await exists(pluginData)).toBe(false);
  });

  it('runs the relocated artifact through the fixture package.json bin entry', async () => {
    const bin = await packageBin();
    expect(bin).toBe(join(relocatedArtifact, 'bin', `${fixtureName}.mjs`));
    await access(bin);

    const help = await execFile(process.execPath, [bin, '--help'], {
      cwd: relocatedPackageRoot,
      env: isolatedEnvironment(isolatedHome),
    });
    expect(help.stdout).toContain('status');
    expect(help.stdout).toContain('web');

    const projected = await execFile(process.execPath, [bin, 'status', '--json'], {
      cwd: relocatedPackageRoot,
      env: isolatedEnvironment(isolatedHome),
    });
    expect(JSON.parse(projected.stdout)).toEqual({ message: 'manifest-default' });

    const web = runBin(bin, ['web', '--no-open', '--json'], {
      cwd: relocatedPackageRoot,
      env: isolatedEnvironment(isolatedHome),
    });
    const line = await awaitStdoutLine(web, (candidate) => candidate.startsWith('{'), 30_000);
    expect(JSON.parse(line)).toMatchObject({
      app: 'proof/status',
      resourceUri: 'ui://manifest-combined-proof/status.html',
      server: 'proof',
      tool: 'show-status',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
    });
    const webState = webPluginDataDirectory(relocatedArtifact, 'proof', isolatedHome);
    await access(webState);
    expectInside(isolatedHome, webState);
    expect(relative(relocatedArtifact, webState).startsWith('..')).toBe(true);
    web.child.kill('SIGINT');
    await expect(web.exit).resolves.toEqual({ code: 130, signal: null });
  });
});
