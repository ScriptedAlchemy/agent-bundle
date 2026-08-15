import { DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import type {
  McpRuntimeRoots,
  McpRuntimeValueField,
  ModernMcpServer,
  TargetMcpRuntimeContract,
} from './mcp-runtime.ts';

export interface ResolveMcpPathTokensOptions {
  readonly roots: McpRuntimeRoots;
  readonly runtime: TargetMcpRuntimeContract;
  readonly server: ModernMcpServer;
}

type McpPathTokenMap = Readonly<Partial<Record<McpRuntimeValueField, Readonly<Record<string, keyof McpRuntimeRoots>>>>>;

export interface McpPathTokenResolverOptions {
  readonly knownTokens?: readonly string[];
  readonly target: string;
  readonly tokens: McpPathTokenMap;
}

const runtimeFields: readonly McpRuntimeValueField[] = ['args', 'cwd', 'env', 'headers', 'url'];

export const standardMcpPathTokens = Object.freeze([
  '${PLUGIN_ROOT}',
  '${PLUGIN_DATA}',
  '${CLAUDE_PLUGIN_ROOT}',
  '${CLAUDE_PLUGIN_DATA}',
  '${CLAUDE_PROJECT_DIR}',
]);

export const allMcpPathTokenFields = (
  tokens: Readonly<Record<string, keyof McpRuntimeRoots>>,
): McpPathTokenMap => Object.freeze({
  args: tokens,
  cwd: tokens,
  env: tokens,
  headers: tokens,
  url: tokens,
});

export const createMcpPathTokenResolver = ({
  knownTokens,
  target,
  tokens,
}: McpPathTokenResolverOptions): TargetMcpRuntimeContract['resolveValue'] => {
  const supportedTokens = knownTokens ?? Object.freeze([
    ...new Set(runtimeFields.flatMap((field) => Object.keys(tokens[field] ?? {}))),
  ]);
  return (field, roots, value) => {
    const diagnostics: Diagnostic[] = [];
    let resolved = value;
    for (const token of supportedTokens) {
      if (!value.includes(token)) continue;
      const root = tokens[field]?.[token];
      if (root === undefined) {
        diagnostics.push({
          code: `mcp.path-token.unsupported.${field}`,
          message: `MCP ${field} cannot resolve ${JSON.stringify(token)} for selected ${target} adapter.`,
          severity: 'error',
          target,
        });
        continue;
      }
      resolved = resolved.replaceAll(token, roots[root]);
    }
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), value: resolved });
  };
};

export const resolveMcpPathTokens = ({
  roots,
  runtime,
  server,
}: ResolveMcpPathTokensOptions): ModernMcpServer => {
  const diagnostics: Diagnostic[] = [];
  const resolveValue = (field: McpRuntimeValueField, value: string): string => {
    const resolved = runtime.resolveValue(field, roots, value);
    diagnostics.push(...resolved.diagnostics);
    return resolved.value;
  };

  if (server.kind === 'streamable-http') {
    const headers = server.headers === undefined
      ? undefined
      : Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, resolveValue('headers', value)]));
    const url = resolveValue('url', server.url);
    if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
    return {
      ...(headers === undefined ? {} : { headers }),
      kind: 'streamable-http',
      url,
    };
  }

  const args = server.args.map((value) => runtime.resolveStdioArgument(resolveValue('args', value), roots));
  const cwd = server.cwd === undefined ? undefined : resolveValue('cwd', server.cwd);
  const env = server.env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveValue('env', value)]));

  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);

  return {
    args,
    command: server.command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    kind: 'stdio',
  };
};
