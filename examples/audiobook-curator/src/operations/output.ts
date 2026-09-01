/**
 * Output production and verification operations: `convert`, `prepare`, and
 * `audit`, backed by `../conversion.ts`, `../curator-core.ts`, and
 * `../integrity-audit.ts`. Conversion and preparation plan by default and
 * mutate only a derived destination; the audit never mutates.
 */
import { defineCliCommand, type CliCommandContext } from '../cli-command.js';
import { z } from 'zod';

import { convertAudiobook, type ConvertInput, type ConvertReceipt } from '../conversion.ts';
import { prepareAudiobook, type PrepareInput, type PrepareReceipt } from '../curator-core.ts';
import {
  auditAudiobookIntegrity,
  type IntegrityAuditInput,
  type IntegrityAuditReceipt,
} from '../integrity-audit.ts';
import {
  assertOptions,
  numberOption,
  onePath,
  optionChoice,
  optionValue,
  optionalField,
  positionalArguments,
  requiredOption,
} from './cli-arguments.ts';
import { parityReceiptSchema, pathSchema, probeSchema } from './schemas.ts';

export interface OutputOperations {
  readonly audit: (input: IntegrityAuditInput, options: CliCommandContext) => Promise<IntegrityAuditReceipt>;
  readonly convert?: (input: ConvertInput, options: CliCommandContext) => Promise<ConvertReceipt>;
  readonly prepare: (input: PrepareInput, options: CliCommandContext) => Promise<PrepareReceipt>;
}

export const defaultOutputOperations: Required<OutputOperations> = {
  audit: (input, options) => auditAudiobookIntegrity(input, options),
  convert: (input, options) => convertAudiobook(input, options),
  prepare: (input, options) => prepareAudiobook(input, options),
};

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

export const outputOperations = (operations: Required<OutputOperations>) => ({
  convert: defineCliCommand({
    cli: {
      name: 'convert',
      parse: (args) => {
        const valued = new Set([
          '--artwork', '--audio-bitrate', '--audio-codec', '--author', '--engine', '--forge-aac-encoder',
          '--forge-cli', '--jobs', '--language', '--narrator', '--output', '--receipt', '--selection', '--title', '--year',
        ]);
        assertOptions(args, new Set(['--apply', '--overwrite']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('convert accepts only named options.');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...(args.includes('--overwrite') ? { overwrite: true } : {}),
          ...optionalField('artwork', optionValue(args, '--artwork')),
          ...optionalField('audioBitrate', optionValue(args, '--audio-bitrate')),
          ...optionalField('audioCodec', optionChoice(args, '--audio-codec', ['aac', 'alac'] as const)),
          author: requiredOption(args, '--author', 'convert'),
          ...optionalField('engine', optionChoice(args, '--engine', ['audiobook-forge', 'ffmpeg'] as const)),
          ...optionalField('forgeAacEncoder', optionValue(args, '--forge-aac-encoder')),
          ...optionalField('forgeCli', optionValue(args, '--forge-cli')),
          ...optionalField('jobs', numberOption(args, '--jobs')),
          ...optionalField('language', optionValue(args, '--language')),
          ...optionalField('narrator', optionValue(args, '--narrator')),
          output: requiredOption(args, '--output', 'convert'),
          receipt: requiredOption(args, '--receipt', 'convert'),
          selection: requiredOption(args, '--selection', 'convert'),
          title: requiredOption(args, '--title', 'convert'),
          ...optionalField('year', optionValue(args, '--year')),
        };
      },
      summary: 'Plan or apply a verified conversion to one chaptered M4B.',
      usage: 'convert --selection FILE --output PATH --receipt FILE --title TITLE --author AUTHOR [--apply] [--overwrite]',
    },
    handler: operations.convert,
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
  }),
  prepare: defineCliCommand({
    cli: {
      name: 'prepare',
      parse: (args) => {
        const valued = new Set(['--name', '--output']);
        assertOptions(args, new Set(['--apply']), valued);
        const outputRoot = optionValue(args, '--output');
        if (outputRoot === undefined) throw new Error('prepare requires --output.');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...optionalField('outputName', optionValue(args, '--name')),
          outputRoot,
          source: onePath(args, valued, 'prepare'),
        };
      },
      summary: 'Plan an M4B output or apply the plan when explicitly requested.',
      usage: 'prepare [--apply] [--name FILE] --output DIR <source>',
    },
    handler: operations.prepare,
    id: 'prepare',
    inputSchema: prepareInputSchema,
    resultSchema: prepareResultSchema,
  }),
  audit: defineCliCommand({
    cli: {
      exitCode: (receipt) => receipt.exitCode,
      name: 'audit',
      parse: (args) => {
        const valued = new Set(['--conversion-receipt', '--file', '--receipt']);
        assertOptions(args, new Set(['--full-decode']), valued);
        if (positionalArguments(args, valued).length > 0) throw new Error('audit accepts only named options.');
        return {
          ...optionalField('conversionReceipt', optionValue(args, '--conversion-receipt')),
          file: requiredOption(args, '--file', 'audit'),
          ...(args.includes('--full-decode') ? { fullDecode: true } : {}),
          receipt: requiredOption(args, '--receipt', 'audit'),
        };
      },
      summary: 'Validate metadata, chapters, source mapping, hashes, and optional complete decode.',
      usage: 'audit --file FILE --receipt FILE [--conversion-receipt FILE] [--full-decode]',
    },
    handler: operations.audit,
    id: 'audit',
    inputSchema: z.object({ conversionReceipt: pathSchema.optional(), file: pathSchema, fullDecode: z.boolean().optional(), receipt: pathSchema.optional() }).strict(),
    resultSchema: auditResultSchema,
  }),
});
