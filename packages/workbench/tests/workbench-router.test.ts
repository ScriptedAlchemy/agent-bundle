import { expect, it } from '@rstest/core';

import type { WorkbenchLocation } from '../src/shell/workbench-location.ts';
import { createWorkbenchRouter, type WorkbenchRouterWindow } from '../src/shell/workbench-router.ts';

interface FakeWindow extends WorkbenchRouterWindow {
  readonly entries: string[];
  readonly listeners: Set<() => void>;
  /** Simulates the browser's Back button: moves to the previous entry and fires `popstate`. */
  back(): void;
}

const fakeWindow = (initial = '/'): FakeWindow => {
  const entries = [initial];
  const listeners = new Set<() => void>();
  let index = 0;
  const location = {
    get pathname(): string { return entries[index]!.split('?')[0]!; },
    get search(): string {
      const current = entries[index]!;
      const query = current.indexOf('?');
      return query === -1 ? '' : current.slice(query);
    },
  };
  const url = (value: string | URL | null | undefined): string => String(value ?? entries[index]);
  return {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    back: () => {
      if (index === 0) return;
      index -= 1;
      for (const listener of listeners) listener();
    },
    entries,
    history: {
      pushState: (_state, _unused, value) => {
        entries.splice(index + 1);
        entries.push(url(value));
        index = entries.length - 1;
      },
      replaceState: (_state, _unused, value) => { entries[index] = url(value); },
    },
    listeners,
    location,
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
};

it('reads the initial location from the window', () => {
  const router = createWorkbenchRouter(fakeWindow('/routes/mcp/curator/tool/search_audible?invocation=inv-1'));
  expect(router.current()).toEqual({
    area: 'application',
    invocationId: 'inv-1',
    node: { kind: 'tool', name: 'search_audible', server: 'curator' },
  });
  expect(router.href({ area: 'problems' })).toBe('/problems');
});

it('pushes history on navigate, notifies subscribers, and pops back to the previous location', () => {
  const window = fakeWindow();
  const router = createWorkbenchRouter(window);
  const seen: WorkbenchLocation[] = [];
  const unsubscribe = router.subscribe((location) => { seen.push(location); });

  router.navigate({ area: 'trace' });
  router.navigate({ area: 'application', node: { kind: 'script', name: 'sync' } });
  expect(window.entries).toEqual(['/', '/trace', '/routes/scripts/sync']);
  expect(seen.map((location) => location.area)).toEqual(['trace', 'application']);
  expect(router.current()).toEqual({ area: 'application', node: { kind: 'script', name: 'sync' } });

  window.back();
  expect(router.current()).toEqual({ area: 'trace' });
  expect(seen).toHaveLength(3);
  expect(seen[2]).toEqual({ area: 'trace' });

  unsubscribe();
  window.back();
  expect(router.current()).toEqual({ area: 'application' });
  expect(seen).toHaveLength(3);
});

it('replaces instead of pushing when asked, and when the target is already shown', () => {
  const window = fakeWindow('/problems');
  const router = createWorkbenchRouter(window);
  let notifications = 0;
  router.subscribe(() => { notifications += 1; });

  router.navigate({ area: 'problems' });
  expect(window.entries).toEqual(['/problems']);
  expect(notifications).toBe(0);

  router.navigate({ area: 'advanced', section: 'logs' }, { replace: true });
  expect(window.entries).toEqual(['/advanced/logs']);
  expect(notifications).toBe(1);
  expect(router.current()).toEqual({ area: 'advanced', section: 'logs' });
});

it('normalizes an unknown initial path to the root URL without a history entry', () => {
  const window = fakeWindow('/nowhere/at/all');
  const router = createWorkbenchRouter(window);
  expect(router.current()).toEqual({ area: 'application' });
  router.navigate({ area: 'application' });
  expect(window.entries).toEqual(['/']);
});

it('ignores popstate that lands on the same location and stops listening after dispose', () => {
  const window = fakeWindow('/trace');
  const router = createWorkbenchRouter(window);
  let notifications = 0;
  router.subscribe(() => { notifications += 1; });
  for (const listener of window.listeners) listener();
  expect(notifications).toBe(0);

  router.dispose();
  expect(window.listeners.size).toBe(0);
  expect(router.subscribe(() => { notifications += 1; })).toBeTypeOf('function');
  router.navigate({ area: 'problems' });
  expect(notifications).toBe(0);
  expect(window.entries).toEqual(['/trace', '/problems']);
});
