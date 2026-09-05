import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { readArtifactManifest } from '../build/manifest-file.ts';
import { isErrno } from '../core/errors.ts';
import { isRecord } from '../core/strict-json.ts';
import { pluginStateRootEnvAnchor } from '../core/types.ts';
import { webPluginDataRoot } from '../web-host/launch.ts';
import type { InstallHost } from './install.ts';

export interface InstalledStateRoot {
  readonly root: string;
  readonly source: 'derived' | 'native';
}

const safePluginSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

// The CLI cannot load the optional React runtime. Uninstall tests pin this spelling against
// `userDataStateRoot` from @agent-bundle/runtime for real installed roots.
const installedUserDataStateRoot = (
  canonicalRoot: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => {
  const xdgStateHome = environment.XDG_STATE_HOME ?? '';
  const stateHome = isAbsolute(xdgStateHome)
    ? join(xdgStateHome, 'agent-bundle')
    : join(home, '.agent-bundle', 'state');
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  const name = basename(canonicalRoot);
  return join(stateHome, safePluginSegment.test(name) ? `${name}-${digest}` : `plugin-${digest}`);
};

/**
 * The host MCP document the installed manifest points at for this host
 * (`projections[].documents.mcp`); an installed root without a manifest or
 * without that projection declares nothing.
 */
const installedMcpDocument = async (pluginRoot: string, host: InstallHost): Promise<string | undefined> => {
  const read = await readArtifactManifest(pluginRoot);
  if (read.status !== 'ok') return undefined;
  return read.manifest.projections.find((projection) => projection.builtInHost === host)?.documents.mcp;
};

const declaredStateRoot = async (pluginRoot: string, host: InstallHost): Promise<string | undefined> => {
  const relativePath = await installedMcpDocument(pluginRoot, host);
  if (relativePath === undefined) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(await readFile(join(pluginRoot, relativePath), 'utf8')) as unknown;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!isRecord(document) || !isRecord(document['mcpServers'])) return undefined;
  for (const server of Object.values(document['mcpServers'])) {
    if (!isRecord(server) || !isRecord(server['env'])) continue;
    const declared = server['env'][pluginStateRootEnvAnchor];
    if (typeof declared !== 'string' || declared.trim() === '') continue;
    const expanded = declared
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
      .replaceAll('${CURSOR_PLUGIN_ROOT}', pluginRoot)
      .replaceAll('${PLUGIN_ROOT}', pluginRoot);
    if (/\$\{[^}]*\}/u.test(expanded)) continue;
    return isAbsolute(expanded) ? resolve(expanded) : resolve(pluginRoot, expanded);
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
  const inherited = environment[pluginStateRootEnvAnchor] ?? '';
  const expandedInherited = inherited.trim() === '' || /\$\{[^}]*\}/u.test(inherited)
    ? undefined
    : isAbsolute(inherited) ? resolve(inherited) : resolve(canonicalRoot, inherited);
  const declared = fromManifest ?? expandedInherited;
  return Object.freeze(declared === undefined
    ? { root: installedUserDataStateRoot(canonicalRoot, environment, home), source: 'derived' as const }
    : { root: declared, source: 'native' as const });
};

export const installedWebDataRoot = (pluginRoot: string, home: string): string =>
  webPluginDataRoot(pluginRoot, home);
