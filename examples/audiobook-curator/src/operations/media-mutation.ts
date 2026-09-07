/**
 * Plan-first derived-media repair operations: `apply-metadata` and
 * `apply-chapters`, backed by `../media-mutation.ts`.
 */
import {
  applyAudiobookChapters,
  applyAudiobookMetadata,
  type ChapterReceipt,
  type MetadataReceipt,
} from '../media-mutation.ts';
import { parityReceiptSchema } from './schemas.ts';

const metadataResultSchema = parityReceiptSchema<MetadataReceipt>('apply-metadata');
const chaptersResultSchema = parityReceiptSchema<ChapterReceipt>('apply-chapters');

export const mediaMutationOperations = Object.freeze({
  applyMetadata: {
    handler: applyAudiobookMetadata,
    id: 'apply-metadata',
    resultSchema: metadataResultSchema,
  },
  applyChapters: {
    handler: applyAudiobookChapters,
    id: 'apply-chapters',
    resultSchema: chaptersResultSchema,
  },
});
