import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { greet } from '../index.js';

/**
 * A routed CLI command: the file path is the command name (`my-agent-plugin
 * greet`). `config.inputJsonSchema` and `config.positionals` compile the argv
 * grammar and generated help; `inputSchema` validates parsed argv at run time;
 * `resultSchema` validates the one canonical JSON line the command prints.
 * No argv parsing lives in this file.
 */
export const config = {
  description: 'Greet one person by name.',
  positionals: ['name'],
  inputJsonSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Who to greet.' },
      shout: { type: 'boolean', description: 'Upper-case the greeting.' },
    },
    required: ['name'],
  },
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  name: z.string().min(1).describe('Who to greet.'),
  shout: z.boolean().optional().describe('Upper-case the greeting.'),
}).strict();

export const resultSchema = z.object({
  message: z.string(),
  name: z.string(),
}).strict();

export default async function greetCommand({ input }: CliRouteProps<typeof inputSchema>) {
  const greeting = greet(input.name);
  return input.shout === true
    ? { ...greeting, message: greeting.message.toUpperCase() }
    : greeting;
}
