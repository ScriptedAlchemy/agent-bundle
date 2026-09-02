import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Returns a typed unavailable result for projection checks.',
  title: 'Unavailable',
};

export const inputSchema = z.object({});

export const resultSchema = z.object({ available: z.literal(false) });

export default async function Unavailable() {
  return (
    <Agent.Result value={{ available: false }}>
      <Agent.Error code="AB9001">The harness fixture represents this capability as unavailable.</Agent.Error>
    </Agent.Result>
  );
}
