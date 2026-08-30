/**
 * Audible catalog-identity operations: `audible-search`, `audible-select`,
 * and `audible-cache`, backed by `../audible.ts`. Ranking is evidence only;
 * `audible-select` records the required human edition choice.
 */
import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';
import React from 'react';
import { z } from 'zod';

import {
  cacheAudibleEdition,
  searchAudible,
  selectAudibleEdition,
  type AudibleCacheInput,
  type AudibleCacheReceipt,
  type AudibleRegion,
  type AudibleSearchInput,
  type AudibleSearchReceipt,
  type AudibleSelectionReceipt,
} from '../audible.ts';
import { readJson, writeReceipt } from '../foundation.ts';
import { CuratorResult } from '../result.tsx';
import {
  assertOptions,
  optionChoice,
  optionValue,
  positionalArguments,
  requiredOption,
} from './cli-arguments.ts';
import { audibleRegions, audibleRegionSchema, parityReceiptSchema, pathSchema } from './schemas.ts';

export interface AudibleOperations {
  readonly audibleCache?: (input: AudibleCacheInput, options: RscOperationContext) => Promise<AudibleCacheReceipt>;
  readonly audibleSearch?: (input: AudibleSearchInput, options: RscOperationContext) => Promise<AudibleSearchReceipt>;
  readonly audibleSelect?: (
    input: { readonly candidate: number; readonly candidates: string; readonly note?: string; readonly receipt?: string },
    options: RscOperationContext,
  ) => Promise<AudibleSelectionReceipt>;
}

const audibleEvidenceSchema = z.object({
  authorMatch: z.boolean(), durationDifferencePercent: z.number().nonnegative().optional(), language: z.string().optional(),
  languageMatch: z.boolean(), narratorMatch: z.boolean(), score: z.number(), strictIdentityMatch: z.boolean(),
  titleMatch: z.boolean(), unabridged: z.boolean(),
}).strict();
const audibleCandidateSchema = z.object({ evidence: audibleEvidenceSchema, region: audibleRegionSchema }).passthrough();
export const audibleSearchResultSchema: z.ZodType<AudibleSearchReceipt> = z.object({
  candidates: z.array(audibleCandidateSchema).max(500),
  errors: z.array(z.object({ error: z.string().max(4096), region: audibleRegionSchema }).strict()).max(10),
  exitCode: z.union([z.literal(0), z.literal(1)]), generatedAt: z.string(), humanReviewRequired: z.literal(true),
  mutation: z.literal(false), operation: z.literal('audible-search'),
  query: z.object({ author: z.string().optional(), durationSeconds: z.number().positive().optional(), narrator: z.string().optional(), title: z.string() }).strict(),
  reviewNote: z.string(),
}).strict() as z.ZodType<AudibleSearchReceipt>;
const audibleSelectResultSchema = parityReceiptSchema<AudibleSelectionReceipt>('audible-select');
const audibleCacheResultSchema = parityReceiptSchema<AudibleCacheReceipt>('audible-cache');

export const defaultAudibleOperations: Required<AudibleOperations> = {
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
};

const audibleRegionList = (value: string): readonly AudibleRegion[] => value.split(',').map((region) => {
  const candidate = region.trim().toLowerCase();
  if (!audibleRegions.includes(candidate as AudibleRegion)) throw new Error(`Unsupported Audible region: ${candidate}.`);
  return candidate as AudibleRegion;
});

export const audibleOperations = (operations: Required<AudibleOperations>) => [
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
      narrator: z.string().min(1).max(512).optional(), regions: z.array(audibleRegionSchema).min(1).max(10).optional(),
      report: pathSchema.optional(), title: z.string().min(1).max(1024),
    }).strict(),
    mcp: { description: 'Search Audible regions and return ranked identity evidence requiring human review.', name: 'search_audible', openWorld: true, readOnly: false, server: 'curator' },
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
      receipt: pathSchema.optional(), region: audibleRegionSchema.optional(),
    }).strict(),
    mcp: { description: 'Cache a reviewed Audible edition and retained source evidence.', name: 'cache_audible_edition', openWorld: true, readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: audibleCacheResultSchema,
  }),
];
