import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const rstestWorkerId = (): string => process.env['RSTEST_WORKER_ID'] ?? '0';

const hostTemporaryRoot = tmpdir();

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
  const root = rstestWorkerRootPath(hostTemporaryRoot, rstestWorkerId());
  mkdirSync(root, { recursive: true });
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
