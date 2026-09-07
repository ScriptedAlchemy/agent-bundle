import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import { appResourceUri } from 'agent-bundle/routes';
import { z } from 'zod';

import { serviceSchema, serviceStatus, serviceStatusSchema } from '../../../service-status.ts';

export const config = {
  _meta: { ui: { resourceUri: appResourceUri('status') } },
  annotations: { readOnlyHint: true },
  description: 'Show the health of one example service.',
} satisfies ToolConfig;

export const inputSchema = z.object({ service: serviceSchema });
export const resultSchema = serviceStatusSchema;

export default async function ShowStatus({ input }: ToolRouteProps<typeof inputSchema>) {
  const status = serviceStatus(input.service);
  return (
    <Agent.Result value={status}>
      <Agent.Text>{status.summary}</Agent.Text>
    </Agent.Result>
  );
}
