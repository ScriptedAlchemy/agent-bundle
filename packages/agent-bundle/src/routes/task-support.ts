import type { Diagnostic } from '../core/diagnostics.ts';
import type { ToolTaskSupport } from './public.ts';
import type { CompiledAgentRoute } from './types.ts';

/** The `Tool.execution.taskSupport` vocabulary of the MCP `2025-11-25` Tasks utility. */
export const toolTaskSupportValues: readonly ToolTaskSupport[] = Object.freeze(['forbidden', 'optional', 'required']);

const EXECUTION_KEYS: ReadonlySet<string> = new Set(['taskSupport']);

const isToolTaskSupport = (value: unknown): value is ToolTaskSupport =>
  typeof value === 'string' && (toolTaskSupportValues as readonly string[]).includes(value);

const executionError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4836',
  message,
  recovery: `Declare config.execution on a tool route as { taskSupport: ${toolTaskSupportValues.map((value) => `'${value}'`).join(' | ')} }, or omit it: a tool without one is called as an ordinary request (forbidden).`,
  severity: 'error',
  sourcePath,
});

export interface ValidatedRouteExecutionConfig {
  readonly diagnostics: readonly Diagnostic[];
  /** Present only when `config.execution.taskSupport` is declared and valid. */
  readonly taskSupport?: ToolTaskSupport;
}

/**
 * Interprets a route's statically extracted `config.execution` (#369): absent
 * means ordinary requests only; declared, it must be an object whose only key
 * is `taskSupport`, one of `forbidden`, `optional`, or `required`, and it may
 * appear on tool routes only — the `2025-11-25` Tasks utility augments
 * `tools/call` and nothing else a generated server serves. `describe` names
 * the route kind in the message (`MCP route`).
 */
export const validateRouteExecutionConfig = (
  route: CompiledAgentRoute,
  describe: string,
): ValidatedRouteExecutionConfig => {
  const declared = route.config['execution'];
  if (declared === undefined) return { diagnostics: [] };
  const relativePath = route.provenance.relativePath;
  if (route.kind !== 'tool') {
    return {
      diagnostics: [executionError(
        `${describe} ${relativePath} declares config.execution, which only tool routes accept: MCP tasks augment tools/call, not ${route.kind} reads.`,
        route.source,
      )],
    };
  }
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    return {
      diagnostics: [executionError(`${describe} ${relativePath} config.execution must be an object.`, route.source)],
    };
  }
  const unknown = Object.keys(declared).filter((key) => !EXECUTION_KEYS.has(key));
  if (unknown.length > 0) {
    return {
      diagnostics: [executionError(
        `${describe} ${relativePath} config.execution declares unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; only taskSupport is accepted.`,
        route.source,
      )],
    };
  }
  const taskSupport = (declared as { readonly taskSupport?: unknown }).taskSupport;
  if (taskSupport === undefined) return { diagnostics: [] };
  if (!isToolTaskSupport(taskSupport)) {
    return {
      diagnostics: [executionError(
        `${describe} ${relativePath} config.execution.taskSupport must be one of ${toolTaskSupportValues.map((value) => JSON.stringify(value)).join(', ')}; got ${JSON.stringify(taskSupport)}.`,
        route.source,
      )],
    };
  }
  return { diagnostics: [], taskSupport };
};

/**
 * The task support a compiled tool config declares at run time: the generated
 * MCP server reads the compiled `config`, which the build already validated,
 * so this reader only picks the well-formed value and treats anything else as
 * the wire default, `forbidden`.
 */
export const routeTaskSupport = (config: Readonly<Record<string, unknown>>): ToolTaskSupport => {
  const declared = config['execution'];
  if (typeof declared !== 'object' || declared === null) return 'forbidden';
  const taskSupport = (declared as { readonly taskSupport?: unknown }).taskSupport;
  return isToolTaskSupport(taskSupport) ? taskSupport : 'forbidden';
};
