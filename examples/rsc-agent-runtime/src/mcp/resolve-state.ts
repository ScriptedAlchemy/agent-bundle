import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { ListRootsResultSchema, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';

export type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ResolveStateOptions {
  stateFile?: string;
  resolveStateFile?: (extra: McpRequestExtra) => string | undefined | Promise<string | undefined>;
}

const usablePath = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : resolve(value);

const stateFileFromRoots = async (extra: McpRequestExtra): Promise<string | undefined> => {
  try {
    const result = await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema);
    const root = result.roots[0];
    if (root === undefined) {
      return undefined;
    }

    return join(fileURLToPath(root.uri), '.agent-runtime-demo', 'events.jsonl');
  } catch {
    return undefined;
  }
};

export const resolveStateFile = async (options: ResolveStateOptions, extra: McpRequestExtra): Promise<string> => {
  const resolvedByOption = options.resolveStateFile === undefined ? undefined : await options.resolveStateFile(extra);
  const explicit = usablePath(resolvedByOption) ?? usablePath(options.stateFile);
  if (explicit !== undefined) {
    return explicit;
  }

  const fromEnvironment = usablePath(process.env.AGENT_RUNTIME_STATE_FILE);
  if (fromEnvironment !== undefined) {
    return fromEnvironment;
  }

  const fromRoots = await stateFileFromRoots(extra);
  if (fromRoots !== undefined) {
    return fromRoots;
  }

  return join(process.cwd(), '.agent-runtime-demo', 'events.jsonl');
};
