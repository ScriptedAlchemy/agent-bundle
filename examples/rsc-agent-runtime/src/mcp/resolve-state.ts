import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type { ServerContext } from '@modelcontextprotocol/server';

import { resolveImplicitRuntimeStateFile } from '../runtime/state-file.js';

export interface ResolveStateOptions {
  stateFile?: string;
  resolveStateFile?: (ctx: ServerContext) => string | undefined | Promise<string | undefined>;
}

const usablePath = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : resolve(value);

const stateFileFromRoots = async (ctx: ServerContext): Promise<string | undefined> => {
  try {
    const result = await ctx.mcpReq.send({ method: 'roots/list' });
    const root = result.roots[0];
    if (root === undefined) {
      return undefined;
    }

    return resolveImplicitRuntimeStateFile(fileURLToPath(root.uri));
  } catch {
    return undefined;
  }
};

export const resolveStateFile = async (options: ResolveStateOptions, ctx: ServerContext): Promise<string> => {
  const resolvedByOption = options.resolveStateFile === undefined ? undefined : await options.resolveStateFile(ctx);
  const explicit = usablePath(resolvedByOption) ?? usablePath(options.stateFile);
  if (explicit !== undefined) {
    return explicit;
  }

  const fromEnvironment = usablePath(process.env.AGENT_RUNTIME_STATE_FILE);
  if (fromEnvironment !== undefined) {
    return fromEnvironment;
  }

  const fromRoots = await stateFileFromRoots(ctx);
  if (fromRoots !== undefined) {
    return fromRoots;
  }

  return resolveImplicitRuntimeStateFile(process.cwd());
};
