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
    resultSchema: convertResultSchema,
  },
  prepare: {
    handler: prepareAudiobook,
    id: 'prepare',
    resultSchema: prepareResultSchema,
  },
  audit: {
    handler: auditAudiobookIntegrity,
    id: 'audit',
    resultSchema: auditResultSchema,
  },
});
