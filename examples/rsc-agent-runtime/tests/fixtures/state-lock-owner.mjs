import { open } from 'node:fs/promises';
import process from 'node:process';
import { setInterval } from 'node:timers';

import lockfile from 'proper-lockfile';

const stateFile = process.argv[2];
if (stateFile === undefined) {
  throw new Error('state file argument is required');
}

const handle = await open(stateFile, 'a');
await handle.close();
const release = await lockfile.lock(stateFile, {
  realpath: true,
  retries: 0,
  stale: 2_000,
  update: 1_000,
});
process.stdout.write('{"ready":true}\n');

process.once('SIGTERM', async () => {
  await release();
  process.exit(0);
});
setInterval(() => undefined, 1_000);
