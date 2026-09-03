import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { rstestWorkerRootPath } from '../../../rstest.worker-isolation.ts';

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
