import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { CodedError } from '../core/errors.ts';
import { mcpServerStateDirectory } from '../core/mcp-state-directory.ts';
import { exists, joinArtifact, safeArtifactPath } from '../core/paths.ts';
import { pathTokens, pluginRootEnvAnchor } from '../core/types.ts';
import type { WebManifestApp } from './manifest.ts';
import type { StdioLaunch } from './session.ts';

/** Plain Node launch support bundled into generated executables (#564). */
export interface ResolveWebLaunchOptions {
  readonly app: WebManifestApp;
  readonly env: NodeJS.ProcessEnv;
  readonly pluginRoot: string;
}

export type WebLaunchErrorCode = 'entry-missing' | 'entry-outside-root';

export class WebLaunchError extends CodedError<WebLaunchErrorCode> {
  constructor(code: WebLaunchErrorCode, message: string) {
    super('WebLaunchError', code, message);
  }
}

export const webPluginDataDirectory = (pluginRoot: string, server: string): string =>
  join(pluginRoot, '.agent-bundle', 'web', mcpServerStateDirectory(server));

const inheritedEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

/**
 * Declared env overrides inherited env, matching installed hosts. Plugin data
 * is artifact-local because the artifact is the durable installation.
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
    args: Object.freeze([entry, ...app.args.map(expand)]),
    command: process.execPath,
    cwd: pluginRoot,
    env: Object.freeze({
      ...inheritedEnvironment(options.env),
      ...declared,
      ...(Object.hasOwn(declared, pluginRootEnvAnchor) ? {} : { [pluginRootEnvAnchor]: pluginRoot }),
    }),
  });
};
