import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  defineOperation,
  defineRscAgentBundle,
  type RscOperationContext,
} from '@agent-bundle/rsc-runtime/plugin';
import React from 'react';
import { z } from 'zod';

import {
  auditAudiobook,
  inspectSources,
  prepareAudiobook,
  type AuditInput,
  type AuditReceipt,
  type InspectionReceipt,
  type PrepareInput,
  type PrepareReceipt,
} from './curator-core.ts';
import { CuratorResult } from './result.tsx';

export interface AudiobookCuratorOperations {
  readonly audit: (input: AuditInput, options: RscOperationContext) => Promise<AuditReceipt>;
  readonly inspect: (
    input: { readonly maxFiles?: number; readonly root: string },
    options: RscOperationContext,
  ) => Promise<InspectionReceipt>;
  readonly prepare: (input: PrepareInput, options: RscOperationContext) => Promise<PrepareReceipt>;
}

const defaultOperations: AudiobookCuratorOperations = {
  audit: (input, options) => auditAudiobook(input, options),
  inspect: (input, options) => inspectSources(input, options),
  prepare: (input, options) => prepareAudiobook(input, options),
};

const pathSchema = z.string().min(1).max(4096);
const tagsSchema = z.record(z.string().max(128), z.string().max(4096));
const probeShape = {
  channels: z.number().nonnegative().optional(),
  codec: z.string(),
  durationSeconds: z.number().nonnegative(),
  format: z.string(),
  sampleRate: z.number().nonnegative().optional(),
  tags: tagsSchema,
};
const probeSchema = z.object(probeShape).strict();
const inspectedFileSchema = z.object({
  ...probeShape,
  bytes: z.number().int().nonnegative(),
  path: pathSchema,
}).strict();
const inspectInputSchema = z.object({
  maxFiles: z.number().int().min(1).max(256).optional(),
  root: pathSchema,
}).strict();
const inspectResultSchema = z.object({
  files: z.array(inspectedFileSchema).max(256),
  operation: z.literal('inspect'),
  root: pathSchema,
  totalBytes: z.number().int().nonnegative(),
}).strict();
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
const auditInputSchema = z.object({
  fullDecode: z.boolean().optional(),
  source: pathSchema,
}).strict();
const auditResultSchema = z.object({
  bytes: z.number().int().nonnegative(),
  fullDecode: z.boolean(),
  operation: z.literal('audit'),
  probe: probeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  source: pathSchema,
}).strict();

const optionValue = (args: readonly string[], option: string): string | undefined => {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
};

const assertOptions = (args: readonly string[], flags: ReadonlySet<string>, valued: ReadonlySet<string>): void => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) continue;
    if (flags.has(argument)) continue;
    if (valued.has(argument)) {
      index += 1;
      if (args[index] === undefined || args[index]!.startsWith('--')) throw new Error(`${argument} requires a value.`);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
};

const positionalArguments = (args: readonly string[], valued: ReadonlySet<string>): readonly string[] => {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valued.has(args[index]!)) {
      index += 1;
    } else if (!args[index]!.startsWith('--')) {
      positional.push(args[index]!);
    }
  }
  return positional;
};

const onePath = (args: readonly string[], valued: ReadonlySet<string>, command: string): string => {
  const positional = positionalArguments(args, valued);
  if (positional.length !== 1) throw new Error(`${command} requires exactly one path.`);
  return positional[0]!;
};

const createOperations = (operations: AudiobookCuratorOperations) => Object.freeze([
  defineOperation({
    cli: {
      name: 'inspect',
      parse: (args) => {
        const valued = new Set(['--max-files']);
        assertOptions(args, new Set(), valued);
        const maximum = optionValue(args, '--max-files');
        return {
          ...(maximum === undefined ? {} : { maxFiles: Number(maximum) }),
          root: onePath(args, valued, 'inspect'),
        };
      },
      summary: 'Inspect a bounded audiobook source tree without changing it.',
      usage: 'inspect [--max-files N] <root>',
    },
    execute: operations.inspect,
    id: 'inspect',
    inputSchema: inspectInputSchema,
    mcp: {
      description: 'Inspect a bounded directory tree and report supported audiobook media without changing it.',
      name: 'inspect_sources',
      readOnly: true,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: inspectResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'prepare',
      parse: (args) => {
        const valued = new Set(['--name', '--output']);
        assertOptions(args, new Set(['--apply']), valued);
        const outputRoot = optionValue(args, '--output');
        if (outputRoot === undefined) throw new Error('prepare requires --output.');
        const outputName = optionValue(args, '--name');
        return {
          ...(args.includes('--apply') ? { apply: true } : {}),
          ...(outputName === undefined ? {} : { outputName }),
          outputRoot,
          source: onePath(args, valued, 'prepare'),
        };
      },
      summary: 'Plan an M4B output or apply the plan when explicitly requested.',
      usage: 'prepare [--apply] [--name FILE] --output DIR <source>',
    },
    execute: operations.prepare,
    id: 'prepare',
    inputSchema: prepareInputSchema,
    mcp: {
      description: 'Plan an M4B output, or apply the plan only when apply is explicitly true.',
      name: 'prepare_audiobook',
      readOnly: false,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: prepareResultSchema,
  }),
  defineOperation({
    cli: {
      name: 'audit',
      parse: (args) => {
        assertOptions(args, new Set(['--full-decode']), new Set());
        return {
          ...(args.includes('--full-decode') ? { fullDecode: true } : {}),
          source: onePath(args, new Set(), 'audit'),
        };
      },
      summary: 'Probe and hash one audiobook, optionally decoding the complete audio stream.',
      usage: 'audit [--full-decode] <source>',
    },
    execute: operations.audit,
    id: 'audit',
    inputSchema: auditInputSchema,
    mcp: {
      description: 'Probe and hash one audiobook, with optional full audio decode.',
      name: 'audit_audiobook',
      readOnly: true,
      server: 'curator',
    },
    render: (receipt) => <CuratorResult receipt={receipt} />,
    resultSchema: auditResultSchema,
  }),
]);

export const createAudiobookCuratorApplication = (
  options: { readonly operations?: AudiobookCuratorOperations } = {},
) => {
  const definitions = createOperations(options.operations ?? defaultOperations);
  return defineRscAgentBundle(
    <AgentBundle
      description="Plan-first audiobook inventory, preparation, and integrity audit."
      marketplace
      name="audiobook-curator"
      node="22.19.0"
      targets={['claude', 'codex']}
      version="1.0.0"
    >
      <Skill source="./skills/curate-audiobooks" />
      <Script entry="./src/cli-entry.ts" name="audiobook-curator" />
      <McpServer entry="./src/mcp-server.ts" name="curator" />
      {definitions.map((definition) => <Operation definition={definition} key={definition.id} />)}
    </AgentBundle>,
  );
};

export const audiobookCuratorApplication = createAudiobookCuratorApplication();
