import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isErrno } from '../core/errors.ts';

/**
 * Read-only access to a Grok Bot computer's `agent-data` directory, shared by the grokbot installer, its
 * sideload into Grok Bot's marketplace clone, Doctor, and uninstall.
 */

/** Where a Grok Bot computer keeps its data, most specific first (`GROK_BOT_AGENT_DATA_DIR` overrides). */
export const grokBotAgentDataCandidates = (
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): readonly string[] => Object.freeze([
  ...(environment['GROK_BOT_AGENT_DATA_DIR'] === undefined ? [] : [environment['GROK_BOT_AGENT_DATA_DIR']]),
  '/home/box/agent-data',
  join(home, '.grokbot', 'agent-data'),
  join(home, 'Library', 'Application Support', 'Grok Bot', 'agent-data'),
]);

export const directoryExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES')) return false;
    throw error;
  }
};

/** The first candidate that holds a `plugins` directory, or undefined when this computer has no Grok Bot data. */
export const findGrokBotAgentData = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<string | undefined> => {
  for (const candidate of grokBotAgentDataCandidates(environment, home)) {
    if (await directoryExists(join(candidate, 'plugins'))) return candidate;
  }
  return undefined;
};

export const readJsonFile = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES') || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
};

export const listDirectory = async (path: string): Promise<readonly string[]> => {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EACCES')) return [];
    throw error;
  }
};

/**
 * `<marketplace>/<plugin>/<version>` of a path inside `plugins/cache`. Grok Bot's indexes may record the legacy
 * `sand-data` root, so only the cache-relative tail identifies a copy.
 */
export const pluginCacheKey = (installPath: string): string | undefined => {
  const segments = installPath.split(/[\\/]/u).filter((segment) => segment !== '');
  const cache = segments.lastIndexOf('cache');
  if (cache < 1 || segments[cache - 1] !== 'plugins' || segments.length !== cache + 4) return undefined;
  return segments.slice(cache + 1).join('/');
};
