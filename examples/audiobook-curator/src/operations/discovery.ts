/**
 * Source discovery and selection operations: `inspect`, `inventory`,
 * `library-audit`, and `select`, backed by `../curator-core.ts` and
 * `../library.ts`. All four retain evidence and never mutate media.
 */
import { defineCliCommand, type CliCommandContext } from '../cli-command.js';
import { z } from 'zod';

import { inspectSources, type InspectionReceipt } from '../curator-core.ts';
import { readJson, writeReceipt } from '../foundation.ts';
import {
  auditLibrary,
  createInventory,
  selectInventorySources,
  type InventoryReceipt,
  type LibraryAuditReceipt,
  type SelectionReceipt,
} from '../library.ts';
import { parityReceiptSchema, pathSchema, probeShape } from './schemas.ts';

export interface DiscoveryOperations {
  readonly inspect: (
    input: { readonly maxFiles?: number; readonly root: string },
    options: CliCommandContext,
  ) => Promise<InspectionReceipt>;
  readonly inventory?: (
    input: { readonly report?: string; readonly source: string; readonly strict?: boolean },
    options: CliCommandContext,
  ) => Promise<InventoryReceipt>;
  readonly libraryAudit?: (
    input: { readonly concurrency?: number; readonly report?: string; readonly sources: readonly string[]; readonly strict?: boolean },
    options: CliCommandContext,
  ) => Promise<LibraryAuditReceipt>;
  readonly select?: (
    input: { readonly inventory: string; readonly report?: string },
    options: CliCommandContext,
  ) => Promise<SelectionReceipt>;
}

const inventoryResultSchema = parityReceiptSchema<InventoryReceipt>('inventory');
const libraryResultSchema = parityReceiptSchema<LibraryAuditReceipt>('library-audit');
const selectionResultSchema = parityReceiptSchema<SelectionReceipt>('quality-selection');

const inspectedFileSchema = z.object({
  ...probeShape,
  bytes: z.number().int().nonnegative(),
  path: pathSchema,
}).strict();
const inspectInputSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: pathSchema,
}).strict();
const inspectResultSchema = z.object({
  files: z.array(inspectedFileSchema).max(256),
  operation: z.literal('inspect'),
  root: pathSchema,
  totalBytes: z.number().int().nonnegative(),
}).strict();

export const defaultDiscoveryOperations: Required<DiscoveryOperations> = {
  inspect: (input, options) => inspectSources(input, options),
  inventory: async (input, options) => {
    const receipt = await createInventory(input, options);
    if (input.report !== undefined) await writeReceipt(input.report, receipt, [input.source]);
    return receipt;
  },
  libraryAudit: async (input, options) => {
    const receipt = await auditLibrary(input, options);
    if (input.report !== undefined) await writeReceipt(input.report, receipt, input.sources);
    return receipt;
  },
  select: async (input) => {
    const inventory = inventoryResultSchema.parse(await readJson(input.inventory));
    const receipt = selectInventorySources(inventory, input.inventory);
    if (input.report !== undefined) await writeReceipt(input.report, receipt, [input.inventory]);
    return receipt;
  },
};

export const discoveryOperations = (operations: Required<DiscoveryOperations>) => ({
  inspect: defineCliCommand({
    handler: operations.inspect,
    id: 'inspect',
    inputSchema: inspectInputSchema,
    resultSchema: inspectResultSchema,
  }),
  inventory: defineCliCommand({
    handler: operations.inventory,
    id: 'inventory',
    inputSchema: z.object({ report: pathSchema.optional(), source: pathSchema, strict: z.boolean().optional() }).strict(),
    resultSchema: inventoryResultSchema,
  }),
  libraryAudit: defineCliCommand({
    handler: operations.libraryAudit,
    id: 'library-audit',
    inputSchema: z.object({
      concurrency: z.number().int().min(1).max(8).optional(),
      report: pathSchema.optional(),
      sources: z.array(pathSchema).min(1).max(64),
      strict: z.boolean().optional(),
    }).strict(),
    resultSchema: libraryResultSchema,
  }),
  select: defineCliCommand({
    handler: operations.select,
    id: 'select',
    inputSchema: z.object({ inventory: pathSchema, report: pathSchema.optional() }).strict(),
    resultSchema: selectionResultSchema,
  }),
});
