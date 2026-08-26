import { lowerMcpResult } from '@agent-bundle/rsc-runtime';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ZodType } from 'zod';

import {
  createAudiobookCuratorApplication,
  type AudiobookCuratorOperations,
} from './application.js';

export type CuratorToolOperations = AudiobookCuratorOperations;

export const curatorToolNames = Object.freeze([
  'apply_audiobook_metadata',
  'apply_audiobook_chapters',
  'search_audible',
  'select_audible_edition',
  'cache_audible_edition',
  'inspect_sources',
  'inventory_sources',
  'audit_library',
  'select_sources',
  'convert_audiobook',
  'prepare_audiobook',
  'audit_audiobook',
] as const);

export interface CuratorTool {
  readonly description: string;
  readonly execute: (input: unknown, signal: AbortSignal) => Promise<CallToolResult>;
  readonly inputSchema: ZodType;
  readonly name: (typeof curatorToolNames)[number];
  readonly readOnly: boolean;
}

export const createCuratorTools = (
  options: { readonly operations?: CuratorToolOperations } = {},
): readonly CuratorTool[] => {
  const application = createAudiobookCuratorApplication(options);
  return Object.freeze(application.operations.flatMap((operation) => operation.mcp === undefined ? [] : [Object.freeze({
    description: operation.mcp.description,
    execute: async (input: unknown, signal: AbortSignal) => {
      const result = await operation.execute(input, { signal });
      return lowerMcpResult(operation.render(result));
    },
    inputSchema: operation.inputSchema,
    name: operation.mcp.name as CuratorTool['name'],
    readOnly: operation.mcp.readOnly,
  })]));
};
