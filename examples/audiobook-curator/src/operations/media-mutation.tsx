/**
 * Plan-first derived-media repair operations: `apply-metadata` and
 * `apply-chapters`, backed by `../media-mutation.ts`.
 */
import { defineOperation, type RscOperationContext } from '@agent-bundle/rsc-runtime/plugin';
import React from 'react';
import { z } from 'zod';

import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  type ChapterInput,
  type ChapterReceipt,
  type MetadataInput,
  type MetadataReceipt,
} from '../media-mutation.ts';
import { CuratorResult } from '../result.tsx';
import {
  assertOptions,
  optionValue,
  optionalField,
  positionalArguments,
  requiredOption,
} from './cli-arguments.ts';
import { parityReceiptSchema, pathSchema } from './schemas.ts';

export interface MediaMutationOperations {
  readonly applyChapters?: (input: ChapterInput, options: RscOperationContext) => Promise<ChapterReceipt>;
  readonly applyMetadata?: (input: MetadataInput, options: RscOperationContext) => Promise<MetadataReceipt>;
}

export const defaultMediaMutationOperations: Required<MediaMutationOperations> = {
  applyChapters: (input, options) => applyAudiobookChapters(input, options),
  applyMetadata: (input, options) => applyAudiobookMetadata(input, options),
};

const metadataResultSchema = parityReceiptSchema<MetadataReceipt>('apply-metadata');
const chaptersResultSchema = parityReceiptSchema<ChapterReceipt>('apply-chapters');

export const mediaMutationOperations = (operations: Required<MediaMutationOperations>) => [
  defineOperation({
    cli: {
      name: 'apply-metadata',
      parse: (args) => {
        const valued = new Set(['--artwork', '--author', '--file', '--language', '--narrator', '--product', '--receipt', '--title', '--year']);
        assertOptions(args, new Set(['--apply']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('apply-metadata accepts only named options.');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...optionalField('artwork', optionValue(args, '--artwork')),
          ...optionalField('author', optionValue(args, '--author')),
          file: requiredOption(args, '--file', 'apply-metadata'),
          ...optionalField('language', optionValue(args, '--language')),
          ...optionalField('narrator', optionValue(args, '--narrator')),
          product: requiredOption(args, '--product', 'apply-metadata'),
          receipt: requiredOption(args, '--receipt', 'apply-metadata'),
          ...optionalField('title', optionValue(args, '--title')),
          ...optionalField('year', optionValue(args, '--year')),
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
    mcp: { description: 'Plan or explicitly apply verified catalog metadata and artwork while preserving every audio stream.', destructive: true, name: 'apply_audiobook_metadata', readOnly: false, server: 'curator' },
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
    mcp: { description: 'Plan or explicitly apply verified chapter rows while preserving all non-chapter media state.', destructive: true, name: 'apply_audiobook_chapters', readOnly: false, server: 'curator' },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: chaptersResultSchema,
  }),
];
