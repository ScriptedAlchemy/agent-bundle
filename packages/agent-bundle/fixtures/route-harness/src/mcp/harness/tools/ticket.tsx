import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Returns a cargo-conductor-shaped ticket status with optional diagnostics fields.',
  title: 'Ticket',
};

export const inputSchema = z.object({
  includeDiagnostics: z.boolean().optional(),
  includeExecArgv: z.boolean().optional(),
  includeTail: z.boolean().optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']).optional(),
});

export const resultSchema = z.object({
  diagnostics: z.array(z.string()).optional(),
  execArgv: z.array(z.string()).optional(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  tail: z.string().optional(),
});

export default async function Ticket({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const status = input.status ?? 'completed';
  const value = {
    status,
    ...(input.includeExecArgv === true ? { execArgv: ['node', 'run.mjs'] } : {}),
    ...(input.includeDiagnostics === true ? { diagnostics: ['ready'] } : {}),
    ...(input.includeTail === true ? { tail: 'done' } : {}),
  };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{`ticket: ${status}`}</Agent.Text>
    </Agent.Result>
  );
}
