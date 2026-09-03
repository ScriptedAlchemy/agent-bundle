import { Agent, type JsonValue } from '@agent-bundle/runtime';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import React from 'react';

import { capture } from '../../../capture.js';
import { dumpCaptures, dumpInputSchema, dumpResultSchema, renderDumpMarkdown } from '../../../dump.js';

export const config = {
  annotations: { readOnlyHint: true },
  description:
    'Dump what the host-test probe has recorded from this host: every hook payload, the framework request context each one saw, and the MCP calls. Filter by any conversation, session, or subagent id.',
} satisfies ToolConfig;

export const inputSchema = dumpInputSchema;
export const resultSchema = dumpResultSchema;

export default async function Dump({ input }: ToolRouteProps<typeof inputSchema>) {
  // The dump call is itself an observation: it records the request context the
  // generated MCP server mounted for this tool call before reading the log.
  const observed = await capture({ kind: 'mcp', observed: { tool: 'dump' } });
  const result = await dumpCaptures(input, observed.log);
  return (
    <Agent.Result value={result as unknown as JsonValue}>
      <Agent.Markdown>{renderDumpMarkdown(result)}</Agent.Markdown>
      <Agent.Json value={result as unknown as JsonValue} />
    </Agent.Result>
  );
}
