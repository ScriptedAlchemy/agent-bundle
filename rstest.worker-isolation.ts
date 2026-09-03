import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rstestWorkerRootOwnerFile } from './scripts/rstest-worker-roots.mjs';

export const rstestWorkerId = (): string => process.env['RSTEST_WORKER_ID'] ?? '0';

const hostTemporaryRoot = tmpdir();

/**
 * Owner marker for a hashed worker root. The root's name is not predictable
 * from outside (the hash includes this process id), so the marker is how a
 * runner that owns `temporaryRoot` — scripts/local-ci.mjs and its per-leg
 * TMPDIR — recognizes and removes the roots a finished run left behind
 * without touching another run's live roots.
 */
export interface RstestWorkerRootOwner {
  readonly cwd: string;
  readonly pid: number;
  readonly temporaryRoot: string;
  readonly workerId: string;
}

export const rstestWorkerRootOwner = (root: string): RstestWorkerRootOwner | undefined => {
  const path = join(root, rstestWorkerRootOwnerFile);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as RstestWorkerRootOwner;
};

const writeOwnerMarker = (root: string, workerId: string): void => {
  const path = join(root, rstestWorkerRootOwnerFile);
  if (existsSync(path)) return;
  const owner: RstestWorkerRootOwner = {
    cwd: process.cwd(),
    pid: process.pid,
    temporaryRoot: hostTemporaryRoot,
    workerId,
  };
  try {
    writeFileSync(path, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
  } catch (error) {
    // Another module of this same invocation won the race; its marker names
    // the same owner.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
};

export const rstestWorkerRootPath = (
  temporaryRoot: string,
  workerId: string,
  platform: NodeJS.Platform = process.platform,
  invocationId: string = process.cwd() + '\0' + String(process.pid),
): string => {
  if (platform === 'win32') return join(temporaryRoot, 'agent-bundle-rstest-w' + workerId);
  const hash = createHash('sha256')
    .update(temporaryRoot, 'utf8')
    .update('\0', 'utf8')
    .update(workerId, 'utf8')
    .update('\0', 'utf8')
    .update(invocationId, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return join('/tmp', `ab-rstest-${hash}`);
};

export const rstestWorkerRoot = (): string => {
  const workerId = rstestWorkerId();
  const root = rstestWorkerRootPath(hostTemporaryRoot, workerId);
  mkdirSync(root, { recursive: true });
  writeOwnerMarker(root, workerId);
  return root;
};

export const rstestWorkerCacheDirectory = (name: string): string => {
  const directory = join(rstestWorkerRoot(), 'cache', name);
  mkdirSync(directory, { recursive: true });
  return directory;
};

export const isolateWorkerEnvironment = (): void => {
  const root = rstestWorkerRoot();
  const cache = rstestWorkerCacheDirectory('xdg');
  const env = process.env;
  env['TMPDIR'] = root;
  env['TMP'] = root;
  env['TEMP'] = root;
  env['XDG_CACHE_HOME'] = cache;
};

let commandSerial = 0;

export const isolatedCommandEnvironment = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  commandSerial += 1;
  const stamp = String(process.pid) + '-' + String(commandSerial);
  const cache = rstestWorkerCacheDirectory('cmd-' + stamp);
  const tmp = join(rstestWorkerRoot(), 'cmd-tmp-' + stamp);
  mkdirSync(tmp, { recursive: true });
  const { NODE_PATH: _nodePath, ...rest } = base;
  const environment: NodeJS.ProcessEnv = { ...rest };
  environment['npm_config_cache'] = cache;
  environment['TMPDIR'] = tmp;
  environment['TMP'] = tmp;
  environment['TEMP'] = tmp;
  return environment;
};
