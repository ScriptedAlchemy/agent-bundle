/**
 * Plan-first derived-media repair operations: `apply-metadata` and
 * `apply-chapters`, backed by `../media-mutation.ts`.
 */
import { z } from 'zod';

import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  type ChapterReceipt,
  type MetadataReceipt,
} from '../media-mutation.ts';
import { parityReceiptSchema, pathSchema } from './schemas.ts';

const metadataResultSchema = parityReceiptSchema<MetadataReceipt>('apply-metadata');
const chaptersResultSchema = parityReceiptSchema<ChapterReceipt>('apply-chapters');

export const mediaMutationOperations = Object.freeze({
  applyMetadata: {
    handler: applyAudiobookMetadata,
    id: 'apply-metadata',
    inputSchema: z.object({
      apply: z.boolean().optional(), artwork: pathSchema.optional(), author: z.string().max(512).optional(), file: pathSchema,
      language: z.string().min(1).max(64).optional(), narrator: z.string().max(512).optional(), product: pathSchema,
      receipt: pathSchema.optional(), title: z.string().max(1024).optional(), year: z.string().max(64).optional(),
    }).strict(),
    resultSchema: metadataResultSchema,
  },
  applyChapters: {
    handler: applyAudiobookChapters,
    id: 'apply-chapters',
    inputSchema: z.object({ apply: z.boolean().optional(), chapters: pathSchema, file: pathSchema, receipt: pathSchema.optional() }).strict(),
    resultSchema: chaptersResultSchema,
  },
});
