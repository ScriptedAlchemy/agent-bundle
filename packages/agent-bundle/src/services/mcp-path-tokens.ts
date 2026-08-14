import type { TargetAdapter } from '../adapters/types.ts';
import { DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';

export interface McpPathTokenRoots {
  readonly pluginData: string;
  readonly pluginRoot: string;
  readonly workspaceRoot: string;
}

export interface McpStdioServer {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ResolveMcpPathTokensOptions {
  readonly adapter: TargetAdapter;
  readonly roots: McpPathTokenRoots;
  readonly server: McpStdioServer;
}

const knownTokens = Object.freeze([
  '${PLUGIN_ROOT}',
  '${PLUGIN_DATA}',
  '${CLAUDE_PLUGIN_ROOT}',
  '${CLAUDE_PLUGIN_DATA}',
  '${CLAUDE_PROJECT_DIR}',
]);

const resolveValue = (
  adapter: TargetAdapter,
  field: 'args' | 'cwd' | 'env',
  roots: McpPathTokenRoots,
  value: string,
  diagnostics: Diagnostic[],
): string => {
  let resolved = value;
  for (const token of knownTokens) {
    if (!value.includes(token)) continue;
    const root = adapter.mcpPathTokens?.[field][token];
    if (root === undefined) {
      diagnostics.push({
        code: `mcp.path-token.unsupported.${field}`,
        message: `MCP ${field} cannot resolve ${JSON.stringify(token)} for selected ${adapter.name} adapter.`,
        severity: 'error',
        target: adapter.name,
      });
      continue;
    }
    resolved = resolved.replaceAll(token, roots[root]);
  }
  return resolved;
};

export const resolveMcpPathTokens = ({
  adapter,
  roots,
  server,
}: ResolveMcpPathTokensOptions): McpStdioServer => {
  const diagnostics: Diagnostic[] = [];
  const args = server.args.map((value) => resolveValue(adapter, 'args', roots, value, diagnostics));
  const cwd = server.cwd === undefined
    ? undefined
    : resolveValue(adapter, 'cwd', roots, server.cwd, diagnostics);
  const env = server.env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.env).map(([key, value]) => [
        key,
        resolveValue(adapter, 'env', roots, value, diagnostics),
      ]));

  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);

  return {
    args,
    command: server.command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
  };
};
