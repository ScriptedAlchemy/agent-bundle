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
