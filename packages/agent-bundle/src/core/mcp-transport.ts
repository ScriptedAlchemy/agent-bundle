import type { Diagnostic } from './diagnostics.ts';
import type { McpTransport, NormalizedMcpServer } from './types.ts';

const describeUnsupportedTransport = (transport: unknown): string =>
  typeof transport === 'string'
    ? JSON.stringify(transport)
    : `of type ${JSON.stringify(typeof transport)}`;

export const isModernMcpTransport = (transport: unknown): transport is McpTransport =>
  transport === 'stdio' || transport === 'streamable-http';

/** Returns the shared model-boundary diagnostic for a non-modern MCP transport. */
export const unsupportedMcpTransportDiagnostic = (
  server: NormalizedMcpServer,
): Diagnostic | undefined => {
  const transport: unknown = server.transport;
  if (isModernMcpTransport(transport)) return undefined;
  return {
    code: 'AB4339',
    message: `MCP server ${JSON.stringify(server.name)} uses unsupported transport ${describeUnsupportedTransport(transport)}.`,
    severity: 'error',
    sourcePath: server.provenance.sourcePath,
  };
};
