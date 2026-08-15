import { open, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setInterval } from 'node:timers';

import lockfile from 'proper-lockfile';

const stateFile = process.argv[2];
if (stateFile === undefined) {
  throw new Error('state file argument is required');
}

const handle = await open(stateFile, 'a');
await handle.close();
const stale = Number(process.argv[3] ?? '2000');
const update = Number(process.argv[4] ?? '1000');
const release = await lockfile.lock(stateFile, {
  realpath: true,
  retries: 0,
  stale,
  update,
});
const metadataFile = `${stateFile}.agent-runtime-lock.json`;
await writeFile(metadataFile, JSON.stringify({ stale }));
process.stdout.write('{"ready":true}\n');

process.once('SIGTERM', async () => {
  await release();
  await rm(metadataFile, { force: true });
  process.exit(0);
});
setInterval(() => undefined, 1_000);
