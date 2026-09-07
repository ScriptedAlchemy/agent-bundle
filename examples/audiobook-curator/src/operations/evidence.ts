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
    resultSchema: acousticIdentifyResultSchema,
  },
  whisperVerify: {
    handler: verifyWithWhisper,
    id: 'whisper-verify',
    resultSchema: whisperResultSchema,
  },
});
