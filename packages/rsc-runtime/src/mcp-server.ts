import { McpServer as ProtocolMcpServer } from '@modelcontextprotocol/server';

import type { RscApplication } from './application.js';
import { available, runAgentRequest, type AgentTerminal } from './agent-request.js';
import { lowerMcpResult } from './lower-mcp.js';

/** An MCP server's stdout is the protocol wire and its stderr the host's log: no terminal, never probed (#511). */
const mcpTerminal: AgentTerminal = Object.freeze({
  hostSurface: 'mcp',
  sharesTarget: false,
  stderr: Object.freeze({ color: 'none', kind: 'none' }),
  stdout: Object.freeze({ color: 'none', kind: 'none' }),
});

export const createRscMcpServer = (
  application: Readonly<RscApplication>,
  serverName: string,
): ProtocolMcpServer => {
  // The server's structural declaration (entry, targets) lives in
  // agent-bundle.config.ts; here the name only selects which operations to
  // serve, so a name no operation references is a wiring mistake.
  if (!application.operations.some((operation) => operation.mcp?.server === serverName)) {
    throw new Error(`Unknown RSC MCP server: ${serverName}`);
  }
  const server = new ProtocolMcpServer({
    name: application.name,
    version: application.version,
  });
  for (const operation of application.operations) {
    const mcp = operation.mcp;
    if (mcp?.server !== serverName) continue;
    server.registerTool(mcp.name, {
      ...(mcp._meta === undefined ? {} : { _meta: mcp._meta }),
      // Emit exactly the hints the author declared: an absent hint carries
      // MCP-spec default semantics on the wire, so synthesizing values here
      // would rewrite the author's contract.
      annotations: {
        ...(mcp.destructive === undefined ? {} : { destructiveHint: mcp.destructive }),
        ...(mcp.idempotent === undefined ? {} : { idempotentHint: mcp.idempotent }),
        ...(mcp.openWorld === undefined ? {} : { openWorldHint: mcp.openWorld }),
        readOnlyHint: mcp.readOnly,
      },
      description: mcp.description,
      inputSchema: operation.inputSchema,
      ...(mcp.title === undefined ? {} : { title: mcp.title }),
    }, async (input, context) => {
      const clientName = server.server.getClientVersion()?.name;
      return runAgentRequest({
        ...(context.http?.authInfo?.clientId === undefined
          ? {}
          : { actor: available({ id: context.http.authInfo.clientId }, 'native') }),
        ...(typeof clientName === 'string' && clientName.trim() !== ''
          ? { host: available({ name: clientName }, 'native') }
          : {}),
        invocation: {
          kind: 'tool',
          operationId: operation.id,
          surface: mcp.name,
        },
        ...(typeof context.sessionId === 'string' && context.sessionId.trim() !== ''
          ? { session: available({ sessionId: context.sessionId }, 'native') }
          : {}),
        signal: context.mcpReq.signal,
        terminal: available(mcpTerminal, 'derived'),
      }, async () => {
        const result = await operation.execute(input, { signal: context.mcpReq.signal });
        return lowerMcpResult(operation.render(result));
      });
    });
  }
  return server;
};
