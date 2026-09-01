import { expect, it } from '@rstest/core';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspect } from '../src/api.ts';
import {
  DiagnosticBag,
  DiagnosticError,
  type Diagnostic,
} from '../src/core/diagnostics.ts';
import { digest, sha256Hex, stableJson } from '../src/core/digest.ts';
import { assertInside } from '../src/core/paths.ts';
import {
  createProjectContext,
  isPackageName,
  isSemanticPackageVersion,
  packageVersionMismatchDiagnostic,
  readProjectPackageJson,
} from '../src/core/project-context.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { ProjectService } from '../src/dev/project-service.ts';
import type { McpTransport } from '../src/index.ts';

// Type-level contract: only modern MCP transports are public.
const modernTransport: McpTransport = 'streamable-http';
// @ts-expect-error Legacy HTTP+SSE is not part of the public MCP transport contract.
const legacyTransport: McpTransport = 'sse';
void [modernTransport, legacyTransport];

it('serializes plain-object keys deterministically without changing JSON values', () => {
  const value = {
    z: 1,
    a: { y: 2, b: 3 },
    items: [{ b: 2, a: 1 }, 3],
    ignored: undefined,
    nonFinite: Number.NaN,
  };

  expect(stableJson(value)).toBe(
    '{"a":{"b":3,"y":2},"items":[{"a":1,"b":2},3],"nonFinite":null,"z":1}',
  );
  expect(digest(value)).toBe(
    '0338f75b2518e061751e01ee2c95f868309c301ae1f02619877fba6063fb84de',
  );
});

it('serializes integer-like object keys in lexical order', () => {
  expect(stableJson({ '2': 'two', '10': 'ten' })).toBe(
    '{"10":"ten","2":"two"}',
  );
});

it('matches JSON.stringify for sparse arrays', () => {
  const oneHole = Array(1);
  const middleHole = [1, 2, 3];
  delete middleHole[1];

  expect(stableJson(oneHole)).toBe(JSON.stringify(oneHole));
  expect(stableJson(middleHole)).toBe(JSON.stringify(middleHole));
});

it('matches JSON.stringify for boxed primitives', () => {
  const boxedNumber = Object(1);
  const boxedString = Object('agent-bundle');
  const boxedBoolean = Object(true);

  expect(stableJson(boxedNumber)).toBe(JSON.stringify(boxedNumber));
  expect(stableJson(boxedString)).toBe(JSON.stringify(boxedString));
  expect(stableJson(boxedBoolean)).toBe(JSON.stringify(boxedBoolean));
});

it('returns resolved paths contained by the output root', () => {
  expect(assertInside('/tmp/out', '/tmp/out')).toBe('/tmp/out');
  expect(assertInside('/tmp/out', '/tmp/out/nested/file.txt')).toBe(
    '/tmp/out/nested/file.txt',
  );
  expect(() => assertInside('/tmp/out', '/tmp/outside/file.txt')).toThrow(
    /outside output root/,
  );
});

it('throws stable error summaries containing only error diagnostics', () => {
  const warning: Diagnostic = {
    code: 'AB1002',
    severity: 'warning',
    message: 'Optional metadata is absent',
  };
  const error: Diagnostic = {
    code: 'AB1001',
    severity: 'error',
    message: 'Plugin name is required',
    sourcePath: '/project/agent-bundle.config.ts',
    generatedPath: '/project/dist/plugin.json',
    target: 'codex',
    recovery: 'Set plugin.name in the configuration.',
  };
  const bag = new DiagnosticBag([warning, error]);

  try {
    bag.throwIfErrors();
  } catch (caught) {
    expect(caught).toBeInstanceOf(DiagnosticError);
    const diagnosticError = caught as DiagnosticError;
    expect(diagnosticError.diagnostics).toEqual([error]);
    expect(diagnosticError.message).toBe(
      'Agent Bundle compilation failed with 1 error:\n[AB1001] Plugin name is required',
    );
    return;
  }

  throw new Error('Expected DiagnosticBag.throwIfErrors() to throw.');
});

const identityModel = (configPath: string, version = '1.0.0'): NormalizedPlugin => ({
  extensions: {},
  hooks: [],
  mcpServers: [],
  metadata: {
    id: 'plugin:review',
    name: 'review',
    provenance: { kind: 'config', sourcePath: configPath },
    version,
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:portable',
    name: 'portable',
    provenance: { kind: 'config', sourcePath: configPath },
  }],
});

const writeIdentityProject = async (options: {
  readonly packageJson?: string;
  readonly pluginVersion?: string;
} = {}): Promise<{ readonly configPath: string; readonly root: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-identity-'));
  const configPath = join(root, 'agent-bundle.config.ts');
  await writeFile(
    configPath,
    `export default { plugin: { name: 'review', version: '${options.pluginVersion ?? '1.0.0'}' }, targets: ['portable'] };\n`,
  );
  if (options.packageJson !== undefined) {
    await writeFile(join(root, 'package.json'), options.packageJson);
  }
  return { configPath, root };
};

it('loads valid package.json name and version into ProjectContext', async () => {
  const { configPath, root } = await writeIdentityProject({
    packageJson: JSON.stringify({ name: '@acme/review', version: '2.3.4' }),
  });
  try {
    const configBytes = await readFile(configPath);
    const packageBytes = await readFile(join(root, 'package.json'));
    const context = createProjectContext({
      configPath,
      model: identityModel(configPath),
      root,
      sourceInputs: [{ path: configPath, sha256: sha256Hex(configBytes) }],
    });
    expect(context.packageName).toBe('@acme/review');
    expect(context.packageVersion).toBe('2.3.4');
    expect(context.sourceInputs.map((input) => input.path)).toEqual(['agent-bundle.config.ts', 'package.json']);
    expect(context.sourceInputs.find((input) => input.path === 'package.json')?.sha256).toBe(sha256Hex(packageBytes));
    expect(Object.isFrozen(context)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('changes the source revision when package.json bytes change', async () => {
  const { configPath, root } = await writeIdentityProject({
    packageJson: JSON.stringify({ name: 'review-pkg', version: '1.0.0' }),
  });
  try {
    const configBytes = await readFile(configPath);
    const first = createProjectContext({
      configPath,
      model: identityModel(configPath),
      root,
      sourceInputs: [{ path: configPath, sha256: sha256Hex(configBytes) }],
    });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'review-pkg', version: '1.1.0' }));
    const second = createProjectContext({
      configPath,
      model: identityModel(configPath),
      root,
      sourceInputs: [{ path: configPath, sha256: sha256Hex(configBytes) }],
    });
    expect(second.packageVersion).toBe('1.1.0');
    expect(second.revision).not.toBe(first.revision);
    expect(second.packageVersion).not.toBe(first.packageVersion);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when release identity is missing or invalid', async () => {
  const missing = await writeIdentityProject();
  try {
    const configBytes = await readFile(missing.configPath);
    expect(() => createProjectContext({
      configPath: missing.configPath,
      model: identityModel(missing.configPath),
      requirePackageIdentity: true,
      root: missing.root,
      sourceInputs: [{ path: missing.configPath, sha256: sha256Hex(configBytes) }],
    })).toThrow(/nonempty name and valid semantic version/i);
  } finally {
    await rm(missing.root, { force: true, recursive: true });
  }

  const invalid = await writeIdentityProject({
    packageJson: JSON.stringify({ name: 'review-pkg', version: 'not-a-version' }),
  });
  try {
    const configBytes = await readFile(invalid.configPath);
    expect(() => createProjectContext({
      configPath: invalid.configPath,
      model: identityModel(invalid.configPath),
      requirePackageIdentity: true,
      root: invalid.root,
      sourceInputs: [{ path: invalid.configPath, sha256: sha256Hex(configBytes) }],
    })).toThrow(/nonempty name and valid semantic version/i);
  } finally {
    await rm(invalid.root, { force: true, recursive: true });
  }
});

it('omits package identity for unpackaged scratch projects', async () => {
  const { configPath, root } = await writeIdentityProject();
  try {
    const configBytes = await readFile(configPath);
    const context = createProjectContext({
      configPath,
      model: identityModel(configPath),
      root,
      sourceInputs: [{ path: configPath, sha256: sha256Hex(configBytes) }],
    });
    expect(context.packageName).toBeUndefined();
    expect(context.packageVersion).toBeUndefined();
    expect(Object.keys(context)).toEqual([
      'configDigest',
      'configPath',
      'modelDigest',
      'revision',
      'sourceInputs',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('treats a hash as an invalid package version and keeps plugin.name separate', () => {
  expect(isPackageName('review')).toBe(true);
  expect(isPackageName('')).toBe(false);
  expect(isSemanticPackageVersion('1.2.3')).toBe(true);
  expect(isSemanticPackageVersion('1.2.3-alpha.1+build.5')).toBe(true);
  expect(isSemanticPackageVersion('a'.repeat(64))).toBe(false);
  expect(readProjectPackageJson('/does-not-exist-agent-bundle-identity')).toBeUndefined();
  expect(packageVersionMismatchDiagnostic('1.0.0', '1.0.0', 'agent-bundle.config.ts')).toBeUndefined();
  expect(packageVersionMismatchDiagnostic('1.0.0', '2.0.0', 'agent-bundle.config.ts')).toMatchObject({
    code: 'AB4008',
    severity: 'warning',
  });
});

it('exposes package identity on inspect results and development source status', async () => {
  const { root } = await writeIdentityProject({
    packageJson: JSON.stringify({ name: 'inspect-pkg', version: '3.1.0' }),
    pluginVersion: '3.1.0',
  });
  try {
    const prepared = await new ProjectService({ root, targets: ['portable'] }).prepare('inspect');
    expect(prepared.projectContext?.packageName).toBe('inspect-pkg');
    expect(prepared.projectContext?.packageVersion).toBe('3.1.0');
    expect(prepared.source.packageName).toBe('inspect-pkg');
    expect(prepared.source.packageVersion).toBe('3.1.0');
    expect(prepared.source.revision).toBe(prepared.projectContext?.revision);
    expect(prepared.model?.metadata.name).toBe('review');
    expect(prepared.model?.packageName).toBe('inspect-pkg');
    expect(prepared.model?.packageVersion).toBe('3.1.0');

    const inspection = await inspect({ root, targets: ['portable'] });
    expect(inspection.state).toBe('ready');
    if (inspection.state !== 'ready') throw new Error('Expected a ready inspection.');
    expect(inspection.projectContext.packageName).toBe('inspect-pkg');
    expect(inspection.projectContext.packageVersion).toBe('3.1.0');
    expect(inspection.model.metadata.name).toBe('review');
    expect(inspection.model.packageName).toBe('inspect-pkg');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('warns when plugin.version differs from package.json and does not let plugin.version win', async () => {
  const { root } = await writeIdentityProject({
    packageJson: JSON.stringify({ name: 'mismatch-pkg', version: '9.9.9' }),
    pluginVersion: '1.0.0',
  });
  try {
    const prepared = await new ProjectService({ root, targets: ['portable'] }).prepare('inspect');
    expect(prepared.projectContext?.packageVersion).toBe('9.9.9');
    expect(prepared.model?.metadata.version).toBe('1.0.0');
    expect(prepared.model?.packageVersion).toBe('9.9.9');
    expect(prepared.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'AB4008',
        severity: 'warning',
      }),
    ]));
    expect(prepared.source.state).toBe('ready');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps plugin.name when package.json uses a different package name', async () => {
  const { root } = await writeIdentityProject({
    packageJson: JSON.stringify({ name: 'canonical-package', version: '1.0.0' }),
  });
  try {
    const prepared = await new ProjectService({ root, targets: ['portable'] }).prepare('inspect');
    expect(prepared.model?.metadata.name).toBe('review');
    expect(prepared.model?.packageName).toBe('canonical-package');
    expect(prepared.diagnostics.some((diagnostic) => diagnostic.message.includes('plugin.name'))).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
