import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import apps from 'agent-bundle/mcp-apps';
import { z } from 'zod';

import { healthyCompilerStatus } from './compiler-status-contract.ts';

const app = apps[0];
if (app === undefined) throw new Error('Expected the status MCP App.');

const server = new McpServer({ name: 'mcp-app-example', version: '1.0.0' });

const serviceCatalog = Object.freeze({
  compiler: healthyCompilerStatus,
  'payments-api': Object.freeze({
    checks: Object.freeze([
      Object.freeze({ label: 'Availability', status: 'passing' }),
      Object.freeze({ label: 'P95 latency', status: 'failing' }),
    ]),
    service: 'payments-api',
    status: 'degraded',
    summary: 'Payment latency is above the release threshold.',
  }),
});

server.registerResource(app.name, app.resourceUri, {
  _meta: { ui: { resourceUri: app.resourceUri } },
  mimeType: app.mimeType,
}, async (uri) => ({
  contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],
}));

server.registerTool('show-status', {
  _meta: { ui: { resourceUri: app.resourceUri } },
  description: 'Show the health of one example service.',
  inputSchema: z.object({ service: z.enum(['compiler', 'payments-api']) }),
}, async ({ service }) => {
  const result = serviceCatalog[service];
  return {
    _meta: { ui: { resourceUri: app.resourceUri } },
    content: [{ text: result.summary, type: 'text' }],
    structuredContent: result,
  };
});

await server.connect(new StdioServerTransport());
