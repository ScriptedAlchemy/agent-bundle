import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  _meta: { ui: { resourceUri: 'ui://route-harness/panel.html' } },
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
  // The MCP Apps convention stamps the App resource on every result as well
  // as on the listing; `metadata` is the result half (`CallToolResult._meta`).
  return (
    <Agent.Result metadata={{ ui: { resourceUri: 'ui://route-harness/panel.html' } }} value={value}>
      <Agent.Text>{value.summary}</Agent.Text>
    </Agent.Result>
  );
}
