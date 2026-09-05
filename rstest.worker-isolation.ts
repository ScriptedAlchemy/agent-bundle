import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

/**
 * Where Playwright keeps its bundled browsers while `PLAYWRIGHT_BROWSERS_PATH`
 * is unset — the same resolution as playwright-core's registry directory:
 * `$XDG_CACHE_HOME/ms-playwright` on Linux (`~/.cache` when the variable is
 * unset or empty), `~/Library/Caches/ms-playwright` on macOS, and
 * `%LOCALAPPDATA%\ms-playwright` on Windows.
 */
export const playwrightBrowsersPath = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  if (platform === 'win32') return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  const xdgCacheHome = env['XDG_CACHE_HOME'];
  return join(xdgCacheHome !== undefined && xdgCacheHome.length > 0 ? xdgCacheHome : join(home, '.cache'), 'ms-playwright');
};

export const isolateWorkerEnvironment = (): void => {
  const root = rstestWorkerRoot();
  const cache = rstestWorkerCacheDirectory('xdg');
  const env = process.env;
  // Playwright's bundled-browser registry is a machine-level cache that the
  // per-worker XDG_CACHE_HOME below would otherwise hide: with
  // AGENT_BUNDLE_PLAYWRIGHT_CHANNEL=chromium (CI) every launch would look for
  // the build `playwright install chromium` downloaded in an empty per-worker
  // directory. Pin the registry to where Playwright resolved it before the
  // override; an explicit PLAYWRIGHT_BROWSERS_PATH (including `0`) wins.
  env['PLAYWRIGHT_BROWSERS_PATH'] ??= playwrightBrowsersPath(env);
  env['TMPDIR'] = root;
  env['TMP'] = root;
  env['TEMP'] = root;
  env['XDG_CACHE_HOME'] = cache;
};

let commandSerial = 0;

/**
 * The worker's npm cache. It is shared by every command this worker spawns
 * (not per command) on purpose: a packed consumer install pulls the package's
 * full dependency tree (~180 MB of registry tarballs), and a per-command cache
 * made every install in a file start cold — on a CI runner, whose npm cache is
 * always empty at job start, that was the whole 30 s budget of each
 * public-api-packed test. Sequential commands in one worker now hit the cache
 * after the first install, and `--prefer-offline` then skips the registry
 * round trips entirely. Concurrent installs within one worker (packed-consumer
 * installs two consumers at once) share it safely: cacache is content
 * addressed with atomic writes, the same property every developer machine
 * relies on for parallel `npm install`s against ~/.npm. Workers never share a
 * cache with each other.
 */
export const rstestWorkerNpmCacheDirectory = (): string => rstestWorkerCacheDirectory('npm');

export const isolatedCommandEnvironment = (base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  commandSerial += 1;
  const stamp = String(process.pid) + '-' + String(commandSerial);
  const cache = rstestWorkerCacheDirectory('cmd-' + stamp);
  const tmp = join(rstestWorkerRoot(), 'cmd-tmp-' + stamp);
  mkdirSync(tmp, { recursive: true });
  const { NODE_PATH: _nodePath, ...rest } = base;
  const environment: NodeJS.ProcessEnv = { ...rest };
  environment['npm_config_cache'] = rstestWorkerNpmCacheDirectory();
  // Rslib's persistent Rspack build cache is keyed by the built config's
  // root (`<package>/node_modules/.cache/rspack`), not by `--dist-path`, so
  // two workers rebuilding the same package into isolated dists would share
  // one cache lock. packages/*/rslib.config.ts honor this override.
  environment['AGENT_BUNDLE_RSLIB_CACHE_DIRECTORY'] = join(cache, 'rslib');
  environment['TMPDIR'] = tmp;
  environment['TMP'] = tmp;
  environment['TEMP'] = tmp;
  return environment;
};
