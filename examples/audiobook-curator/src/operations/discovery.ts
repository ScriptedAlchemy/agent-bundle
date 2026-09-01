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
import {
  assertOptions,
  numberOption,
  onePath,
  optionalField,
  positionalArguments,
  requiredOption,
} from './cli-arguments.ts';
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
    cli: {
      name: 'inspect',
      parse: (args) => {
        const valued = new Set(['--max-files']);
        assertOptions(args, new Set(), valued);
        return {
          ...optionalField('maxFiles', numberOption(args, '--max-files')),
          root: onePath(args, valued, 'inspect'),
        };
      },
      summary: 'Inspect a bounded audiobook source tree without changing it.',
      usage: 'inspect [--max-files N] <root>',
    },
    handler: operations.inspect,
    id: 'inspect',
    inputSchema: inspectInputSchema,
    resultSchema: inspectResultSchema,
  }),
  inventory: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'inventory',
      parse: (args) => {
        const valued = new Set(['--report']);
        assertOptions(args, new Set(['--strict']), valued);
        return {
          report: requiredOption(args, '--report', 'inventory'),
          source: onePath(args, valued, 'inventory'),
          ...(args.includes('--strict') ? { strict: true } : {}),
        };
      },
      summary: 'Probe source audio without changing it.',
      usage: 'inventory <source> --report FILE [--strict]',
    },
    handler: operations.inventory,
    id: 'inventory',
    inputSchema: z.object({ report: pathSchema.optional(), source: pathSchema, strict: z.boolean().optional() }).strict(),
    resultSchema: inventoryResultSchema,
  }),
  libraryAudit: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'library-audit',
      parse: (args) => {
        const valued = new Set(['--concurrency', '--report']);
        assertOptions(args, new Set(['--strict']), valued);
        const sources = positionalArguments(args, valued);
        if (sources.length === 0) throw new Error('library-audit requires at least one source path.');
        return {
          ...optionalField('concurrency', numberOption(args, '--concurrency')),
          report: requiredOption(args, '--report', 'library-audit'),
          sources,
          ...(args.includes('--strict') ? { strict: true } : {}),
        };
      },
      summary: 'Audit metadata, artwork, chapters, duplicate candidates, and multipart groups.',
      usage: 'library-audit <sources...> --report FILE [--concurrency N] [--strict]',
    },
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
    cli: {
      name: 'select',
      parse: (args) => {
        const valued = new Set(['--inventory', '--report']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('select accepts only named options.');
        return {
          inventory: requiredOption(args, '--inventory', 'select'),
          report: requiredOption(args, '--report', 'select'),
        };
      },
      summary: 'Choose the strongest source among normalized collisions.',
      usage: 'select --inventory FILE --report FILE',
    },
    handler: operations.select,
    id: 'select',
    inputSchema: z.object({ inventory: pathSchema, report: pathSchema.optional() }).strict(),
    resultSchema: selectionResultSchema,
  }),
});
