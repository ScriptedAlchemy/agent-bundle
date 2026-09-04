import { Agent, agent, type JsonValue } from '@agent-bundle/runtime';
import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { z } from 'zod';

export const config = {
  description: 'Renders the request providers a rendered command observes.',
} satisfies CliRouteConfig;

export const inputSchema = z.object({}).strict();

export const resultSchema = z.object({
  keys: z.array(z.string()),
  libraryTooling: z.unknown().optional(),
  requestView: z.unknown().optional(),
}).strict();

export default async function ToolingReport(_props: CliRouteProps<typeof inputSchema>) {
  const { providers } = await agent();
  const value = {
    keys: Object.keys(providers).sort(),
    libraryTooling: providers['libraryTooling'] as JsonValue,
    requestView: providers['requestView'] as JsonValue,
  };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`tooling: ${JSON.stringify(providers['libraryTooling'])}`}</Agent.Text>
    </Agent.Result>
  );
}
