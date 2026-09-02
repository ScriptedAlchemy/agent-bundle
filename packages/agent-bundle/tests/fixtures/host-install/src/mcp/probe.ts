import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export default () => {
  const server = new McpServer({
    name: 'host-install-proof',
    version: '1.0.0',
  });
  server.registerTool('echo', {
    description: 'Echoes one message from the installed host process.',
    inputSchema: { message: z.string() },
  }, async ({ message }) => ({
    content: [{ text: message, type: 'text' }],
    structuredContent: { message, operationId: 'tool:probe/echo' },
  }));
  return server;
};
