import { execFile as executeFile } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { sha256Hex } from '../src/core/digest.ts';
import { cachedNpmInstallArguments, installedEnvironment } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const fixtureRoot = join(workspaceRoot, 'fixtures', 'integration', 'comprehensive');
const agentBundleImport = /\b(?:import|export)(?:\s*[\s\S]*?\s+from)?\s*['"]agent-bundle(?:\/[^'"]*)?['"]|\bimport\s*\(\s*['"]agent-bundle(?:\/[^'"]*)?['"]|\brequire\s*\(\s*['"]agent-bundle(?:\/[^'"]*)?['"]/;

interface FileDigest {
  readonly bytes: number;
  readonly path: string;
  readonly sha256: string;
}

interface ManifestDigest extends FileDigest {
  readonly mode?: number;
}

const artifactDigest = async (root: string): Promise<readonly FileDigest[]> => {
  const collect = async (directory: string): Promise<FileDigest[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const collected = await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collect(path);
      if (!entry.isFile()) return [];
      const contents = await readFile(path);
      return [{
        bytes: contents.byteLength,
        path: relative(root, path),
        sha256: sha256Hex(contents),
      }];
    }));
    return collected.flat();
  };
  return (await collect(root)).sort((left, right) => left.path.localeCompare(right.path));
};

const runInstalled = async (
  cli: string,
  root: string,
  args: readonly string[],
): Promise<{ readonly stderr: string; readonly stdout: string }> => execFile(cli, [...args], {
  cwd: root,
  env: installedEnvironment(),
});

it('uses only an installed tarball after source deletion', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-consumer-'));
  const packedPackageRoot = join(consumerRoot, 'packed-agent-bundle');
  const projectRoot = join(consumerRoot, 'project with spaces');
  const scriptProjectRoot = join(consumerRoot, 'script-run-project');
  const artifact = join(projectRoot, 'artifact with spaces');

  try {
    // Deliberately not sharedPackedTarball: this test packs from a deletable
    // copy of the package and removes that copy after install, proving the
    // tarball's contents hold no path references back to the pack source. The
    // shared tarball packs from the live workspace, which survives the run,
    // so a leaked path would resolve and pass silently.
    await cp(packageRoot, packedPackageRoot, { recursive: true });
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'rslib'), [
      'build', '--config', join(packageRoot, 'rslib.config.ts'), '--dist-path', join(packedPackageRoot, 'dist'),
    ], { cwd: workspaceRoot, env: installedEnvironment() });
    const { stdout: packed } = await execFile('npm', [
      'pack',
      '--json',
      '--pack-destination',
      consumerRoot,
    ], {
      cwd: packedPackageRoot,
      env: installedEnvironment(),
    });
    const tarball = join(consumerRoot, (JSON.parse(packed) as Array<{ filename: string }>)[0]!.filename);
    await cp(fixtureRoot, projectRoot, { recursive: true });
    const [sourceShellMode, sourcePythonMode] = await Promise.all([
      stat(join(projectRoot, 'src', 'shell.sh')).then((metadata) => metadata.mode & 0o777),
      stat(join(projectRoot, 'src', 'python.py')).then((metadata) => metadata.mode & 0o777),
    ]);
    await mkdir(scriptProjectRoot, { recursive: true });
    await Promise.all([
      writeFile(join(scriptProjectRoot, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(scriptProjectRoot, 'agent-bundle.config.ts'),
        "export default { plugin: { name: 'packed-script-run', version: '1.0.0' }, scripts: { shell: './shell.sh' }, targets: ['portable'] };\n",
      ),
      writeFile(join(scriptProjectRoot, 'shell.sh'), "printf 'packed script stdout\\n'\nprintf 'packed script stderr\\n' >&2\n"),
    ]);
    // The two consumers are disjoint directories; npm's cache handles the
    // concurrent installs (the scaffolder e2e relies on the same property).
    await Promise.all([projectRoot, scriptProjectRoot].map(async (consumer) =>
      execFile('npm', ['install', ...cachedNpmInstallArguments, tarball], {
        cwd: consumer,
        env: installedEnvironment(),
      })));

    const cli = join(projectRoot, 'node_modules', '.bin', 'agent-bundle');
    const installedPackage = await realpath(join(projectRoot, 'node_modules', 'agent-bundle'));
    expect(installedPackage.startsWith(workspaceRoot)).toBe(false);
    expect(installedEnvironment().NODE_PATH).toBeUndefined();
    await rm(packedPackageRoot, { force: true, recursive: true });

    const scriptPackage = await realpath(join(scriptProjectRoot, 'node_modules', 'agent-bundle'));
    expect(scriptPackage.startsWith(workspaceRoot)).toBe(false);
    const installed = await import(pathToFileURL(join(scriptPackage, 'dist', 'index.js')).href) as {
      readonly startDevServer: (options: { readonly open: false; readonly port: number; readonly root: string }) => Promise<{
        close(): Promise<void>;
        readonly url: string;
      }>;
    };
    const devServer = await installed.startDevServer({ open: false, port: 0, root: scriptProjectRoot });
    try {
      const bootstrap = await fetch(`${devServer.url}/api/project/session`, {
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(bootstrap.status).toBe(200);
      const session = await bootstrap.json() as { readonly token: string };
      const runResponse = await fetch(`${devServer.url}/api/playground/runs`, {
        body: JSON.stringify({ operation: 'script.run', scriptId: 'script:shell', target: 'portable' }),
        headers: {
          'content-type': 'application/json',
          origin: devServer.url,
          'x-agent-bundle-session': session.token,
        },
        method: 'POST',
      });
      expect(runResponse.status).toBe(200);
      const run = await runResponse.json() as { readonly run: { readonly session: { readonly id: string } } };
      let trace: { readonly events: readonly { readonly kind: string; readonly raw: unknown }[]; readonly session: { readonly state: string } } | undefined;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const response = await fetch(`${devServer.url}/api/playground/sessions/${encodeURIComponent(run.run.session.id)}/export`, {
          headers: { origin: devServer.url, 'x-agent-bundle-session': session.token },
        });
        if (response.ok) {
          const body = await response.json() as { readonly export: typeof trace };
          trace = body.export;
          if (trace?.session.state === 'finalized') break;
        }
        await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 20); });
      }
      expect(trace?.session.state).toBe('finalized');
      expect(trace?.events).toContainEqual(expect.objectContaining({
        kind: 'script.completed',
        raw: expect.objectContaining({ result: expect.objectContaining({
          exitCode: 0,
          script: 'shell',
          stderr: 'packed script stderr\n',
          stdout: 'packed script stdout\n',
        }) }),
      }));
    } finally {
      await devServer.close();
    }

    const { stdout: inspection } = await runInstalled(cli, projectRoot, ['inspect', '--json', '--root', projectRoot]);
    expect(JSON.parse(inspection)).toMatchObject({ model: { metadata: { name: 'integration-fixture' } } });

    await runInstalled(cli, projectRoot, ['build', '--root', projectRoot, '--output', artifact]);
    const firstArtifactDigest = await artifactDigest(artifact);
    await runInstalled(cli, projectRoot, ['build', '--root', projectRoot, '--output', artifact]);
    expect(await artifactDigest(artifact)).toEqual(firstArtifactDigest);

    const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly (ManifestDigest & {
        readonly kind: 'bundle' | 'copy' | 'generated' | 'prebuilt';
        readonly sourceInputs: readonly string[];
      })[];
    };
    const files = (await artifactDigest(artifact)).filter((entry) => entry.path !== 'agent-bundle.manifest.json');
    const manifestFiles = await Promise.all(files.map(async (file): Promise<ManifestDigest> => {
      if (!/(?:^|\/)scripts\/[^/]+\.(?:sh|bash|py)$/iu.test(file.path)) return file;
      const mode = (await stat(join(artifact, file.path))).mode & 0o777;
      return (mode & 0o111) === 0 ? file : { ...file, mode };
    }));
    expect(
      manifest.files
        .map(({ kind: _kind, sourceInputs: _sourceInputs, ...file }) => file)
        .sort((left, right) => left.path.localeCompare(right.path)),
    ).toEqual(manifestFiles);
    for (const file of manifest.files) {
      expect(['bundle', 'copy', 'generated', 'prebuilt']).toContain(file.kind);
      expect(file.sourceInputs).toEqual([...file.sourceInputs].sort((left, right) => left.localeCompare(right)));
    }
    for (const file of files.filter((entry) => entry.path.endsWith('.mjs'))) {
      await expect(readFile(join(artifact, file.path), 'utf8')).resolves.not.toMatch(
        agentBundleImport,
      );
    }
    const localServer = JSON.parse(await readFile(join(artifact, 'portable', 'mcp.json'), 'utf8')) as {
      readonly mcpServers: { readonly local: { readonly args: readonly [string, ...string[]] } };
    };
    const localServerBundle = join(artifact, 'portable', localServer.mcpServers.local.args[0]);

    await Promise.all([
      rm(join(projectRoot, 'agent-bundle.config.ts')),
      rm(join(projectRoot, 'native'), { force: true, recursive: true }),
      rm(join(projectRoot, 'package.json')),
      rm(join(projectRoot, 'skills'), { force: true, recursive: true }),
      rm(join(projectRoot, 'src'), { force: true, recursive: true }),
      rm(join(projectRoot, 'views'), { force: true, recursive: true }),
    ]);
    await expect(access(join(projectRoot, 'agent-bundle.config.ts'))).rejects.toThrow();

    const { stdout: validation } = await runInstalled(cli, projectRoot, [
      'validate', '--json', '--root', projectRoot, '--artifact', artifact,
    ]);
    expect(validation).toBe('{"diagnostics":[]}\n');

    const bundlePath = join(artifact, 'portable', 'scripts', 'bundle.mjs');
    await expect(execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      "const module = await import(process.argv[1]); console.log(module.bundleMessage);",
      pathToFileURL(bundlePath).href,
    ], { cwd: projectRoot, env: installedEnvironment() })).resolves.toMatchObject({ stdout: 'bundled fixture\n' });
    await expect(execFile(join(artifact, 'portable', 'scripts', 'shell.sh'), [], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'shell fixture\n' });
    await expect(execFile('python3', [join(artifact, 'portable', 'scripts', 'python.py')], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'python fixture\n' });
    expect((await stat(join(artifact, 'portable', 'scripts', 'shell.sh'))).mode & 0o777).toBe(sourceShellMode);
    expect((await stat(join(artifact, 'portable', 'scripts', 'python.py'))).mode & 0o777).toBe(sourcePythonMode);

    const { stdout: hooks } = await runInstalled(cli, projectRoot, [
      'hooks', 'list', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'codex',
    ]);
    const hook = (JSON.parse(hooks) as Array<{ id: string }>)[0]!;
    const { stdout: simulation } = await runInstalled(cli, projectRoot, [
      'hooks', 'simulate', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'codex',
      '--hook', hook.id, '--input', JSON.stringify({
        cwd: projectRoot,
        sessionId: 'packed-consumer',
        source: 'packed-consumer',
        transcriptPath: join(projectRoot, 'transcript.json'),
      }),
    ]);
    expect(JSON.parse(simulation)).toEqual({ additionalContext: 'hook:packed-consumer', outcome: 'continue' });

    const { stdout: listedTools } = await runInstalled(cli, projectRoot, [
      'mcp', 'list', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'portable', '--server', 'local',
    ]);
    expect(JSON.parse(listedTools)).toMatchObject({
      tools: [{
        _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard.html' } },
        name: 'show-dashboard',
      }],
    });
    const { stdout: invokedTool } = await runInstalled(cli, projectRoot, [
      'mcp', 'invoke', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'portable', '--server', 'local',
      '--tool', 'show-dashboard', '--input', '{}',
    ]);
    expect(JSON.parse(invokedTool)).toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard.html' } },
        content: [{ text: 'dashboard ready: ordinary local import', type: 'text' }],
        structuredContent: { resourceUri: 'ui://integration-fixture/dashboard.html', view: 'dashboard' },
      },
    });

    // The framework-owned package build and generated stdio lifecycle must
    // work from the installed tarball alone: bin/lib/dts outputs under dist/,
    // a factory-exporting conventional MCP entry served by the packaged
    // runtime shell, and foreground resolution of the hashed entry.
    const frameworkRoot = join(consumerRoot, 'framework-build-project');
    await mkdir(join(frameworkRoot, 'src', 'mcp'), { recursive: true });
    await Promise.all([
      writeFile(join(frameworkRoot, 'package.json'), '{"name":"framework-build-fixture","type":"module","private":true}\n'),
      writeFile(join(frameworkRoot, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          module: 'esnext',
          moduleResolution: 'bundler',
          strict: true,
          target: 'es2022',
          types: ['node'],
        },
      })),
      writeFile(join(frameworkRoot, 'agent-bundle.config.ts'), [
        'export default {',
        '  mcp: { servers: { greeter: {} } },',
        "  plugin: { name: 'framework-build-fixture', version: '1.0.0' },",
        "  targets: ['portable'],",
        '};',
        '',
      ].join('\n')),
      writeFile(join(frameworkRoot, 'src', 'cli.ts'), [
        'export const main = async (argv: readonly string[]): Promise<number> => {',
        "  process.stdout.write(`packed bin ran:${argv.join(',')}\\n`);",
        '  return 0;',
        '};',
        '',
      ].join('\n')),
      writeFile(join(frameworkRoot, 'src', 'index.ts'), [
        'export interface PackedAnswer { readonly value: number }',
        'export const packedAnswer: PackedAnswer = { value: 42 };',
        '',
      ].join('\n')),
      writeFile(join(frameworkRoot, 'src', 'mcp', 'greeter.ts'), [
        "import { McpServer } from '@modelcontextprotocol/server';",
        '',
        'export default () => {',
        "  const server = new McpServer({ name: 'framework-build-fixture', version: '1.0.0' });",
        "  server.registerTool('greet', { description: 'Greets from the packaged runtime shell.' }, async () => ({",
        "    content: [{ text: 'hello from the framework shell', type: 'text' }],",
        '  }));',
        '  return server;',
        '};',
        '',
      ].join('\n')),
    ]);
    await execFile('npm', ['install', ...cachedNpmInstallArguments, tarball], {
      cwd: frameworkRoot,
      env: installedEnvironment(),
    });
    // Declaration generation resolves typescript and ambient node types from
    // the consumer project, exactly like a real devDependency install.
    await Promise.all([
      symlink(join(workspaceRoot, 'node_modules', 'typescript'), join(frameworkRoot, 'node_modules', 'typescript'), 'dir'),
      symlink(join(workspaceRoot, 'node_modules', '@types'), join(frameworkRoot, 'node_modules', '@types'), 'dir'),
    ]);
    const frameworkCli = join(frameworkRoot, 'node_modules', '.bin', 'agent-bundle');
    const frameworkArtifact = join(frameworkRoot, 'artifact');
    await runInstalled(frameworkCli, frameworkRoot, ['build', '--root', frameworkRoot, '--output', frameworkArtifact]);

    const packedBin = join(frameworkRoot, 'dist', 'bin', 'framework-build-fixture.js');
    expect((await stat(packedBin)).mode & 0o111).not.toBe(0);
    expect((await readFile(packedBin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
    await expect(execFile(packedBin, ['alpha'], { cwd: frameworkRoot, env: installedEnvironment() }))
      .resolves.toMatchObject({ stdout: 'packed bin ran:alpha\n' });
    const packedLib = await import(pathToFileURL(join(frameworkRoot, 'dist', 'index.js')).href) as {
      readonly packedAnswer: { readonly value: number };
    };
    expect(packedLib.packedAnswer.value).toBe(42);
    await expect(readFile(join(frameworkRoot, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('PackedAnswer');

    const greeterManifest = JSON.parse(await readFile(join(frameworkArtifact, 'portable', 'mcp.json'), 'utf8')) as {
      readonly mcpServers: { readonly greeter: { readonly args: readonly [string, ...string[]] } };
    };
    const greeterEntry = join(frameworkArtifact, 'portable', greeterManifest.mcpServers.greeter.args[0]);
    const greeterBundle = await readFile(greeterEntry, 'utf8');
    expect(greeterBundle).not.toMatch(agentBundleImport);
    expect(greeterBundle).toContain('stdio heartbeat');
    // The packaged lifecycle shell exits 0 on stdin EOF so clients can
    // respawn. execFile never closes the child's stdin pipe, so deliver the
    // EOF explicitly — the real server's transport holds the process alive
    // until it arrives.
    const greeterRun = execFile(process.execPath, [greeterEntry], {
      cwd: frameworkRoot,
      env: installedEnvironment(),
      timeout: 30_000,
    });
    greeterRun.child.stdin?.end();
    await expect(greeterRun).resolves.toMatchObject({ stdout: '' });
    const { stdout: greeterTools } = await runInstalled(frameworkCli, frameworkRoot, [
      'mcp', 'list', '--json', '--root', frameworkRoot, '--artifact', frameworkArtifact, '--target', 'portable', '--server', 'greeter',
    ]);
    expect(JSON.parse(greeterTools)).toMatchObject({ tools: [{ name: 'greet' }] });

    const reader = join(projectRoot, 'read-resource.mjs');
    await writeFile(reader, [
      "import { Client } from '@modelcontextprotocol/client';",
      "import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';",
      'const [server, uri] = process.argv.slice(2);',
      "const client = new Client({ name: 'packed-consumer', version: '1.0.0' });",
      "await client.connect(new StdioClientTransport({ args: [server], command: process.execPath, stderr: 'pipe' }));",
      'try { console.log(JSON.stringify(await client.readResource({ uri }))); } finally { await client.close(); }',
    ].join('\n'));
    const { stdout: resource } = await execFile(process.execPath, [
      reader,
      localServerBundle,
      'ui://integration-fixture/dashboard.html',
    ], { cwd: projectRoot, env: installedEnvironment() });
    expect(JSON.parse(resource)).toMatchObject({
      contents: [{
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('integration dashboard'),
        uri: 'ui://integration-fixture/dashboard.html',
      }],
    });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 240_000);
