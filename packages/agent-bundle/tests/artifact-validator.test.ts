import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@rstest/core';

import { assembleArtifactManifest, type ArtifactManifestV2 } from '../src/build/manifest.ts';
import { validateArtifact } from '../src/build/validate-artifact.ts';
import { digest } from '../src/core/digest.ts';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const manifestFor = (files: readonly { readonly contents: string; readonly kind: 'bundle' | 'copy' | 'generated'; readonly path: string }[]): ArtifactManifestV2 => {
  const configHash = hash('export default {};\n');
  const sourceInputs = [{ path: 'agent-bundle.config.ts', sha256: configHash }];
  return {
    agentSkills: {
      schemaSha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
      sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
      specification: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
    },
    files: files.map((file) => ({
      bytes: Buffer.byteLength(file.contents),
      kind: file.kind,
      path: file.path,
      sha256: hash(file.contents),
      sourceInputs: ['agent-bundle.config.ts'],
    })),
    producer: { name: 'agent-bundle', version: '0.1.0' },
    project: {
      configDigest: configHash,
      configPath: 'agent-bundle.config.ts',
      modelDigest: 'b'.repeat(64),
      revision: digest({ inputs: sourceInputs }),
      sourceInputs,
    },
    targets: [],
    validation: {
      artifact: { status: 'passed' },
      source: { status: 'passed' },
      targets: [],
    },
    version: 2,
  };
};

const writeArtifact = async (
  files: readonly { readonly contents: string; readonly kind: 'bundle' | 'copy' | 'generated'; readonly path: string }[],
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-validator-'));
  for (const file of files) {
    await writeFile(join(root, file.path), file.contents);
  }
  await writeFile(
    join(root, 'agent-bundle.manifest.json'),
    assembleArtifactManifest(manifestFor(files)).bytes,
  );
  return root;
};

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
