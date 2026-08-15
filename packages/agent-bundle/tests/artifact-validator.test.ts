import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from '@rstest/core';

import { TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { assembleArtifactManifest, type ArtifactManifestV2 } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';
import { agentSkillsSchemaRevision } from '../src/schemas/agent-skills/contract.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

interface ArtifactFixtureFile {
  readonly contents: string;
  readonly kind: 'bundle' | 'copy' | 'generated';
  readonly mode?: number;
  readonly path: string;
}

const manifestFor = (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifestV2['targets'][number][] = [],
): ArtifactManifestV2 => {
  const configHash = hash('export default {};\n');
  const sourceInputs = [{ path: 'agent-bundle.config.ts', sha256: configHash }];
  return {
    agentSkills: agentSkillsSchemaRevision,
    files: files
      .map((file) => ({
        bytes: Buffer.byteLength(file.contents),
        kind: file.kind,
        ...(includeModes && file.mode !== undefined ? { mode: file.mode } : {}),
        path: file.path,
        sha256: hash(file.contents),
        sourceInputs: ['agent-bundle.config.ts'],
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: configHash,
      configPath: 'agent-bundle.config.ts',
      modelDigest: 'b'.repeat(64),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    targets,
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: targets.map(({ name }) => ({ name, status: 'passed' })),
    },
    version: 2,
  };
};

const writeArtifact = async (
  files: readonly ArtifactFixtureFile[],
  includeModes = true,
  targets: readonly ArtifactManifestV2['targets'][number][] = [],
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-'));
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
    if (file.mode !== undefined) await chmod(path, file.mode);
  }
  await writeFile(
    join(root, 'agent-bundle.manifest.json'),
    assembleArtifactManifest(manifestFor(files, includeModes, targets)).bytes,
  );
  return root;
};

const customTarget = 'custom';
const customMetadata = Object.freeze({
  adapterRevision: 'custom-adapter-v1',
  capabilityRevision: 'custom-capabilities-v1',
  capabilitySha256: 'a'.repeat(64),
  observedVersion: 'custom-observed-v1',
  schemas: Object.freeze([Object.freeze({
    name: 'document',
    revision: 'custom-schema-v1',
    sha256: 'b'.repeat(64),
  })]),
});

const customManifestTarget = Object.freeze({
  ...customMetadata,
  name: customTarget,
});

const customRegistry = (): TargetRegistry => new TargetRegistry().register({
  artifactValidation: {
    documents: [{ path: 'document.json', required: true, schema: 'document' }],
    schemas: [{
      name: 'document',
      validate: (document: unknown) =>
        typeof document === 'object' && document !== null && (document as { readonly kind?: unknown }).kind === 'custom'
          ? []
          : [{ instancePath: '/kind', message: 'must equal "custom"' }],
    }],
  },
  capabilities: {},
  metadata: customMetadata,
  name: customTarget,
  plan: () => ({ diagnostics: [], entries: [] }),
  validateModel: () => [],
} satisfies TargetAdapter);

it('rejects legacy, noncanonical, and duplicate-key manifests as strict v2 parse failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-v1-validator-'));

  try {
    await writeFile(join(root, 'agent-bundle.manifest.json'), '{"files":[],"targets":[],"version":1}\n');
    expect(await validateArtifact({ artifactRoot: root })).toEqual([
      expect.objectContaining({ code: 'AB6001', generatedPath: 'agent-bundle.manifest.json' }),
    ]);

    const canonical = assembleArtifactManifest(manifestFor([])).bytes;
    for (const bytes of [JSON.stringify(JSON.parse(canonical), null, 2), canonical.replace(',"version":2', ',"version":2,"version":2')]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), bytes);
      expect(await validateArtifact({ artifactRoot: root })).toEqual([
        expect.objectContaining({ code: 'AB6001', generatedPath: 'agent-bundle.manifest.json' }),
      ]);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('matches a canonical nested manifest file table by path instead of directory traversal position', async () => {
  const root = await writeArtifact([
    { contents: '{}\n', kind: 'generated', path: 'nested/entry.json' },
    { contents: '{}\n', kind: 'generated', path: 'nested.json' },
  ]);

  try {
    expect(await validateArtifact({ artifactRoot: root })).toEqual([]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a canonical manifest that omits an executable file mode', async () => {
  const root = await writeArtifact([
    { contents: 'export const executable = true;\n', kind: 'bundle', mode: 0o755, path: 'bin/tool.mjs' },
  ], false);

  try {
    expect(await validateArtifact({ artifactRoot: root })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves structural artifact diagnostics after a strict v2 manifest passes', async () => {
  const files = [
    { contents: 'export const broken = ;\n', kind: 'bundle' as const, path: 'broken.mjs' },
    { contents: '{', kind: 'generated' as const, path: 'invalid.json' },
    { contents: '{"mcpServers":{"local":{"args":["mcp/mcp-local-deadbeef.mjs"]}}}', kind: 'generated' as const, path: 'mcp.json' },
  ];
  const root = await writeArtifact(files);

  try {
    await writeFile(join(root, 'mcp.json'), '{"mcpServers":{"local":{"args":["mcp/mcp-local-deadbeef.mjs"]}}}\n');
    await writeFile(join(root, 'invalid.json'), '{');
    await writeFile(join(root, 'broken.mjs'), 'export const broken = ;\n');
    const diagnostics = await validateArtifact({ artifactRoot: root });
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6005', generatedPath: 'broken.mjs' }),
      expect.objectContaining({ code: 'AB6006', generatedPath: 'invalid.json' }),
      expect.objectContaining({ code: 'AB6007', generatedPath: 'mcp.json' }),
    ]));

    await writeFile(join(root, 'broken.mjs'), 'export const repaired = true;\n');
    expect(await validateArtifact({ artifactRoot: root })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6004', generatedPath: 'agent-bundle.manifest.json' }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when Agent Skills provenance does not equal the pinned contract', async () => {
  const root = await writeArtifact([]);

  try {
    const manifest = manifestFor([]);
    for (const agentSkills of [
      { ...manifest.agentSkills, schemaSha256: '0'.repeat(64) },
      { ...manifest.agentSkills, sourceRevision: '0'.repeat(40) },
      { ...manifest.agentSkills, specification: 'https://example.test/forged-specification.mdx' },
    ]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest({
        ...manifest,
        agentSkills,
      }).bytes);

      await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB6008', generatedPath: 'agent-bundle.manifest.json' }),
      ]));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires manifest target metadata to match the supplied registry exactly', async () => {
  const files = [{ contents: '{"kind":"custom"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
  const root = await writeArtifact(files, true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6009', target: customTarget }),
    ]));
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual([]);

    for (const target of [
      { ...customManifestTarget, adapterRevision: 'different-adapter' },
      { ...customManifestTarget, capabilityRevision: 'different-capabilities' },
      { ...customManifestTarget, capabilitySha256: 'c'.repeat(64) },
      { ...customManifestTarget, observedVersion: 'different-observed-version' },
      { ...customManifestTarget, schemas: [{ ...customMetadata.schemas[0]!, sha256: 'c'.repeat(64) }] },
      {
        ...customManifestTarget,
        schemas: [
          ...customMetadata.schemas,
          { name: 'unexpected', revision: 'custom-schema-v1', sha256: 'c'.repeat(64) },
        ],
      },
    ]) {
      await writeFile(join(root, 'agent-bundle.manifest.json'), assembleArtifactManifest(manifestFor(files, true, [target])).bytes);
      await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'AB6010', target: customTarget }),
      ]));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires registered target-native documents and validates their pinned schema contracts', async () => {
  const root = await writeArtifact([], true, [customManifestTarget]);

  try {
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6011', generatedPath: 'custom/document.json', target: customTarget }),
    ]));

    const invalidFiles = [{ contents: '{"kind":"invalid"}\n', kind: 'generated' as const, path: 'custom/document.json' }];
    await mkdir(join(root, 'custom'), { recursive: true });
    await writeFile(join(root, 'custom', 'document.json'), invalidFiles[0]!.contents);
    await writeFile(
      join(root, 'agent-bundle.manifest.json'),
      assembleArtifactManifest(manifestFor(invalidFiles, true, [customManifestTarget])).bytes,
    );
    await expect(validateArtifact({ artifactRoot: root, registry: customRegistry() })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AB6012', generatedPath: 'custom/document.json', target: customTarget }),
    ]));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
