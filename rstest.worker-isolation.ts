import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const rstestWorkerId = (): string => process.env['RSTEST_WORKER_ID'] ?? '0';

const hostTemporaryRoot = tmpdir();

export const rstestWorkerRoot = (): string => {
  const root = join(hostTemporaryRoot, 'agent-bundle-rstest-w' + rstestWorkerId());
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
  const env = process['env'];
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
