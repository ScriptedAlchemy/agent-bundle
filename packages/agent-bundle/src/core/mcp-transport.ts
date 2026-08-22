import type { Diagnostic } from './diagnostics.ts';
import type { McpTransport, NormalizedMcpServer } from './types.ts';

const unreadableTransport = Symbol('unreadable transport');

const describeUnsupportedTransport = (transport: unknown): string =>
  transport === unreadableTransport
    ? 'that could not be read'
    : typeof transport === 'string'
    ? JSON.stringify(transport)
    : `of type ${JSON.stringify(typeof transport)}`;

export const isModernMcpTransport = (transport: unknown): transport is McpTransport =>
  transport === 'stdio' || transport === 'streamable-http';

/** Reads an untrusted normalized-model transport without exposing a getter or proxy failure. */
export const readMcpTransport = (server: NormalizedMcpServer): unknown => {
  try {
    return server.transport;
  } catch {
    return unreadableTransport;
  }
};

const diagnosticName = (server: NormalizedMcpServer): string => {
  try {
    const name = server.name;
    return typeof name === 'string' ? JSON.stringify(name) : '"<unknown>"';
  } catch {
    return '"<unknown>"';
  }
};

const diagnosticSourcePath = (server: NormalizedMcpServer): string | undefined => {
  try {
    const sourcePath = server.provenance.sourcePath;
    return typeof sourcePath === 'string' ? sourcePath : undefined;
  } catch {
    return undefined;
  }
};

/** Returns the shared model-boundary diagnostic for a non-modern MCP transport. */
export const unsupportedMcpTransportDiagnostic = (
  server: NormalizedMcpServer,
  transport: unknown = readMcpTransport(server),
): Diagnostic | undefined => {
  if (isModernMcpTransport(transport)) return undefined;
  const sourcePath = diagnosticSourcePath(server);
  return {
    code: 'AB4339',
    message: `MCP server ${diagnosticName(server)} uses unsupported transport ${describeUnsupportedTransport(transport)}.`,
    severity: 'error',
    ...(sourcePath === undefined ? {} : { sourcePath }),
  };
};
