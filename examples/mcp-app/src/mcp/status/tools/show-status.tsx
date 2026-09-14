import { Agent } from '@agent-bundle/runtime';
import React from 'react';
import { appResourceUri, defineTool } from 'agent-bundle/routes';
import { z } from 'zod';

import { serviceSchema, serviceStatus, serviceStatusSchema } from '../../../service-status.ts';

export const inputSchema = z.object({ service: serviceSchema });
export const resultSchema = serviceStatusSchema;

export default defineTool({
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "service": {
        "enum": [
          "compiler",
          "payments-api"
        ],
        "type": "string",
        "description": "The example service to inspect."
      }
    },
    "required": [
      "service"
    ],
    "type": "object"
  },
  _meta: { ui: { resourceUri: appResourceUri('status') } },
  annotations: { readOnlyHint: true },
  description: 'Show the health of one example service.',
  inputSchema,
  resultSchema,
}, async (input) => {
  const status = serviceStatus(input.service);
  return (
    <Agent.Result value={status}>
      <Agent.Text>{status.summary}</Agent.Text>
    </Agent.Result>
  );
});
