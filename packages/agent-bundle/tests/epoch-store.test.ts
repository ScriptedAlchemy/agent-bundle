import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore } from '../src/dev/epoch-store.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';

const epochFor = (
  root: string,
  id: string,
  createdAt = '2026-08-14T12:00:00.000Z',
  targetDigests: Readonly<Record<string, string>> = { claude: 'claude-digest', codex: 'codex-digest' },
): ArtifactEpoch => ({
  configDigest: 'config-digest',
  createdAt,
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'model-digest',
  projectRevision: 'project-revision',
  targetDigests,
});

const publishEpoch = async (store: EpochStore, epoch: ArtifactEpoch): Promise<void> => {
  const targets = Object.keys(epoch.targetDigests);
  const staging = await store.createStagingEpoch({ epoch, targets });
  await Promise.all(targets.map((target) => mkdir(join(staging.root, target), { recursive: true })));
  await Promise.all(targets.map((target) => writeFile(join(staging.root, target, 'plugin.json'), `${epoch.id}\n`)));
  await writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n');
  await staging.publish(async () => undefined);
};

const activeMetadataPathFor = (root: string): string => join(root, '.agent-bundle', 'active-epoch.json');
const epochMetadataPathFor = (root: string, epochId: string): string =>
  join(root, '.agent-bundle', 'epochs', '.metadata', `${epochId}.json`);

it('publishes a validated staging directory as the active immutable epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch store with spaces '));
  const epoch = epochFor(root, 'epoch-1');

  try {
    const store = new EpochStore({ projectRoot: root });
    const staging = await store.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    await Promise.all([
      mkdir(join(staging.root, 'claude'), { recursive: true }),
      mkdir(join(staging.root, 'codex'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(staging.root, 'claude', 'plugin.json'), '{"name":"claude"}\n'),
      writeFile(join(staging.root, 'codex', 'plugin.json'), '{"name":"codex"}\n'),
      writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
    ]);

    await staging.publish(async (stagedRoot) => {
      await expect(readFile(join(stagedRoot, 'claude', 'plugin.json'), 'utf8')).resolves.toBe(
        '{"name":"claude"}\n',
      );
      await expect(readFile(join(stagedRoot, 'codex', 'plugin.json'), 'utf8')).resolves.toBe(
        '{"name":"codex"}\n',
      );
    });

    expect(await store.readActiveEpoch()).toEqual(epoch);
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('{"name":"claude"}\n');
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'codex', 'plugin.json'), 'utf8'),
    ).resolves.toBe('{"name":"codex"}\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('exposes the validated immutable epoch directory on an acquired reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch reference root '));
  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1'));
    const reference = await store.acquireEpochReference('epoch-1');

    expect(reference.root).toBe(join(root, '.agent-bundle', 'epochs', 'epoch-1'));
    await reference.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects an unsafe epoch id before it can create a staging directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle unsafe epoch id '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await expect(
      store.createStagingEpoch({
        epoch: epochFor(root, '../outside-epochs'),
        targets: ['claude'],
      }),
    ).rejects.toMatchObject({ code: 'EPOCH_ID_INVALID' });
    await expect(readFile(join(root, '.agent-bundle', 'outside-epochs'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains active, referenced, and five newest unreferenced epochs until the final reference closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch retention '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const reference = await store.acquireEpochReference('epoch-1');

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        store,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

    await store.cleanup();
    const epochsRoot = join(root, '.agent-bundle', 'epochs');
    expect(
      (await readdir(epochsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['epoch-1', 'epoch-3', 'epoch-4', 'epoch-5', 'epoch-6', 'epoch-7', 'epoch-8']);

    await reference.close();
    await reference.close();
    expect(
      (await readdir(epochsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(['epoch-3', 'epoch-4', 'epoch-5', 'epoch-6', 'epoch-7', 'epoch-8']);
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps a retired epoch until the final of multiple references closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch final reference '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const first = await store.acquireEpochReference('epoch-1');
    const final = await store.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        store,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

    await first.close();
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');

    await final.close();
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not duplicate concurrent close calls before the final reference closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch concurrent close '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const repeated = await store.acquireEpochReference('epoch-1');
    const final = await store.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        store,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

    await Promise.all([repeated.close(), repeated.close(), repeated.close()]);
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');

    await Promise.all([final.close(), final.close(), final.close()]);
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('retains an epoch when reference acquisition is serialized before its final close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch acquire before close '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const initial = await store.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        store,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

    const successor = store.acquireEpochReference('epoch-1');
    await initial.close();
    const reference = await successor;
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');

    await reference.close();
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('shares final-release cleanup failure with concurrent close callers without restoring the reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch close cleanup failure '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const reference = await store.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 7; sequence += 1) {
      await publishEpoch(
        store,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }
    const active = epochFor(root, 'epoch-8', '2026-08-14T12:00:08.000Z');
    await publishEpoch(store, active);
    await writeFile(
      activeMetadataPathFor(root),
      `${JSON.stringify({ epoch: epochFor(root, 'epoch-ghost'), version: 1 })}\n`,
    );

    const outcomes = await Promise.allSettled([reference.close(), reference.close()]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);

    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: active, version: 1 })}\n`);
    await store.cleanup();
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps the previous active epoch when validation rejects a staged replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle failed epoch publication '));
  const first = epochFor(root, 'epoch-1');
  const replacement = epochFor(root, 'epoch-2', '2026-08-14T12:01:00.000Z');

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, first);
    const staging = await store.createStagingEpoch({ epoch: replacement, targets: ['claude', 'codex'] });
    await Promise.all([
      mkdir(join(staging.root, 'claude'), { recursive: true }),
      mkdir(join(staging.root, 'codex'), { recursive: true }),
    ]);

    await expect(
      staging.publish(async () => {
        throw new Error('generated artifact validation failed');
      }),
    ).rejects.toThrow('generated artifact validation failed');

    expect(await store.readActiveEpoch()).toEqual(first);
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-2', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('removes abandoned staging directories without touching the active epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle staging recovery '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const staging = await store.createStagingEpoch({
      epoch: epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' }),
      targets: ['claude'],
    });
    await mkdir(join(staging.root, 'claude'), { recursive: true });
    await writeFile(join(staging.root, 'claude', 'plugin.json'), 'abandoned\n');
    await expect(readFile(join(staging.root, 'claude', 'plugin.json'), 'utf8')).resolves.toBe('abandoned\n');

    await store.recoverStaging();

    await expect(readFile(join(staging.root, 'claude', 'plugin.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(store.readActiveEpoch()).resolves.toBeUndefined();
    await staging.close();
    await staging.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('requires selected targets to exactly match the epoch target digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch target identity '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await expect(store.createStagingEpoch({
      epoch: epochFor(root, 'epoch-1'),
      targets: ['claude'],
    })).rejects.toMatchObject({ code: 'EPOCH_TARGET_SET_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects epoch metadata whose manifest path escapes the final epoch directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle escaping epoch manifest '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const epoch = {
      ...epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' }),
      manifestPath: join(root, 'outside.manifest.json'),
    };
    await expect(store.createStagingEpoch({ epoch, targets: ['claude'] })).rejects.toMatchObject({
      code: 'EPOCH_MANIFEST_INVALID',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a replaced staging root even when it has the expected files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle opaque staging root '));
  const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });

  try {
    const store = new EpochStore({ projectRoot: root });
    const staging = await store.createStagingEpoch({ epoch, targets: ['claude'] });
    await rm(staging.root, { force: true, recursive: true });
    await mkdir(join(staging.root, 'claude'), { recursive: true });
    await Promise.all([
      writeFile(join(staging.root, 'claude', 'plugin.json'), 'replacement\n'),
      writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
    ]);

    await expect(staging.publish(async () => undefined)).rejects.toMatchObject({
      code: 'EPOCH_STAGING_INVALID',
    });
    await expect(store.readActiveEpoch()).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rejects a selected target symlink and a missing staged manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch symlink target '));
  const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });

  try {
    const store = new EpochStore({ projectRoot: root });
    const symlinked = await store.createStagingEpoch({ epoch, targets: ['claude'] });
    const outside = join(root, 'outside target');
    await mkdir(outside);
    await symlink(outside, join(symlinked.root, 'claude'), 'dir');
    await writeFile(join(symlinked.root, 'agent-bundle.manifest.json'), '{}\n');
    await expect(symlinked.publish(async () => undefined)).rejects.toMatchObject({
      code: 'EPOCH_STAGING_INVALID',
    });

    const missingManifest = await store.createStagingEpoch({
      epoch: epochFor(root, 'epoch-2', undefined, { claude: 'claude-digest' }),
      targets: ['claude'],
    });
    await mkdir(join(missingManifest.root, 'claude'), { recursive: true });
    await expect(missingManifest.publish(async () => undefined)).rejects.toMatchObject({
      code: 'EPOCH_MANIFEST_INVALID',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('surfaces corrupt per-epoch metadata instead of silently excluding it from cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle corrupt epoch metadata '));
  const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epoch);
    await writeFile(join(root, '.agent-bundle', 'epochs', '.metadata', 'epoch-1.json'), '{not json}\n');

    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('does not remove an epoch when concurrent references are admitted before its final close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch reference cleanup race '));

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const retained = await store.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(store, epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`));
    }

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 16 }, () => store.acquireEpochReference('epoch-1')),
      retained.close(),
    ]);
    const references = outcomes
      .filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof store.acquireEpochReference>>> =>
        outcome.status === 'fulfilled' && 'value' in outcome && typeof outcome.value !== 'undefined',
      )
      .map((outcome) => outcome.value);

    expect(references).toHaveLength(16);
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');
    await Promise.all(references.map((reference) => reference.close()));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when active metadata points at a ghost epoch and leaves cleanup targets intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle ghost active epoch '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const persisted = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });
    await publishEpoch(store, persisted);
    const ghost = epochFor(root, 'epoch-ghost', undefined, { claude: 'claude-digest' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: ghost, version: 1 })}\n`);

    await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when active metadata differs from its epoch metadata or targets on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle inconsistent active epoch '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest', codex: 'codex-digest' });
    await publishEpoch(store, epoch);
    const mismatched = {
      ...epoch,
      targetDigests: { claude: 'different-digest', codex: 'codex-digest' },
    };
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: mismatched, version: 1 })}\n`);

    await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch, version: 1 })}\n`);
    await rm(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'codex'), { force: true, recursive: true });
    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).resolves.toContain('epoch-1');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('fails closed when matching active metadata gives its manifest an outside path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle outside active manifest '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });
    await publishEpoch(store, epoch);
    const escaping = { ...epoch, manifestPath: join(root, 'outside.manifest.json') };
    const metadata = `${JSON.stringify({ epoch: escaping, version: 1 })}\n`;
    await Promise.all([
      writeFile(activeMetadataPathFor(root), metadata),
      writeFile(epochMetadataPathFor(root, 'epoch-1'), metadata),
    ]);

    await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('continues processing later state transitions after a failed cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch queue recovery '));

  try {
    const store = new EpochStore({ projectRoot: root });
    const epoch = epochFor(root, 'epoch-1', undefined, { claude: 'claude-digest' });
    await publishEpoch(store, epoch);
    const ghost = epochFor(root, 'epoch-ghost', undefined, { claude: 'claude-digest' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: ghost, version: 1 })}\n`);

    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch, version: 1 })}\n`);
    await expect(store.cleanup()).resolves.toBeUndefined();
    await expect(store.readActiveEpoch()).resolves.toEqual(epoch);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
