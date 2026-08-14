import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createRuntimeMcpServer } from './create-server.js';
import { allowsOrigin, resolveHttpSecurityConfig } from './http-security.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const security = resolveHttpSecurityConfig();
const app = createMcpExpressApp({ allowedHosts: security.allowedHosts });

app.use((request, response, next) => {
  if (allowsOrigin(security, request.get('host'), request.get('origin'))) {
    next();
    return;
  }

  response.status(403).json({
    error: { code: -32000, message: `Invalid Origin header: ${request.get('origin')}` },
    id: null,
    jsonrpc: '2.0',
  });
});

app.get('/health', (_request, response) => {
  response.json({ ok: true, transport: 'streamable-http' });
});

app.post('/mcp', async (request, response) => {
  const server = createRuntimeMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    await server.close();
  }
});

const httpServer = app.listen(port, '127.0.0.1', () => {
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stderr.write(`${JSON.stringify({ port: actualPort, transport: 'streamable-http' })}\n`);
});

const close = (): void => {
  httpServer.close(() => process.exit(0));
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
