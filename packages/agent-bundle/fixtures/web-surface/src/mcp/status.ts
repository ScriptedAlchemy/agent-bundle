import { McpServer } from '@modelcontextprotocol/server';
import apps from 'agent-bundle/mcp-apps';
import { name, version } from 'agent-bundle/meta';

const app = apps[0];
if (app === undefined) throw new Error('Expected the status MCP App.');

export default function createStatusServer(): McpServer {
  const server = new McpServer({ name, version });

  server.registerResource(app.name, app.resourceUri, {
    _meta: { ui: { resourceUri: app.resourceUri } },
    mimeType: app.mimeType,
  }, async (uri) => ({
    contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }],
  }));

  server.registerTool('status', {
    _meta: { ui: { resourceUri: app.resourceUri } },
    description: 'Reports the fixture status and opens the status App.',
  }, async () => ({
    _meta: { ui: { resourceUri: app.resourceUri } },
    content: [{ text: 'status: healthy', type: 'text' }],
    // Echoes the launch so the packed proof can read what the host started.
    structuredContent: {
      launch: {
        args: process.argv.slice(2),
        cache: process.env['STATUS_CACHE'] ?? null,
        mode: process.env['STATUS_MODE'] ?? null,
      },
      status: 'healthy',
    },
  }));

  return server;
}
