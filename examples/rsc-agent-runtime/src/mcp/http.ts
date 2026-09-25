import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, isJsonContentType } from '@modelcontextprotocol/server';

import { createRuntimeMcpServer } from './create-server.js';
import { allowsOrigin, resolveHttpSecurityConfig } from './http-security.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const security = resolveHttpSecurityConfig();
const allowsHost = hostHeaderValidation(security.allowedHosts);
const mcpHandler = createMcpHandler(
  () => createRuntimeMcpServer({ publicMcpUrl: process.env.AGENT_RUNTIME_PUBLIC_MCP_URL }),
  { legacy: 'stateless' },
);
const handleMcp = toNodeHandler(mcpHandler);

const maximumRequestBodyBytes = 100 * 1024;

const writeJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
};

const writeJsonRpcError = (response: ServerResponse, status: number, code: number, message: string): void => {
  writeJson(response, status, { error: { code, message }, id: null, jsonrpc: '2.0' });
};

const readRequestBody = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maximumRequestBodyBytes) {
      chunks.push(chunk);
    }
  }
  return size > maximumRequestBodyBytes ? undefined : Buffer.concat(chunks);
};

const serveMcp = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  if (request.method !== 'POST') {
    await handleMcp(request, response);
    return;
  }

  const encoding = request.headers['content-encoding'];
  if (encoding !== undefined && encoding.toLowerCase() !== 'identity') {
    request.resume();
    writeJsonRpcError(response, 415, -32000, `Unsupported Content-Encoding: ${encoding}`);
    return;
  }

  const body = await readRequestBody(request);
  if (body === undefined) {
    writeJsonRpcError(response, 413, -32000, 'Request body too large');
    return;
  }

  let parsedBody: unknown;
  if (isJsonContentType(request.headers['content-type'])) {
    try {
      parsedBody = JSON.parse(body.toString('utf8'));
    } catch {
      writeJsonRpcError(response, 400, -32700, 'Parse error');
      return;
    }
  }
  await handleMcp(request, response, parsedBody);
};

const httpServer = createServer((request, response) => {
  if (!allowsHost(request, response)) {
    return;
  }

  if (!allowsOrigin(security, request.headers.host, request.headers.origin)) {
    writeJsonRpcError(response, 403, -32000, `Invalid Origin header: ${request.headers.origin}`);
    return;
  }

  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && pathname === '/health') {
    writeJson(response, 200, { ok: true, transport: 'streamable-http' });
  } else if (pathname === '/mcp') {
    serveMcp(request, response).catch(() => response.destroy());
  } else {
    writeJson(response, 404, { error: 'Not found' });
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stderr.write(`${JSON.stringify({ port: actualPort, transport: 'streamable-http' })}\n`);
});

const close = (): void => {
  void mcpHandler.close();
  httpServer.close(() => process.exit(0));
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
