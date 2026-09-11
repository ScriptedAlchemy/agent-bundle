import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  inputJsonSchema: {
    "additionalProperties": false,
    "properties": {
      "failProvider": {
        "type": "boolean"
      },
      "inbox": {
        "type": "boolean"
      }
    },
    "type": "object"
  },
  annotations: { readOnlyHint: true },
  description: 'Reports the request providers an MCP tool observes.',
  title: 'Tooling',
};

export const inputSchema = z.object({
  /** Makes the `library-tooling` provider throw, to prove the request fails closed. */
  failProvider: z.boolean().optional(),
  /** Makes the `request-view` provider read `notices.inbox()`, which records an exposure receipt. */
  inbox: z.boolean().optional(),
}).strict();

export const resultSchema = z.object({
  keys: z.array(z.string()),
  libraryTooling: z.unknown().optional(),
  processLifetime: z.object({ hits: z.number(), instanceId: z.string(), pid: z.number() }).optional(),
  requestView: z.unknown().optional(),
}).strict();

export default async function Tooling() {
  const context = await agent();
  const providers = {
    processLifetime: context.process,
    libraryTooling: await context.provider('libraryTooling'),
    requestView: await context.provider('requestView'),
  };
  const { processLifetime } = providers;
  const value = {
    keys: Object.keys(providers).sort(),
    libraryTooling: providers['libraryTooling'] as JsonValue,
    ...(processLifetime === undefined ? {} : { processLifetime: { ...processLifetime } }),
    requestView: providers['requestView'] as JsonValue,
  };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`tooling: ${JSON.stringify(providers['libraryTooling'])}`}</Agent.Text>
    </Agent.Result>
  );
}
