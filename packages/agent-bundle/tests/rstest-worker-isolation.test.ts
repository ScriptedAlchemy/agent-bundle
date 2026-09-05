import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  removeOwnedRstestWorkerRoots,
  rstestWorkerRootOwnerFile,
  rstestWorkerRootPrefix,
  rstestWorkerRootsParent,
} from '../../../scripts/rstest-worker-roots.mjs';
import {
  playwrightBrowsersPath,
  rstestWorkerRoot,
  rstestWorkerRootOwner,
  rstestWorkerRootPath,
} from '../../../rstest.worker-isolation.ts';

it('keeps Doctor socket fixtures below the Linux AF_UNIX pathname cap', () => {
  const longLocalCiRoot = join(
    '/tmp',
    `abci-repository-hash-${'verify-current-pathological-node-version-'.repeat(3)}`,
  );
  const workerRoot = rstestWorkerRootPath(longLocalCiRoot, '123', 'linux');
  const longestDoctorEndpoint = join(
    workerRoot,
    'agent-bundle-doctor-XXXXXX',
    'endpoints',
    'event-identity.sock',
  );

  // Linux sun_path is 108 bytes including NUL; 96 leaves 12 bytes of headroom.
  expect(Buffer.byteLength(longestDoctorEndpoint, 'utf8') + 1).toBeLessThanOrEqual(96);
});

it('isolates concurrent Rstest invocations that share a host temporary root', () => {
  const firstRoot = rstestWorkerRootPath('/tmp', '1', 'linux', '/workspace/first\0' + '101');
  const secondRoot = rstestWorkerRootPath('/tmp', '1', 'linux', '/workspace/second\0' + '202');

  expect(firstRoot).not.toBe(secondRoot);
});

it('stamps every worker root with the owner marker the local-CI runner cleans up by', () => {
  const root = rstestWorkerRoot();
  expect(root.startsWith(join(rstestWorkerRootsParent, rstestWorkerRootPrefix)) || process.platform === 'win32').toBe(true);
  // The setup file already isolated this worker, so TMPDIR points at the
  // root itself; the marker records the HOST temp root it was derived from
  // and the process that owns it.
  const owner = rstestWorkerRootOwner(root);
  expect(owner).toMatchObject({
    cwd: process.cwd(),
    pid: process.pid,
    workerId: process.env['RSTEST_WORKER_ID'] ?? '0',
  });
  // Absolute in the platform's own shape (`/tmp`, `C:\Temp`, a UNC root).
  expect(isAbsolute(owner?.temporaryRoot ?? '')).toBe(true);
  expect(owner?.temporaryRoot).not.toBe(root);
});

it('pins the Playwright browser registry before the per-worker cache override hides it', () => {
  // Mirrors playwright-core's registry resolution per platform.
  expect(playwrightBrowsersPath({ XDG_CACHE_HOME: '/srv/cache' }, 'linux', '/home/dev')).toBe(join('/srv/cache', 'ms-playwright'));
  expect(playwrightBrowsersPath({}, 'linux', '/home/dev')).toBe(join('/home/dev', '.cache', 'ms-playwright'));
  expect(playwrightBrowsersPath({ XDG_CACHE_HOME: '' }, 'linux', '/home/dev')).toBe(join('/home/dev', '.cache', 'ms-playwright'));
  expect(playwrightBrowsersPath({}, 'darwin', '/Users/dev')).toBe(join('/Users/dev', 'Library', 'Caches', 'ms-playwright'));
  expect(playwrightBrowsersPath({ LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' }, 'win32', 'C:\\Users\\dev'))
    .toBe(join('C:\\Users\\dev\\AppData\\Local', 'ms-playwright'));

  // The setup file already isolated this worker: XDG_CACHE_HOME now names the
  // worker's own cache, and the registry pin must point outside it.
  const pinned = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  expect(pinned).toBeDefined();
  expect(pinned?.startsWith(rstestWorkerRoot())).toBe(false);
});

it('removes only the finished roots owned by one host temporary root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ab-rstest-roots-parent-'));
  const legTmp = '/tmp/abci-deadbeef-verify-node24';
  const otherLegTmp = '/tmp/abci-deadbeef-verify-node26';
  const writeRoot = async (name: string, owner: Readonly<Record<string, unknown>> | undefined): Promise<string> => {
    const root = join(parent, name);
    await mkdir(join(root, 'cache', 'cmd-1-1'), { recursive: true });
    await writeFile(join(root, 'cache', 'cmd-1-1', 'leftover'), 'x');
    if (owner !== undefined) await writeFile(join(root, rstestWorkerRootOwnerFile), `${JSON.stringify(owner)}\n`);
    return root;
  };
  try {
    const finished = await writeRoot(`${rstestWorkerRootPrefix}0000000000000001`, { cwd: '/w', pid: 4_000_001, temporaryRoot: legTmp, workerId: '1' });
    const interrupted = await writeRoot(`${rstestWorkerRootPrefix}0000000000000002`, { cwd: '/w', pid: 4_000_002, temporaryRoot: legTmp, workerId: '2' });
    const live = await writeRoot(`${rstestWorkerRootPrefix}0000000000000003`, { cwd: '/w', pid: 4_000_003, temporaryRoot: legTmp, workerId: '3' });
    const otherLeg = await writeRoot(`${rstestWorkerRootPrefix}0000000000000004`, { cwd: '/w', pid: 4_000_004, temporaryRoot: otherLegTmp, workerId: '1' });
    const unmarked = await writeRoot(`${rstestWorkerRootPrefix}0000000000000005`, undefined);
    const corrupt = await writeRoot(`${rstestWorkerRootPrefix}0000000000000006`, undefined);
    await writeFile(join(corrupt, rstestWorkerRootOwnerFile), '{not json');
    const unrelated = await writeRoot('agent-bundle-artifact-000001', { cwd: '/w', pid: 4_000_007, temporaryRoot: legTmp, workerId: '1' });

    const result = await removeOwnedRstestWorkerRoots({
      isAlive: (pid) => pid === 4_000_003,
      parent,
      temporaryRoot: legTmp,
    });

    expect(result).toEqual({ removed: [finished, interrupted], retained: [live] });
    expect((await readdir(parent)).sort()).toEqual([
      unrelated, otherLeg, live, unmarked, corrupt,
    ].map((root) => root.slice(parent.length + 1)).sort());
    await expect(readdir(join(live, 'cache', 'cmd-1-1'))).resolves.toEqual(['leftover']);

    // Once its owner has exited the retained root is removed on the next pass;
    // a pass with nothing to do is not an error, and neither is a missing parent.
    await expect(removeOwnedRstestWorkerRoots({ isAlive: () => false, parent, temporaryRoot: legTmp }))
      .resolves.toEqual({ removed: [live], retained: [] });
    await expect(removeOwnedRstestWorkerRoots({ isAlive: () => false, parent, temporaryRoot: legTmp }))
      .resolves.toEqual({ removed: [], retained: [] });
    await expect(removeOwnedRstestWorkerRoots({ parent: join(parent, 'missing'), temporaryRoot: legTmp }))
      .resolves.toEqual({ removed: [], retained: [] });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
