import apps from 'agent-bundle/mcp-apps';
import { localMcpMessage } from './mcp-local.ts';

let buffer = '';
const app = apps[0];
const send = (id: unknown, result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line) as { id?: unknown; method: string; params?: { uri?: string } };
    if (request.method === 'initialize') {
      send(request.id, {
        capabilities: { resources: {}, tools: {} },
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'integration-mcp', version: '1.0.0' },
      });
    }
    if (request.method === 'tools/list') {
      send(request.id, { tools: [{
        _meta: app === undefined ? undefined : { ui: { resourceUri: app.resourceUri } },
        description: 'Returns the integration MCP App.',
        inputSchema: { properties: {}, type: 'object' },
        name: 'show-dashboard',
      }] });
    }
    if (request.method === 'tools/call') {
      send(request.id, {
        _meta: app === undefined ? undefined : { ui: { resourceUri: app.resourceUri } },
        content: [{ text: `dashboard ready: ${localMcpMessage}`, type: 'text' }],
        structuredContent: { resourceUri: app?.resourceUri, view: app?.name },
      });
    }
    if (request.method === 'resources/list') {
      send(request.id, { resources: app === undefined ? [] : [{
        _meta: app._meta,
        mimeType: app.mimeType,
        name: app.name,
        uri: app.resourceUri,
      }] });
    }
    if (request.method === 'resources/read') {
      send(request.id, { contents: app === undefined || request.params?.uri !== app.resourceUri ? [] : [{
        mimeType: app.mimeType,
        text: app.html,
        uri: app.resourceUri,
      }] });
    }
  }
});
