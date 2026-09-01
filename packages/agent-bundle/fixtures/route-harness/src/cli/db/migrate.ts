import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

/**
 * Nested one level below the CLI root, so the dispatch level exercises path
 * nesting (`db migrate`) rather than a single flat command, and carries the
 * `result` exit-code policy so the harness proves that mapping too.
 */
export const config = {
  description: 'Applies pending harness migrations.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  dryRun: z.boolean().default(false),
}).strict();

export const resultSchema = z.object({
  applied: z.number().int(),
  dryRun: z.boolean(),
  exitCode: z.number().int(),
}).strict();

export default async function migrate({ input }: CliRouteProps<typeof inputSchema>) {
  // A dry run reports pending work and exits non-zero without applying it.
  return input.dryRun
    ? { applied: 0, dryRun: true, exitCode: 3 }
    : { applied: 2, dryRun: false, exitCode: 0 };
}
