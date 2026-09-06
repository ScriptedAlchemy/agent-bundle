/**
 * Acoustic and transcript identity-evidence operations: `acoustic-verify`,
 * `acoustic-identify`, and `whisper-verify`, backed by `../evidence.ts`.
 */
import type { JsonObject } from '@agent-bundle/runtime';

import { z } from 'zod';

import type { CliCommandContext } from '../cli-command.js';
import {
  identifyAudibleSample,
  verifyAudibleSample,
  verifyWithWhisper,
  type AcousticIdentifyReceipt,
  type AcousticReceipt,
  type WhisperReceipt,
} from '../evidence.ts';
import { readJson } from '../foundation.ts';
import { audibleRegionSchema, parityReceiptSchema, pathSchema } from './schemas.ts';

const acousticResultSchema = parityReceiptSchema<AcousticReceipt>('audiolocate');
const acousticIdentifyResultSchema = parityReceiptSchema<AcousticIdentifyReceipt>('acoustic-identify');
const whisperResultSchema = parityReceiptSchema<WhisperReceipt>('whisper-identity');

export const evidenceOperations = Object.freeze({
  acousticVerify: {
    handler: verifyAudibleSample,
    id: 'acoustic-verify',
    inputSchema: z.object({
      asin: z.string().min(1).max(64), attempts: z.number().int().min(1).max(10).optional(), audiolocatePython: pathSchema.optional(),
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      region: audibleRegionSchema.optional(), sampleUrl: z.url().optional(), verbose: z.boolean().optional(),
    }).strict(),
    resultSchema: acousticResultSchema,
  },
  acousticIdentify: {
    handler: async (
      input: { readonly all?: boolean; readonly attempts?: number; readonly candidates: string; readonly chunkSeconds?: number; readonly file: string; readonly receipt?: string; readonly top?: number; readonly verbose?: boolean },
      options: CliCommandContext,
    ) => {
      const payload = await readJson(input.candidates);
      const rows = z.object({ candidates: z.array(z.record(z.string(), z.unknown())).max(500) })
        .passthrough().parse(payload).candidates as JsonObject[];
      return identifyAudibleSample({
        ...input,
        candidates: rows,
        candidatesReport: input.candidates,
      }, options);
    },
    id: 'acoustic-identify',
    inputSchema: z.object({
      all: z.boolean().optional(), attempts: z.number().int().min(1).max(10).optional(), candidates: pathSchema,
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      top: z.number().int().min(1).max(10).optional(), verbose: z.boolean().optional(),
    }).strict(),
    resultSchema: acousticIdentifyResultSchema,
  },
  whisperVerify: {
    handler: verifyWithWhisper,
    id: 'whisper-verify',
    inputSchema: z.object({
      author: z.string().max(512).optional(), file: pathSchema, language: z.string().min(1).max(64).optional(),
      maxWindows: z.number().int().min(5).max(11).optional(), minimumChars: z.number().int().min(1).max(16_384).optional(),
      model: pathSchema, receipt: pathSchema.optional(), threads: z.number().int().min(1).max(256).optional(), title: z.string().max(1024).optional(),
      whisperCli: pathSchema.optional(), windowSeconds: z.number().int().min(1).max(3600).optional(),
    }).strict(),
    resultSchema: whisperResultSchema,
  },
});
