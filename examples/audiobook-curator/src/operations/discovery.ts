/**
 * Source discovery and selection operations: `inspect`, `inventory`,
 * `library-audit`, and `select`, backed by `../curator-core.ts` and
 * `../library.ts`. All four retain evidence and never mutate media.
 */
import { z } from 'zod';

import type { CliCommandContext } from '../cli-command.js';
import { inspectSources } from '../curator-core.ts';
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

export const discoveryOperations = Object.freeze({
  inspect: {
    handler: inspectSources,
    id: 'inspect',
    inputSchema: inspectInputSchema,
    resultSchema: inspectResultSchema,
  },
  inventory: {
    handler: async (
      input: { readonly report?: string; readonly source: string; readonly strict?: boolean },
      options: CliCommandContext,
    ) => {
      const receipt = await createInventory(input, options);
      if (input.report !== undefined) await writeReceipt(input.report, receipt, [input.source]);
      return receipt;
    },
    id: 'inventory',
    inputSchema: z.object({ report: pathSchema.optional(), source: pathSchema, strict: z.boolean().optional() }).strict(),
    resultSchema: inventoryResultSchema,
  },
  libraryAudit: {
    handler: async (
      input: { readonly concurrency?: number; readonly report?: string; readonly sources: readonly string[]; readonly strict?: boolean },
      options: CliCommandContext,
    ) => {
      const receipt = await auditLibrary(input, options);
      if (input.report !== undefined) await writeReceipt(input.report, receipt, input.sources);
      return receipt;
    },
    id: 'library-audit',
    inputSchema: z.object({
      concurrency: z.number().int().min(1).max(8).optional(),
      report: pathSchema.optional(),
      sources: z.array(pathSchema).min(1).max(64),
      strict: z.boolean().optional(),
    }).strict(),
    resultSchema: libraryResultSchema,
  },
  select: {
    handler: async (
      input: { readonly inventory: string; readonly report?: string },
      _context: CliCommandContext,
    ) => {
      const inventory = inventoryResultSchema.parse(await readJson(input.inventory));
      const receipt = selectInventorySources(inventory, input.inventory);
      if (input.report !== undefined) await writeReceipt(input.report, receipt, [input.inventory]);
      return receipt;
    },
    id: 'select',
    inputSchema: z.object({ inventory: pathSchema, report: pathSchema.optional() }).strict(),
    resultSchema: selectionResultSchema,
  },
});
