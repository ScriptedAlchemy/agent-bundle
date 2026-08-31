import { redirectConsoleToStderr, runStdioServer } from 'agent-bundle/mcp-entry';

const main = async (): Promise<void> => {
  // The console guard must be active before the server module or the MCP SDK
  // evaluate — a stray console.log during either import would corrupt the
  // JSON-RPC stream on stdout — so both imports are deferred past the guard
  // install, mirroring the framework's generated stdio shell.
  const guard = redirectConsoleToStderr();
  const { createRuntimeMcpServer } = await import('./create-server.js');
  const server = createRuntimeMcpServer();
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  guard.restoreProtocolStdout();
  await runStdioServer({
    server,
    serverName: 'rsc-agent-runtime',
    transport: new StdioServerTransport(),
  });
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
