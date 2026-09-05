import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { compileEvidenceFileName } from '../src/build/compile-evidence.ts';
import { writeManifest } from '../src/build/emit.ts';
import { artifactManifestName, parseArtifactManifest } from '../src/build/manifest.ts';
import { reindexArtifactManifest } from '../src/build/manifest-reindex.ts';
import { sha256Hex } from '../src/core/digest.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';

it('reindexes changed, added, and removed artifact files canonically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-reindex-'));
  const manifestPath = join(root, artifactManifestName);
  try {
    await mkdir(join(root, '.cursor-plugin'));
    await writeFile(join(root, '.cursor-plugin', 'plugin.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'changed.txt'), 'before\n');
    await writeInstallFixtureManifest(
      root,
      { name: 'reindex-fixture', version: '1.0.0' },
      [{ host: 'cursor' }],
    );
    await writeFile(join(root, 'removed.txt'), 'remove me\n');
    await reindexArtifactManifest(root, {
      added: [{ kind: 'generated', path: 'removed.txt' }],
    });
    const originalBytes = await readFile(manifestPath, 'utf8');
    const original = parseArtifactManifest(originalBytes);

    await writeFile(join(root, 'changed.txt'), 'after\n');
    await writeFile(join(root, 'added.txt'), 'added\n');
    await rm(join(root, 'removed.txt'));
    const reindexed = await reindexArtifactManifest(root, {
      added: [{ kind: 'generated', path: 'added.txt' }],
      changed: ['changed.txt'],
      removed: ['removed.txt'],
    });
    const output = parseArtifactManifest(await readFile(manifestPath, 'utf8'));

    expect(output).toEqual(reindexed);
    expect(output.files.find((file) => file.path === 'changed.txt')).toMatchObject({
      bytes: 6,
      sha256: sha256Hex('after\n'),
    });
    expect(output.files.find((file) => file.path === 'added.txt')).toMatchObject({
      bytes: 6,
      kind: 'generated',
      sha256: sha256Hex('added\n'),
    });
    expect(output.files.some((file) => file.path === 'removed.txt')).toBe(false);
    expect(output.compiler.provenance.find((entry) => entry.path === 'added.txt')).toEqual({
      path: 'added.txt',
      sourceInputs: [],
    });
    expect(output.compiler.provenance.some((entry) => entry.path === 'removed.txt')).toBe(false);
    expect({
      ...output,
      compiler: { ...output.compiler, provenance: original.compiler.provenance },
      files: original.files,
    }).toEqual(original);

    await writeFile(join(root, 'changed.txt'), 'before\n');
    await rm(join(root, 'added.txt'));
    await writeFile(join(root, 'removed.txt'), 'remove me\n');
    await reindexArtifactManifest(root, {
      added: [{ kind: 'generated', path: 'removed.txt' }],
      changed: ['changed.txt'],
      removed: ['added.txt'],
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(originalBytes);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('refuses to reindex compiled files and the compile evidence record: only a rebuild describes new bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-manifest-reindex-'));
  const evidence = '{}\n';
  try {
    await mkdir(join(root, '.cursor-plugin'));
    await mkdir(join(root, 'mcp'));
    await writeFile(join(root, '.cursor-plugin', 'plugin.json'), '{"name":"fixture"}\n');
    await writeFile(join(root, 'mcp', 'mcp-fixture.mjs'), 'export {};\n');
    await writeInstallFixtureManifest(
      root,
      { name: 'reindex-fixture', version: '1.0.0' },
      [{ host: 'cursor' }],
    );
    await writeFile(join(root, compileEvidenceFileName), evidence);
    await expect(reindexArtifactManifest(root, { added: [{ kind: 'generated', path: compileEvidenceFileName }] }))
      .rejects.toThrow(`Cannot add "${compileEvidenceFileName}": only the compiler writes compile evidence.`);

    // The compiler's own index of the same artifact: one bundle row and its evidence record.
    const written = parseArtifactManifest(await readFile(join(root, artifactManifestName), 'utf8'));
    const evidenceRow = { bytes: evidence.length, kind: 'generated' as const, path: compileEvidenceFileName, sha256: sha256Hex(evidence) };
    await writeManifest({
      artifactRoot: root,
      manifest: {
        ...written,
        compiler: {
          ...written.compiler,
          provenance: [...written.compiler.provenance, { path: compileEvidenceFileName, sourceInputs: [] }]
            .sort((left, right) => left.path.localeCompare(right.path)),
        },
        files: [...written.files.map((file) => file.path === 'mcp/mcp-fixture.mjs' ? { ...file, kind: 'bundle' as const } : file), evidenceRow]
          .sort((left, right) => left.path.localeCompare(right.path)),
      },
    });
    const before = await readFile(join(root, artifactManifestName), 'utf8');

    await writeFile(join(root, 'mcp', 'mcp-fixture.mjs'), 'export const changed = true;\n');
    for (const path of ['mcp/mcp-fixture.mjs', compileEvidenceFileName]) {
      await expect(reindexArtifactManifest(root, { changed: [path] }))
        .rejects.toThrow(`Cannot reindex compiled artifact path ${JSON.stringify(path)}: rebuild instead.`);
      await expect(reindexArtifactManifest(root, { removed: [path] }))
        .rejects.toThrow(`Cannot reindex compiled artifact path ${JSON.stringify(path)}: rebuild instead.`);
    }
    expect(await readFile(join(root, artifactManifestName), 'utf8')).toBe(before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
