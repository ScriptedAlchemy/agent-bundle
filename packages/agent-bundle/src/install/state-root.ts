import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  PLUGIN_STATE_ROOT_ENV_ANCHOR,
  pluginStateSegment,
  userDataStateRoot,
} from '@agent-bundle/runtime';

import { isErrno } from '../core/errors.ts';
import type { InstallHost } from './install.ts';

export interface InstalledStateRoot {
  readonly root: string;
  readonly source: 'derived' | 'native';
}

const manifestCandidates = (host: InstallHost): readonly string[] => {
  switch (host) {
    case 'claude':
      return ['.mcp.json'];
    case 'codex':
      return ['.codex-plugin/mcp.json'];
    case 'cursor':
      return ['.cursor-plugin/mcp.json', 'mcp.json'];
    default: {
      const exhaustive: never = host;
      throw new TypeError(`Unknown install host ${String(exhaustive)}.`);
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const declaredStateRoot = async (pluginRoot: string, host: InstallHost): Promise<string | undefined> => {
  for (const relativePath of manifestCandidates(host)) {
    let document: unknown;
    try {
      document = JSON.parse(await readFile(join(pluginRoot, relativePath), 'utf8')) as unknown;
    } catch (error) {
      if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(document) || !isRecord(document['mcpServers'])) continue;
    for (const server of Object.values(document['mcpServers'])) {
      if (!isRecord(server) || !isRecord(server['env'])) continue;
      const declared = server['env'][PLUGIN_STATE_ROOT_ENV_ANCHOR];
      if (typeof declared !== 'string' || declared.trim() === '') continue;
      const expanded = declared
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
        .replaceAll('${CURSOR_PLUGIN_ROOT}', pluginRoot)
        .replaceAll('${PLUGIN_ROOT}', pluginRoot);
      if (/\$\{[^}]*\}/u.test(expanded)) continue;
      return isAbsolute(expanded) ? resolve(expanded) : resolve(pluginRoot, expanded);
    }
  }
  return undefined;
};

export const resolveInstalledStateRoot = async (
  pluginRoot: string,
  host: InstallHost,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): Promise<InstalledStateRoot> => {
  const canonicalRoot = await realpath(pluginRoot).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return resolve(pluginRoot);
    throw error;
  });
  const fromManifest = await declaredStateRoot(canonicalRoot, host);
  const inherited = environment[PLUGIN_STATE_ROOT_ENV_ANCHOR] ?? '';
  const expandedInherited = inherited.trim() === '' || /\$\{[^}]*\}/u.test(inherited)
    ? undefined
    : isAbsolute(inherited) ? resolve(inherited) : resolve(canonicalRoot, inherited);
  const declared = fromManifest ?? expandedInherited;
  return Object.freeze(declared === undefined
    ? { root: userDataStateRoot(canonicalRoot, environment, home), source: 'derived' as const }
    : { root: declared, source: 'native' as const });
};

export const installedWebDataRoot = async (pluginRoot: string, home: string): Promise<string> => {
  const canonicalRoot = await realpath(pluginRoot).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return resolve(pluginRoot);
    throw error;
  });
  return join(home, '.agent-bundle', 'web-data', pluginStateSegment(canonicalRoot));
};
