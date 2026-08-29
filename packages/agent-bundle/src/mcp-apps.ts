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

/**
 * Every export must throw through a hoisted function declaration: the rslib
 * bundle emits `export default <binding>;` above the const initializers, so a
 * top-level `throw` or a `const`-backed default export surfaces a TDZ
 * ReferenceError instead of this message (see the mcp-apps dist test).
 */
function throwUnavailableEntrypoint(): readonly McpAppResource[] {
  throw new Error(
    'agent-bundle/mcp-apps is available only while Agent Bundle compiles a local MCP server.',
  );
}

export const mcpApps: readonly McpAppResource[] = throwUnavailableEntrypoint();

export default throwUnavailableEntrypoint();
