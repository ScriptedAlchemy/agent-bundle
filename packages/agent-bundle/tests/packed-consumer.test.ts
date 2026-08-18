import { createHash } from 'node:crypto';
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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

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

const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

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
        sha256: createHash('sha256').update(contents).digest('hex'),
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

it('recognizes agent-bundle re-exports and CommonJS requires in generated code', () => {
  expect("export { build } from 'agent-bundle';").toMatch(agentBundleImport);
  expect("const bundle = require('agent-bundle/api');").toMatch(agentBundleImport);
});

it('uses only an installed tarball after source deletion', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-consumer-'));
  const packedPackageRoot = join(consumerRoot, 'packed-agent-bundle');
  const projectRoot = join(consumerRoot, 'project with spaces');
  const scriptProjectRoot = join(consumerRoot, 'script-run-project');
  const artifact = join(projectRoot, 'artifact');

  try {
    await cp(packageRoot, packedPackageRoot, { recursive: true });
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'rslib'), [
      'build', '--dist-path', join(packedPackageRoot, 'dist'),
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
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: projectRoot,
      env: installedEnvironment(),
    });
    await mkdir(scriptProjectRoot, { recursive: true });
    await Promise.all([
      writeFile(join(scriptProjectRoot, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(scriptProjectRoot, 'agent-bundle.config.ts'),
        "export default { plugin: { name: 'packed-script-run', version: '1.0.0' }, scripts: { shell: './shell.sh' }, targets: ['portable'] };\n",
      ),
      writeFile(join(scriptProjectRoot, 'shell.sh'), "printf 'packed script stdout\\n'\nprintf 'packed script stderr\\n' >&2\n"),
    ]);
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: scriptProjectRoot,
      env: installedEnvironment(),
    });

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
        readonly kind: 'bundle' | 'copy' | 'generated';
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
      expect(['bundle', 'copy', 'generated']).toContain(file.kind);
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
    expect((await stat(join(artifact, 'portable', 'scripts', 'shell.sh'))).mode & 0o777).toBe(0o751);
    expect((await stat(join(artifact, 'portable', 'scripts', 'python.py'))).mode & 0o777).toBe(0o711);

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
        _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
        name: 'show-dashboard',
      }],
    });
    const { stdout: invokedTool } = await runInstalled(cli, projectRoot, [
      'mcp', 'invoke', '--json', '--root', projectRoot, '--artifact', artifact, '--target', 'portable', '--server', 'local',
      '--tool', 'show-dashboard', '--input', '{}',
    ]);
    expect(JSON.parse(invokedTool)).toMatchObject({
      result: {
        _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
        content: [{ text: 'dashboard ready: ordinary local import', type: 'text' }],
        structuredContent: { resourceUri: 'ui://integration-fixture/dashboard-v1.html', view: 'dashboard' },
      },
    });

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
      'ui://integration-fixture/dashboard-v1.html',
    ], { cwd: projectRoot, env: installedEnvironment() });
    expect(JSON.parse(resource)).toMatchObject({
      contents: [{
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('integration dashboard'),
        uri: 'ui://integration-fixture/dashboard-v1.html',
      }],
    });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 120_000);
