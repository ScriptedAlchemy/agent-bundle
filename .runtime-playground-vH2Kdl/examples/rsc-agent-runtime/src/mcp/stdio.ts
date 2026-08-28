import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRuntimeMcpServer } from './create-server.js';

const run = async (): Promise<void> => {
  const server = createRuntimeMcpServer();
  await server.connect(new StdioServerTransport());
};

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
