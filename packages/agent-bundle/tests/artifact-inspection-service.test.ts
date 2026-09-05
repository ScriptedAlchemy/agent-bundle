import { supportedCapabilities } from './support/adapter-capabilities.ts';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter, TargetAdapterMetadata } from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifestFileKind, type ArtifactManifest } from '../src/build/manifest.ts';
import { validateArtifact, validateArtifactWithSnapshot } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';
import { ArtifactInspectionService } from '../src/dev/index.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';
import { createTargetMcpRuntime, type TargetMcpRuntimeContract } from '../src/services/mcp-runtime.ts';
import { sha256Hex } from '../src/core/digest.ts';

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
  observedVersion: 'synthetic-observed-v1',
  schemas: Object.freeze([]),
});

const scriptRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactLayout: { scripts: { allowedSuffixes: ['.mjs'], directory: 'scripts' } },
  capabilities: {},
  metadata: fixtureMetadata,
  name: fixtureTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
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
    scripts: { allowedSuffixes: ['.mjs'], directory: 'scripts' },
  },
  capabilities: supportedCapabilities('hooks', 'mcp'),
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

const projectionRecord = (
  registry: TargetRegistry,
  files: readonly FixtureFile[],
  omitMcpDocument = false,
): ArtifactManifest['projections'][number] => {
  const metadata = registry.metadata(fixtureTarget);
  return {
    ...metadata,
    documents: {
      ...(files.some((file) => file.path === 'hooks/hooks.json') ? { hooks: 'hooks/hooks.json' } : {}),
      ...(!omitMcpDocument && files.some((file) => file.path === 'mcp.json') ? { mcp: 'mcp.json' } : {}),
    },
    host: fixtureTarget,
    schemas: [...metadata.schemas].sort((left, right) => left.name.localeCompare(right.name)),
  };
};

const manifestFor = (
  registry: TargetRegistry,
  files: readonly FixtureFile[],
  sourceInputs = fixtureInputs,
  omitMcpDocument = false,
): ArtifactManifest => {
  const projection = projectionRecord(registry, files, omitMcpDocument);
  const hookRows = [
    ...(files.some((file) => file.path === 'hooks/run.mjs')
      ? [{
        event: 'beforeTool',
        host: fixtureTarget,
        id: 'hook-1',
        kind: 'config' as const,
        name: 'Check command',
        path: 'hooks/run.mjs',
      }]
      : []),
    ...(files.some((file) => file.path === 'hooks/replacement.mjs')
      ? [{
        event: 'beforeTool',
        host: fixtureTarget,
        id: 'replacement-hook',
        kind: 'config' as const,
        name: 'Replacement hook',
        path: 'hooks/replacement.mjs',
      }]
      : []),
  ];
  const scripts = [
    ...(files.some((file) => file.path === 'scripts/alpha.mjs')
      ? [{
        hosts: [fixtureTarget],
        id: 'script:alpha',
        mode: 'bundle' as const,
        name: 'alpha',
        path: 'scripts/alpha.mjs',
        rendered: { routeId: 'script:render-alpha' },
        worker: 'hooks/run.mjs',
      }]
      : []),
    ...(files.some((file) => file.path === 'scripts/zeta.mjs')
      ? [{
        hosts: [fixtureTarget],
        id: 'script:zeta',
        mode: 'copy' as const,
        name: 'zeta',
        path: 'scripts/zeta.mjs',
      }]
      : []),
  ];
  return {
    agentSkills: agentSkillsSchemaRevision,
    application: {
      id: 'application:fixture',
      name: 'fixture-application',
      version: '1.2.3',
    },
    distribution: { channels: ['local'] },
    executables: {
      bins: files.some((file) => file.path === 'mcp/runner.mjs')
        ? [{ hosts: [fixtureTarget], name: 'fixture', path: 'mcp/runner.mjs', worker: 'hooks/run.mjs' }]
        : [],
      hooks: hookRows,
      mcpServers: files.some((file) => file.path === 'mcp/runner.mjs')
        ? [{
          apps: [{
            id: 'app:runner',
            name: 'Runner',
            prebuilt: true,
            resourceUri: 'ui://runner',
          }],
          entry: { path: 'mcp/runner.mjs' },
          hosts: [fixtureTarget],
          id: 'mcp:runner',
          kind: 'compiled',
          name: 'runner',
          transport: 'stdio',
        }]
        : [],
      scripts,
    },
    files: files
      .map((file) => ({
        bytes: Buffer.byteLength(file.contents),
        kind: file.kind,
        ...(file.mode === undefined ? {} : { mode: file.mode }),
        path: file.path,
        sha256: sha256Hex(file.contents),
        sourceInputs: [...(file.sourceInputs ?? [configPath])],
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    manifestVersion: 2,
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: sourceInputs[0]!.sha256,
      configPath,
      modelDigest: 'd'.repeat(64),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    projections: [projection],
    routes: {
      digest: 'e'.repeat(64),
      events: [],
      layouts: [],
      providers: [],
      scripts: scripts.some((script) => script.rendered !== undefined)
        ? [{
          id: 'script:render-alpha',
          kind: 'script',
          provenance: { kind: 'conventional' },
          source: 'src/runner.ts',
        }]
        : [],
      servers: [],
    },
    runtime: { node: '22.12.0' },
    validation: {
      artifact: { status: 'passed' },
      projections: [{ host: projection.host, status: 'passed' }],
      source: { status: 'passed' },
    },
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
  targetDigests: Object.freeze({ [fixtureTarget]: sha256Hex(id) }),
});

const publish = async (options: {
  readonly files: readonly FixtureFile[];
  readonly id: string;
  readonly omitMcpDocument?: boolean;
  readonly registry: TargetRegistry;
  readonly root: string;
  readonly sourceInputs?: typeof fixtureInputs;
  readonly store: EpochStore;
}): Promise<void> => {
  const epoch = epochFor(options.root, options.id);
  const staging = await options.store.createStagingEpoch({ epoch, targets: [fixtureTarget] });
  const files = options.files;

  try {
    for (const file of files) {
      const path = join(staging.root, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
      if (file.mode !== undefined) await chmod(path, file.mode);
    }
    await writeFile(
      join(staging.root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(
        options.registry,
        files,
        options.sourceInputs,
        options.omitMcpDocument,
      )).bytes,
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
  {
    contents: '{"mcpServers":{"runner":{"args":["./mcp/runner.mjs"],"command":"node","env":{"SECRET":"do-not-expose"},"type":"stdio"}}}\n',
    kind: 'generated',
    path: 'mcp.json',
  },
  { contents: 'export const runner = true;\n', kind: 'bundle', mode: 0o755, path: 'mcp/runner.mjs', sourceInputs: [runnerSourcePath] },
  { contents: '{}\n', kind: 'generated', path: 'hooks/hooks.json' },
  { contents: 'export const check = true;\n', kind: 'bundle', mode: 0o755, path: 'hooks/run.mjs', sourceInputs: [runnerSourcePath] },
  { contents: 'export const alpha = true;\n', kind: 'bundle', path: 'scripts/alpha.mjs' },
  { contents: 'export const omitted = true;\n', kind: 'bundle', path: 'scripts/not-manifested-as-script.mjs' },
  { contents: 'export const zeta = true;\n', kind: 'copy', path: 'scripts/zeta.mjs' },
];

const diffFiles = (variant: 'base' | 'candidate'): readonly FixtureFile[] => {
  const candidate = variant === 'candidate';
  return [
    ...(candidate ? [{ contents: 'export const added = true;\n', kind: 'generated' as const, path: 'scripts/added.mjs' }] : []),
    { contents: candidate ? 'b' : 'a', kind: 'generated', path: 'scripts/digest.mjs' },
    { contents: candidate ? 'longer' : 'short', kind: 'generated', path: 'scripts/bytes.mjs' },
    { contents: 'export const mode = true;\n', kind: 'generated', mode: candidate ? 0o744 : 0o755, path: 'scripts/mode.mjs' },
    { contents: 'export const kind = true;\n', kind: candidate ? 'copy' : 'generated', path: 'scripts/kind.mjs' },
    { contents: 'export const source = true;\n', kind: 'generated', path: 'scripts/source.mjs', sourceInputs: candidate ? [runnerSourcePath] : [configPath] },
    { contents: 'export const same = true;\n', kind: 'generated', path: 'scripts/unchanged.mjs' },
    ...(candidate ? [] : [{ contents: 'export const removed = true;\n', kind: 'generated' as const, path: 'scripts/removed.mjs' }]),
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
    await rm(join(reference.root, 'mcp', 'runner.mjs'));
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

    expect(inspection.application).toEqual({
      id: 'application:fixture',
      name: 'fixture-application',
      version: '1.2.3',
    });
    expect(inspection.distribution).toEqual({ channels: ['local'] });
    expect(inspection.epochId).toBe('epoch-runtime');
    expect(inspection.project).toEqual({
      configDigest: fixtureInputs[0]!.sha256,
      configPath,
      modelDigest: 'd'.repeat(64),
      revision: digest({ inputs: fixtureInputs }),
      sourceInputs: fixtureInputs,
    });
    expect(inspection.files.map((file) => file.path)).toEqual([
      'hooks/hooks.json',
      'hooks/run.mjs',
      'mcp.json',
      'mcp/runner.mjs',
      'scripts/alpha.mjs',
      'scripts/not-manifested-as-script.mjs',
      'scripts/zeta.mjs',
    ]);
    // The projection's tree is the composite root itself, named after the host (#555).
    expect(inspection.projections).toEqual([
      expect.objectContaining({
        documents: { hooks: 'hooks/hooks.json', mcp: 'mcp.json' },
        host: fixtureTarget,
        tree: expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({ kind: 'directory', name: 'hooks', path: 'hooks' }),
            expect.objectContaining({ kind: 'file', name: 'mcp.json', path: 'mcp.json' }),
          ]),
          name: fixtureTarget,
          path: '.',
        }),
      }),
    ]);
    expect(inspection.provenance).toContainEqual({
      outputPath: 'mcp/runner.mjs',
      sourceInputs: [{ path: runnerSourcePath, sha256: fixtureInputs[1]!.sha256 }],
    });
    expect(inspection.runtime.executables.map((file) => file.path)).toEqual([
      'hooks/run.mjs',
      'mcp/runner.mjs',
    ]);
    expect(inspection.runtime.bins).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ path: 'mcp/runner.mjs' }),
        hosts: [fixtureTarget],
        name: 'fixture',
        worker: expect.objectContaining({ path: 'hooks/run.mjs' }),
      }),
    ]);
    expect(inspection.runtime.hooks).toEqual([
      expect.objectContaining({ kind: 'config', path: 'hooks/run.mjs', target: fixtureTarget }),
    ]);
    expect(inspection.runtime.mcpServers).toEqual([{
      apps: [{ id: 'app:runner', name: 'Runner', resourceUri: 'ui://runner' }],
      entryPaths: ['mcp/runner.mjs'],
      kind: 'compiled',
      manifestPath: 'mcp.json',
      name: 'runner',
      target: fixtureTarget,
    }]);
    expect(inspection.runtime.scripts).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ path: 'scripts/alpha.mjs' }),
        id: 'script:alpha',
        mode: 'bundle',
        name: 'alpha',
        rendered: 'script:render-alpha',
        target: fixtureTarget,
        worker: expect.objectContaining({ path: 'hooks/run.mjs' }),
      }),
      expect.objectContaining({
        file: expect.objectContaining({ path: 'scripts/zeta.mjs' }),
        id: 'script:zeta',
        mode: 'copy',
        name: 'zeta',
        target: fixtureTarget,
      }),
    ]);
    expect(JSON.stringify(inspection)).not.toContain('do-not-expose');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a manifested MCP host without its projection MCP document', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-mcp-document-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({
      files: runtimeFiles(),
      id: 'epoch-missing-mcp-document',
      omitMcpDocument: true,
      registry,
      root,
      store,
    });

    await expect(new ArtifactInspectionService(store, registry).inspect('epoch-missing-mcp-document'))
      .rejects.toMatchObject({
        code: 'ARTIFACT_INSPECTION_RUNTIME_INVALID',
        diagnostics: [expect.objectContaining({ code: 'AB6202', target: fixtureTarget })],
      });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('revalidates an epoch on each inspection so post-publication corruption is visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-inspection-revalidation-'));
  const registry = runtimeRegistry();
  const store = new EpochStore({ projectRoot: root });

  try {
    await publish({ files: runtimeFiles(), id: 'epoch-revalidation', registry, root, store });
    const service = new ArtifactInspectionService(store, registry);

    await expect(service.inspect('epoch-revalidation')).resolves.toMatchObject({
      epochId: 'epoch-revalidation',
    });
    await writeFile(
      join(root, '.agent-bundle', 'epochs', 'epoch-revalidation', 'scripts', 'alpha.mjs'),
      'export const alpha = false;\n',
    );

    await expect(service.inspect('epoch-revalidation')).rejects.toMatchObject({
      code: 'ARTIFACT_INSPECTION_INVALID',
    });
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
    expect(Object.isFrozen(inspection.application)).toBe(true);
    expect(Object.isFrozen(inspection.projections[0]!.documents)).toBe(true);
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
      apps: [{ id: 'app:runner', name: 'Runner', resourceUri: 'ui://runner' }],
      entryPaths: ['mcp/runner.mjs'],
      kind: 'compiled',
      manifestPath: 'mcp.json',
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
      entryPaths: ['mcp/runner.mjs'],
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
      ...runtimeFiles(),
      { contents: 'export const replacement = true;\n', kind: 'bundle' as const, mode: 0o755, path: 'hooks/replacement.mjs' },
    ];
    await writeFile(join(artifactRoot, 'hooks', 'replacement.mjs'), replacementFiles.at(-1)!.contents);
    await writeFile(
      join(artifactRoot, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(registry, replacementFiles)).bytes,
    );

    expect(result.snapshot).toMatchObject({
      manifest: { files: expect.not.arrayContaining([expect.objectContaining({ path: 'hooks/replacement.mjs' })]) },
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
    await publish({ files: runtimeFiles(), id: 'epoch-invalid', registry, root, store });
    const service = new ArtifactInspectionService(store, registry);
    await service.inspect('epoch-reference');
    expect(store).toMatchObject({ acquired: 1, closed: 1 });

    await writeFile(join(root, '.agent-bundle', 'epochs', 'epoch-invalid', 'agent-bundle.manifest.json'), '{\n');
    await expect(service.inspect('epoch-invalid')).rejects.toMatchObject({
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

    expect(diff.added.map((record) => record.path)).toEqual(['scripts/added.mjs']);
    expect(diff.removed.map((record) => record.path)).toEqual(['scripts/removed.mjs']);
    expect(diff.changed.map((record) => record.path)).toEqual([
      'scripts/bytes.mjs',
      'scripts/digest.mjs',
      'scripts/kind.mjs',
      'scripts/mode.mjs',
      'scripts/source.mjs',
    ]);
    expect(diff.unchanged.map((record) => record.path)).toEqual([
      'scripts/unchanged.mjs',
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
      'scripts/bytes.mjs',
      'scripts/digest.mjs',
      'scripts/kind.mjs',
      'scripts/mode.mjs',
      'scripts/removed.mjs',
      'scripts/source.mjs',
      'scripts/unchanged.mjs',
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
    path: 'scripts/source.mjs',
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
      'scripts/source.mjs',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
