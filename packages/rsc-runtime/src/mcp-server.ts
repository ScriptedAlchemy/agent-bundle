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
      ...(operation.mcp._meta === undefined ? {} : { _meta: operation.mcp._meta }),
      // Emit exactly the hints the author declared: an absent hint carries
      // MCP-spec default semantics on the wire, so synthesizing values here
      // would rewrite the author's contract.
      annotations: {
        ...(operation.mcp.destructive === undefined ? {} : { destructiveHint: operation.mcp.destructive }),
        ...(operation.mcp.idempotent === undefined ? {} : { idempotentHint: operation.mcp.idempotent }),
        ...(operation.mcp.openWorld === undefined ? {} : { openWorldHint: operation.mcp.openWorld }),
        readOnlyHint: operation.mcp.readOnly,
      },
      description: operation.mcp.description,
      inputSchema: operation.inputSchema,
      ...(operation.mcp.title === undefined ? {} : { title: operation.mcp.title }),
    }, async (input, context) => {
      const result = await operation.execute(input, { signal: context.mcpReq.signal });
      return lowerMcpResult(operation.render(result));
    });
  }
  return server;
};
