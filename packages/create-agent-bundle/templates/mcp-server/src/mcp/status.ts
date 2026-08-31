import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { reportStatus } from '../status.js';

export const createStatusServer = (): McpServer => {
  const server = new McpServer({ name: 'my-agent-plugin', version: '0.1.0' });

  server.registerTool('report-status', {
    description: 'Report the readiness of one service.',
    inputSchema: z.object({ service: z.string().min(1) }),
  }, async ({ service }) => {
    const report = reportStatus(service);
    return {
      content: [{ text: report.summary, type: 'text' }],
      structuredContent: { ...report },
    };
  });

  return server;
};

/**
 * Default-exported server factory: `agent-bundle build` detects it and wraps
 * this entry in the framework stdio lifecycle shell (console-to-stderr guard,
 * SIGINT/SIGTERM handling, stdin-EOF exit, bounded shutdown, heartbeat).
 */
export default createStatusServer;
