import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import apps from 'agent-bundle/mcp-apps';

const app = apps[0];
if (app === undefined) throw new Error('Expected the packed-release MCP App.');

const server = new McpServer({ name: 'packed-release-mcp', version: '1.0.0' });

server.registerResource(app.name, app.resourceUri, {
  _meta: { ui: { resourceUri: app.resourceUri } },
  mimeType: app.mimeType,
}, async (uri) => ({
  contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],
}));

server.registerTool('show-dashboard', {
  _meta: { ui: { resourceUri: app.resourceUri } },
  description: 'Returns the packed-release MCP App.',
}, async () => ({
  _meta: { ui: { resourceUri: app.resourceUri } },
  content: [{ text: 'packed dashboard ready', type: 'text' }],
  structuredContent: { resourceUri: app.resourceUri, view: app.name },
}));

await server.connect(new StdioServerTransport());
