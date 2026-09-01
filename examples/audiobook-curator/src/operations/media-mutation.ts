/**
 * Plan-first derived-media repair operations: `apply-metadata` and
 * `apply-chapters`, backed by `../media-mutation.ts`.
 */
import { defineCliCommand, type CliCommandContext } from '../cli-command.js';
import { z } from 'zod';

import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  type ChapterInput,
  type ChapterReceipt,
  type MetadataInput,
  type MetadataReceipt,
} from '../media-mutation.ts';
import { parityReceiptSchema, pathSchema } from './schemas.ts';

export interface MediaMutationOperations {
  readonly applyChapters?: (input: ChapterInput, options: CliCommandContext) => Promise<ChapterReceipt>;
  readonly applyMetadata?: (input: MetadataInput, options: CliCommandContext) => Promise<MetadataReceipt>;
}

export const defaultMediaMutationOperations: Required<MediaMutationOperations> = {
  applyChapters: (input, options) => applyAudiobookChapters(input, options),
  applyMetadata: (input, options) => applyAudiobookMetadata(input, options),
};

const metadataResultSchema = parityReceiptSchema<MetadataReceipt>('apply-metadata');
const chaptersResultSchema = parityReceiptSchema<ChapterReceipt>('apply-chapters');

export const mediaMutationOperations = (operations: Required<MediaMutationOperations>) => ({
  applyMetadata: defineCliCommand({
    handler: operations.applyMetadata,
    id: 'apply-metadata',
    inputSchema: z.object({
      apply: z.boolean().optional(), artwork: pathSchema.optional(), author: z.string().max(512).optional(), file: pathSchema,
      language: z.string().min(1).max(64).optional(), narrator: z.string().max(512).optional(), product: pathSchema,
      receipt: pathSchema.optional(), title: z.string().max(1024).optional(), year: z.string().max(64).optional(),
    }).strict(),
    resultSchema: metadataResultSchema,
  }),
  applyChapters: defineCliCommand({
    handler: operations.applyChapters,
    id: 'apply-chapters',
    inputSchema: z.object({ apply: z.boolean().optional(), chapters: pathSchema, file: pathSchema, receipt: pathSchema.optional() }).strict(),
    resultSchema: chaptersResultSchema,
  }),
});
