import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import apps from 'agent-bundle/mcp-apps';
import { z } from 'zod';

const app = apps[0];
if (app === undefined) throw new Error('Expected the status MCP App.');

const server = new McpServer({ name: 'mcp-app-example', version: '1.0.0' });

server.registerResource(app.name, app.resourceUri, {
  _meta: { ui: { resourceUri: app.resourceUri } },
  mimeType: app.mimeType,
}, async (uri) => ({
  contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],
}));

server.registerTool('show-status', {
  _meta: { ui: { resourceUri: app.resourceUri } },
  description: 'Show the health of one example service.',
  inputSchema: z.object({ service: z.string() }),
}, async ({ service }) => ({
  _meta: { ui: { resourceUri: app.resourceUri } },
  content: [{ text: `${service} is healthy`, type: 'text' }],
  structuredContent: { service, status: 'healthy' },
}));

await server.connect(new StdioServerTransport());
