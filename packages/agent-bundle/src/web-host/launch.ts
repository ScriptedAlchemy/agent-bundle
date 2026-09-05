/**
 * How `<plugin> web` launches the MCP server behind one exposed App (#564):
 * the artifact's generated stdio entry, run by this Node, anchored on the
 * plugin root the bin itself lives in.
 *
 * Plain Node. This module is bundled into the generated bin beside
 * `command.ts`, so it imports neither Effect nor a compiler module.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CodedError } from '../core/errors.ts';
import { mcpServerStateDirectory } from '../core/mcp-state-directory.ts';
import { exists, joinArtifact, safeArtifactPath } from '../core/paths.ts';
import { pathTokens, pluginRootEnvAnchor } from '../core/types.ts';
import type { WebManifestApp } from './manifest.ts';
import type { StdioLaunch } from './session.ts';

export interface ResolveWebLaunchOptions {
  /** The exposed App: its server's artifact-relative entry and static env. */
  readonly app: WebManifestApp;
  /** The environment the server inherits — `process.env` in production, injectable for tests. */
  readonly env: NodeJS.ProcessEnv;
  /** The plugin root: the built artifact, or the plugin directory a host installed it to. */
  readonly pluginRoot: string;
}

/**
 * Why a `web` manifest entry cannot be launched, as the error's `code`:
 * - `entry-outside-root`: the App's `entry` is absolute or traverses out of
 *   the plugin root, so it cannot be a file of this artifact;
 * - `entry-missing`: the entry resolves inside the root but no file is there
 *   — the artifact is incomplete or the manifest is stale.
 */
export type WebLaunchErrorCode = 'entry-missing' | 'entry-outside-root';

export class WebLaunchError extends CodedError<WebLaunchErrorCode> {
  constructor(code: WebLaunchErrorCode, message: string) {
    super('WebLaunchError', code, message);
  }
}

/** The directory under the plugin root that holds `<plugin> web`'s per-server durable state. */
export const webPluginDataDirectory = (pluginRoot: string, server: string): string =>
  join(pluginRoot, '.agent-bundle', 'web', mcpServerStateDirectory(server));

const inheritedEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/**
 * Resolves the stdio launch of the App's MCP server.
 *
 * - `command` is this Node (`process.execPath`) and `args` the App's `entry`
 *   joined to the plugin root: the generated MCP executable is self-contained
 *   (AB6005), so the bin's own runtime runs it. An `entry` that is absolute
 *   or traverses out of the root is refused — a manifest may only name files
 *   of its own artifact — and one that names no file is reported before the
 *   spawn would fail with Node's module-not-found text.
 * - `cwd` is the plugin root, as every host launches the server.
 * - `env` reproduces a host launch: the inherited environment (string values
 *   only) first, the server's declared entries over it — a declared entry
 *   wins over an exported variable exactly as it does under Claude or Cursor,
 *   the opposite of `mcp run`, which rehearses an operator's shell and lets
 *   `process.env` win — and the `AGENT_BUNDLE_PLUGIN_ROOT` anchor the
 *   adapters inject, unless the server declares that key itself. The
 *   framework path tokens in declared values expand to real paths:
 *   `plugin-root` to the plugin root, `plugin-data` to
 *   `<pluginRoot>/.agent-bundle/web/<server>` (created when a value names
 *   it), `workspace-root` to the working directory. The artifact root is the
 *   durable anchor here because the artifact *is* the install — the same
 *   root the generated MCP entry resolves its own state against — whereas
 *   `mcp run` anchors plugin-data under the workspace because its artifact
 *   is a rebuildable product.
 */
export const resolveWebLaunch = async (options: ResolveWebLaunchOptions): Promise<StdioLaunch> => {
  const pluginRoot = resolve(options.pluginRoot);
  const { app } = options;
  if (!safeArtifactPath(app.entry)) {
    throw new WebLaunchError(
      'entry-outside-root',
      `MCP server entry ${JSON.stringify(app.entry)} of ${app.app} escapes the plugin root ${pluginRoot}; `
        + 'a web manifest may only name files of its own artifact.',
    );
  }
  const entry = joinArtifact(pluginRoot, app.entry);
  if (!(await exists(entry))) {
    throw new WebLaunchError(
      'entry-missing',
      `MCP server entry ${entry} of ${app.app} does not exist; rebuild the plugin so the artifact matches its manifest.`,
    );
  }
  const pluginData = webPluginDataDirectory(pluginRoot, app.server);
  const workspaceRoot = process.cwd();
  const expand = (value: string): string => value
    .replaceAll(pathTokens.pluginRoot, pluginRoot)
    .replaceAll(pathTokens.pluginData, pluginData)
    .replaceAll(pathTokens.workspaceRoot, workspaceRoot);
  const declared = Object.fromEntries(Object.entries<string>(app.env).map(([key, value]) => [key, expand(value)]));
  if (Object.values<string>(app.env).some((value) => value.includes(pathTokens.pluginData))) {
    await mkdir(pluginData, { recursive: true });
  }
  return Object.freeze({
    args: Object.freeze([entry]),
    command: process.execPath,
    cwd: pluginRoot,
    env: Object.freeze({
      ...inheritedEnvironment(options.env),
      ...declared,
      ...(Object.hasOwn(declared, pluginRootEnvAnchor) ? {} : { [pluginRootEnvAnchor]: pluginRoot }),
    }),
  });
};
