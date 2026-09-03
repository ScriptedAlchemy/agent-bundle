import { McpServer } from '@modelcontextprotocol/server';
import type { JsonObject, JsonValue } from '@agent-bundle/runtime';
import { z } from 'zod';

import { captureRaw, environmentNames } from '../capture.js';

const asJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue;

/**
 * A deliberately hand-rolled stdio server (the framework lifecycle shell wraps
 * this factory): it records the raw MCP request context the SDK hands a tool
 * handler — session id, JSON-RPC id, `_meta`, the lifted envelope, the
 * negotiated client identity — so hook↔MCP correlation can be judged against
 * the wire rather than against what the generated server chooses to mount.
 */
export default () => {
  const server = new McpServer({ name: 'host-test-raw', version: '1.0.0' });
  server.registerTool('probe', {
    annotations: { readOnlyHint: true },
    description:
      'Record and return the raw MCP request envelope this server received (session id, request id, _meta, client info, env variable names).',
    inputSchema: z.object({ note: z.string().max(1024).optional() }).strict(),
  }, async (input, context) => {
    const client = server.server.getClientVersion();
    const observed: JsonObject = {
      client: asJson(client),
      clientCapabilities: asJson(server.server.getClientCapabilities()),
      env: { names: [...environmentNames()] },
      http: asJson(context.http),
      mcpReq: {
        _meta: asJson(context.mcpReq._meta),
        envelope: asJson(context.mcpReq.envelope),
        id: asJson(context.mcpReq.id),
        method: context.mcpReq.method,
      },
      note: input.note ?? null,
      sessionId: context.sessionId ?? null,
      tool: 'probe',
    };
    const { log, record } = captureRaw(client?.name ?? 'unknown', observed);
    const result = { log: log.path, observed, sequence: record.sequence };
    return {
      content: [{ text: JSON.stringify(result, null, 2), type: 'text' as const }],
      structuredContent: result,
    };
  });
  return server;
};
