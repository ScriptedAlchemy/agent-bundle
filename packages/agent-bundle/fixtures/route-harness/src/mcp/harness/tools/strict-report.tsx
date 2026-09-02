import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  description: 'Returns a closed-object report that rejects unknown serialized keys.',
  title: 'Strict report',
};

export const inputSchema = z.object({ reportId: z.string().optional() });

export const resultSchema = z.strictObject({
  reportId: z.string(),
  summary: z.string(),
});

export default async function StrictReport({ input }: { readonly input: z.infer<typeof inputSchema> }) {
  const reportId = input.reportId ?? 'report-1';
  const value = { reportId, summary: `summary for ${reportId}` };
  return (
    <Agent.Result value={value}>
      <Agent.Text>{value.summary}</Agent.Text>
    </Agent.Result>
  );
}
