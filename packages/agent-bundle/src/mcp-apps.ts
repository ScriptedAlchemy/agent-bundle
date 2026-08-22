/**
 * This package subpath is replaced by the compiler for local MCP servers.
 * A direct runtime import would silently produce an empty resource registry,
 * so make the unsupported boundary explicit instead.
 */
export interface McpAppResource {
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly html: string;
  readonly mimeType: 'text/html;profile=mcp-app';
  readonly name: string;
  readonly resourceUri: string;
}

export const mcpApps: readonly McpAppResource[] = Object.freeze([]);

export default mcpApps;

throw new Error(
  'agent-bundle/mcp-apps is available only while Agent Bundle compiles a local MCP server.',
);
