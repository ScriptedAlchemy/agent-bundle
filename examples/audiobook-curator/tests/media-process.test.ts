import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { runMediaProcess } from '../src/index.js';

const fixture = join(import.meta.dirname, 'fixtures', 'media-process.mjs');

describe('bounded media process', () => {
  it('returns bounded successful output and reports nonzero exits', async () => {
    await expect(runMediaProcess(process.execPath, [fixture, 'success'])).resolves.toEqual({
      stderr: '',
      stdout: 'ready',
    });
    await expect(runMediaProcess(process.execPath, [fixture, 'failure']))
      .rejects.toThrow('exit 3): fixture failure');
  });

  it('terminates output overflow', async () => {
    await expect(runMediaProcess(process.execPath, [fixture, 'overflow']))
      .rejects.toThrow('stdout exceeded 256 KiB');
  });

  it('terminates only on caller cancellation', async () => {
    const controller = new AbortController();
    const result = runMediaProcess(process.execPath, [fixture, 'sleep'], { signal: controller.signal });
    controller.abort(new Error('cancelled by test'));
    await expect(result).rejects.toThrow('cancelled by test');
  });
});
