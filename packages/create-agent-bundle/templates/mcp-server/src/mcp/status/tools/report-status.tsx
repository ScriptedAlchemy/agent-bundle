import React from 'react';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import { Agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

import { reportStatus } from '../../../status.js';

export const config = {
  description: 'Report the readiness of one service.',
  annotations: { readOnlyHint: true },
} satisfies ToolConfig;
export const inputSchema = z.object({ service: z.string().min(1) }).strict();
export const resultSchema = z.object({
  service: z.string(),
  status: z.enum(['healthy', 'unknown']),
  summary: z.string(),
}).strict();

export default async function ReportStatus({ input }: ToolRouteProps<typeof inputSchema>) {
  const report = reportStatus(input.service);
  return (
    <Agent.Result value={report as unknown as JsonValue}>
      <Agent.Text>{report.summary}</Agent.Text>
    </Agent.Result>
  );
}
