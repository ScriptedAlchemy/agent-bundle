import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { execFile as executeFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import {
  createCodexEvalHarness,
  createEvalHarness,
  runClaudeTrial,
  runCodexEvalTrial,
  type EvalHarness,
  type EvalServiceNativeOptions,
} from '../src/index.ts';
import {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
  TargetRegistry,
  createDefaultRegistry,
  createRuntimeGenerationStore,
  createRuntimeMcpRegistry,
} from '../src/api.ts';
import type {
  DevRuntimeDescriptor,
  DevRuntimeInspectionEnvelope,
  DevRuntimeMcpServerDescriptor,
  DevRuntimeProvider,
  DevRuntimeSession,
  DevRuntimeStartContext,
  RuntimeGenerationCandidate,
  RuntimeGenerationStoreOptions,
  RuntimeMcpRegistryOptions,
  TargetAdapter,
  TargetHookContract,
  TargetMcpRuntimeContract,
} from '../src/api.ts';
import { runCli } from '../src/cli.ts';
import { agentBundleNodeModules, workspaceNodeModules } from './helpers/workspace-paths.ts';

interface PackageManifest {
  bin: {
    'agent-bundle': string;
  };
  engines?: {
    node?: string;
  };
  /** Code entries carry both conditions; `./package.json` is a plain file target. */
  exports: Record<string, string | { import: string; types: string }>;
  version: string;
}

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages/agent-bundle');
let buildPromise: Promise<void> | undefined;

const buildPackage = async (): Promise<void> => {
  // The integration pool runs this file on parallel workers that share the
  // built dist directories, so a root rebuild here would race every reader.
  // `test:integration:run` builds once up front and sets the prebuilt seam.
  if (process.env['AGENT_BUNDLE_PACKAGE_PREBUILT'] === '1') return;
  buildPromise ??= execFile('pnpm', ['build'], {
    cwd: workspaceRoot,
  }).then(() => undefined);
  await buildPromise;
};

const readPackageManifest = async (): Promise<PackageManifest> =>
  JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;

const createBuildProject = async (root: string): Promise<{ readonly output: string; readonly project: string }> => {
  const project = join(root, 'manifest-version-project');
  const output = join(project, 'manifest-version-artifact');
  await mkdir(join(project, 'src', 'skills', 'review'), { recursive: true });
  await Promise.all([
    writeFile(join(project, 'package.json'), '{"type":"module"}\n'),
    writeFile(
      join(project, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'manifest-version-fixture', version: '1.0.0' }, targets: ['portable'] };\n",
    ),
    writeFile(
      join(project, 'src', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: Reviews changes\n---\n# Review\n',
    ),
  ]);
  return { output, project };
};

const producerFrom = async (output: string): Promise<{ readonly name: string; readonly version: string }> => {
  const manifest = JSON.parse(
    await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'),
  ) as { readonly compiler: { readonly producer: { readonly name: string; readonly version: string } } };
  return manifest.compiler.producer;
};

it('keeps package output filenames stable', async () => {
  const config = (await import('../rslib.config.ts')).default;
  expect(config).toMatchObject({ output: { filenameHash: false, target: 'node' } });
  expect(config.output).not.toHaveProperty('autoExternal');
  expect(config.output).not.toHaveProperty('externals');
});

it('exposes native eval descriptors, runners, and injection types from the root import', () => {
  const descriptor: EvalHarness = createEvalHarness('claude');
  const native: EvalServiceNativeOptions = { environment: { PATH: '/usr/bin' } };

  expect(descriptor).toEqual({ kind: 'native-claude', name: 'claude' });
  expect(createCodexEvalHarness().kind).toBe('native-codex');
  expect(typeof runClaudeTrial).toBe('function');
  expect(typeof runCodexEvalTrial).toBe('function');
  expect(native.environment?.PATH).toBe('/usr/bin');
});

it('exposes advanced adapter registry and contract types only from the advanced API', () => {
  const hookContract = {
    commandRoot: '${PLUGIN_ROOT}',
    encodePlaygroundInput: (input) => input,
    encodePlaygroundOutput: (result) => result,
    eventNames: { afterTool: 'AfterTool', beforeTool: 'BeforeTool', sessionStart: 'SessionStart', stop: 'Stop' },
    manifestPath: 'hooks.json',
    matchers: {},
    wrapperPath: () => 'hook.mjs',
    wrapperSource: () => 'export default undefined;\n',
  } satisfies TargetHookContract;
  const mcpRuntime = {
    manifestPath: 'mcp.json',
    readModernServers: () => ({ servers: [], status: 'found' as const }),
    resolveStdioArgument: (value) => value,
    resolveValue: (_field, _roots, value) => ({ diagnostics: [], value }),
  } satisfies TargetMcpRuntimeContract;
  const adapter = {
    capabilities: supportedCapabilities('hooks', 'mcp'),
    hookContract,
    mcpRuntime,
    metadata: {
      adapterRevision: 'test',
      observedVersion: 'test',
      schemas: [],
    },
    name: 'advanced-synthetic',
    plan: () => ({ diagnostics: [], entries: [] }),
  } satisfies TargetAdapter;
  const registry = new TargetRegistry().register(adapter, { default: true });

  expect(registry.defaultTargetNames()).toEqual(['advanced-synthetic']);
  expect(createDefaultRegistry().has('portable')).toBe(true);
});

it('exposes the dev.runtime.provider protocol from the advanced API (#485)', () => {
  // A provider module is written against these names alone: the start
  // context it accepts, the session it returns, the envelope and MCP
  // descriptor it produces, and the store and registry a session drives.
  const descriptor: DevRuntimeDescriptor = { environmentVariables: [], id: 'synthetic', label: 'Synthetic', schemaVersion: 1 };
  const provider = {
    descriptor,
    start: async (context: DevRuntimeStartContext): Promise<DevRuntimeSession> => {
      throw new DevRuntimeUnavailableError(`no runtime for ${context.projectRoot}`);
    },
  } satisfies DevRuntimeProvider;
  const server: DevRuntimeMcpServerDescriptor = {
    definitionDigest: 'd', name: 'fixture', resources: [], serverDigest: 's', target: 'portable', tools: [], transportDigest: 't',
  };
  const envelope: Pick<DevRuntimeInspectionEnvelope, 'trace'> = { trace: [] };
  const candidate: Pick<RuntimeGenerationCandidate, 'id'> = { id: 'gen-1' };
  const storeOptions: Pick<RuntimeGenerationStoreOptions<unknown>, 'storageRoot'> = { storageRoot: '/tmp/never-opened' };
  const registryOptions: Pick<RuntimeMcpRegistryOptions, 'stateStoreId'> = { stateStoreId: 'state' };

  expect(provider.descriptor.id).toBe('synthetic');
  expect(server.name).toBe('fixture');
  expect(envelope.trace).toEqual([]);
  expect(candidate.id).toBe('gen-1');
  expect(storeOptions.storageRoot).toBe('/tmp/never-opened');
  expect(registryOptions.stateStoreId).toBe('state');
  // The two errors a provider throws for the documented Workbench behaviour carry their codes.
  expect(new DevRuntimeUnavailableError().code).toBe('AB8201');
  expect(new DevRuntimeGenerationConflictError('gen-2', 'gen-1')).toMatchObject({
    actualGenerationId: 'gen-1',
    code: 'AB8204',
    expectedGenerationId: 'gen-2',
  });
  // The store and registry ship as effect-free contracts plus constructors;
  // their classes throw YieldableFrameworkErrors and stay behind the boundary.
  expect(typeof createRuntimeGenerationStore).toBe('function');
  expect(typeof createRuntimeMcpRegistry).toBe('function');
});

it('loads every public subpath and reports the package version', async () => {
  await expect(import('../src/api.ts')).resolves.toBeDefined();
  await expect(import('../src/app/index.ts')).resolves.toBeDefined();
  await expect(import('../src/config/index.ts')).resolves.toBeDefined();
  await expect(import('../src/eval/index.ts')).resolves.toBeDefined();
  await expect(runCli(['--version'])).resolves.toBe(0);
});

it('publishes directly executable built entrypoints with declarations', async () => {
  await buildPackage();

  const manifest = await readPackageManifest();
  expect(manifest.engines?.node).toBe('>=22.19.0');

  for (const entrypoint of Object.values(manifest.exports)) {
    if (typeof entrypoint === 'string') {
      await expect(access(join(packageRoot, entrypoint))).resolves.toBeUndefined();
      continue;
    }
    await expect(access(join(packageRoot, entrypoint.import))).resolves.toBeUndefined();
    await expect(access(join(packageRoot, entrypoint.types))).resolves.toBeUndefined();
  }

  const distFiles = await readdir(join(packageRoot, 'dist'));
  expect(distFiles.filter((file) => file.endsWith('.js')).every((file) => !/-[a-f0-9]{8,}\.js$/i.test(file))).toBe(true);

  const rootEntrypoint = await import('agent-bundle');
  await expect(import('agent-bundle/api')).resolves.toBeDefined();
  await expect(import('agent-bundle/app')).resolves.toBeDefined();
  const configEntrypoint = await import('agent-bundle/config');
  await expect(import('agent-bundle/eval')).resolves.toBeDefined();
  const runtimeContractsEntrypoint = await import('agent-bundle/runtime-contracts');
  expect(configEntrypoint.defineConfig).toBe(rootEntrypoint.defineConfig);
  expect(runtimeContractsEntrypoint.maximumDevRuntimeFlightPreviewBytes).toBe(32 * 1024);

  const binPath = join(packageRoot, manifest.bin['agent-bundle']);
  const binSource = await readFile(binPath, 'utf8');
  expect(binSource.startsWith('#!/usr/bin/env node\n')).toBe(true);

  const { stdout } = await execFile(binPath, ['--version']);
  expect(stdout).toBe(`${manifest.version}\n`);
}, 15_000);

/**
 * Declaration files each public export reaches, by breadth-first walk over
 * the relative `import`/`export ... from` specifiers of the emitted `.d.ts`
 * graph (per-file declarations, `dts.bundle: false`).
 */
const reachableDeclarations = async (entry: string): Promise<ReadonlyMap<string, string>> => {
  const specifierPattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/gu;
  const resolveRelative = async (from: string, specifier: string): Promise<string | undefined> => {
    if (!specifier.startsWith('.')) return undefined;
    const base = join(dirname(from), specifier).replace(/\.ts$/u, '');
    for (const candidate of [`${base}.d.ts`, `${base}/index.d.ts`]) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    return undefined;
  };
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = await readFile(file, 'utf8');
    seen.set(file, source);
    for (const match of source.matchAll(specifierPattern)) {
      const next = await resolveRelative(file, match[1]!);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
};

it('keeps every public declaration graph free of effect', async () => {
  // Effect is an implementation detail (docs/effect-conventions.md § Boundary
  // modules): a consumer's `tsc` resolves every declaration the exports
  // reach, so one `import ... from 'effect'` in a reachable `.d.ts` (for
  // example a class extending `src/effect/errors.ts`) makes `effect` a type
  // dependency of the package. Public entry classes therefore stay on plain
  // `Error` / `CodedError`, and this pins it for each export.
  await buildPackage();
  const manifest = await readPackageManifest();
  const effectImport = /from\s+["']effect(?:\/|["'])/u;
  const offenders: string[] = [];
  for (const [name, entrypoint] of Object.entries(manifest.exports)) {
    if (typeof entrypoint === 'string') continue;
    const reachable = await reachableDeclarations(join(packageRoot, entrypoint.types));
    for (const [file, source] of reachable) {
      if (effectImport.test(source)) offenders.push(`${name} -> ${relative(packageRoot, file)}`);
    }
  }
  expect(offenders).toEqual([]);
}, 30_000);

it('writes the package version as the producer of a built CLI manifest', async () => {
  await buildPackage();

  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-built-manifest-'));
  const manifest = await readPackageManifest();
  try {
    const project = await createBuildProject(root);
    const binPath = join(packageRoot, manifest.bin['agent-bundle']);
    await execFile(binPath, ['build', '--root', project.project, '--output', project.output], { cwd: project.project });

    await expect(producerFrom(project.output)).resolves.toEqual({
      name: 'agent-bundle',
      version: manifest.version,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps bundled config extension types in emitted root declarations', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-root-types-'));
  try {
    const emittedPackageRoot = join(consumerRoot, 'node_modules', 'agent-bundle');
    await mkdir(emittedPackageRoot, { recursive: true });
    await symlink(
      join(agentBundleNodeModules, '@modelcontextprotocol'),
      join(consumerRoot, 'node_modules', '@modelcontextprotocol'),
      'dir',
    );
    await symlink(
      join(agentBundleNodeModules, '@agent-bundle'),
      join(consumerRoot, 'node_modules', '@agent-bundle'),
      'dir',
    );
    await symlink(
      join(workspaceNodeModules, '@types'),
      join(consumerRoot, 'node_modules', '@types'),
      'dir',
    );
    // The adapter validator factory types its ajv engine, so the emitted
    // declaration graph resolves ajv exactly as installed consumers do.
    await symlink(
      join(agentBundleNodeModules, 'ajv'),
      join(consumerRoot, 'node_modules', 'ajv'),
      'dir',
    );
    // The route-graph compiler types its project ignore rules, so the
    // declaration graph resolves ignore exactly as installed consumers do
    // (a runtime dependency of the package).
    await symlink(
      join(agentBundleNodeModules, 'ignore'),
      join(consumerRoot, 'node_modules', 'ignore'),
      'dir',
    );
    // The tools escape hatch types the Rsbuild environment-config surface, so
    // the declaration graph resolves the bundler packages exactly as
    // installed consumers do. @rsbuild/core is a runtime dependency; the
    // @rspack/core types it references resolve through it (Rslib guidance:
    // never install @rspack/core directly), so the consumer fixture links
    // the copy @rsbuild/core itself resolves.
    await symlink(
      join(agentBundleNodeModules, '@rsbuild'),
      join(consumerRoot, 'node_modules', '@rsbuild'),
      'dir',
    );
    // realpath first: under pnpm the @rsbuild/core entry is a symlink into
    // the virtual store, and plain-Node resolution walks the literal path
    // (where @rspack/core is not visible) rather than the store.
    const requireFromRsbuildCore = createRequire(
      join(await realpath(join(agentBundleNodeModules, '@rsbuild', 'core')), 'package.json'),
    );
    await mkdir(join(consumerRoot, 'node_modules', '@rspack'));
    await symlink(
      dirname(requireFromRsbuildCore.resolve('@rspack/core/package.json')),
      join(consumerRoot, 'node_modules', '@rspack', 'core'),
      'dir',
    );
    // The bundler-inspection surface types the composed Rslib lib config, so
    // the declaration graph resolves @rslib/core exactly as installed
    // consumers do (also a runtime dependency of the package).
    await symlink(
      join(agentBundleNodeModules, '@rslib'),
      join(consumerRoot, 'node_modules', '@rslib'),
      'dir',
    );
    // The validators' and services' FileSystem programs type their Effect
    // signatures, so the declaration graph resolves effect exactly as
    // installed consumers do (a runtime dependency of the package; nothing
    // Effect-typed is re-exported from a package entry).
    await symlink(
      join(agentBundleNodeModules, 'effect'),
      join(consumerRoot, 'node_modules', 'effect'),
      'dir',
    );
    await writeFile(join(emittedPackageRoot, 'package.json'), JSON.stringify({
      exports: { '.': { types: './dist/index.d.ts' } },
      name: 'agent-bundle',
      type: 'module',
    }));
    await execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--declaration',
      '--emitDeclarationOnly',
      '--ignoreConfig',
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noCheck',
      '--rootDir', join(packageRoot, 'src'),
      '--outDir', join(emittedPackageRoot, 'dist'),
      '--target', 'es2022',
      join(packageRoot, 'src', 'index.ts'),
    ], { cwd: workspaceRoot });
    await writeFile(join(consumerRoot, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(consumerRoot, 'config.mts'), [
      "import type { AgentBundleConfig } from 'agent-bundle';",
      '',
      'const config: AgentBundleConfig = {',
      "  claude: { nativeHooks: './claude-hooks.json' },",
      "  codex: { nativeHooks: './codex-hooks.json' },",
      "  plugin: { name: 'packed-root-types', version: '1.0.0' },",
      "  portable: { compatibility: 'v1' },",
      '};',
      '',
      'const claudeHook: string | undefined = config.claude?.nativeHooks;',
      'const codexHook: string | undefined = config.codex?.nativeHooks;',
      'const portableValue: unknown = config.portable?.compatibility;',
      'void [claudeHook, codexHook, portableValue];',
      '',
    ].join('\n'));

    await expect(execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--module', 'nodenext',
      '--moduleResolution', 'nodenext',
      '--noEmit',
      '--strict',
      '--target', 'es2022',
      '--types', 'node',
      'config.mts',
    ], { cwd: consumerRoot })).resolves.toMatchObject({ stderr: '', stdout: '' });
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 30_000);

