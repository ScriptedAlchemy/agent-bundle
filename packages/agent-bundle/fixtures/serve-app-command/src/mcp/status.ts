import { McpServer } from '@modelcontextprotocol/server';
import apps from 'agent-bundle/mcp-apps';
import { name, version } from 'agent-bundle/meta';

const app = apps[0];
if (app === undefined) throw new Error('Expected the status MCP App.');

/**
 * Default-exported server factory: `agent-bundle build` wraps it in the
 * framework stdio lifecycle shell. One App resource and one tool that opens
 * it — the pair `agent-bundle serve-app status/status --tool status` binds.
 * The tool takes no input, so the opening call `serve-app` makes needs none.
 */
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
    structuredContent: { status: 'healthy' },
  }));

  return server;
}
