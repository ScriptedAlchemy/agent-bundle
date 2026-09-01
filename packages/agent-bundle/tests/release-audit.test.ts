import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { isolatedCommandEnvironment } from '../../../rstest.worker-isolation.ts';
import { npmInstallArguments, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();
const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');

const releaseEnvironment = (): NodeJS.ProcessEnv => isolatedCommandEnvironment({ ...process.env, NODE_ENV: 'production' });

it('audits an externally installed production tarball and generates its CycloneDX SBOM', async () => {
  const { stdout } = await execFile(process.execPath, ['scripts/audit-packed-release.mjs'], {
    cwd: workspaceRoot,
    env: releaseEnvironment(),
  });
  const sbom = JSON.parse(stdout) as {
    readonly bomFormat?: string;
    readonly components?: readonly {
      readonly 'bom-ref'?: string;
      readonly name?: string;
      readonly scope?: string;
      readonly version?: string;
      readonly properties?: readonly { readonly name?: string; readonly value?: string }[];
    }[];
    readonly dependencies?: readonly { readonly dependsOn?: readonly string[]; readonly ref?: string }[];
    readonly metadata?: {
      readonly component?: { readonly 'bom-ref'?: string; readonly name?: string; readonly version?: string };
    };
    readonly specVersion?: string;
  };
  const sourceManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    readonly name: string;
    readonly version: string;
  };
  const components = sbom.components ?? [];
  const root = sbom.metadata?.component;
  const product = components.find((component) => (
    component.name === sourceManifest.name && component.version === sourceManifest.version
  ));
  const componentReferences = new Set(components.flatMap((component) => (
    component['bom-ref'] === undefined ? [] : [component['bom-ref']]
  )));
  const rootReference = root?.['bom-ref'];
  expect(rootReference).toBeDefined();
  const dependencyReferences = new Set<string>([
    ...(rootReference === undefined ? [] : [rootReference]),
    ...componentReferences,
  ]);
  const declaredDependencyReferences = new Set((sbom.dependencies ?? []).flatMap((dependency) => (
    dependency.ref === undefined ? [] : [dependency.ref]
  )));
  const rootDependencies = (sbom.dependencies ?? []).find((dependency) => dependency.ref === root?.['bom-ref']);
  const productDependencies = (sbom.dependencies ?? []).find((dependency) => dependency.ref === product?.['bom-ref']);

  expect(sbom.bomFormat).toBe('CycloneDX');
  expect(sbom.specVersion).toMatch(/^1\./u);
  expect(root).toMatchObject({ version: '1.0.0' });
  expect(root?.name).not.toBe(sourceManifest.name);
  expect(product).toBeDefined();
  expect(rootDependencies?.dependsOn).toContain(product?.['bom-ref']);
  expect(productDependencies?.dependsOn?.length).toBeGreaterThan(0);
  expect([...dependencyReferences].every((reference) => declaredDependencyReferences.has(reference))).toBe(true);
  expect((sbom.dependencies ?? []).every((dependency) => (
    dependency.ref !== undefined
      && dependencyReferences.has(dependency.ref)
      && (dependency.dependsOn ?? []).every((reference) => dependencyReferences.has(reference))
  ))).toBe(true);
  expect(components.some((component) => component.scope === 'development')).toBe(false);
  expect(components.every((component) => {
    const path = component.properties?.find((property) => property.name === 'cdx:npm:package:path')?.value;
    // npm >= 11 omits the property; the audit script then verifies components against the installed tree instead.
    if (path === undefined) return true;
    return path.startsWith('node_modules/')
      && !path.includes('node_modules/.pnpm/')
      && !path.includes('/packages/');
  })).toBe(true);
}, 120_000);

it('ships repository and support metadata that matches the verified origin', async () => {
  const tarballRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-package-metadata-'));

  try {
    const { tarball } = await sharedPackedTarball('agent-bundle');
    await execFile('tar', ['--extract', '--file', tarball, '--directory', tarballRoot]);
    const manifest = JSON.parse(await readFile(join(tarballRoot, 'package', 'package.json'), 'utf8')) as {
      readonly bugs?: { readonly url?: string };
      readonly description?: string;
      readonly homepage?: string;
      readonly keywords?: readonly string[];
      readonly repository?: { readonly type?: string; readonly url?: string };
    };

    expect(manifest).toMatchObject({
      bugs: { url: 'https://github.com/ScriptedAlchemy/agent-bundle/issues' },
      homepage: 'https://github.com/ScriptedAlchemy/agent-bundle#readme',
      repository: { type: 'git', url: 'git+https://github.com/ScriptedAlchemy/agent-bundle.git' },
    });
    expect(manifest.keywords).toEqual(expect.arrayContaining(['agent', 'claude-code', 'codex', 'mcp']));
  } finally {
    await rm(tarballRoot, { force: true, recursive: true });
  }
});

it('packs generated Workbench legal companion files', async () => {
  const { packOutput } = await sharedPackedTarball('agent-bundle');
  const productManifest = await readFile(join(packageRoot, 'package.json'), 'utf8');

  expect(packOutput.files.map((file) => file.path)).toContainEqual(
    expect.stringMatching(/^dist\/workbench\/.*\.LICENSE\.txt$/u),
  );
  expect(packOutput.files.some(({ path }) => path.startsWith('examples/'))).toBe(false);
  expect(productManifest).not.toContain('workspace:');
}, 120_000);

it('installs public entrypoints and an externally resolved CLI for production consumers', async () => {
  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-release-consumer-'));

  try {
    const { tarball } = await sharedPackedTarball('agent-bundle');
    await writeFile(join(consumerRoot, 'package.json'), '{"private":true,"type":"module"}\n');
    await execFile('npm', [
      'install', '--omit=dev', ...npmInstallArguments, tarball,
    ], { cwd: consumerRoot, env: releaseEnvironment() });

    const installedPackageRoot = await realpath(join(consumerRoot, 'node_modules', 'agent-bundle'));
    expect(installedPackageRoot.startsWith(workspaceRoot)).toBe(false);
    const manifest = JSON.parse(await readFile(join(installedPackageRoot, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.dependencies?.commander).toBe('15.0.0');
    expect(manifest.dependencies?.['agent-bundle']).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
    await Promise.all([
      writeFile(join(consumerRoot, 'canonical-contract.mts'), [
        "import { type CompareEvalsOptions, type RunEvalsOptions } from 'agent-bundle/api';",
        "import { defineConfig, type AgentBundleConfig } from 'agent-bundle/config';",
        "import { defineEvalSuite, expectExitCode, normalizeEvalConfig, type EvalConfigInput, type EvalSuiteInput } from 'agent-bundle/eval';",
        '',
        "const config = defineConfig({ plugin: { name: 'canonical-consumer', version: '1.0.0' }, targets: ['portable'] } satisfies AgentBundleConfig);",
        "const evalConfig = { include: ['evals/**/*.eval.ts'], runsDir: '.agent-bundle/runs' } satisfies EvalConfigInput;",
        "const evalSuite = { cases: [{ assertions: [expectExitCode(0)], fixture: '.', hosts: { claude: { model: 'claude-sonnet-4-5' } }, id: 'canonical-case', invocation: { mode: 'none' }, prompt: 'Verify the canonical contract.' }], name: 'canonical-consumer' } satisfies EvalSuiteInput;",
        "const runOptions = { harness: 'claude', root: '.', trials: 1 } satisfies RunEvalsOptions;",
        "const comparisonOptions = { baseRunId: 'baseline', candidateRunId: 'candidate', root: '.' } satisfies CompareEvalsOptions;",
        '',
        'void [config, normalizeEvalConfig(evalConfig), defineEvalSuite(evalSuite), runOptions, comparisonOptions];',
        '',
      ].join('\n')),
      writeFile(join(consumerRoot, 'canonical-contract.mjs'), [
        "import { compareEvals, runEvals } from 'agent-bundle/api';",
        "import { defineConfig } from 'agent-bundle/config';",
        "import { defineEvalSuite, expectExitCode, normalizeEvalConfig } from 'agent-bundle/eval';",
        '',
        "const config = defineConfig({ plugin: { name: 'canonical-consumer', version: '1.0.0' }, targets: ['portable'] });",
        "const evalConfig = normalizeEvalConfig({ include: ['evals/**/*.eval.ts'], runsDir: '.agent-bundle/runs' });",
        "const evalSuite = defineEvalSuite({ cases: [{ assertions: [expectExitCode(0)], fixture: '.', hosts: { claude: { model: 'claude-sonnet-4-5' } }, id: 'canonical-case', invocation: { mode: 'none' }, prompt: 'Verify the canonical contract.' }], name: 'canonical-consumer' });",
        'const canonicalValues = { config, evalConfig, evalSuite };',
        'const serialized = JSON.stringify(canonicalValues);',
        "if (serialized.includes('\"schemaVersion\"') || serialized.includes('\"version\":1')) throw new Error('Canonical public values must not emit schemaVersion or version:1.');",
        "if (typeof compareEvals !== 'function' || typeof runEvals !== 'function') throw new Error('Expected public Eval API entrypoints.');",
        "process.stdout.write('canonical public contract\\n');",
        '',
      ].join('\n')),
    ]);
    await expect(execFile(join(workspaceRoot, 'node_modules', '.bin', 'tsc'), [
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--noEmit',
      '--skipLibCheck',
      '--strict',
      '--target', 'ES2024',
      'canonical-contract.mts',
    ], { cwd: consumerRoot, env: releaseEnvironment() })).resolves.toMatchObject({ stderr: '', stdout: '' });
    await expect(execFile(process.execPath, ['canonical-contract.mjs'], {
      cwd: consumerRoot,
      env: releaseEnvironment(),
    })).resolves.toMatchObject({ stderr: '', stdout: 'canonical public contract\n' });
    await expect(execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      "await Promise.all(['agent-bundle', 'agent-bundle/api', 'agent-bundle/config', 'agent-bundle/eval'].map((specifier) => import(specifier)));",
    ], { cwd: consumerRoot, env: releaseEnvironment() })).resolves.toMatchObject({ stderr: '', stdout: '' });
    const cli = join(consumerRoot, 'node_modules', '.bin', 'agent-bundle');
    await expect(execFile(cli, ['--help'], { cwd: consumerRoot, env: releaseEnvironment() })).resolves.toMatchObject({
      stderr: '',
      stdout: expect.stringContaining('Usage: agent-bundle'),
    });
    await rm(join(consumerRoot, 'node_modules', 'commander'), { force: true, recursive: true });
    await expect(execFile(cli, ['--help'], { cwd: consumerRoot, env: releaseEnvironment() })).rejects.toThrow();
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 120_000);
