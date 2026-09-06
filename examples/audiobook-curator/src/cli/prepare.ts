import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { outputOperations } from '../operations/output.js';

const operation = outputOperations.prepare;

export const config = {
  description: 'Plan an M4B output or apply the plan when explicitly requested.',
  positionals: ['source'],
} satisfies CliRouteConfig;

// Schema keys are the CLI surface (`--output`, `--name`); the handler maps
// them onto the operation input's `outputRoot`/`outputName`, preserving the
// pre-migration option names byte for byte.
export const inputSchema = z.object({
  apply: z.boolean().optional(),
  name: z.string().min(5).max(204).optional(),
  output: z.string().min(1).max(4096),
  source: z.string().min(1).max(4096),
}).strict();

export const resultSchema = operation.resultSchema;

export default async function prepare({ input, signal }: CliRouteProps<typeof inputSchema>) {
  return operation.handler({
    ...(input.apply === undefined ? {} : { apply: input.apply }),
    ...(input.name === undefined ? {} : { outputName: input.name }),
    outputRoot: input.output,
    source: input.source,
  }, { signal });
}
