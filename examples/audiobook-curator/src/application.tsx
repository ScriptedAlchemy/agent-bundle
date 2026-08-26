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
  inspectSources,
  prepareAudiobook,
  type InspectionReceipt,
  type PrepareInput,
  type PrepareReceipt,
} from './curator-core.ts';
import {
  auditAudiobookIntegrity,
  type IntegrityAuditInput,
  type IntegrityAuditReceipt,
} from './integrity-audit.ts';
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
import {
  identifyAudibleSample,
  verifyAudibleSample,
  verifyWithWhisper,
  type AcousticIdentifyReceipt,
  type AcousticReceipt,
  type AcousticVerifyInput,
  type WhisperInput,
  type WhisperReceipt,
} from './evidence.ts';
import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  type ChapterInput,
  type ChapterReceipt,
  type MetadataInput,
  type MetadataReceipt,
} from './media-mutation.ts';

export interface AudiobookCuratorOperations {
  readonly acousticIdentify?: (
    input: { readonly all?: boolean; readonly attempts?: number; readonly candidates: string; readonly chunkSeconds?: number; readonly file: string; readonly receipt?: string; readonly top?: number; readonly verbose?: boolean },
    options: RscOperationContext,
  ) => Promise<AcousticIdentifyReceipt>;
  readonly acousticVerify?: (input: AcousticVerifyInput, options: RscOperationContext) => Promise<AcousticReceipt>;
  readonly audibleCache?: (input: AudibleCacheInput, options: RscOperationContext) => Promise<AudibleCacheReceipt>;
  readonly audibleSearch?: (input: AudibleSearchInput, options: RscOperationContext) => Promise<AudibleSearchReceipt>;
  readonly audibleSelect?: (
    input: { readonly candidate: number; readonly candidates: string; readonly note?: string; readonly receipt?: string },
    options: RscOperationContext,
  ) => Promise<AudibleSelectionReceipt>;
  readonly audit: (input: IntegrityAuditInput, options: RscOperationContext) => Promise<IntegrityAuditReceipt>;
  readonly applyChapters?: (input: ChapterInput, options: RscOperationContext) => Promise<ChapterReceipt>;
  readonly applyMetadata?: (input: MetadataInput, options: RscOperationContext) => Promise<MetadataReceipt>;
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
  readonly whisperVerify?: (input: WhisperInput, options: RscOperationContext) => Promise<WhisperReceipt>;
}

const defaultOperations: Required<AudiobookCuratorOperations> = {
  acousticIdentify: async (input, options) => {
    const payload = await readJson(input.candidates);
    const rows = z.object({ candidates: z.array(z.record(z.string(), z.unknown())).max(500) }).passthrough().parse(payload).candidates;
    return identifyAudibleSample({
      ...input,
      candidates: rows,
      candidatesReport: input.candidates,
    }, options);
  },
  acousticVerify: (input, options) => verifyAudibleSample(input, options),
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
  applyChapters: (input, options) => applyAudiobookChapters(input, options),
  applyMetadata: (input, options) => applyAudiobookMetadata(input, options),
  audit: (input, options) => auditAudiobookIntegrity(input, options),
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
  whisperVerify: (input, options) => verifyWithWhisper(input, options),
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
const metadataResultSchema = parityReceiptSchema<MetadataReceipt>('apply-metadata');
const chaptersResultSchema = parityReceiptSchema<ChapterReceipt>('apply-chapters');
const acousticResultSchema = parityReceiptSchema<AcousticReceipt>('audiolocate');
const acousticIdentifyResultSchema = parityReceiptSchema<AcousticIdentifyReceipt>('acoustic-identify');
const whisperResultSchema = parityReceiptSchema<WhisperReceipt>('whisper-identity');
const auditResultSchema = parityReceiptSchema<IntegrityAuditReceipt>('audit');

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
      name: 'acoustic-verify',
      parse: (args) => {
        const valued = new Set(['--asin', '--attempts', '--audiolocate-python', '--chunk-seconds', '--file', '--receipt', '--region', '--sample-url']);
        assertOptions(args, new Set(['--verbose']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('acoustic-verify accepts only named options.');
        const attempts = optionValue(args, '--attempts');
        const chunks = optionValue(args, '--chunk-seconds');
        return {
          asin: requiredOption(args, '--asin', 'acoustic-verify'),
          ...(attempts === undefined ? {} : { attempts: Number(attempts) }),
          ...(optionValue(args, '--audiolocate-python') === undefined ? {} : { audiolocatePython: optionValue(args, '--audiolocate-python') }),
          ...(chunks === undefined ? {} : { chunkSeconds: Number(chunks) }),
          file: requiredOption(args, '--file', 'acoustic-verify'),
          receipt: requiredOption(args, '--receipt', 'acoustic-verify'),
          ...(optionChoice(args, '--region', audibleRegions) === undefined ? {} : { region: optionChoice(args, '--region', audibleRegions) }),
          ...(optionValue(args, '--sample-url') === undefined ? {} : { sampleUrl: optionValue(args, '--sample-url') }),
          ...(args.includes('--verbose') ? { verbose: true } : {}),
        };
      },
      summary: 'Compare one bounded Audible sample with local audio through optional Audiolocate.',
      usage: 'acoustic-verify --file FILE --asin ASIN --region REGION --receipt FILE [--audiolocate-python PATH]',
    },
    execute: operations.acousticVerify,
    id: 'acoustic-verify',
    inputSchema: z.object({
      asin: z.string().min(1).max(64), attempts: z.number().int().min(1).max(10).optional(), audiolocatePython: pathSchema.optional(),
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      region: z.enum(audibleRegions).optional(), sampleUrl: z.url().optional(), verbose: z.boolean().optional(),
    }).strict(),
    mcp: { description: 'Compare a bounded Audible sample with local audio through an optional Audiolocate Python capability.', name: 'verify_audible_sample', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: acousticResultSchema,
  }),
  defineOperation({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'acoustic-identify',
      parse: (args) => {
        const valued = new Set(['--attempts', '--candidates', '--chunk-seconds', '--file', '--receipt', '--top']);
        assertOptions(args, new Set(['--all', '--verbose']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('acoustic-identify accepts only named options.');
        const attempts = optionValue(args, '--attempts');
        const chunks = optionValue(args, '--chunk-seconds');
        const top = optionValue(args, '--top');
        return {
          ...(args.includes('--all') ? { all: true } : {}),
          ...(attempts === undefined ? {} : { attempts: Number(attempts) }),
          candidates: requiredOption(args, '--candidates', 'acoustic-identify'),
          ...(chunks === undefined ? {} : { chunkSeconds: Number(chunks) }),
          file: requiredOption(args, '--file', 'acoustic-identify'),
          receipt: requiredOption(args, '--receipt', 'acoustic-identify'),
          ...(top === undefined ? {} : { top: Number(top) }),
          ...(args.includes('--verbose') ? { verbose: true } : {}),
        };
      },
      summary: 'Try score-ranked, deduplicated Audible candidates and retain per-candidate evidence.',
      usage: 'acoustic-identify --file FILE --candidates FILE --receipt FILE [--top N] [--all]',
    },
    execute: operations.acousticIdentify,
    id: 'acoustic-identify',
    inputSchema: z.object({
      all: z.boolean().optional(), attempts: z.number().int().min(1).max(10).optional(), candidates: pathSchema,
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      top: z.number().int().min(1).max(10).optional(), verbose: z.boolean().optional(),
    }).strict(),
    mcp: { description: 'Try ranked Audible candidates, retaining skips/errors and stopping at the first acoustic match by default.', name: 'identify_audible_sample', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: acousticIdentifyResultSchema,
  }),
  defineOperation({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'whisper-verify',
      parse: (args) => {
        const valued = new Set(['--author', '--file', '--language', '--max-windows', '--minimum-chars', '--model', '--receipt', '--threads', '--title', '--whisper-cli', '--window-seconds']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('whisper-verify accepts only named options.');
        return {
          ...(optionValue(args, '--author') === undefined ? {} : { author: optionValue(args, '--author') }),
          file: requiredOption(args, '--file', 'whisper-verify'),
          ...(optionValue(args, '--language') === undefined ? {} : { language: optionValue(args, '--language') }),
          ...(optionValue(args, '--max-windows') === undefined ? {} : { maxWindows: Number(optionValue(args, '--max-windows')) }),
          ...(optionValue(args, '--minimum-chars') === undefined ? {} : { minimumChars: Number(optionValue(args, '--minimum-chars')) }),
          model: requiredOption(args, '--model', 'whisper-verify'),
          receipt: requiredOption(args, '--receipt', 'whisper-verify'),
          ...(optionValue(args, '--threads') === undefined ? {} : { threads: Number(optionValue(args, '--threads')) }),
          ...(optionValue(args, '--title') === undefined ? {} : { title: optionValue(args, '--title') }),
          ...(optionValue(args, '--whisper-cli') === undefined ? {} : { whisperCli: optionValue(args, '--whisper-cli') }),
          ...(optionValue(args, '--window-seconds') === undefined ? {} : { windowSeconds: Number(optionValue(args, '--window-seconds')) }),
        };
      },
      summary: 'Transcribe distributed audiobook windows for human language and identity review.',
      usage: 'whisper-verify --file FILE --model FILE --receipt FILE [--language CODE] [--max-windows N]',
    },
    execute: operations.whisperVerify,
    id: 'whisper-verify',
    inputSchema: z.object({
      author: z.string().max(512).optional(), file: pathSchema, language: z.string().min(1).max(64).optional(),
      maxWindows: z.number().int().min(5).max(11).optional(), minimumChars: z.number().int().min(1).max(16_384).optional(),
      model: pathSchema, receipt: pathSchema.optional(), threads: z.number().int().min(1).max(256).optional(), title: z.string().max(1024).optional(),
      whisperCli: pathSchema.optional(), windowSeconds: z.number().int().min(1).max(3600).optional(),
    }).strict(),
    mcp: { description: 'Extract and transcribe distributed PCM windows for human language, story, and narrator review.', name: 'verify_with_whisper', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: whisperResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'apply-metadata',
      parse: (args) => {
        const valued = new Set(['--artwork', '--author', '--file', '--language', '--narrator', '--product', '--receipt', '--title', '--year']);
        assertOptions(args, new Set(['--apply']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('apply-metadata accepts only named options.');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...(optionValue(args, '--artwork') === undefined ? {} : { artwork: optionValue(args, '--artwork') }),
          ...(optionValue(args, '--author') === undefined ? {} : { author: optionValue(args, '--author') }),
          file: requiredOption(args, '--file', 'apply-metadata'),
          ...(optionValue(args, '--language') === undefined ? {} : { language: optionValue(args, '--language') }),
          ...(optionValue(args, '--narrator') === undefined ? {} : { narrator: optionValue(args, '--narrator') }),
          product: requiredOption(args, '--product', 'apply-metadata'),
          receipt: requiredOption(args, '--receipt', 'apply-metadata'),
          ...(optionValue(args, '--title') === undefined ? {} : { title: optionValue(args, '--title') }),
          ...(optionValue(args, '--year') === undefined ? {} : { year: optionValue(args, '--year') }),
        };
      },
      summary: 'Plan or apply verified Audible metadata and artwork without changing encoded audio.',
      usage: 'apply-metadata --file FILE --product FILE --receipt FILE [--artwork FILE] [--language CODE] [--apply]',
    },
    execute: operations.applyMetadata,
    id: 'apply-metadata',
    inputSchema: z.object({
      apply: z.boolean().optional(), artwork: pathSchema.optional(), author: z.string().max(512).optional(), file: pathSchema,
      language: z.string().min(1).max(64).optional(), narrator: z.string().max(512).optional(), product: pathSchema,
      receipt: pathSchema.optional(), title: z.string().max(1024).optional(), year: z.string().max(64).optional(),
    }).strict(),
    mcp: { description: 'Plan or explicitly apply verified catalog metadata and artwork while preserving every audio stream.', name: 'apply_audiobook_metadata', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: metadataResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'apply-chapters',
      parse: (args) => {
        const valued = new Set(['--chapters', '--file', '--receipt']);
        assertOptions(args, new Set(['--apply']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('apply-chapters accepts only named options.');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          chapters: requiredOption(args, '--chapters', 'apply-chapters'),
          file: requiredOption(args, '--file', 'apply-chapters'),
          receipt: requiredOption(args, '--receipt', 'apply-chapters'),
        };
      },
      summary: 'Plan or apply verified generic or Audible chapter rows without changing encoded audio.',
      usage: 'apply-chapters --file FILE --chapters FILE --receipt FILE [--apply]',
    },
    execute: operations.applyChapters,
    id: 'apply-chapters',
    inputSchema: z.object({ apply: z.boolean().optional(), chapters: pathSchema, file: pathSchema, receipt: pathSchema.optional() }).strict(),
    mcp: { description: 'Plan or explicitly apply verified chapter rows while preserving all non-chapter media state.', name: 'apply_audiobook_chapters', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: chaptersResultSchema,
  }),
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
      exitCode: (receipt) => receipt.exitCode,
      name: 'audit',
      parse: (args) => {
        const valued = new Set(['--conversion-receipt', '--file', '--receipt']);
        assertOptions(args, new Set(['--full-decode']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('audit accepts only named options.');
        return {
          ...(optionValue(args, '--conversion-receipt') === undefined ? {} : { conversionReceipt: optionValue(args, '--conversion-receipt') }),
          file: requiredOption(args, '--file', 'audit'),
          ...(args.includes('--full-decode') ? { fullDecode: true } : {}),
          receipt: requiredOption(args, '--receipt', 'audit'),
        };
      },
      summary: 'Validate metadata, chapters, source mapping, hashes, and optional complete decode.',
      usage: 'audit --file FILE --receipt FILE [--conversion-receipt FILE] [--full-decode]',
    },
    execute: operations.audit,
    id: 'audit',
    inputSchema: z.object({ conversionReceipt: pathSchema.optional(), file: pathSchema, fullDecode: z.boolean().optional(), receipt: pathSchema.optional() }).strict(),
    mcp: {
      description: 'Validate chapter structure, optional conversion mapping, file/audio hashes, probe facts, and optional full decode.',
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
