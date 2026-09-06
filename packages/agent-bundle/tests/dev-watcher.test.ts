import { chmod, mkdtemp, mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { ProjectWatcher, type Invalidation } from '../src/dev/index.ts';

type Listener = (path: string) => void;

class FakeWatcher {
  #closed = false;
  #closeCalls = 0;
  readonly #listeners = new Map<string, Listener[]>();

  close(): Promise<void> {
    this.#closeCalls += 1;
    this.#closed = true;
    return Promise.resolve();
  }

  emit(event: string, path: string): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(path);
  }

  get closeCalls(): number {
    return this.#closeCalls;
  }

  get closed(): boolean {
    return this.#closed;
  }

  on(event: string, listener: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }
}

const nextInvalidation = (
  setListener: (listener: (invalidation: Invalidation) => void) => void,
): Promise<Invalidation> => new Promise((resolvePromise, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for a watcher invalidation.')), 5_000);
  setListener((invalidation) => {
    clearTimeout(timeout);
    resolvePromise(invalidation);
  });
});

it('debounces only relevant source paths into one ordered invalidation and closes idempotently', async () => {
  const fake = new FakeWatcher();
  const invalidations: Invalidation[] = [];
  const watcher = new ProjectWatcher({
    createWatcher: () => fake,
    debounceMs: 60_000,
    now: () => new Date('2026-08-14T12:00:00.000Z'),
    onInvalidation: async (invalidation) => {
      invalidations.push(invalidation);
    },
    root: '/project with spaces',
  });

  fake.emit('change', '/project with spaces/src/second.ts');
  fake.emit('add', '/project with spaces/src/first.ts');
  fake.emit('unlink', '/project with spaces/src/second.ts');
  fake.emit('change', '/project with spaces/.git/HEAD');
  fake.emit('change', '/project with spaces/node_modules/dependency/index.js');
  fake.emit('change', '/project with spaces/.agent-bundle/active-epoch.json');
  fake.emit('change', '/project with spaces/dist/plugin.json');
  // The package build stages `dist/` in a `.dist.stage-XXXXXX` sibling before
  // renaming it into place; that staging tree is output, not source.
  fake.emit('addDir', '/project with spaces/.dist.stage-W3rHAr');
  fake.emit('add', '/project with spaces/.dist.stage-W3rHAr/bin/plugin.js');
  // ... and compiles into a `.dist.compile-XXXXXX` sibling first (#656).
  fake.emit('addDir', '/project with spaces/.dist.compile-Qm2xLp');
  fake.emit('add', '/project with spaces/.dist.compile-Qm2xLp/bin/plugin.js');
  fake.emit('unlinkDir', '/project with spaces/.dist.compile-Qm2xLp');
  fake.emit('add', '/project with spaces/.distinct-source.ts');
  await watcher.flush();

  expect(invalidations).toEqual([{
    occurredAt: '2026-08-14T12:00:00.000Z',
    paths: ['.distinct-source.ts', 'src/first.ts', 'src/second.ts'],
    reason: 'source-change',
  }]);

  await watcher.close();
  await watcher.close();
  fake.emit('change', '/project with spaces/src/later.ts');
  await watcher.flush();

  expect(fake.closeCalls).toBe(1);
  expect(fake.closed).toBe(true);
  expect(invalidations).toHaveLength(1);
});

it('drops delayed source events until the path signature changes', async () => {
  const fake = new FakeWatcher();
  const invalidations: Invalidation[] = [];
  const source = '/project/src/input.ts';
  let signature: string | undefined = 'revision-1';
  const watcher = new ProjectWatcher({
    createWatcher: () => fake,
    debounceMs: 60_000,
    onInvalidation: async (invalidation) => {
      invalidations.push(invalidation);
    },
    readPathSignature: async () => signature,
    root: '/project',
  });

  fake.emit('add', source);
  await watcher.flush();
  fake.emit('change', source);
  await watcher.flush();

  expect(invalidations).toHaveLength(1);

  signature = 'revision-2';
  fake.emit('change', source);
  await watcher.flush();

  expect(invalidations).toEqual([
    expect.objectContaining({ paths: ['src/input.ts'] }),
    expect.objectContaining({ paths: ['src/input.ts'] }),
  ]);

  signature = undefined;
  fake.emit('unlink', source);
  await watcher.flush();
  fake.emit('unlink', source);
  await watcher.flush();

  expect(invalidations).toHaveLength(3);

  signature = 'revision-1';
  fake.emit('add', source);
  await watcher.flush();

  expect(invalidations).toHaveLength(4);
  await watcher.close();
});

it('invalidates a reported file after chmod changes only its executable mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-chmod-watcher-'));
  const source = join(root, 'script.sh');
  const fake = new FakeWatcher();
  const invalidations: Invalidation[] = [];
  await writeFile(source, '#!/bin/sh\nexit 0\n');
  await chmod(source, 0o644);
  const watcher = new ProjectWatcher({
    createWatcher: () => fake,
    debounceMs: 60_000,
    onInvalidation: async (invalidation) => {
      invalidations.push(invalidation);
    },
    root,
  });

  try {
    fake.emit('add', source);
    await watcher.flush();
    const before = await stat(source, { bigint: true });

    await chmod(source, 0o755);
    const after = await stat(source, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(before.mode & 0o111n).toBe(0n);
    expect(after.mode & 0o111n).not.toBe(0n);

    fake.emit('change', source);
    await watcher.flush();

    expect(invalidations).toEqual([
      expect.objectContaining({ paths: ['script.sh'] }),
      expect.objectContaining({ paths: ['script.sh'] }),
    ]);
  } finally {
    await watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});

it('waits for the real watcher root before reporting create, change, and delete source inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-real-watcher-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'existing.ts'), 'export const value = 1;\n');
  let listen: ((invalidation: Invalidation) => void) | undefined;
  const received: Invalidation[] = [];
  const watcher = new ProjectWatcher({
    debounceMs: 20,
    onInvalidation: async (invalidation) => {
      received.push(invalidation);
      listen?.(invalidation);
      listen = undefined;
    },
    root,
  });

  try {
    await watcher.ready();

    const changed = nextInvalidation((listener) => { listen = listener; });
    await writeFile(join(root, 'src', 'existing.ts'), 'export const value = 2;\n');
    expect((await changed).paths).toContain('src/existing.ts');

    const added = nextInvalidation((listener) => { listen = listener; });
    await writeFile(join(root, 'src', 'created.ts'), 'export const created = true;\n');
    expect((await added).paths).toContain('src/created.ts');

    const deleted = nextInvalidation((listener) => { listen = listener; });
    await unlink(join(root, 'src', 'created.ts'));
    expect((await deleted).paths).toContain('src/created.ts');

    await Promise.all([
      mkdir(join(root, '.agent-bundle', 'output'), { recursive: true }).then(async () =>
        writeFile(join(root, '.agent-bundle', 'output', 'generated.ts'), 'ignored\n')),
      mkdir(join(root, '.git'), { recursive: true }).then(async () =>
        writeFile(join(root, '.git', 'HEAD'), 'ignored\n')),
      mkdir(join(root, 'node_modules', 'dependency'), { recursive: true }).then(async () =>
        writeFile(join(root, 'node_modules', 'dependency', 'index.js'), 'ignored\n')),
    ]);
    const sentinel = nextInvalidation((listener) => { listen = listener; });
    await writeFile(join(root, 'src', 'sentinel.ts'), 'export const sentinel = true;\n');
    expect((await sentinel).paths).toContain('src/sentinel.ts');

    const reportedPaths = received.flatMap((invalidation) => invalidation.paths);
    expect(reportedPaths).not.toContain('.agent-bundle/output/generated.ts');
    expect(reportedPaths).not.toContain('.git/HEAD');
    expect(reportedPaths).not.toContain('node_modules/dependency/index.js');
    expect(received).toHaveLength(4);
  } finally {
    await watcher.close();
    await rm(root, { force: true, recursive: true });
  }
});
