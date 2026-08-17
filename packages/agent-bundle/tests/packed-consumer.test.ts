import { createHash } from 'node:crypto';
import { execFile as executeFile } from 'node:child_process';
import {
  access,
  cp,
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
  const firstArtifact = join(projectRoot, 'first artifact');

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
    const [sourceShellMode, sourcePythonMode] = await Promise.all([
      stat(join(projectRoot, 'src', 'shell.sh')).then((metadata) => metadata.mode & 0o777),
      stat(join(projectRoot, 'src', 'python.py')).then((metadata) => metadata.mode & 0o777),
    ]);
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: projectRoot,
      env: installedEnvironment(),
    });

    const cli = join(projectRoot, 'node_modules', '.bin', 'agent-bundle');
    const installedPackage = await realpath(join(projectRoot, 'node_modules', 'agent-bundle'));
    expect(installedPackage.startsWith(workspaceRoot)).toBe(false);
    expect(installedEnvironment().NODE_PATH).toBeUndefined();

    const { stdout: inspection } = await runInstalled(cli, projectRoot, ['inspect', '--json', '--root', projectRoot]);
    expect(JSON.parse(inspection)).toMatchObject({ model: { metadata: { name: 'integration-fixture' } } });

    await runInstalled(cli, projectRoot, ['build', '--root', projectRoot, '--output', firstArtifact]);
    const firstArtifactDigest = await artifactDigest(firstArtifact);
    await runInstalled(cli, projectRoot, ['build', '--root', projectRoot, '--output', firstArtifact]);
    expect(firstArtifactDigest).toEqual(await artifactDigest(firstArtifact));

    const manifest = JSON.parse(await readFile(join(firstArtifact, 'agent-bundle.manifest.json'), 'utf8')) as {
      readonly files: readonly (ManifestDigest & {
        readonly kind: 'bundle' | 'copy' | 'generated';
        readonly sourceInputs: readonly string[];
      })[];
    };
    const files = (await artifactDigest(firstArtifact)).filter((entry) => entry.path !== 'agent-bundle.manifest.json');
    const manifestFiles = await Promise.all(files.map(async (file): Promise<ManifestDigest> => {
      if (!/(?:^|\/)scripts\/[^/]+\.(?:sh|bash|py)$/iu.test(file.path)) return file;
      const mode = (await stat(join(firstArtifact, file.path))).mode & 0o777;
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
      await expect(readFile(join(firstArtifact, file.path), 'utf8')).resolves.not.toMatch(
        agentBundleImport,
      );
    }
    const localServer = JSON.parse(await readFile(join(firstArtifact, 'portable', 'mcp.json'), 'utf8')) as {
      readonly mcpServers: { readonly local: { readonly args: readonly [string, ...string[]] } };
    };
    const localServerBundle = join(firstArtifact, 'portable', localServer.mcpServers.local.args[0]);

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
      'validate', '--json', '--root', projectRoot, '--artifact', firstArtifact,
    ]);
    expect(validation).toBe('{"diagnostics":[]}\n');

    const bundlePath = join(firstArtifact, 'portable', 'scripts', 'bundle.mjs');
    await expect(execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      "const module = await import(process.argv[1]); console.log(module.bundleMessage);",
      pathToFileURL(bundlePath).href,
    ], { cwd: projectRoot, env: installedEnvironment() })).resolves.toMatchObject({ stdout: 'bundled fixture\n' });
    await expect(execFile(join(firstArtifact, 'portable', 'scripts', 'shell.sh'), [], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'shell fixture\n' });
    await expect(execFile('python3', [join(firstArtifact, 'portable', 'scripts', 'python.py')], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'python fixture\n' });
    expect((await stat(join(firstArtifact, 'portable', 'scripts', 'shell.sh'))).mode & 0o777).toBe(sourceShellMode);
    expect((await stat(join(firstArtifact, 'portable', 'scripts', 'python.py'))).mode & 0o777).toBe(sourcePythonMode);

    const { stdout: hooks } = await runInstalled(cli, projectRoot, [
      'hooks', 'list', '--json', '--root', projectRoot, '--artifact', firstArtifact, '--target', 'codex',
    ]);
    const hook = (JSON.parse(hooks) as Array<{ id: string }>)[0]!;
    const { stdout: simulation } = await runInstalled(cli, projectRoot, [
      'hooks', 'simulate', '--json', '--root', projectRoot, '--artifact', firstArtifact, '--target', 'codex',
      '--hook', hook.id, '--input', JSON.stringify({
        cwd: projectRoot,
        sessionId: 'packed-consumer',
        source: 'packed-consumer',
        transcriptPath: join(projectRoot, 'transcript.json'),
      }),
    ]);
    expect(JSON.parse(simulation)).toEqual({ additionalContext: 'hook:packed-consumer', outcome: 'continue' });

    const { stdout: listedTools } = await runInstalled(cli, projectRoot, [
      'mcp', 'list', '--json', '--root', projectRoot, '--artifact', firstArtifact, '--target', 'portable', '--server', 'local',
    ]);
    expect(JSON.parse(listedTools)).toMatchObject({
      tools: [{
        _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
        name: 'show-dashboard',
      }],
    });
    const { stdout: invokedTool } = await runInstalled(cli, projectRoot, [
      'mcp', 'invoke', '--json', '--root', projectRoot, '--artifact', firstArtifact, '--target', 'portable', '--server', 'local',
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
