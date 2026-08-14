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
  await watcher.flush();

  expect(invalidations).toEqual([{
    occurredAt: '2026-08-14T12:00:00.000Z',
    paths: ['src/first.ts', 'src/second.ts'],
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
