import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import { EpochStore, type EpochStaging } from '../src/dev/epoch-store.ts';
import { publishNativePlaygroundCatalogSnapshot } from '../src/dev/native-playground-service.ts';
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
const nativeCatalogPathFor = (root: string, epochId: string): string =>
  join(root, '.agent-bundle', 'epochs', '.metadata', 'native-playground', `${epochId}.json`);

const settleMicrotasks = async (): Promise<void> => {
  for (let step = 0; step < 16; step += 1) await Promise.resolve();
};

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

it('persists one canonical versionless staging and epoch metadata shape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle canonical epoch storage '));
  const epoch = epochFor(root, 'epoch-canonical');

  try {
    const store = new EpochStore({ projectRoot: root });
    const staging = await store.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    const marker = JSON.parse(
      await readFile(join(staging.root, '.agent-bundle-epoch-stage.json'), 'utf8'),
    ) as unknown;
    expect(marker).toEqual({ token: expect.any(String) });

    await Promise.all([
      mkdir(join(staging.root, 'claude'), { recursive: true }),
      mkdir(join(staging.root, 'codex'), { recursive: true }),
      writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
    ]);
    await Promise.all([
      writeFile(join(staging.root, 'claude', 'plugin.json'), 'claude\n'),
      writeFile(join(staging.root, 'codex', 'plugin.json'), 'codex\n'),
    ]);
    await staging.publish(async () => undefined);

    await expect(
      readFile(epochMetadataPathFor(root, epoch.id), 'utf8').then((value) => JSON.parse(value)),
    ).resolves.toEqual({ epoch });
    await expect(
      readFile(activeMetadataPathFor(root), 'utf8').then((value) => JSON.parse(value)),
    ).resolves.toEqual({ epoch });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('revalidates active metadata after a same-size in-place rewrite with a restored mtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle active epoch cache invalidation '));
  const epoch = epochFor(root, 'epoch-cache-invalidation');
  const metadataPath = activeMetadataPathFor(root);

  try {
    const store = new EpochStore({ projectRoot: root });
    await publishEpoch(store, epoch);
    const canonicalTime = new Date(Math.floor(Date.now() / 1_000) * 1_000 - 10_000);
    await utimes(metadataPath, canonicalTime, canonicalTime);
    await expect(store.readActiveEpoch()).resolves.toEqual(epoch);
    const before = await stat(metadataPath);
    const original = await readFile(metadataPath, 'utf8');
    const corrupted = original.replace('project-revision', 'project-revisioX');
    expect(corrupted).not.toBe(original);
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(original));

    await writeFile(metadataPath, corrupted);
    await utimes(metadataPath, before.atime, before.mtime);
    const rewritten = await stat(metadataPath);
    expect(rewritten.ino).toBe(before.ino);
    expect(rewritten.mtimeMs).toBe(before.mtimeMs);
    expect(rewritten.size).toBe(before.size);

    await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it.each(['active', 'per-epoch'] as const)(
  'rejects a version property added to the canonical %s metadata shape',
  async (metadataKind) => {
    const root = await mkdtemp(join(tmpdir(), 'agent bundle version metadata extra '));
    const epoch = epochFor(root, 'epoch-version-extra');

    try {
      const store = new EpochStore({ projectRoot: root });
      await publishEpoch(store, epoch);
      const metadataPath = metadataKind === 'active'
        ? activeMetadataPathFor(root)
        : epochMetadataPathFor(root, epoch.id);
      await writeFile(metadataPath, `${JSON.stringify({ epoch, version: 1 })}\n`);

      const readMetadata = metadataKind === 'active'
        ? store.readActiveEpoch()
        : store.acquireEpochReference(epoch.id);
      await expect(readMetadata).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.each(['active', 'per-epoch'] as const)(
  'rejects duplicate keys in %s metadata',
  async (metadataKind) => {
    const root = await mkdtemp(join(tmpdir(), 'agent bundle duplicate epoch metadata '));
    const epoch = epochFor(root, 'epoch-duplicate-key');

    try {
      const store = new EpochStore({ projectRoot: root });
      await publishEpoch(store, epoch);
      const metadataPath = metadataKind === 'active'
        ? activeMetadataPathFor(root)
        : epochMetadataPathFor(root, epoch.id);
      const encodedEpoch = JSON.stringify(epoch);
      await writeFile(metadataPath, `{"epoch":${encodedEpoch},"epoch":${encodedEpoch}}\n`);

      const readMetadata = metadataKind === 'active'
        ? store.readActiveEpoch()
        : store.acquireEpochReference(epoch.id);
      await expect(readMetadata).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.each([
  ['epoch', (epoch: ArtifactEpoch) => ({ ...epoch, unexpected: true })],
  ['diagnostics', (epoch: ArtifactEpoch) => ({
    ...epoch,
    diagnostics: { ...epoch.diagnostics, unexpected: true },
  })],
] as const)(
  'rejects unexpected keys on persisted %s metadata',
  async (_location, withUnexpectedKey) => {
    const root = await mkdtemp(join(tmpdir(), 'agent bundle nested metadata extra '));
    const epoch = epochFor(root, 'epoch-nested-extra');

    try {
      const store = new EpochStore({ projectRoot: root });
      await publishEpoch(store, epoch);
      await writeFile(
        activeMetadataPathFor(root),
        `${JSON.stringify({ epoch: withUnexpectedKey(epoch) })}\n`,
      );

      await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it.each(['marker removal', 'marker file sync', 'marker directory sync'] as const)(
  'does not activate a new epoch when %s fails and can retry from truth',
  async (failureKind) => {
    const root = await mkdtemp(join(tmpdir(), 'agent bundle staging marker durability '));
    const marker = '.agent-bundle-epoch-stage.json';
    const failure = new Error(`${failureKind} failed`);
    let failMarkerBoundary = false;
    const controlledOpen = async (path: string, flags: string | number, mode?: number) => {
      const handle = await open(path, flags as Parameters<typeof open>[1], mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'sync') return async () => {
            if (failMarkerBoundary && (
              failureKind === 'marker file sync' && path.endsWith(marker) ||
              failureKind === 'marker directory sync' && path.includes(`${join('.agent-bundle', 'epochs')}${path.includes('\\') ? '\\' : '/'}.stage-`)
            )) throw failure;
            await target.sync();
          };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const controlledRemove: typeof rm = async (path, options) => {
      if (failMarkerBoundary && failureKind === 'marker removal' && String(path).endsWith(marker)) throw failure;
      await rm(path, options);
    };
    const store = new EpochStore({
      projectRoot: root,
      durabilityStorage: Object.freeze({ open: controlledOpen as typeof open, remove: controlledRemove }),
    });
    const stage = async (epoch: ArtifactEpoch): Promise<EpochStaging> => {
      const staging = await store.createStagingEpoch({ epoch, targets: Object.keys(epoch.targetDigests) });
      await Promise.all(Object.keys(epoch.targetDigests).map(async (target) => {
        await mkdir(join(staging.root, target), { recursive: true });
        await writeFile(join(staging.root, target, 'plugin.json'), `${epoch.id}\n`);
      }));
      await writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n');
      return staging;
    };
    try {
      const active = epochFor(root, 'epoch-marker-active', '2026-08-14T12:00:01.000Z');
      const replacement = epochFor(root, 'epoch-marker-replacement', '2026-08-14T12:00:02.000Z');
      await (await stage(active)).publish(async () => undefined);
      failMarkerBoundary = true;
      const failed = await stage(replacement);
      await expect(failed.publish(async () => undefined)).rejects.toBe(failure);
      await expect(store.readActiveEpoch()).resolves.toEqual(active);
      await expect(readFile(join(root, '.agent-bundle', 'epochs', replacement.id, marker), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      failMarkerBoundary = false;
      await (await stage(replacement)).publish(async () => undefined);
      await expect(store.readActiveEpoch()).resolves.toEqual(replacement);
      await expect(readFile(join(root, '.agent-bundle', 'epochs', replacement.id, marker), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
);

it('fsyncs staged artifacts and each durable publication rename in commit order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle durable epoch publication '));
  const syncedPaths: string[] = [];
  const recordingOpen: typeof open = async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'sync') return async () => {
          syncedPaths.push(String(path));
          await target.sync();
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };

  try {
    const epoch = epochFor(root, 'epoch-durable');
    const store = new EpochStore({
      projectRoot: root,
      durabilityStorage: Object.freeze({ open: recordingOpen, remove: rm }),
    });
    const staging = await store.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    const manifestPath = join(staging.root, 'agent-bundle.manifest.json');
    const pluginPath = join(staging.root, 'claude', 'plugin.json');
    await Promise.all([
      mkdir(join(staging.root, 'claude'), { recursive: true }),
      mkdir(join(staging.root, 'codex'), { recursive: true }),
      writeFile(manifestPath, '{}\n'),
    ]);
    await Promise.all([
      writeFile(pluginPath, 'claude\n'),
      writeFile(join(staging.root, 'codex', 'plugin.json'), 'codex\n'),
    ]);

    await staging.publish(async () => undefined);

    const epochsRoot = join(root, '.agent-bundle', 'epochs');
    const metadataRoot = dirname(epochMetadataPathFor(root, epoch.id));
    const agentBundleRoot = dirname(activeMetadataPathFor(root));
    const pluginSync = syncedPaths.indexOf(pluginPath);
    const manifestSync = syncedPaths.indexOf(manifestPath);
    const epochRenameSync = syncedPaths.indexOf(epochsRoot);
    const epochMetadataFileSync = syncedPaths.findIndex((path) =>
      dirname(path) === metadataRoot && basename(path).startsWith(`.${epoch.id}.json.stage-`));
    const epochMetadataRenameSync = syncedPaths.indexOf(metadataRoot);
    const activeMetadataFileSync = syncedPaths.findIndex((path) =>
      dirname(path) === agentBundleRoot && basename(path).startsWith('.active-epoch.json.stage-'));
    const activeMetadataRenameSync = syncedPaths.indexOf(agentBundleRoot);

    expect(pluginSync).toBeGreaterThanOrEqual(0);
    expect(manifestSync).toBeGreaterThanOrEqual(0);
    expect(epochRenameSync).toBeGreaterThan(pluginSync);
    expect(epochRenameSync).toBeGreaterThan(manifestSync);
    expect(epochMetadataFileSync).toBeGreaterThan(epochRenameSync);
    expect(epochMetadataRenameSync).toBeGreaterThan(epochMetadataFileSync);
    expect(activeMetadataFileSync).toBeGreaterThan(epochMetadataRenameSync);
    expect(activeMetadataRenameSync).toBeGreaterThan(activeMetadataFileSync);
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

it('acquires the active epoch and its immutable metadata in one transition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle active epoch reference '));
  try {
    const store = new EpochStore({ projectRoot: root });
    const epoch = epochFor(root, 'epoch-active');
    await publishEpoch(store, epoch);

    const reference = await store.acquireActiveEpochReference();

    expect(reference.epoch).toEqual(epoch);
    expect(reference.root).toBe(join(root, '.agent-bundle', 'epochs', 'epoch-active'));
    expect(Object.isFrozen(reference.epoch)).toBe(true);
    await reference.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('lists detached immutable epoch identities newest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle listed epochs '));
  try {
    const store = new EpochStore({ projectRoot: root });
    const oldest = epochFor(root, 'epoch-oldest', '2026-08-14T12:00:01.000Z');
    const newest = epochFor(root, 'epoch-newest', '2026-08-14T12:00:02.000Z');
    await publishEpoch(store, oldest);
    await publishEpoch(store, newest);

    const listed = await store.listEpochs();

    expect(listed).toEqual([newest, oldest]);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(Object.isFrozen(listed[0]!)).toBe(true);
    expect(listed[0]).not.toBe(newest);
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

it('retains an epoch leased through another store for the same project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle shared epoch lease '));

  try {
    const leaseStore = new EpochStore({ projectRoot: root });
    const publishingStore = new EpochStore({ projectRoot: root });
    await publishEpoch(leaseStore, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const reference = await leaseStore.acquireEpochReference('epoch-1');

    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        publishingStore,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

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

it('does not admit a cross-store reference while final-release cleanup removes its epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle shared epoch transition '));
  let markDeletionStarted: (() => void) | undefined;
  let permitDeletion: (() => void) | undefined;
  const deletionStarted = new Promise<void>((resolve) => { markDeletionStarted = resolve; });
  const deletionPermitted = new Promise<void>((resolve) => { permitDeletion = resolve; });

  try {
    const leaseStore = new EpochStore({
      cleanupRemove: async (path, options) => {
        if (path === nativeCatalogPathFor(root, 'epoch-1')) {
          markDeletionStarted?.();
          await deletionPermitted;
        }
        await rm(path, options);
      },
      projectRoot: root,
    });
    const acquiringStore = new EpochStore({ projectRoot: root });
    await publishEpoch(leaseStore, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    const retained = await leaseStore.acquireEpochReference('epoch-1');
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      await publishEpoch(
        acquiringStore,
        epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`),
      );
    }

    const closing = retained.close();
    await deletionStarted;
    const acquisition = acquiringStore.acquireEpochReference('epoch-1');
    permitDeletion?.();
    const [closeOutcome, acquireOutcome] = await Promise.allSettled([closing, acquisition]);
    if (acquireOutcome.status === 'fulfilled') await acquireOutcome.value.close();

    expect(closeOutcome).toEqual({ status: 'fulfilled', value: undefined });
    expect(acquireOutcome).toEqual({
      reason: expect.objectContaining({ code: 'EPOCH_NOT_FOUND' }),
      status: 'rejected',
    });
  } finally {
    permitDeletion?.();
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
      `${JSON.stringify({ epoch: epochFor(root, 'epoch-ghost') })}\n`,
    );

    const outcomes = await Promise.allSettled([reference.close(), reference.close()]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);

    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: active })}\n`);
    await store.cleanup();
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('preserves epoch metadata when final-reference cleanup cannot remove its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch cleanup retry '));

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
    const epochsRoot = join(root, '.agent-bundle', 'epochs');

    await chmod(epochsRoot, 0o555);
    const outcomes = await Promise.allSettled([reference.close(), reference.close()]);
    await chmod(epochsRoot, 0o755);

    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).resolves.toContain('epoch-1');
    await expect(
      readFile(join(epochsRoot, 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).resolves.toBe('epoch-1\n');
    await expect(store.readActiveEpoch()).resolves.toEqual(active);

    await store.cleanup();
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(epochsRoot, 'epoch-1', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('waits for every eligible cleanup deletion before admitting a later reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch cleanup transition gate '));
  const epochOneRoot = join(root, '.agent-bundle', 'epochs', 'epoch-1');
  const epochTwoRoot = join(root, '.agent-bundle', 'epochs', 'epoch-2');
  const firstFailure = new Error('epoch-1 directory removal failed');
  const earlyGate = Promise.withResolvers<void>();
  const lateGate = Promise.withResolvers<void>();
  const earlyStarted = Promise.withResolvers<void>();
  const lateStarted = Promise.withResolvers<void>();
  let preserveDuringPublication = true;

  const cleanupRemove: typeof rm = async (path, options) => {
    if (
      preserveDuringPublication &&
      (path === epochOneRoot ||
        path === epochTwoRoot ||
        path === epochMetadataPathFor(root, 'epoch-1') ||
        path === epochMetadataPathFor(root, 'epoch-2'))
    ) {
      return;
    }
    if (path === epochOneRoot) {
      earlyStarted.resolve();
      await earlyGate.promise;
      throw firstFailure;
    }
    if (path === epochTwoRoot) {
      lateStarted.resolve();
      await lateGate.promise;
    }
    await rm(path, options);
  };

  try {
    const store = new EpochStore({ cleanupRemove, projectRoot: root });
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      await publishEpoch(store, epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`));
    }
    preserveDuringPublication = false;

    const cleanup = store.cleanup();
    let cleanupSettled = false;
    const cleanupOutcome = cleanup.then(
      () => {
        cleanupSettled = true;
        return { status: 'fulfilled' as const };
      },
      (reason: unknown) => {
        cleanupSettled = true;
        return { reason, status: 'rejected' as const };
      },
    );
    await Promise.all([earlyStarted.promise, lateStarted.promise]);
    const acquisitionOutcome = store.acquireEpochReference('epoch-2').then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ reason, status: 'rejected' as const }),
    );

    earlyGate.resolve();
    await settleMicrotasks();
    const settledBeforeLateDeletion = cleanupSettled;
    lateGate.resolve();

    expect(settledBeforeLateDeletion).toBe(false);
    await expect(cleanupOutcome).resolves.toMatchObject({
      reason: expect.objectContaining({
        failures: [
          expect.objectContaining({ epochId: 'epoch-1', reason: firstFailure, resource: 'directory' }),
        ],
      }),
      status: 'rejected',
    });
    await expect(acquisitionOutcome).resolves.toMatchObject({
      reason: { code: 'EPOCH_NOT_FOUND' },
      status: 'rejected',
    });
  } finally {
    earlyGate.resolve();
    lateGate.resolve();
    await rm(root, { force: true, recursive: true });
  }
});

it('aggregates sorted cleanup failures and retries retained metadata after a metadata failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle epoch cleanup aggregate '));
  const epochOneRoot = join(root, '.agent-bundle', 'epochs', 'epoch-1');
  const epochTwoMetadata = epochMetadataPathFor(root, 'epoch-2');
  const directoryFailure = new Error('epoch-1 directory removal failed');
  const metadataFailure = new Error('epoch-2 metadata removal failed');
  let preserveDuringPublication = true;
  let failuresEnabled = true;

  const cleanupRemove: typeof rm = async (path, options) => {
    if (
      preserveDuringPublication &&
      (path === epochOneRoot ||
        path === join(root, '.agent-bundle', 'epochs', 'epoch-2') ||
        path === epochMetadataPathFor(root, 'epoch-1') ||
        path === epochTwoMetadata)
    ) {
      return;
    }
    if (failuresEnabled && path === epochOneRoot) throw directoryFailure;
    if (failuresEnabled && path === epochTwoMetadata) throw metadataFailure;
    await rm(path, options);
  };

  try {
    const store = new EpochStore({ cleanupRemove, projectRoot: root });
    for (let sequence = 1; sequence <= 9; sequence += 1) {
      await publishEpoch(store, epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`));
    }
    preserveDuringPublication = false;

    await expect(store.cleanup()).rejects.toMatchObject({
      failures: [
        { epochId: 'epoch-1', reason: directoryFailure, resource: 'directory' },
        { epochId: 'epoch-2', reason: metadataFailure, resource: 'metadata' },
      ],
    });
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).resolves.toContain('epoch-1');
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8')).resolves.toBe('epoch-1\n');
    await expect(readFile(epochTwoMetadata, 'utf8')).resolves.toContain('epoch-2');
    await expect(
      readFile(join(root, '.agent-bundle', 'epochs', 'epoch-2', 'claude', 'plugin.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    failuresEnabled = false;
    await store.cleanup();
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(epochTwoMetadata, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: ghost })}\n`);

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
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: mismatched })}\n`);

    await expect(store.readActiveEpoch()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch })}\n`);
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
    const metadata = `${JSON.stringify({ epoch: escaping })}\n`;
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
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch: ghost })}\n`);

    await expect(store.cleanup()).rejects.toMatchObject({ code: 'EPOCH_METADATA_INVALID' });
    await writeFile(activeMetadataPathFor(root), `${JSON.stringify({ epoch })}\n`);
    await expect(store.cleanup()).resolves.toBeUndefined();
    await expect(store.readActiveEpoch()).resolves.toEqual(epoch);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports a cleanup failure as post-commit when the new epoch is already active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle post commit cleanup '));
  const cleanupFailure = new Error('retired epoch cleanup failed');
  let failCleanup = false;

  try {
    const store = new EpochStore({
      cleanupRemove: async (path, options) => {
        if (failCleanup && path === nativeCatalogPathFor(root, 'epoch-1')) throw cleanupFailure;
        await rm(path, options);
      },
      projectRoot: root,
    });
    for (let sequence = 1; sequence <= 6; sequence += 1) {
      await publishEpoch(store, epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`));
    }
    const committed = epochFor(root, 'epoch-7', '2026-08-14T12:00:07.000Z');
    failCleanup = true;

    await expect(publishEpoch(store, committed)).rejects.toMatchObject({
      cause: expect.objectContaining({
        failures: [expect.objectContaining({
          epochId: 'epoch-1',
          reason: cleanupFailure,
          resource: 'native-playground-catalog',
        })],
      }),
      committedEpoch: committed,
      name: 'EpochPostCommitCleanupError',
    });
    await expect(store.readActiveEpoch()).resolves.toEqual(committed);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps epoch metadata and contents retryable when native catalog sidecar deletion fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle native catalog cleanup retry '));
  let failSidecarRemoval = true;
  const sidecarFailure = new Error('native catalog deletion failed');
  try {
    const store = new EpochStore({
      cleanupRemove: async (path, options) => {
        if (failSidecarRemoval && path === nativeCatalogPathFor(root, 'epoch-1')) throw sidecarFailure;
        await rm(path, options);
      },
      projectRoot: root,
    });
    await publishEpoch(store, epochFor(root, 'epoch-1', '2026-08-14T12:00:01.000Z'));
    await mkdir(dirname(nativeCatalogPathFor(root, 'epoch-1')), { recursive: true });
    await writeFile(nativeCatalogPathFor(root, 'epoch-1'), '{"epochId":"epoch-1","selections":[]}\n');
    let cleanupError: unknown;
    for (let sequence = 2; sequence <= 7; sequence += 1) {
      try { await publishEpoch(store, epochFor(root, `epoch-${sequence}`, `2026-08-14T12:00:0${sequence}.000Z`)); }
      catch (error) { cleanupError = error; }
    }
    expect(cleanupError).toMatchObject({
      cause: expect.objectContaining({
        failures: [expect.objectContaining({ epochId: 'epoch-1', reason: sidecarFailure, resource: 'native-playground-catalog' })],
      }),
      committedEpoch: expect.objectContaining({ id: 'epoch-7' }),
      name: 'EpochPostCommitCleanupError',
    });
    await expect(readFile(nativeCatalogPathFor(root, 'epoch-1'), 'utf8')).resolves.toContain('epoch-1');
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).resolves.toContain('epoch-1');
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8')).resolves.toBe('epoch-1\n');

    failSidecarRemoval = false;
    await expect(store.cleanup()).resolves.toBeUndefined();
    await expect(readFile(nativeCatalogPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(epochMetadataPathFor(root, 'epoch-1'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '.agent-bundle', 'epochs', 'epoch-1', 'claude', 'plugin.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('rolls back a publisher-owned catalog sidecar when activation fails after publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle native catalog publication rollback '));
  const epoch = epochFor(root, 'epoch-sidecar-rollback');
  try {
    const store = new EpochStore({ projectRoot: root });
    const staging = await store.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    await Promise.all([
      mkdir(join(staging.root, 'claude'), { recursive: true }),
      mkdir(join(staging.root, 'codex'), { recursive: true }),
      writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
    ]);
    await Promise.all([
      writeFile(join(staging.root, 'claude', 'plugin.json'), 'claude\n'),
      writeFile(join(staging.root, 'codex', 'plugin.json'), 'codex\n'),
    ]);
    await expect(staging.publish(async () => undefined, async () => {
      await mkdir(dirname(nativeCatalogPathFor(root, epoch.id)), { recursive: true });
      await writeFile(nativeCatalogPathFor(root, epoch.id), '{"epochId":"epoch-sidecar-rollback","selections":[]}\n');
      await rm(staging.root, { force: true, recursive: true });
      return Object.freeze({ rollback: async () => rm(nativeCatalogPathFor(root, epoch.id), { force: true }) });
    })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(nativeCatalogPathFor(root, epoch.id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.readActiveEpoch()).resolves.toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('never rolls back an accepted native catalog sidecar winner from a concurrent epoch publisher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent bundle native catalog publication race '));
  const epoch = epochFor(root, 'epoch-sidecar-race');
  let markFirstReady: (() => void) | undefined;
  let markSecondReady: (() => void) | undefined;
  let permitSecondFinish: (() => void) | undefined;
  const firstReady = new Promise<void>((resolve) => { markFirstReady = resolve; });
  const secondReady = new Promise<void>((resolve) => { markSecondReady = resolve; });
  const secondMayFinish = new Promise<void>((resolve) => { permitSecondFinish = resolve; });
  let firstReceipt: Awaited<ReturnType<typeof publishNativePlaygroundCatalogSnapshot>> | undefined;
  let secondReceipt: Awaited<ReturnType<typeof publishNativePlaygroundCatalogSnapshot>> | undefined;
  try {
    const firstStore = new EpochStore({ projectRoot: root });
    const secondStore = new EpochStore({ projectRoot: root });
    const first = await firstStore.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    const second = await secondStore.createStagingEpoch({ epoch, targets: ['claude', 'codex'] });
    for (const staging of [first, second]) {
      await Promise.all([
        mkdir(join(staging.root, 'claude'), { recursive: true }),
        mkdir(join(staging.root, 'codex'), { recursive: true }),
        writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
      ]);
      await Promise.all([
        writeFile(join(staging.root, 'claude', 'plugin.json'), 'claude\n'),
        writeFile(join(staging.root, 'codex', 'plugin.json'), 'codex\n'),
      ]);
    }

    const firstPublication = first.publish(async () => undefined, async (publishingEpoch) => {
      firstReceipt = await publishNativePlaygroundCatalogSnapshot({
        discover: async () => Object.freeze([]),
        epoch: publishingEpoch,
        projectRoot: root,
      });
      markFirstReady!();
      await secondReady;
      return firstReceipt;
    });
    await firstReady;
    const secondPublication = second.publish(async () => undefined, async (publishingEpoch) => {
      secondReceipt = await publishNativePlaygroundCatalogSnapshot({
        discover: async () => Object.freeze([]),
        epoch: publishingEpoch,
        projectRoot: root,
      });
      markSecondReady!();
      await secondMayFinish;
      return secondReceipt;
    });
    await secondReady;
    await expect(firstPublication).resolves.toEqual(epoch);
    permitSecondFinish!();
    await expect(secondPublication).rejects.toBeDefined();

    expect(firstReceipt?.created).toBe(true);
    expect(secondReceipt?.created).toBe(false);
    await expect(readFile(nativeCatalogPathFor(root, epoch.id), 'utf8')).resolves.toContain('epoch-sidecar-race');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
