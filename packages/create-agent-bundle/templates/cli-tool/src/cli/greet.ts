import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

import { greet } from '../index.js';

/**
 * A routed CLI command: the file path is the command name (`my-agent-plugin
 * greet`), the static `config` and `inputSchema` compile into the argv
 * grammar and generated help, and `resultSchema` validates what the command
 * prints as one canonical JSON line. No argv parsing lives in this file.
 */
export const config = {
  description: 'Greet one person by name.',
  positionals: ['name'],
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
