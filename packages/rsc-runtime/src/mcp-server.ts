import { McpServer as ProtocolMcpServer } from '@modelcontextprotocol/server';

import { lowerMcpResult } from './lower-mcp.js';
import type { RscAgentBundleApplication } from './plugin-definition.js';

export const createRscMcpServer = (
  application: Readonly<RscAgentBundleApplication>,
  serverName: string,
): ProtocolMcpServer => {
  const serverDefinition = application.config.mcp?.servers[serverName];
  if (serverDefinition === undefined) throw new Error(`Unknown RSC MCP server: ${serverName}`);
  const server = new ProtocolMcpServer({
    name: application.config.plugin.name,
    version: application.config.plugin.version,
  });
  for (const operation of application.operations) {
    if (operation.mcp?.server !== serverName) continue;
    server.registerTool(operation.mcp.name, {
      annotations: {
        destructiveHint: operation.mcp.destructive ?? false,
        idempotentHint: operation.mcp.idempotent ?? operation.mcp.readOnly,
        openWorldHint: operation.mcp.openWorld ?? false,
        readOnlyHint: operation.mcp.readOnly,
      },
      description: operation.mcp.description,
      inputSchema: operation.inputSchema,
    }, async (input, context) => {
      const result = await operation.execute(input, { signal: context.mcpReq.signal });
      return lowerMcpResult(operation.render(result));
    });
  }
  return server;
};
