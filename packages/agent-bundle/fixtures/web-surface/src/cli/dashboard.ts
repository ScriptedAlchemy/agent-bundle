import type { CliRouteConfig } from 'agent-bundle';
import { z } from 'zod';

/**
 * An authored routed command with no framework value import: it exists so
 * the packed proof can show the author's commands and the framework-owned
 * `web` command sharing one generated `bin/<plugin>.mjs` (#564).
 */
export const config = {
  description: 'Report that the dashboard command is wired into the plugin bin.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({ ok: z.literal(true) }).strict();

export default async function dashboard() {
  return { ok: true as const };
}
