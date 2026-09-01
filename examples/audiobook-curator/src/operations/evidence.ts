/**
 * Acoustic and transcript identity-evidence operations: `acoustic-verify`,
 * `acoustic-identify`, and `whisper-verify`, backed by `../evidence.ts`.
 */
import { defineCliCommand, type CliCommandContext } from '../cli-command.js';
import { z } from 'zod';

import {
  identifyAudibleSample,
  verifyAudibleSample,
  verifyWithWhisper,
  type AcousticIdentifyReceipt,
  type AcousticReceipt,
  type AcousticVerifyInput,
  type WhisperInput,
  type WhisperReceipt,
} from '../evidence.ts';
import { readJson } from '../foundation.ts';
import {
  assertOptions,
  numberOption,
  optionChoice,
  optionValue,
  optionalField,
  positionalArguments,
  requiredOption,
} from './cli-arguments.ts';
import { audibleRegions, audibleRegionSchema, parityReceiptSchema, pathSchema } from './schemas.ts';

export interface EvidenceOperations {
  readonly acousticIdentify?: (
    input: { readonly all?: boolean; readonly attempts?: number; readonly candidates: string; readonly chunkSeconds?: number; readonly file: string; readonly receipt?: string; readonly top?: number; readonly verbose?: boolean },
    options: CliCommandContext,
  ) => Promise<AcousticIdentifyReceipt>;
  readonly acousticVerify?: (input: AcousticVerifyInput, options: CliCommandContext) => Promise<AcousticReceipt>;
  readonly whisperVerify?: (input: WhisperInput, options: CliCommandContext) => Promise<WhisperReceipt>;
}

export const defaultEvidenceOperations: Required<EvidenceOperations> = {
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
  whisperVerify: (input, options) => verifyWithWhisper(input, options),
};

const acousticResultSchema = parityReceiptSchema<AcousticReceipt>('audiolocate');
const acousticIdentifyResultSchema = parityReceiptSchema<AcousticIdentifyReceipt>('acoustic-identify');
const whisperResultSchema = parityReceiptSchema<WhisperReceipt>('whisper-identity');

export const evidenceOperations = (operations: Required<EvidenceOperations>) => ({
  acousticVerify: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'acoustic-verify',
      parse: (args) => {
        const valued = new Set(['--asin', '--attempts', '--audiolocate-python', '--chunk-seconds', '--file', '--receipt', '--region', '--sample-url']);
        assertOptions(args, new Set(['--verbose']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('acoustic-verify accepts only named options.');
        return {
          asin: requiredOption(args, '--asin', 'acoustic-verify'),
          ...optionalField('attempts', numberOption(args, '--attempts')),
          ...optionalField('audiolocatePython', optionValue(args, '--audiolocate-python')),
          ...optionalField('chunkSeconds', numberOption(args, '--chunk-seconds')),
          file: requiredOption(args, '--file', 'acoustic-verify'),
          receipt: requiredOption(args, '--receipt', 'acoustic-verify'),
          ...optionalField('region', optionChoice(args, '--region', audibleRegions)),
          ...optionalField('sampleUrl', optionValue(args, '--sample-url')),
          ...(args.includes('--verbose') ? { verbose: true } : {}),
        };
      },
      summary: 'Compare one bounded Audible sample with local audio through optional Audiolocate.',
      usage: 'acoustic-verify --file FILE --asin ASIN --region REGION --receipt FILE [--audiolocate-python PATH]',
    },
    handler: operations.acousticVerify,
    id: 'acoustic-verify',
    inputSchema: z.object({
      asin: z.string().min(1).max(64), attempts: z.number().int().min(1).max(10).optional(), audiolocatePython: pathSchema.optional(),
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      region: audibleRegionSchema.optional(), sampleUrl: z.url().optional(), verbose: z.boolean().optional(),
    }).strict(),
    resultSchema: acousticResultSchema,
  }),
  acousticIdentify: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'acoustic-identify',
      parse: (args) => {
        const valued = new Set(['--attempts', '--candidates', '--chunk-seconds', '--file', '--receipt', '--top']);
        assertOptions(args, new Set(['--all', '--verbose']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('acoustic-identify accepts only named options.');
        return {
          ...(args.includes('--all') ? { all: true } : {}),
          ...optionalField('attempts', numberOption(args, '--attempts')),
          candidates: requiredOption(args, '--candidates', 'acoustic-identify'),
          ...optionalField('chunkSeconds', numberOption(args, '--chunk-seconds')),
          file: requiredOption(args, '--file', 'acoustic-identify'),
          receipt: requiredOption(args, '--receipt', 'acoustic-identify'),
          ...optionalField('top', numberOption(args, '--top')),
          ...(args.includes('--verbose') ? { verbose: true } : {}),
        };
      },
      summary: 'Try score-ranked, deduplicated Audible candidates and retain per-candidate evidence.',
      usage: 'acoustic-identify --file FILE --candidates FILE --receipt FILE [--top N] [--all]',
    },
    handler: operations.acousticIdentify,
    id: 'acoustic-identify',
    inputSchema: z.object({
      all: z.boolean().optional(), attempts: z.number().int().min(1).max(10).optional(), candidates: pathSchema,
      chunkSeconds: z.number().int().min(1).max(86_400).optional(), file: pathSchema, receipt: pathSchema.optional(),
      top: z.number().int().min(1).max(10).optional(), verbose: z.boolean().optional(),
    }).strict(),
    resultSchema: acousticIdentifyResultSchema,
  }),
  whisperVerify: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'whisper-verify',
      parse: (args) => {
        const valued = new Set(['--author', '--file', '--language', '--max-windows', '--minimum-chars', '--model', '--receipt', '--threads', '--title', '--whisper-cli', '--window-seconds']);
        assertOptions(args, new Set(), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('whisper-verify accepts only named options.');
        return {
          ...optionalField('author', optionValue(args, '--author')),
          file: requiredOption(args, '--file', 'whisper-verify'),
          ...optionalField('language', optionValue(args, '--language')),
          ...optionalField('maxWindows', numberOption(args, '--max-windows')),
          ...optionalField('minimumChars', numberOption(args, '--minimum-chars')),
          model: requiredOption(args, '--model', 'whisper-verify'),
          receipt: requiredOption(args, '--receipt', 'whisper-verify'),
          ...optionalField('threads', numberOption(args, '--threads')),
          ...optionalField('title', optionValue(args, '--title')),
          ...optionalField('whisperCli', optionValue(args, '--whisper-cli')),
          ...optionalField('windowSeconds', numberOption(args, '--window-seconds')),
        };
      },
      summary: 'Transcribe distributed audiobook windows for human language and identity review.',
      usage: 'whisper-verify --file FILE --model FILE --receipt FILE [--language CODE] [--max-windows N]',
    },
    handler: operations.whisperVerify,
    id: 'whisper-verify',
    inputSchema: z.object({
      author: z.string().max(512).optional(), file: pathSchema, language: z.string().min(1).max(64).optional(),
      maxWindows: z.number().int().min(5).max(11).optional(), minimumChars: z.number().int().min(1).max(16_384).optional(),
      model: pathSchema, receipt: pathSchema.optional(), threads: z.number().int().min(1).max(256).optional(), title: z.string().max(1024).optional(),
      whisperCli: pathSchema.optional(), windowSeconds: z.number().int().min(1).max(3600).optional(),
    }).strict(),
    resultSchema: whisperResultSchema,
  }),
});
