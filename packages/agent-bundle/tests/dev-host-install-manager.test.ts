import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it, rs } from '@rstest/core';

import * as codexAppServer from '../src/dev/codex-app-server.ts';
import { ProjectEventHub } from '../src/dev/events.ts';
import { DevHostInstallManager } from '../src/dev/host-install-manager.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';
import { writeInstallFixtureManifest } from './support/install-fixture.ts';

it('removes app-server-managed entries on the first Codex filesystem fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-fallback-'));
  const destination = join(root, 'installed');
  const stableSource = join(root, '.agent-bundle/dev/codex');
  const appServer = rs.spyOn(codexAppServer, 'withCodexAppServer');
  const refresh = async () => {
    await cp(stableSource, destination, { recursive: true });
    return true;
  };
  appServer.mockImplementationOnce(refresh).mockImplementationOnce(refresh).mockResolvedValue(undefined);
  const manager = new DevHostInstallManager({
    epochStore: {
      acquireEpochReference: async (id) => ({
        close: async () => undefined,
        epoch: {
          configDigest: 'config', createdAt: '2026-09-08T00:00:00.000Z',
          diagnostics: { errors: 0, infos: 0, warnings: 0 }, id,
          manifestPath: join(root, id, 'agent-bundle.manifest.json'),
          modelDigest: 'model', projectRevision: id, targetDigests: { codex: id },
        } satisfies ArtifactEpoch,
        root: join(root, id),
      }),
    },
    environment: { CODEX_HOME: join(root, 'home') },
    eventHub: new ProjectEventHub(),
    home: join(root, 'home'),
    hosts: ['codex'],
    installBundle: async (options) => {
      await cp(options.from, destination, { recursive: true });
      return {
        bundleRoot: options.from, destination, host: 'codex', plugin: 'probe',
        state: 'installed', version: '1.0.0',
      };
    },
    projectRoot: root,
    uninstallBundle: async () => undefined,
  });
  try {
    for (const [id, files] of [
      ['epoch-1', []],
      ['epoch-2', ['skills/probe/SKILL.md', 'old.txt']],
      ['epoch-failed', ['aaa-new/probe.md', 'blocked.txt']],
      ['epoch-3', ['commands/probe.md']],
    ] as const) {
      const source = join(root, id);
      for (const file of ['.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', ...files]) {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await writeFile(join(source, file), file.endsWith('.json') ? '{"name":"probe","version":"1.0.0"}' : id);
      }
      await writeInstallFixtureManifest(source, { name: 'probe', version: '1.0.0' }, [{ host: 'codex' }]);
    }
    for (const id of ['epoch-1', 'epoch-2']) {
      manager.sync(id);
      await manager.settled();
      expect(manager.attached('codex')?.epochId).toBe(id);
    }
    expect(await readFile(join(destination, 'skills/probe/SKILL.md'), 'utf8')).toBe('epoch-2');
    await expect(lstat(join(destination, '.agent-bundle-dev/generations'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(destination, 'host-receipt.json'), 'keep file');
    await mkdir(join(destination, 'blocked.txt'));
    await writeFile(join(destination, 'blocked.txt/keep'), 'unmanaged collision');
    manager.sync('epoch-failed');
    await manager.settled();
    expect(manager.attached('codex')?.epochId).toBe('epoch-2');
    expect(await readFile(join(destination, 'skills/probe/SKILL.md'), 'utf8')).toBe('epoch-2');
    expect(await readFile(join(destination, 'old.txt'), 'utf8')).toBe('epoch-2');
    await expect(lstat(join(destination, 'aaa-new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'blocked.txt/keep'), 'utf8')).toBe('unmanaged collision');
    manager.sync('epoch-3');
    await manager.settled();
    expect(manager.attached('codex')?.epochId).toBe('epoch-3');
    await expect(lstat(join(destination, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(destination, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'commands/probe.md'), 'utf8')).toBe('epoch-3');
    expect(await readFile(join(destination, 'host-receipt.json'), 'utf8')).toBe('keep file');
  } finally {
    await manager.close();
    appServer.mockRestore();
    await rm(root, { force: true, recursive: true });
  }
});

it('reconciles removed generation entries without deleting unmanaged installation state, including rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-host-generations-'));
  const destination = join(root, 'installed');
  const eventHub = new ProjectEventHub();
  const events: unknown[] = [];
  eventHub.subscribe((event) => { if (event.type === 'dev.host.sync') events.push(event.payload); });
  const manager = new DevHostInstallManager({
    epochStore: {
      acquireEpochReference: async (id) => ({
        close: async () => undefined,
        epoch: {
          configDigest: 'config', createdAt: '2026-09-08T00:00:00.000Z',
          diagnostics: { errors: 0, infos: 0, warnings: 0 }, id,
          manifestPath: join(root, id, 'agent-bundle.manifest.json'),
          modelDigest: 'model', projectRevision: id, targetDigests: { cursor: id },
        } satisfies ArtifactEpoch,
        root: join(root, id),
      }),
    },
    eventHub,
    home: join(root, 'home'),
    hosts: ['cursor'],
    installBundle: async (options) => {
      await cp(options.from, destination, { recursive: true });
      return {
        bundleRoot: options.from, destination, host: 'cursor', plugin: 'probe',
        state: 'installed', version: '1.0.0',
      };
    },
    projectRoot: root,
  });
  try {
    for (const [id, files] of [
      ['epoch-1', ['skills/probe/SKILL.md', 'old.txt']],
      ['epoch-2', ['commands/probe.md']],
      ['epoch-3', ['commands/probe.md']],
      ['epoch-failed', ['aaa-new/probe.md', 'blocked.txt']],
    ] as const) {
      const source = join(root, id);
      for (const file of ['.cursor-plugin/plugin.json', ...files]) {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await writeFile(join(source, file), file.endsWith('.json') ? '{"name":"probe","version":"1.0.0"}' : id);
      }
      await writeInstallFixtureManifest(source, { name: 'probe', version: '1.0.0' }, [{ host: 'cursor' }]);
    }
    manager.sync('epoch-1');
    await manager.settled();
    expect(await readFile(join(destination, 'skills/probe/SKILL.md'), 'utf8')).toBe('epoch-1');
    await mkdir(join(destination, 'host-state'));
    await writeFile(join(destination, 'host-state/settings.json'), 'keep directory');
    await writeFile(join(destination, 'host-receipt.json'), 'keep file');

    for (const id of ['epoch-2', 'epoch-3']) {
      manager.sync(id);
      await manager.settled();
      expect(manager.attached('cursor')?.epochId).toBe(id);
      await expect(lstat(join(destination, 'skills'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(destination, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(destination, 'commands/probe.md'), 'utf8')).toBe(id);
    }
    expect((await readdir(join(destination, '.agent-bundle-dev/generations'))).sort()).toEqual(['epoch-2', 'epoch-3']);
    await mkdir(join(destination, 'blocked.txt'));
    await writeFile(join(destination, 'blocked.txt/keep'), 'unmanaged collision');
    manager.sync('epoch-failed');
    await manager.settled();
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ epochId: 'epoch-failed', state: 'failed' })]));
    expect(manager.attached('cursor')?.epochId).toBe('epoch-3');
    await expect(lstat(join(destination, 'aaa-new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(destination, 'commands/probe.md'), 'utf8')).toBe('epoch-3');
    expect(await readFile(join(destination, 'blocked.txt/keep'), 'utf8')).toBe('unmanaged collision');
    expect(await readFile(join(destination, 'host-state/settings.json'), 'utf8')).toBe('keep directory');
    expect(await readFile(join(destination, 'host-receipt.json'), 'utf8')).toBe('keep file');
  } finally {
    await manager.close();
    await rm(root, { force: true, recursive: true });
  }
});
