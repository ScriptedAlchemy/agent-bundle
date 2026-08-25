import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { createCuratorTools } from './mcp-tools.js';

export const createAudiobookCuratorServer = (): McpServer => {
  const server = new McpServer({ name: 'audiobook-curator', version: '1.0.0' });
  for (const tool of createCuratorTools()) {
    server.registerTool(tool.name, {
      annotations: {
        destructiveHint: false,
        idempotentHint: tool.readOnly,
        readOnlyHint: tool.readOnly,
      },
      description: tool.description,
      inputSchema: tool.inputSchema,
    }, (input, context) => tool.execute(input, context.mcpReq.signal));
  }
  return server;
};

await createAudiobookCuratorServer().connect(new StdioServerTransport());
