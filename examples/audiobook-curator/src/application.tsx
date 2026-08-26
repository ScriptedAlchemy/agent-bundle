import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  defineOperation,
  defineRscAgentBundle,
  type RscOperationContext,
} from '@agent-bundle/rsc-runtime/plugin';
import React from 'react';
import { z } from 'zod';

import {
  cacheAudibleEdition,
  searchAudible,
  selectAudibleEdition,
  type AudibleCacheInput,
  type AudibleCacheReceipt,
  type AudibleSearchInput,
  type AudibleSearchReceipt,
  type AudibleSelectionReceipt,
  type AudibleRegion,
} from './audible.ts';
import {
  auditAudiobook,
  inspectSources,
  prepareAudiobook,
  type AuditInput,
  type AuditReceipt,
  type InspectionReceipt,
  type PrepareInput,
  type PrepareReceipt,
} from './curator-core.ts';
import { convertAudiobook, type ConvertInput, type ConvertReceipt } from './conversion.ts';
import { readJson, writeReceipt } from './foundation.ts';
import {
  auditLibrary,
  createInventory,
  selectInventorySources,
  type InventoryReceipt,
  type LibraryAuditReceipt,
  type SelectionReceipt,
} from './library.ts';
import { CuratorResult } from './result.tsx';

export interface AudiobookCuratorOperations {
  readonly audibleCache?: (input: AudibleCacheInput, options: RscOperationContext) => Promise<AudibleCacheReceipt>;
  readonly audibleSearch?: (input: AudibleSearchInput, options: RscOperationContext) => Promise<AudibleSearchReceipt>;
  readonly audibleSelect?: (
    input: { readonly candidate: number; readonly candidates: string; readonly note?: string; readonly receipt?: string },
    options: RscOperationContext,
  ) => Promise<AudibleSelectionReceipt>;
  readonly audit: (input: AuditInput, options: RscOperationContext) => Promise<AuditReceipt>;
  readonly convert?: (input: ConvertInput, options: RscOperationContext) => Promise<ConvertReceipt>;
  readonly inspect: (
    input: { readonly maxFiles?: number; readonly root: string },
    options: RscOperationContext,
  ) => Promise<InspectionReceipt>;
  readonly inventory?: (
    input: { readonly report?: string; readonly source: string; readonly strict?: boolean },
    options: RscOperationContext,
  ) => Promise<InventoryReceipt>;
  readonly libraryAudit?: (
    input: { readonly concurrency?: number; readonly report?: string; readonly sources: readonly string[]; readonly strict?: boolean },
    options: RscOperationContext,
  ) => Promise<LibraryAuditReceipt>;
  readonly prepare: (input: PrepareInput, options: RscOperationContext) => Promise<PrepareReceipt>;
  readonly select?: (
    input: { readonly inventory: string; readonly report?: string },
    options: RscOperationContext,
  ) => Promise<SelectionReceipt>;
}

const defaultOperations: Required<AudiobookCuratorOperations> = {
  audibleCache: (input, options) => cacheAudibleEdition(input, options),
  audibleSearch: (input, options) => searchAudible(input, options),
  audibleSelect: async (input) => {
    const report = audibleSearchResultSchema.parse(await readJson(input.candidates));
    const receipt = selectAudibleEdition(report, {
      candidate: input.candidate,
      candidateReport: input.candidates,
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    if (input.receipt !== undefined) await writeReceipt(input.receipt, receipt, [input.candidates]);
    return receipt;
  },
  audit: (input, options) => auditAudiobook(input, options),
  convert: (input, options) => convertAudiobook(input, options),
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
  prepare: (input, options) => prepareAudiobook(input, options),
  select: async (input) => {
    const inventory = inventoryResultSchema.parse(await readJson(input.inventory));
    const receipt = selectInventorySources(inventory, input.inventory);
    if (input.report !== undefined) await writeReceipt(input.report, receipt, [input.inventory]);
    return receipt;
  },
};

const pathSchema = z.string().min(1).max(4096);
const audibleRegions = ['au', 'ca', 'de', 'es', 'fr', 'in', 'it', 'jp', 'uk', 'us'] as const;
const tagsSchema = z.record(z.string().max(128), z.string().max(4096));
const probeShape = {
  channels: z.number().nonnegative().optional(),
  codec: z.string(),
  durationSeconds: z.number().nonnegative(),
  format: z.string(),
  sampleRate: z.number().nonnegative().optional(),
  tags: tagsSchema,
};
const probeSchema = z.object(probeShape).strict();
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
const prepareInputSchema = z.object({
  apply: z.boolean().optional(),
  outputName: z.string().min(5).max(204).optional(),
  outputRoot: pathSchema,
  source: pathSchema,
}).strict();
const prepareResultSchema = z.object({
  applied: z.boolean(),
  operation: z.literal('prepare'),
  output: pathSchema,
  probe: probeSchema,
  source: pathSchema,
}).strict();
const auditInputSchema = z.object({
  fullDecode: z.boolean().optional(),
  source: pathSchema,
}).strict();
const auditResultSchema = z.object({
  bytes: z.number().int().nonnegative(),
  fullDecode: z.boolean(),
  operation: z.literal('audit'),
  probe: probeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: pathSchema,
}).strict();
const parityReceiptSchema = <T extends { readonly generatedAt: string; readonly mutation: boolean; readonly operation: string }>(
  operation: T['operation'],
): z.ZodType<T> => z.object({
  generatedAt: z.string().min(1),
  mutation: z.boolean(),
  operation: z.literal(operation),
}).catchall(z.json()) as unknown as z.ZodType<T>;
const inventoryResultSchema = parityReceiptSchema<InventoryReceipt>('inventory');
const libraryResultSchema = parityReceiptSchema<LibraryAuditReceipt>('library-audit');
const selectionResultSchema = parityReceiptSchema<SelectionReceipt>('quality-selection');
const convertResultSchema = parityReceiptSchema<ConvertReceipt>('convert');
const audibleEvidenceSchema = z.object({
  authorMatch: z.boolean(), durationDifferencePercent: z.number().nonnegative().optional(), language: z.string().optional(),
  languageMatch: z.boolean(), narratorMatch: z.boolean(), score: z.number(), strictIdentityMatch: z.boolean(),
  titleMatch: z.boolean(), unabridged: z.boolean(),
}).strict();
const audibleCandidateSchema = z.object({ evidence: audibleEvidenceSchema, region: z.enum(audibleRegions) }).passthrough();
const audibleSearchResultSchema: z.ZodType<AudibleSearchReceipt> = z.object({
  candidates: z.array(audibleCandidateSchema).max(500),
  errors: z.array(z.object({ error: z.string().max(4096), region: audibleCandidateSchema.shape.region }).strict()).max(10),
  exitCode: z.union([z.literal(0), z.literal(1)]), generatedAt: z.string(), humanReviewRequired: z.literal(true),
  mutation: z.literal(false), operation: z.literal('audible-search'),
  query: z.object({ author: z.string().optional(), durationSeconds: z.number().positive().optional(), narrator: z.string().optional(), title: z.string() }).strict(),
  reviewNote: z.string(),
}).strict() as z.ZodType<AudibleSearchReceipt>;
const audibleSelectResultSchema = parityReceiptSchema<AudibleSelectionReceipt>('audible-select');
const audibleCacheResultSchema = parityReceiptSchema<AudibleCacheReceipt>('audible-cache');

const optionValue = (args: readonly string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
};

const assertOptions = (args: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>): void => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) continue;
    if (flags.has(argument)) continue;
    if (valued.has(argument)) {
      index += 1;
      if (args[index] === undefined || args[index]!.startsWith('--')) throw new Error(`${argument} requires a value.`);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
};

const positionalArguments = (args: readonly string[], valued: ReadonlySet<string>): readonly string[] => {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valued.has(args[index]!)) {
      index += 1;
    } else if (!args[index]!.startsWith('--')) {
      positional.push(args[index]!);
    }
  }
  return positional;
};

const onePath = (args: readonly string[], valued: ReadonlySet<string>, command: string): string => {
  const positional = positionalArguments(args, valued);
  if (positional.length !== 1) throw new Error(`${command} requires exactly one path.`);
  return positional[0]!;
};

const requiredOption = (args: readonly string[], option: string, command: string): string => {
  const value = optionValue(args, option);
  if (value === undefined) throw new Error(`${command} requires ${option}.`);
  return value;
};

const optionChoice = <T extends string>(
  args: readonly string[],
  option: string,
  choices: readonly T[],
): T | undefined => {
  const value = optionValue(args, option);
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) throw new Error(`${option} must be one of: ${choices.join(', ')}.`);
  return value as T;
};

const audibleRegionList = (value: string): readonly AudibleRegion[] => value.split(',').map((region) => {
  const candidate = region.trim().toLowerCase();
  if (!audibleRegions.includes(candidate as AudibleRegion)) throw new Error(`Unsupported Audible region: ${candidate}.`);
  return candidate as AudibleRegion;
});

const createOperations = (operations: Required<AudiobookCuratorOperations>) => Object.freeze([
  defineOperation({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'audible-search',
      parse: (args) => {
        const valued = new Set(['--attempts', '--author', '--duration', '--limit', '--narrator', '--regions', '--report', '--title']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('audible-search accepts only named options.');
        const attempts = optionValue(args, '--attempts');
        const duration = optionValue(args, '--duration');
        const limit = optionValue(args, '--limit');
        const regions = optionValue(args, '--regions');
        return {
          ...(attempts === undefined ? {} : { attempts: Number(attempts) }),
          ...(optionValue(args, '--author') === undefined ? {} : { author: optionValue(args, '--author') }),
          ...(duration === undefined ? {} : { durationSeconds: Number(duration) }),
          ...(limit === undefined ? {} : { limit: Number(limit) }),
          ...(optionValue(args, '--narrator') === undefined ? {} : { narrator: optionValue(args, '--narrator') }),
          ...(regions === undefined ? {} : { regions: audibleRegionList(regions) }),
          report: requiredOption(args, '--report', 'audible-search'),
          title: requiredOption(args, '--title', 'audible-search'),
        };
      },
      summary: 'Search and rank Audible identity candidates across reviewed regions.',
      usage: 'audible-search --title TITLE --report FILE [--author AUTHOR] [--narrator NARRATOR] [--duration SECONDS] [--regions LIST]',
    },
    execute: operations.audibleSearch,
    id: 'audible-search',
    inputSchema: z.object({
      attempts: z.number().int().min(1).max(10).optional(), author: z.string().min(1).max(512).optional(),
      durationSeconds: z.number().positive().optional(), limit: z.number().int().min(1).max(50).optional(),
      narrator: z.string().min(1).max(512).optional(), regions: z.array(audibleCandidateSchema.shape.region).min(1).max(10).optional(),
      report: pathSchema.optional(), title: z.string().min(1).max(1024),
    }).strict(),
    mcp: { description: 'Search Audible regions and return ranked identity evidence requiring human review.', name: 'search_audible', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: audibleSearchResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'audible-select',
      parse: (args) => {
        const valued = new Set(['--candidate', '--candidates', '--note', '--receipt']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('audible-select accepts only named options.');
        return {
          candidate: Number(requiredOption(args, '--candidate', 'audible-select')),
          candidates: requiredOption(args, '--candidates', 'audible-select'),
          ...(optionValue(args, '--note') === undefined ? {} : { note: optionValue(args, '--note') }),
          receipt: requiredOption(args, '--receipt', 'audible-select'),
        };
      },
      summary: 'Record one explicit human-reviewed Audible edition choice.',
      usage: 'audible-select --candidates FILE --candidate N --receipt FILE [--note NOTE]',
    },
    execute: operations.audibleSelect,
    id: 'audible-select',
    inputSchema: z.object({ candidate: z.number().int().min(1).max(500), candidates: pathSchema, note: z.string().max(4096).optional(), receipt: pathSchema.optional() }).strict(),
    mcp: { description: 'Record an explicit human-reviewed Audible edition choice from a candidate report.', name: 'select_audible_edition', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: audibleSelectResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'audible-cache',
      parse: (args) => {
        const valued = new Set(['--asin', '--attempts', '--cache-dir', '--receipt', '--region']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('audible-cache accepts only named options.');
        const attempts = optionValue(args, '--attempts');
        return {
          asin: requiredOption(args, '--asin', 'audible-cache'),
          ...(attempts === undefined ? {} : { attempts: Number(attempts) }),
          cacheDirectory: requiredOption(args, '--cache-dir', 'audible-cache'),
          receipt: requiredOption(args, '--receipt', 'audible-cache'),
          ...(optionChoice(args, '--region', audibleRegions) === undefined ? {} : { region: optionChoice(args, '--region', audibleRegions) }),
        };
      },
      summary: 'Cache one reviewed Audible product, chapters, artwork, and source URLs.',
      usage: 'audible-cache --asin ASIN --region REGION --cache-dir DIR --receipt FILE',
    },
    execute: operations.audibleCache,
    id: 'audible-cache',
    inputSchema: z.object({
      asin: z.string().min(1).max(64), attempts: z.number().int().min(1).max(10).optional(), cacheDirectory: pathSchema,
      receipt: pathSchema.optional(), region: audibleCandidateSchema.shape.region.optional(),
    }).strict(),
    mcp: { description: 'Cache a reviewed Audible edition and retained source evidence.', name: 'cache_audible_edition', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: audibleCacheResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'inspect',
      parse: (args) => {
        const valued = new Set(['--max-files']);
        assertOptions(args, new Set(), valued);
        const maximum = optionValue(args, '--max-files');
        return {
          ...(maximum === undefined ? {} : { maxFiles: Number(maximum) }),
          root: onePath(args, valued, 'inspect'),
        };
      },
      summary: 'Inspect a bounded audiobook source tree without changing it.',
      usage: 'inspect [--max-files N] <root>',
    },
    execute: operations.inspect,
    id: 'inspect',
    inputSchema: inspectInputSchema,
    mcp: {
      description: 'Inspect a bounded directory tree and report supported audiobook media without changing it.',
      name: 'inspect_sources',
      readOnly: true,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: inspectResultSchema,
  }),
  defineOperation({
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
    execute: operations.inventory,
    id: 'inventory',
    inputSchema: z.object({ report: pathSchema.optional(), source: pathSchema, strict: z.boolean().optional() }).strict(),
    mcp: {
      description: 'Inventory source audio with retained per-file probe evidence.',
      name: 'inventory_sources',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: inventoryResultSchema,
  }),
  defineOperation({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'library-audit',
      parse: (args) => {
        const valued = new Set(['--concurrency', '--report']);
        assertOptions(args, new Set(['--strict']), valued);
        const concurrency = optionValue(args, '--concurrency');
        const sources = positionalArguments(args, valued);
        if (sources.length === 0) throw new Error('library-audit requires at least one source path.');
        return {
          ...(concurrency === undefined ? {} : { concurrency: Number(concurrency) }),
          report: requiredOption(args, '--report', 'library-audit'),
          sources,
          ...(args.includes('--strict') ? { strict: true } : {}),
        };
      },
      summary: 'Audit metadata, artwork, chapters, duplicate candidates, and multipart groups.',
      usage: 'library-audit <sources...> --report FILE [--concurrency N] [--strict]',
    },
    execute: operations.libraryAudit,
    id: 'library-audit',
    inputSchema: z.object({
      concurrency: z.number().int().min(1).max(8).optional(),
      report: pathSchema.optional(),
      sources: z.array(pathSchema).min(1).max(64),
      strict: z.boolean().optional(),
    }).strict(),
    mcp: {
      description: 'Audit audiobook library metadata, duplicates, and multipart evidence without deletion advice.',
      name: 'audit_library',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: libraryResultSchema,
  }),
  defineOperation({
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
    execute: operations.select,
    id: 'select',
    inputSchema: z.object({ inventory: pathSchema, report: pathSchema.optional() }).strict(),
    mcp: {
      description: 'Select strongest source encodings while retaining alternates and duration review evidence.',
      name: 'select_sources',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: selectionResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'convert',
      parse: (args) => {
        const valued = new Set([
          '--artwork', '--audio-bitrate', '--audio-codec', '--author', '--engine', '--forge-aac-encoder',
          '--forge-cli', '--jobs', '--language', '--narrator', '--output', '--receipt', '--selection', '--title', '--year',
        ]);
        assertOptions(args, new Set(['--apply', '--overwrite']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('convert accepts only named options.');
        const audioCodec = optionChoice(args, '--audio-codec', ['aac', 'alac'] as const);
        const engine = optionChoice(args, '--engine', ['audiobook-forge', 'ffmpeg'] as const);
        const jobs = optionValue(args, '--jobs');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...(args.includes('--overwrite') ? { overwrite: true } : {}),
          ...(optionValue(args, '--artwork') === undefined ? {} : { artwork: optionValue(args, '--artwork') }),
          ...(optionValue(args, '--audio-bitrate') === undefined ? {} : { audioBitrate: optionValue(args, '--audio-bitrate') }),
          ...(audioCodec === undefined ? {} : { audioCodec }),
          author: requiredOption(args, '--author', 'convert'),
          ...(engine === undefined ? {} : { engine }),
          ...(optionValue(args, '--forge-aac-encoder') === undefined ? {} : { forgeAacEncoder: optionValue(args, '--forge-aac-encoder') }),
          ...(optionValue(args, '--forge-cli') === undefined ? {} : { forgeCli: optionValue(args, '--forge-cli') }),
          ...(jobs === undefined ? {} : { jobs: Number(jobs) }),
          ...(optionValue(args, '--language') === undefined ? {} : { language: optionValue(args, '--language') }),
          ...(optionValue(args, '--narrator') === undefined ? {} : { narrator: optionValue(args, '--narrator') }),
          output: requiredOption(args, '--output', 'convert'),
          receipt: requiredOption(args, '--receipt', 'convert'),
          selection: requiredOption(args, '--selection', 'convert'),
          title: requiredOption(args, '--title', 'convert'),
          ...(optionValue(args, '--year') === undefined ? {} : { year: optionValue(args, '--year') }),
        };
      },
      summary: 'Plan or apply a verified conversion to one chaptered M4B.',
      usage: 'convert --selection FILE --output PATH --receipt FILE --title TITLE --author AUTHOR [--apply] [--overwrite]',
    },
    execute: operations.convert,
    id: 'convert',
    inputSchema: z.object({
      apply: z.boolean().optional(), artwork: pathSchema.optional(), audioBitrate: z.string().min(2).max(32).optional(),
      audioCodec: z.enum(['aac', 'alac']).optional(), author: z.string().min(1).max(512),
      engine: z.enum(['audiobook-forge', 'ffmpeg']).optional(), forgeAacEncoder: z.string().min(1).max(128).optional(),
      forgeCli: pathSchema.optional(), jobs: z.number().int().min(0).max(256).optional(), language: z.string().min(1).max(64).optional(),
      narrator: z.string().min(1).max(512).optional(), output: pathSchema, overwrite: z.boolean().optional(), receipt: pathSchema.optional(),
      selection: pathSchema, title: z.string().min(1).max(1024), year: z.string().min(1).max(64).optional(),
    }).strict(),
    mcp: {
      description: 'Plan or explicitly apply a verified FFmpeg or Audiobook Forge conversion while preserving sources.',
      name: 'convert_audiobook',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: convertResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'prepare',
      parse: (args) => {
        const valued = new Set(['--name', '--output']);
        assertOptions(args, new Set(['--apply']), valued);
        const outputRoot = optionValue(args, '--output');
        if (outputRoot === undefined) throw new Error('prepare requires --output.');
        const outputName = optionValue(args, '--name');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...(outputName === undefined ? {} : { outputName }),
          outputRoot,
          source: onePath(args, valued, 'prepare'),
        };
      },
      summary: 'Plan an M4B output or apply the plan when explicitly requested.',
      usage: 'prepare [--apply] [--name FILE] --output DIR <source>',
    },
    execute: operations.prepare,
    id: 'prepare',
    inputSchema: prepareInputSchema,
    mcp: {
      description: 'Plan an M4B output, or apply the plan only when apply is explicitly true.',
      name: 'prepare_audiobook',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: prepareResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'audit',
      parse: (args) => {
        assertOptions(args, new Set(['--full-decode']), new Set());
        return {
          ...(args.includes('--full-decode') ? { fullDecode: true } : {}),
          source: onePath(args, new Set(), 'audit'),
        };
      },
      summary: 'Probe and hash one audiobook, optionally decoding the complete audio stream.',
      usage: 'audit [--full-decode] <source>',
    },
    execute: operations.audit,
    id: 'audit',
    inputSchema: auditInputSchema,
    mcp: {
      description: 'Probe and hash one audiobook, with optional full audio decode.',
      name: 'audit_audiobook',
      readOnly: true,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: auditResultSchema,
  }),
]);

export const createAudiobookCuratorApplication = (
  options: { readonly operations?: AudiobookCuratorOperations } = {},
) => {
  const definitions = createOperations({ ...defaultOperations, ...options.operations });
  return defineRscAgentBundle(
    <AgentBundle
      description="Plan-first audiobook inventory, preparation, and integrity audit."
      marketplace
      name="audiobook-curator"
      node="22.19.0"
      targets={['claude', 'codex']}
      version="1.0.0"
    >
      <Skill source="./skills/curate-audiobooks" />
      <Script entry="./src/cli-entry.ts" name="audiobook-curator" />
      <McpServer entry="./src/mcp-server.ts" name="curator" />
      {definitions.map((definition) => <Operation definition={definition} key={definition.id} />)}
    </AgentBundle>,
  );
};

export const audiobookCuratorApplication = createAudiobookCuratorApplication();
