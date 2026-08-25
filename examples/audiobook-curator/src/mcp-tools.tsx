import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  auditAudiobook,
  inspectSources,
  prepareAudiobook,
  type AuditInput,
  type AuditReceipt,
  type InspectionReceipt,
  type PrepareInput,
  type PrepareReceipt,
} from './curator-core.js';
import { renderCuratorResult } from './result.js';

interface OperationOptions {
  readonly signal: AbortSignal;
}

export interface CuratorToolOperations {
  readonly audit: (input: AuditInput, options: OperationOptions) => Promise<AuditReceipt>;
  readonly inspect: (
    input: { readonly maxFiles?: number; readonly root: string },
    options: OperationOptions,
  ) => Promise<InspectionReceipt>;
  readonly prepare: (input: PrepareInput, options: OperationOptions) => Promise<PrepareReceipt>;
}

const defaultOperations: CuratorToolOperations = {
  audit: (input, options) => auditAudiobook(input, options),
  inspect: (input, options) => inspectSources(input, options),
  prepare: (input, options) => prepareAudiobook(input, options),
};

const path = z.string().min(1).max(4096);
const inspectSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: path,
}).strict();
const prepareSchema = z.object({
  apply: z.boolean().optional(),
  outputName: z.string().min(5).max(204).optional(),
  outputRoot: path,
  source: path,
}).strict();
const auditSchema = z.object({
  fullDecode: z.boolean().optional(),
  source: path,
}).strict();

export const curatorToolNames = Object.freeze([
  'inspect_sources',
  'prepare_audiobook',
  'audit_audiobook',
] as const);

export interface CuratorTool {
  readonly description: string;
  readonly execute: (input: unknown, signal: AbortSignal) => Promise<CallToolResult>;
  readonly inputSchema: z.ZodType;
  readonly name: (typeof curatorToolNames)[number];
  readonly readOnly: boolean;
}

export const createCuratorTools = (
  options: { readonly operations?: CuratorToolOperations } = {},
): readonly CuratorTool[] => {
  const operations = options.operations ?? defaultOperations;
  return Object.freeze([
    Object.freeze({
      description: 'Inspect a bounded directory tree and report supported audiobook media without changing it.',
      execute: async (input: unknown, signal: AbortSignal) =>
        renderCuratorResult(await operations.inspect(inspectSchema.parse(input), { signal })),
      inputSchema: inspectSchema,
      name: 'inspect_sources' as const,
      readOnly: true,
    }),
    Object.freeze({
      description: 'Plan an M4B output, or apply the plan only when apply is explicitly true.',
      execute: async (input: unknown, signal: AbortSignal) =>
        renderCuratorResult(await operations.prepare(prepareSchema.parse(input), { signal })),
      inputSchema: prepareSchema,
      name: 'prepare_audiobook' as const,
      readOnly: false,
    }),
    Object.freeze({
      description: 'Probe and hash one audiobook, with optional full audio decode.',
      execute: async (input: unknown, signal: AbortSignal) =>
        renderCuratorResult(await operations.audit(auditSchema.parse(input), { signal })),
      inputSchema: auditSchema,
      name: 'audit_audiobook' as const,
      readOnly: true,
    }),
  ] satisfies CuratorTool[]);
};
