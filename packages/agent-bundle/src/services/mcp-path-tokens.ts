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
  readonly target: string;
}

type McpPathTokenMap = Readonly<Partial<Record<McpRuntimeValueField, Readonly<Record<string, keyof McpRuntimeRoots>>>>>;

export interface McpPathTokenResolverOptions {
  readonly knownTokens?: readonly string[];
  readonly target: string;
  readonly tokens: McpPathTokenMap;
}

const runtimeFields: readonly McpRuntimeValueField[] = ['args', 'cwd', 'env', 'headers', 'url'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const runtimeDiagnostic = (
  target: string,
  field: McpRuntimeValueField,
  operation: 'resolve-value' | 'resolve-stdio-argument',
): Diagnostic => ({
  code: `mcp.runtime.${operation}.${field}`,
  message: operation === 'resolve-value'
    ? `MCP target ${JSON.stringify(target)} returned an invalid ${field} value resolver result.`
    : `MCP target ${JSON.stringify(target)} returned an invalid stdio argument resolver result for ${field}.`,
  severity: 'error',
  target,
});

const validDiagnostic = (value: unknown): value is Diagnostic =>
  isRecord(value) &&
  typeof value.code === 'string' &&
  typeof value.message === 'string' &&
  (value.generatedPath === undefined || typeof value.generatedPath === 'string') &&
  (value.recovery === undefined || typeof value.recovery === 'string') &&
  (value.sourcePath === undefined || typeof value.sourcePath === 'string') &&
  (value.target === undefined || typeof value.target === 'string') &&
  (value.severity === 'error' || value.severity === 'info' || value.severity === 'warning');

const validValueResolution = (value: unknown): value is { readonly diagnostics: readonly Diagnostic[]; readonly value: string } =>
  isRecord(value) &&
  typeof value.value === 'string' &&
  Array.isArray(value.diagnostics) &&
  value.diagnostics.every(validDiagnostic);

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
  target,
}: ResolveMcpPathTokensOptions): ModernMcpServer => {
  const diagnostics: Diagnostic[] = [];
  const resolveValue = (field: McpRuntimeValueField, value: string): string => {
    let resolved: unknown;
    try {
      resolved = runtime.resolveValue(field, roots, value);
    } catch {
      diagnostics.push(runtimeDiagnostic(target, field, 'resolve-value'));
      return value;
    }
    if (!validValueResolution(resolved)) {
      diagnostics.push(runtimeDiagnostic(target, field, 'resolve-value'));
      return value;
    }
    diagnostics.push(...resolved.diagnostics);
    return resolved.value;
  };

  const resolveStdioArgument = (value: string): string => {
    try {
      const resolved: unknown = runtime.resolveStdioArgument(value, roots);
      if (typeof resolved === 'string') return resolved;
    } catch {
      // Target callbacks are isolated behind a stable diagnostic below.
    }
    diagnostics.push(runtimeDiagnostic(target, 'args', 'resolve-stdio-argument'));
    return value;
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

  const unresolvedArgs = server.args.map((value) => resolveValue('args', value));
  const cwd = server.cwd === undefined ? undefined : resolveValue('cwd', server.cwd);
  const env = server.env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, resolveValue('env', value)]));

  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  const args = unresolvedArgs.map(resolveStdioArgument);
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);

  return {
    args,
    command: server.command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(env === undefined ? {} : { env }),
    kind: 'stdio',
  };
};
