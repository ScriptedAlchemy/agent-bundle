/**
 * Output production and verification operations: `convert`, `prepare`, and
 * `audit`, backed by `../conversion.ts`, `../curator-core.ts`, and
 * `../integrity-audit.ts`. Conversion and preparation plan by default and
 * mutate only a derived destination; the audit never mutates.
 */
import { z } from 'zod';

import { convertAudiobook, type ConvertReceipt } from '../conversion.ts';
import { prepareAudiobook } from '../curator-core.ts';
import { auditAudiobookIntegrity, type IntegrityAuditReceipt } from '../integrity-audit.ts';
import { parityReceiptSchema, pathSchema, probeSchema } from './schemas.ts';

const convertResultSchema = parityReceiptSchema<ConvertReceipt>('convert');
const auditResultSchema = parityReceiptSchema<IntegrityAuditReceipt>('audit');
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

export const outputOperations = Object.freeze({
  convert: {
    handler: convertAudiobook,
    id: 'convert',
    inputSchema: z.object({
      apply: z.boolean().optional(), artwork: pathSchema.optional(), audioBitrate: z.string().min(2).max(32).optional(),
      audioCodec: z.enum(['aac', 'alac']).optional(), author: z.string().min(1).max(512),
      engine: z.enum(['audiobook-forge', 'ffmpeg']).optional(), forgeAacEncoder: z.string().min(1).max(128).optional(),
      forgeCli: pathSchema.optional(), jobs: z.number().int().min(0).max(256).optional(), language: z.string().min(1).max(64).optional(),
      narrator: z.string().min(1).max(512).optional(), output: pathSchema, overwrite: z.boolean().optional(), receipt: pathSchema.optional(),
      selection: pathSchema, title: z.string().min(1).max(1024), year: z.string().min(1).max(64).optional(),
    }).strict(),
    resultSchema: convertResultSchema,
  },
  prepare: {
    handler: prepareAudiobook,
    id: 'prepare',
    inputSchema: prepareInputSchema,
    resultSchema: prepareResultSchema,
  },
  audit: {
    handler: auditAudiobookIntegrity,
    id: 'audit',
    inputSchema: z.object({ conversionReceipt: pathSchema.optional(), file: pathSchema, fullDecode: z.boolean().optional(), receipt: pathSchema.optional() }).strict(),
    resultSchema: auditResultSchema,
  },
});
