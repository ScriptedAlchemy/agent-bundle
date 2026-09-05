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
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';
import { init, parse } from 'es-module-lexer';

import { sha256Hex } from '../src/core/digest.ts';
import { cachedNpmInstallArguments, installedEnvironment, linkWorkspaceTypes, packOutputFromJson } from './support/shared-pack.ts';

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

interface EmittedModule {
  /** Path relative to the walked root. */
  readonly path: string;
  /** Literal specifiers of the module's live imports; `import.meta` is not an import. */
  readonly specifiers: readonly string[];
}

interface EmittedModuleReport {
  readonly modules: readonly EmittedModule[];
  /** One entry per import that breaks the constraint, naming the importing module and the specifier. */
  readonly violations: readonly string[];
}

/**
 * Walks every `.js`/`.mjs` module under `root` — a plugin artifact or a
 * package build's `dist/` — and checks the self-containment constraint on
 * the emitted JavaScript itself. A plugin build bundles every dependency of
 * each generated executable, so Node builtins are the only external modules
 * an emitted module may import; every other specifier must be a relative
 * path (`./` or `../`) to a file inside the same output tree. The author's
 * own `tools` hatch is the only way a non-builtin may remain external, and
 * this fixture declares none. `AB6005` (src/build/validate-artifact-modules.ts)
 * enforces the same rule inside every build; this walk proves it on the
 * outputs a real consumer builds from the installed tarball.
 */
const emittedModuleReport = async (root: string): Promise<EmittedModuleReport> => {
  await init;
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.m?js$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const violations: string[] = [];
  const modules = await Promise.all(files.map(async (file): Promise<EmittedModule> => {
    const path = relative(root, file);
    const [imports] = parse(await readFile(file, 'utf8'), path);
    const specifiers: string[] = [];
    // `import.meta` is reported as a pseudo-import (`d === -2`) without a specifier.
    for (const record of imports.filter((candidate) => candidate.d !== -2)) {
      if (record.n === undefined) {
        violations.push(`${path} has a non-literal dynamic import`);
        continue;
      }
      specifiers.push(record.n);
      if (isBuiltin(record.n)) continue;
      if (!record.n.startsWith('./') && !record.n.startsWith('../')) {
        violations.push(`${path} imports ${JSON.stringify(record.n)}`);
        continue;
      }
      const target = resolve(dirname(file), record.n);
      const location = relative(root, target);
      const inside = location !== '' && location !== '..' && !location.startsWith('../');
      const exists = inside && await stat(target).then((metadata) => metadata.isFile(), () => false);
      if (!exists) violations.push(`${path} imports ${JSON.stringify(record.n)}, which is not a file inside the output tree`);
    }
    return { path, specifiers };
  }));
  return { modules, violations: violations.sort() };
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
    const tarball = join(consumerRoot, packOutputFromJson(packed, 'agent-bundle').filename);
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
      readonly compiler: { readonly provenance: readonly { readonly path: string; readonly sourceInputs: readonly string[] }[] };
      readonly files: readonly (ManifestDigest & { readonly kind: 'bundle' | 'copy' | 'generated' | 'prebuilt' })[];
    };
    const files = (await artifactDigest(artifact)).filter((entry) => entry.path !== 'agent-bundle.manifest.json');
    const manifestFiles = await Promise.all(files.map(async (file): Promise<ManifestDigest> => {
      if (!/(?:^|\/)scripts\/[^/]+\.(?:sh|bash|py)$/iu.test(file.path)) return file;
      const mode = (await stat(join(artifact, file.path))).mode & 0o777;
      return (mode & 0o111) === 0 ? file : { ...file, mode };
    }));
    expect(
      manifest.files
        .map(({ kind: _kind, ...file }) => file)
        .sort((left, right) => left.path.localeCompare(right.path)),
    ).toEqual(manifestFiles);
    for (const file of manifest.files) {
      expect(['bundle', 'copy', 'generated', 'prebuilt']).toContain(file.kind);
    }
    expect(manifest.compiler.provenance.map((entry) => entry.path)).toEqual(manifest.files.map((file) => file.path));
    for (const entry of manifest.compiler.provenance) {
      expect(entry.sourceInputs).toEqual([...entry.sourceInputs].sort((left, right) => left.localeCompare(right)));
    }
    for (const file of files.filter((entry) => entry.path.endsWith('.mjs'))) {
      await expect(readFile(join(artifact, file.path), 'utf8')).resolves.not.toMatch(
        agentBundleImport,
      );
    }
    const localServer = JSON.parse(await readFile(join(artifact, 'mcp.json'), 'utf8')) as {
      readonly mcpServers: { readonly local: { readonly args: readonly [string, ...string[]] } };
    };
    const localServerBundle = join(artifact, localServer.mcpServers.local.args[0]);

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
    const validationDocument = JSON.parse(validation) as {
      readonly diagnostics: readonly { readonly code: string; readonly severity: string }[];
      readonly hostValidation: readonly {
        readonly diagnostics: readonly { readonly code: string; readonly severity: string }[];
        readonly host: string;
        readonly status: string;
        readonly target: string;
      }[];
    };
    expect(validationDocument.hostValidation.map((report) => report.host).sort()).toEqual(['claude', 'codex', 'portable']);
    for (const host of ['claude', 'codex', 'portable'] as const) {
      const report = validationDocument.hostValidation.find((candidate) => candidate.host === host)!;
      expect(report.target).toBe(host);
      expect(report.diagnostics.every((diagnostic) => diagnostic.severity === 'info')).toBe(true);
      if (host === 'claude' && report.status === 'passed') {
        expect(report.diagnostics).toEqual([]);
      }
      if (host === 'portable') {
        // The pinned Agent Plugins byte lane spawns no client; it passes from the installed tarball alone.
        expect(report.status).toBe('passed');
        expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['AB6038']);
      }
      if (report.status === 'unavailable') expect(report.diagnostics.length).toBeGreaterThan(0);
    }
    const hostDiagnosticCodes = validationDocument.hostValidation
      .flatMap((report) => report.diagnostics.map((diagnostic) => diagnostic.code))
      .sort();
    expect(validationDocument.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(hostDiagnosticCodes);

    const bundlePath = join(artifact, 'scripts', 'bundle.mjs');
    await expect(execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      "const module = await import(process.argv[1]); console.log(module.bundleMessage);",
      pathToFileURL(bundlePath).href,
    ], { cwd: projectRoot, env: installedEnvironment() })).resolves.toMatchObject({ stdout: 'bundled fixture\n' });
    await expect(execFile(join(artifact, 'scripts', 'shell.sh'), [], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'shell fixture\n' });
    await expect(execFile('python3', [join(artifact, 'scripts', 'python.py')], {
      cwd: projectRoot,
      env: installedEnvironment(),
    })).resolves.toMatchObject({ stdout: 'python fixture\n' });
    expect((await stat(join(artifact, 'scripts', 'shell.sh'))).mode & 0o777).toBe(sourceShellMode);
    expect((await stat(join(artifact, 'scripts', 'python.py'))).mode & 0o777).toBe(sourcePythonMode);

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
        "  targets: ['claude', 'codex', 'portable'],",
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
    await linkWorkspaceTypes(frameworkRoot, { typescript: true });
    const frameworkCli = join(frameworkRoot, 'node_modules', '.bin', 'agent-bundle');
    const frameworkArtifact = join(frameworkRoot, 'artifact');
    await runInstalled(frameworkCli, frameworkRoot, ['build', '--root', frameworkRoot, '--output', frameworkArtifact]);

    // Self-containment on the outputs a consumer builds from the installed
    // tarball: the composite root and the package build's dist/ import
    // nothing but Node builtins. A violation names the importer and the
    // specifier that survived bundling. The MCP entry is compiled once for
    // the three selected hosts (#555), not once per host.
    const [artifactModules, packageModules] = await Promise.all([
      emittedModuleReport(frameworkArtifact),
      emittedModuleReport(join(frameworkRoot, 'dist')),
    ]);
    expect(artifactModules.violations).toEqual([]);
    expect(packageModules.violations).toEqual([]);
    expect(artifactModules.modules.filter((module) => /^mcp\/[^/]+\.mjs$/u.test(module.path))).toHaveLength(1);
    expect(packageModules.modules.map((module) => module.path)).toEqual(expect.arrayContaining([
      'bin/framework-build-fixture-install.js',
      'bin/framework-build-fixture.js',
      'index.js',
    ]));

    const packedBin = join(frameworkRoot, 'dist', 'bin', 'framework-build-fixture.js');
    const packedInstallerBin = join(frameworkRoot, 'dist', 'bin', 'framework-build-fixture-install.js');
    expect((await stat(packedBin)).mode & 0o111).not.toBe(0);
    expect((await stat(packedInstallerBin)).mode & 0o111).not.toBe(0);
    expect((await readFile(packedBin, 'utf8')).startsWith('#!/usr/bin/env node\n')).toBe(true);
    await expect(execFile(packedBin, ['alpha'], { cwd: frameworkRoot, env: installedEnvironment() }))
      .resolves.toMatchObject({ stdout: 'packed bin ran:alpha\n' });
    const packedLib = await import(pathToFileURL(join(frameworkRoot, 'dist', 'index.js')).href) as {
      readonly packedAnswer: { readonly value: number };
    };
    expect(packedLib.packedAnswer.value).toBe(42);
    await expect(readFile(join(frameworkRoot, 'dist', 'index.d.ts'), 'utf8')).resolves.toContain('PackedAnswer');

    const greeterManifest = JSON.parse(await readFile(join(frameworkArtifact, 'mcp.json'), 'utf8')) as {
      readonly mcpServers: { readonly greeter: { readonly args: readonly [string, ...string[]] } };
    };
    const greeterEntry = join(frameworkArtifact, greeterManifest.mcpServers.greeter.args[0]);
    const greeterBundle = await readFile(greeterEntry, 'utf8');
    expect(greeterBundle).not.toMatch(agentBundleImport);
    expect(greeterBundle).toContain('stdio heartbeat');
    // `@modelcontextprotocol/server` is inlined: its tool registry is in the
    // bundle and no live import names it. The inlined SDK's own doc comments
    // still spell `from '@modelcontextprotocol/server'`, so the lexed
    // specifiers are the evidence, not a text search.
    expect(greeterBundle).toContain('registerTool');
    const greeterModule = artifactModules.modules.find((module) => module.path === relative(frameworkArtifact, greeterEntry));
    expect(greeterModule).toBeDefined();
    expect(greeterModule?.specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([]);
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
