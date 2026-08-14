import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import apps from 'agent-bundle/mcp-apps';

import { localMcpMessage } from './mcp-local.ts';

const app = apps[0];
if (app === undefined) throw new Error('Expected an integration MCP App.');

const server = new McpServer({ name: 'integration-mcp', version: '1.0.0' });

server.registerResource(app.name, app.resourceUri, {
  _meta: {
    ui: {
      ...(typeof app._meta?.ui === 'object' && app._meta.ui !== null ? app._meta.ui : {}),
      resourceUri: app.resourceUri,
    },
  },
  mimeType: app.mimeType,
}, async (uri) => ({
  contents: [{
    mimeType: app.mimeType,
    text: app.html,
    uri: uri.href,
  }],
}));

server.registerTool('show-dashboard', {
  _meta: { ui: { resourceUri: app.resourceUri } },
  description: 'Returns the integration MCP App.',
}, async () => ({
  _meta: { ui: { resourceUri: app.resourceUri } },
  content: [{ text: `dashboard ready: ${localMcpMessage}`, type: 'text' }],
  structuredContent: { resourceUri: app.resourceUri, view: app.name },
}));

await server.connect(new StdioServerTransport());
