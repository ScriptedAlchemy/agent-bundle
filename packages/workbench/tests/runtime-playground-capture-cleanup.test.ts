import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

// @ts-expect-error The executable capture script is intentionally imported as the cleanup-boundary test seam.
import { atomically, cleanupCaptureResources, captureFailureAfterCleanup, formatCaptureFailure } from '../scripts/capture-runtime-playground.mjs';

test('settles every capture cleanup action without masking the primary failure', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-runtime-capture-cleanup-'));
  const temporary = join(outputRoot, '.desktop.png.temporary');
  const primary = new Error('primary capture failed');
  const order: string[] = [];
  let fixtureCloseCount = 0;
  try {
    await expect(atomically(temporary, async (path: string) => {
      await writeFile(path, 'partial output', 'utf8');
      throw primary;
    })).rejects.toBe(primary);

    const cleanup = await cleanupCaptureResources({
      browser: {
        close: async () => {
          order.push('browser.close');
          throw new Error('browser close rejected');
        },
      },
      fixture: {
        close: async () => {
          fixtureCloseCount += 1;
          order.push('fixture.close');
          throw new Error('fixture close rejected with fixture-secret');
        },
      },
      restores: [
        async () => {
          order.push('restore-one');
          throw new Error('restore one rejected');
        },
        async () => {
          order.push('restore-two');
        },
      ],
    });

    expect(order).toEqual(['restore-one', 'restore-two', 'browser.close', 'fixture.close']);
    expect(fixtureCloseCount).toBe(1);
    expect(cleanup).toEqual({ attemptedRestores: 2, failedSteps: ['restore-1', 'browser.close', 'fixture.close'] });
    await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });

    const failure = captureFailureAfterCleanup(primary, cleanup);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ message: 'primary capture failed' });
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors[1]).toMatchObject({ message: 'Capture cleanup failed: restore-1, browser.close, fixture.close.' });
    const formatted = formatCaptureFailure(failure);
    expect(formatted).toBe('primary capture failed\nCapture cleanup failed: restore-1, browser.close, fixture.close.');
    expect(formatted).not.toContain('restore one rejected');
    expect(formatted).not.toContain('browser close rejected');
    expect(formatted).not.toContain('fixture-secret');
  } finally {
    await rm(outputRoot, { force: true, recursive: true });
  }
});

test('bounds a wedged cleanup step instead of holding the capture process open', async () => {
  const cleanup = await cleanupCaptureResources({
    browser: { close: async () => new Promise(() => {}) },
    fixture: { close: async () => {} },
    restores: [async () => new Promise(() => {})],
    stepTimeout: 50,
  });
  expect(cleanup).toEqual({ attemptedRestores: 1, failedSteps: ['restore-1', 'browser.close'] });
});
