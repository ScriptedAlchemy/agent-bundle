import { dirname, resolve } from 'node:path';

import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import React from 'react';
import { z } from 'zod';

import { capture } from '../capture.js';
import { dumpCaptures, dumpResultSchema, renderDumpMarkdown } from '../dump.js';
import { resolveLog } from '../log.js';

export const config = {
  description: 'Print the host-test capture log: every hook payload and MCP call the probe recorded, with the request context each one saw.',
} satisfies CliRouteConfig;

// Routed CLI argv projection needs literal zod, so the dump filter is restated
// here; the MCP tool and this command share the same execution in ../dump.ts.
export const inputSchema = z.object({
  conversation: z.string().min(1).max(1024).optional(),
  full: z.boolean().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  /** Read this captures.ndjson instead of the resolved default. */
  log: z.string().min(1).max(4096).optional(),
}).strict();

export const resultSchema = dumpResultSchema;

export default async function Dump({ input }: CliRouteProps<typeof inputSchema>) {
  const log = input.log === undefined
    ? resolveLog()
    : { dir: dirname(resolve(input.log)), path: resolve(input.log), source: 'env:HOST_TEST_LOG_DIR' as const };
  if (input.log === undefined) {
    // Only the default log is also written to: a dump of someone else's file
    // must not append a record to it.
    await capture({ kind: 'cli', observed: { command: 'dump' } });
  }
  const result = await dumpCaptures({
    ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
    ...(input.full === undefined ? {} : { full: input.full }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  }, log);
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Markdown>{renderDumpMarkdown(result)}</Agent.Markdown>
    </Agent.Result>
  );
}
