import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter, TargetAdapterMetadata } from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifestFileKind, type ArtifactManifestV2 } from '../src/build/manifest.ts';
import { validateArtifact, validateArtifactWithSnapshot } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';
import { ArtifactInspectionService } from '../src/dev/index.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';
import { createTargetMcpRuntime, type TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';

interface FixtureFile {
  readonly contents: string;
  readonly kind: ArtifactManifestFileKind;
  readonly mode?: number;
  readonly path: string;
  readonly sourceInputs?: readonly string[];
}

const fixtureTarget = 'synthetic';
const configPath = 'agent-bundle.config.ts';
const runnerSourcePath = 'src/runner.ts';
const fixtureInputs = Object.freeze([
  Object.freeze({ path: configPath, sha256: 'a'.repeat(64) }),
  Object.freeze({ path: runnerSourcePath, sha256: 'b'.repeat(64) }),
]);

const fixtureMetadata: TargetAdapterMetadata = Object.freeze({
  adapterRevision: 'synthetic-adapter-v1',
  capabilityRevision: 'synthetic-capabilities-v1',
  capabilitySha256: 'c'.repeat(64),
  observedVersion: 'synthetic-observed-v1',
  schemas: Object.freeze([]),
});

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const scriptRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactLayout: { scripts: { allowedSuffixes: ['.mjs'], directory: 'scripts' } },
  capabilities: {},
  metadata: fixtureMetadata,
  name: fixtureTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
} satisfies TargetAdapter);

const runtimeRegistry = (
  mcpRuntime: TargetMcpRuntimeContract = createTargetMcpRuntime({
    manifestPath: 'mcp.json',
    remoteTypes: ['streamable-http'],
    resolveValue: (_field, _roots, value) => Object.freeze({ diagnostics: Object.freeze([]), value }),
  }),
): TargetRegistry => new TargetRegistry().register({
  artifactLayout: {
    hookWrappers: { allowedSuffixes: ['.mjs'], directory: 'hooks' },
    mcpEntries: { allowedSuffixes: ['.mjs'], directory: 'mcp' },
  },
  capabilities: { hooks: true, mcp: true },
  hookContract: {
    commandRoot: '${HOOK_ROOT}',
    encodePlaygroundInput: (input) => input,
    encodePlaygroundOutput: (output) => output,
    eventNames: { afterTool: 'After', beforeTool: 'Before', sessionStart: 'Start', stop: 'Stop' },
    manifestPath: 'hooks/hooks.json',
    matchers: {},
    readNativeCommands: () => Object.freeze({
      commands: Object.freeze([Object.freeze({ command: 'node "${HOOK_ROOT}/hooks/run.mjs"' })]),
      status: 'found' as const,
    }),
    wrapperPath: () => 'hooks/run.mjs',
    wrapperSource: () => 'export {};\n',
  },
  mcpRuntime,
  metadata: fixtureMetadata,
  name: fixtureTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
} satisfies TargetAdapter);

const mutatingRuntimeRegistry = (calls: { reads: number; resolutions: number }): TargetRegistry => runtimeRegistry(Object.freeze({
  manifestPath: 'mcp.json',
  readModernServers: () => {
    calls.reads += 1;
    return calls.reads === 1
      ? Object.freeze({
        servers: Object.freeze([Object.freeze({
          name: 'runner',
          server: Object.freeze({
            args: Object.freeze(['./mcp/runner.mjs']),
            command: 'node',
            kind: 'stdio' as const,
          }),
        })]),
        status: 'found' as const,
      })
      : Object.freeze({
        servers: Object.freeze([Object.freeze({
          name: 'mutated',
          server: Object.freeze({
            args: Object.freeze(['./mcp/not-manifested.mjs']),
            command: 'node',
            kind: 'stdio' as const,
          }),
        })]),
        status: 'found' as const,
      });
  },
  resolveStdioArgument: (value: string) => value,
  resolveValue: (_field, _roots, value) => {
    calls.resolutions += 1;
    return Object.freeze({
      diagnostics: Object.freeze([]),
      value: calls.resolutions === 1 ? value : './mcp/not-manifested.mjs',
    });
  },
} satisfies TargetMcpRuntimeContract));

const statefulResolverRuntimeRegistry = (calls: string[]): TargetRegistry => runtimeRegistry(Object.freeze({
  manifestPath: 'mcp.json',
  readModernServers: () => Object.freeze({
    servers: Object.freeze([Object.freeze({
      name: 'runner',
      server: Object.freeze({
        args: Object.freeze(['./mcp/runner.mjs', './mcp/runner.mjs']),
        command: 'node',
        kind: 'stdio' as const,
      }),
    })]),
    status: 'found' as const,
  }),
  resolveStdioArgument: (value: string) => value,
  resolveValue: (_field, _roots, value) => {
    calls.push(value);
    return Object.freeze({
      diagnostics: Object.freeze([]),
      value: calls.length === 1 ? value : 'probe.second-call',
    });
  },
} satisfies TargetMcpRuntimeContract));

const targetRecord = (registry: TargetRegistry): ArtifactManifestV2['targets'][number] => {
  const metadata = registry.metadata(fixtureTarget);
  return {
    ...metadata,
    name: fixtureTarget,
    schemas: [...metadata.schemas].sort((left, right) => left.name.localeCompare(right.name)),
  };
};

const hookIndex = (hooks: readonly Record<string, unknown>[] = []): FixtureFile => ({
  contents: `${JSON.stringify({ hooks, version: 1 })}\n`,
  kind: 'generated',
  path: 'agent-bundle.hooks.json',
  sourceInputs: [],
});

const manifestFor = (
  registry: TargetRegistry,
  files: readonly FixtureFile[],
  sourceInputs = fixtureInputs,
): ArtifactManifestV2 => {
  const target = targetRecord(registry);
  return {
    agentSkills: agentSkillsSchemaRevision,
    files: files
      .map((file) => ({
        bytes: Buffer.byteLength(file.contents),
        kind: file.kind,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
        path: file.path,
        sha256: sha256(file.contents),
        sourceInputs: [...(file.sourceInputs ?? [configPath])],
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: sourceInputs[0]!.sha256,
      configPath,
      modelDigest: 'd'.repeat(64),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    targets: [target],
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: [{ name: target.name, status: 'passed' }],
    },
    version: 2,
  };
};

const epochFor = (root: string, id: string): ArtifactEpoch => Object.freeze({
  configDigest: fixtureInputs[0]!.sha256,
  createdAt: '2026-08-15T12:00:00.000Z',
  diagnostics: Object.freeze({ errors: 0, infos: 0, warnings: 0 }),
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'd'.repeat(64),
  projectRevision: digest({ inputs: fixtureInputs }),
  targetDigests: Object.freeze({ [fixtureTarget]: sha256(id) }),
});

const publish = async (options: {
  readonly files: readonly FixtureFile[];
  readonly id: string;
  readonly registry: TargetRegistry;
  readonly root: string;
  readonly sourceInputs?: typeof fixtureInputs;
  readonly store: EpochStore;
}): Promise<void> => {
  const epoch = epochFor(options.root, options.id);
  const staging = await options.store.createStagingEpoch({ epoch, targets: [fixtureTarget] });
  const files = options.files.some((file) => file.path === 'agent-bundle.hooks.json')
    ? options.files
    : [hookIndex(), ...options.files];

  try {
    for (const file of files) {
      const path = join(staging.root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
      if (file.mode !== undefined) await chmod(path, file.mode);
    }
    await writeFile(
      join(staging.root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(options.registry, files, options.sourceInputs)).bytes,
    );
    await staging.publish(async (artifactRoot) => {
      const diagnostics = await validateArtifact({
        allowEpochStagingMarker: true,
        artifactRoot,
        registry: options.registry,
      });
      if (diagnostics.length > 0) throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join('\n'));
    });
  } catch (error) {
    await staging.close();
    throw error;
  }
};

const runtimeFiles = (): readonly FixtureFile[] => [
  hookIndex([{
    event: 'beforeTool',
    id: 'hook-1',
    name: 'Check command',
    path: 'synthetic/hooks/run.mjs',
    target: fixtureTarget,
  }]),
  {
    contents: '{"mcpServers":{"runner":{"args":["./mcp/runner.mjs"],"command":"node","env":{"SECRET":"do-not-expose"},"type":"stdio"}}}\n',
    kind: 'generated',
    path: 'synthetic/mcp.json',
  },
  { contents: 'export const runner = true;\n', kind: 'bundle', mode: 0o755, path: 'synthetic/mcp/runner.mjs', sourceInputs: [runnerSourcePath] },
  { contents: '{}\n', kind: 'generated', path: 'synthetic/hooks/hooks.json' },
  { contents: 'export const check = true;\n', kind: 'bundle', mode: 0o755, path: 'synthetic/hooks/run.mjs', sourceInputs: [runnerSourcePath] },
];

const diffFiles = (variant: 'base' | 'candidate'): readonly FixtureFile[] => {
  const candidate = variant === 'candidate';
  return [
    ...(candidate ? [{ contents: 'export const added = true;\n', kind: 'generated' as const, path: 'synthetic/scripts/added.mjs' }] : []),
    { contents: candidate ? 'b' : 'a', kind: 'generated', path: 'synthetic/scripts/digest.mjs' },
    { contents: candidate ? 'longer' : 'short', kind: 'generated', path: 'synthetic/scripts/bytes.mjs' },
    { contents: 'export const mode = true;\n', kind: 'generated', mode: candidate ? 0o744 : 0o755, path: 'synthetic/scripts/mode.mjs' },
    { contents: 'export const kind = true;\n', kind: candidate ? 'copy' : 'generated', path: 'synthetic/scripts/kind.mjs' },
    { contents: 'export const source = true;\n', kind: 'generated', path: 'synthetic/scripts/source.mjs', sourceInputs: candidate ? [runnerSourcePath] : [configPath] },
    { contents: 'export const same = true;\n', kind: 'generated', path: 'synthetic/scripts/unchanged.mjs' },
    ...(candidate ? [] : [{ contents: 'export const removed = true;\n', kind: 'generated' as const, path: 'synthetic/scripts/removed.mjs' }]),
  ];
};

class TrackingEpochStore extends EpochStore {
  acquired = 0;
  closed = 0;

  override async acquireEpochReference(epochId: string) {
    const reference = await super.acquireEpochReference(epochId);
    this.acquired += 1;
    const close = reference.close.bind(reference);
    Object.defineProperty(reference, 'close', {
      configurable: true,
      value: async () => {
        this.closed += 1;
        await close();
      },
    });
    return reference;
  }
}

class ReadFailingEpochStore extends TrackingEpochStore {
  override async acquireEpochReference(epochId: string) {
    const reference = await super.acquireEpochReference(epochId);
    await rm(join(reference.root, 'synthetic', 'mcp', 'runner.mjs'));
    return reference;
  }
}

class ThrowingCloseEpochStore extends TrackingEpochStore {
  override async acquireEpochReference(epochId: string) {
    const reference = await super.acquireEpochReference(epochId);
    const close = reference.close.bind(reference);
    Object.defineProperty(reference, 'close', {
      value: async () => {
        await close();
        throw new Error('synthetic close failure');
      },
    });
    return reference;
  }
}

it('inspects one validated epoch as sorted, source-free artifact facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });

  try {
    await writeFile(join(root, configPath), 'export default {};\n');
    await mkdir(dirname(join(root, runnerSourcePath)), { recursive: true });
    await writeFile(join(root, runnerSourcePath), 'export const source = true;\n', { flush: true });
    await publish({ files: runtimeFiles(), id: 'epoch-runtime', registry, root, store });
    await rm(join(root, configPath));
    await rm(join(root, runnerSourcePath));

    const inspection = await new ArtifactInspectionService(store, registry).inspect('epoch-runtime');

    expect(inspection.epochId).toBe('epoch-runtime');
    expect(inspection.project).toEqual({
      configDigest: fixtureInputs[0]!.sha256,
      configPath,
      modelDigest: 'd'.repeat(64),
      revision: digest({ inputs: fixtureInputs }),
      sourceInputs: fixtureInputs,
    });
    expect(inspection.files.map((file) => file.path)).toEqual([
      'agent-bundle.hooks.json',
      'synthetic/hooks/hooks.json',
      'synthetic/hooks/run.mjs',
      'synthetic/mcp.json',
      'synthetic/mcp/runner.mjs',
    ]);
    expect(inspection.targets).toEqual([
      expect.objectContaining({ name: fixtureTarget, tree: expect.objectContaining({ path: fixtureTarget }) }),
    ]);
    expect(inspection.provenance).toContainEqual({
      outputPath: 'synthetic/mcp/runner.mjs',
      sourceInputs: [{ path: runnerSourcePath, sha256: fixtureInputs[1]!.sha256 }],
    });
    expect(inspection.runtime.executables.map((file) => file.path)).toEqual([
      'synthetic/hooks/run.mjs',
      'synthetic/mcp/runner.mjs',
    ]);
    expect(inspection.runtime.hooks).toEqual([
      expect.objectContaining({ path: 'synthetic/hooks/run.mjs', target: fixtureTarget }),
    ]);
    expect(inspection.runtime.mcpServers).toEqual([{
      entryPaths: ['synthetic/mcp/runner.mjs'],
      kind: 'stdio',
      manifestPath: 'synthetic/mcp.json',
      name: 'runner',
      target: fixtureTarget,
    }]);
    expect(JSON.stringify(inspection)).not.toContain('do-not-expose');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('returns deeply frozen detached inspection records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-immutable-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-immutable', registry, root, store });
    const service = new ArtifactInspectionService(store, registry);
    const inspection = await service.inspect('epoch-immutable');

    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.project)).toBe(true);
    expect(Object.isFrozen(inspection.project.sourceInputs)).toBe(true);
    expect(Object.isFrozen(inspection.project.sourceInputs[0]!)).toBe(true);
    expect(Object.isFrozen(inspection.files)).toBe(true);
    expect(Object.isFrozen(inspection.files[0]!)).toBe(true);
    expect(Object.isFrozen(inspection.runtime.mcpServers[0]!.entryPaths)).toBe(true);
    expect(() => {
      (inspection.files as unknown as { push(value: unknown): void }).push({});
    }).toThrow(TypeError);
    expect(() => {
      (inspection.project.sourceInputs[0] as { path: string }).path = 'mutated.ts';
    }).toThrow(TypeError);

    expect((await service.inspect('epoch-immutable')).project.sourceInputs[0]!.path).toBe(configPath);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses callback facts captured during validation and excludes unmanifested mutated MCP paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-runtime-snapshot-'));
  const publishingRegistry = runtimeRegistry();
  const calls = { reads: 0, resolutions: 0 };
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-runtime-snapshot', registry: publishingRegistry, root, store });
    const inspection = await new ArtifactInspectionService(store, mutatingRuntimeRegistry(calls))
      .inspect('epoch-runtime-snapshot');

    expect(calls.reads).toBe(1);
    expect(calls.resolutions).toBe(1);
    expect(inspection.runtime.mcpServers).toEqual([{
      entryPaths: ['synthetic/mcp/runner.mjs'],
      kind: 'stdio',
      manifestPath: 'synthetic/mcp.json',
      name: 'runner',
      target: fixtureTarget,
    }]);
    expect(JSON.stringify(inspection.runtime)).not.toContain('not-manifested.mjs');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves the supplied runtime resolver call sequence while inspecting validated MCP facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-resolver-sequence-'));
  const publishingRegistry = runtimeRegistry();
  const validatorCalls: string[] = [];
  const inspectionCalls: string[] = [];
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-resolver-sequence', registry: publishingRegistry, root, store });
    await expect(validateArtifact({
      allowEpochStagingMarker: true,
      artifactRoot: join(root, '.agent-bundle', 'epochs', 'epoch-resolver-sequence'),
      registry: statefulResolverRuntimeRegistry(validatorCalls),
    })).resolves.toEqual([]);
    expect(validatorCalls).toEqual(['./mcp/runner.mjs', './mcp/runner.mjs']);

    const inspection = await new ArtifactInspectionService(store, statefulResolverRuntimeRegistry(inspectionCalls))
      .inspect('epoch-resolver-sequence');

    expect(inspectionCalls).toEqual(['./mcp/runner.mjs', './mcp/runner.mjs']);
    expect(inspection.runtime.mcpServers).toEqual([expect.objectContaining({
      entryPaths: ['synthetic/mcp/runner.mjs'],
      name: 'runner',
    })]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('accepts an exact registry with a non-configurable own method', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-registry-identity-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });
  Object.defineProperty(registry, 'has', {
    configurable: false,
    enumerable: true,
    value: registry.has.bind(registry),
    writable: false,
  });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-registry-identity', registry, root, store });
    await expect(new ArtifactInspectionService(store, registry).inspect('epoch-registry-identity')).resolves.toMatchObject({
      epochId: 'epoch-registry-identity',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains immutable inspection evidence when manifest and hook bytes are replaced after validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-manifest-snapshot-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });
  const epochId = 'epoch-manifest-snapshot';

  try {
    await publish({ files: runtimeFiles(), id: epochId, registry, root, store });
    const artifactRoot = join(root, '.agent-bundle', 'epochs', epochId);
    const result = await validateArtifactWithSnapshot({
      allowEpochStagingMarker: true,
      artifactRoot,
      registry,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.snapshot).toBeDefined();

    const replacementFiles = [
      hookIndex([{
        event: 'beforeTool',
        id: 'replacement-hook',
        name: 'Replacement hook',
        path: 'synthetic/hooks/replacement.mjs',
        target: fixtureTarget,
      }]),
      ...runtimeFiles().filter((file) => file.path !== 'agent-bundle.hooks.json'),
      { contents: 'export const replacement = true;\n', kind: 'bundle' as const, mode: 0o755, path: 'synthetic/hooks/replacement.mjs' },
    ];
    await writeFile(join(artifactRoot, 'agent-bundle.hooks.json'), replacementFiles[0]!.contents);
    await writeFile(join(artifactRoot, 'synthetic', 'hooks', 'replacement.mjs'), replacementFiles.at(-1)!.contents);
    await writeFile(
      join(artifactRoot, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(registry, replacementFiles)).bytes,
    );

    expect(result.snapshot).toMatchObject({
      manifest: { files: expect.not.arrayContaining([expect.objectContaining({ path: 'synthetic/hooks/replacement.mjs' })]) },
      runtime: { hooks: [expect.objectContaining({ id: 'hook-1' })] },
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.manifest.files)).toBe(true);
    expect(Object.isFrozen(result.snapshot!.runtime.hooks)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed without an inspection when an acquired artifact file cannot be read and releases its reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-read-failure-'));
  const registry = runtimeRegistry();
  const store = new ReadFailingEpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-read-failure', registry, root, store });
    await expect(new ArtifactInspectionService(store, registry).inspect('epoch-read-failure')).rejects.toMatchObject({
      code: 'ARTIFACT_INSPECTION_INVALID',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'AB6004' })]),
    });
    expect(store).toMatchObject({ acquired: 1, closed: 1 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('surfaces release failure after inspecting and closes every acquired reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-close-failure-'));
  const registry = runtimeRegistry();
  const store = new ThrowingCloseEpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-close-failure', registry, root, store });
    await expect(new ArtifactInspectionService(store, registry).inspect('epoch-close-failure')).rejects.toMatchObject({
      code: 'ARTIFACT_INSPECTION_RELEASE_FAILED',
      diagnostics: [expect.objectContaining({ code: 'AB6201' })],
    });
    expect(store).toMatchObject({ acquired: 1, closed: 1 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('releases references after successful and invalid artifact inspections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-references-'));
  const registry = runtimeRegistry();
  const store = new TrackingEpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-reference', registry, root, store });
    const service = new ArtifactInspectionService(store, registry);
    await service.inspect('epoch-reference');
    expect(store).toMatchObject({ acquired: 1, closed: 1 });

    await writeFile(join(root, '.agent-bundle', 'epochs', 'epoch-reference', 'agent-bundle.manifest.json'), '{\n');
    await expect(service.inspect('epoch-reference')).rejects.toMatchObject({
      code: 'ARTIFACT_INSPECTION_INVALID',
      diagnostics: [expect.objectContaining({ code: 'AB6001' })],
    });
    expect(store).toMatchObject({ acquired: 2, closed: 2 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('uses the exact supplied registry and fails closed with the default registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-registry-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-registry', registry, root, store });
    await expect(new ArtifactInspectionService(store).inspect('epoch-registry')).rejects.toMatchObject({
      code: 'ARTIFACT_INSPECTION_INVALID',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'AB6009', target: fixtureTarget })]),
    });
    await expect(new ArtifactInspectionService(store, registry).inspect('epoch-registry')).resolves.toMatchObject({
      epochId: 'epoch-registry',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('diffs exact epochs by artifact facts with stable lexical records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-diff-'));
  const registry = scriptRegistry();
  const store = new TrackingEpochStore({ projectRoot: root });

  try {
    await publish({ files: [...diffFiles('base')].reverse(), id: 'epoch-base', registry, root, store });
    await publish({ files: diffFiles('candidate'), id: 'epoch-candidate', registry, root, store });
    const service = new ArtifactInspectionService(store, registry);
    const diff = await service.diff('epoch-base', 'epoch-candidate');

    expect(diff.added.map((record) => record.path)).toEqual(['synthetic/scripts/added.mjs']);
    expect(diff.removed.map((record) => record.path)).toEqual(['synthetic/scripts/removed.mjs']);
    expect(diff.changed.map((record) => record.path)).toEqual([
      'synthetic/scripts/bytes.mjs',
      'synthetic/scripts/digest.mjs',
      'synthetic/scripts/kind.mjs',
      'synthetic/scripts/mode.mjs',
      'synthetic/scripts/source.mjs',
    ]);
    expect(diff.unchanged.map((record) => record.path)).toEqual([
      'agent-bundle.hooks.json',
      'synthetic/scripts/unchanged.mjs',
    ]);
    expect(diff.changed.find((record) => record.path.endsWith('/source.mjs'))).toMatchObject({
      after: { sourceInputs: [{ path: runnerSourcePath }] },
      before: { sourceInputs: [{ path: configPath }] },
    });
    expect(diff.changed.find((record) => record.path.endsWith('/mode.mjs'))).toMatchObject({
      after: { mode: 0o744 },
      before: { mode: 0o755 },
    });
    expect(Object.isFrozen(diff.changed)).toBe(true);
    expect(Object.isFrozen(diff.changed[0]!)).toBe(true);
    expect(Object.isFrozen(diff.changed[0]!.before)).toBe(true);

    const same = await service.diff('epoch-base', 'epoch-base');
    expect(same).toMatchObject({ added: [], changed: [], removed: [] });
    expect(same.unchanged.map((record) => record.path)).toEqual([
      'agent-bundle.hooks.json',
      'synthetic/scripts/bytes.mjs',
      'synthetic/scripts/digest.mjs',
      'synthetic/scripts/kind.mjs',
      'synthetic/scripts/mode.mjs',
      'synthetic/scripts/removed.mjs',
      'synthetic/scripts/source.mjs',
      'synthetic/scripts/unchanged.mjs',
    ]);
    expect(store).toMatchObject({ acquired: 4, closed: 4 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('releases an acquired base reference when candidate acquisition fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-partial-reference-'));
  const registry = scriptRegistry();
  const store = new TrackingEpochStore({ projectRoot: root });

  try {
    await publish({ files: diffFiles('base'), id: 'epoch-base', registry, root, store });
    await expect(new ArtifactInspectionService(store, registry).diff('epoch-base', 'epoch-missing'))
      .rejects.toMatchObject({ code: 'EPOCH_NOT_FOUND' });
    expect(store).toMatchObject({ acquired: 1, closed: 1 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('surfaces release failure when diff closes a partially acquired reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-partial-close-failure-'));
  const registry = scriptRegistry();
  const store = new ThrowingCloseEpochStore({ projectRoot: root });

  try {
    await publish({ files: diffFiles('base'), id: 'epoch-base', registry, root, store });
    await expect(new ArtifactInspectionService(store, registry).diff('epoch-base', 'epoch-missing'))
      .rejects.toMatchObject({
        code: 'ARTIFACT_INSPECTION_RELEASE_FAILED',
        diagnostics: [expect.objectContaining({ code: 'AB6201' })],
      });
    expect(store).toMatchObject({ acquired: 1, closed: 1 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('compares canonical file source-input paths rather than project input hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-provenance-diff-'));
  const registry = scriptRegistry();
  const store = new EpochStore({ projectRoot: root });
  const files = [{
    contents: 'export const source = true;\n',
    kind: 'generated' as const,
    path: 'synthetic/scripts/source.mjs',
    sourceInputs: [runnerSourcePath],
  }];
  const changedProjectInputs = Object.freeze([
    fixtureInputs[0]!,
    Object.freeze({ path: runnerSourcePath, sha256: 'e'.repeat(64) }),
  ]);

  try {
    await publish({ files, id: 'epoch-provenance-base', registry, root, store });
    await publish({
      files,
      id: 'epoch-provenance-candidate',
      registry,
      root,
      sourceInputs: changedProjectInputs,
      store,
    });
    const diff = await new ArtifactInspectionService(store, registry)
      .diff('epoch-provenance-base', 'epoch-provenance-candidate');

    expect(diff.changed).toEqual([]);
    expect(diff.unchanged.map((record) => record.path)).toEqual([
      'agent-bundle.hooks.json',
      'synthetic/scripts/source.mjs',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
