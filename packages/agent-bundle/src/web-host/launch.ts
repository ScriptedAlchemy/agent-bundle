import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { sha256Hex } from '../core/digest.ts';
import { CodedError } from '../core/errors.ts';
import { mcpServerStateDirectory } from '../core/mcp-state-directory.ts';
import { exists, joinArtifact, safeArtifactPath } from '../core/paths.ts';
import { pathTokens, pluginRootEnvAnchor } from '../core/types.ts';
import { expandLaunchTokens, type ArtifactManifestLaunch, type WebManifestApp } from './manifest.ts';
import type { StdioLaunch } from './session.ts';

/** Plain Node launch support bundled into generated executables (#564). */
export interface ResolveWebLaunchOptions {
  readonly app: WebManifestApp;
  readonly env: NodeJS.ProcessEnv;
  /** The user home the durable web state root anchors on; defaults to the OS home directory. */
  readonly home?: string;
  /** The App's server launch record (`executables.mcpServers[].launch`). */
  readonly launch: ArtifactManifestLaunch;
  readonly pluginRoot: string;
}

export type WebLaunchErrorCode = 'entry-missing' | 'entry-outside-root';

export class WebLaunchError extends CodedError<WebLaunchErrorCode> {
  constructor(code: WebLaunchErrorCode, message: string) {
    super('WebLaunchError', code, message);
  }
}

const safePluginSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

/**
 * One state segment per installed plugin root: the resolved root's digest
 * keys the state, so two installs of the same plugin never share it, and the
 * basename stays in front only when it is already a safe path segment.
 */
const webPluginStateSegment = (pluginRoot: string): string => {
  const digest = sha256Hex(pluginRoot).slice(0, 16);
  const name = basename(pluginRoot);
  return safePluginSegment.test(name) ? `${name}-${digest}` : `plugin-${digest}`;
};

/**
 * Durable per-server web state, outside the installed artifact: the artifact
 * stays immutable (it may be installed read-only), so framework-owned
 * writable state anchors under the user's home instead of the plugin root.
 */
export const webPluginDataDirectory = (pluginRoot: string, server: string, home = homedir()): string =>
  join(home, '.agent-bundle', 'web-data', webPluginStateSegment(resolve(pluginRoot)), mcpServerStateDirectory(server));

const inheritedEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/** A launch record path resolved inside the plugin root; the artifact must contain it. */
const artifactFile = async (pluginRoot: string, app: string, role: string, path: string): Promise<string> => {
  if (!safeArtifactPath(path)) {
    throw new WebLaunchError(
      'entry-outside-root',
      `MCP server ${role} ${JSON.stringify(path)} of ${app} escapes the plugin root ${pluginRoot}; `
        + 'a launch record may only name files of its own artifact.',
    );
  }
  const resolved = joinArtifact(pluginRoot, path);
  if (!(await exists(resolved))) {
    throw new WebLaunchError(
      'entry-missing',
      `MCP server ${role} ${resolved} of ${app} does not exist; rebuild the plugin so the artifact matches its manifest.`,
    );
  }
  return resolved;
};

/**
 * Declared env overrides inherited env, matching installed hosts. Plugin data
 * lives outside the artifact (under the user's home), because the installed
 * artifact is immutable — a read-only install must still launch when the
 * server declares plugin-data state.
 */
export const resolveWebLaunch = async (options: ResolveWebLaunchOptions): Promise<StdioLaunch> => {
  const pluginRoot = resolve(options.pluginRoot);
  const { app, launch } = options;
  const entry = await artifactFile(pluginRoot, app.app, 'entry', launch.entry);
  if (launch.worker !== undefined) await artifactFile(pluginRoot, app.app, 'worker', launch.worker);
  const pluginData = webPluginDataDirectory(pluginRoot, app.server, options.home);
  const roots = { pluginData, pluginRoot, workspaceRoot: process.cwd() };
  const expand = (value: string): string => expandLaunchTokens(value, roots);
  const args: string[] = [];
  for (const argument of launch.args) {
    switch (argument.kind) {
      case 'artifact':
        args.push(await artifactFile(pluginRoot, app.app, 'argument', argument.path));
        break;
      case 'literal':
        args.push(expand(argument.value));
        break;
      default: {
        const unreachable: never = argument;
        throw new TypeError(`Unhandled launch argument ${String(unreachable)}.`);
      }
    }
  }
  const declared = Object.fromEntries(Object.entries<string>(launch.env).map(([key, value]) => [key, expand(value)]));
  if (Object.values<string>(launch.env).some((value) => value.includes(pathTokens.pluginData))) {
    await mkdir(pluginData, { recursive: true });
  }
  return Object.freeze({
    args: Object.freeze([entry, ...args]),
    command: process.execPath,
    cwd: pluginRoot,
    env: Object.freeze({
      ...inheritedEnvironment(options.env),
      ...declared,
      ...(Object.hasOwn(declared, pluginRootEnvAnchor) ? {} : { [pluginRootEnvAnchor]: pluginRoot }),
    }),
  });
};
