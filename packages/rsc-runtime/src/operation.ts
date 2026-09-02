import type { ReactNode } from 'react';
import type { ZodType } from 'zod';

import { currentAgentRequest, type AgentRequestContext } from './agent-request.js';
import { frozenJsonRecord } from './lower-mcp.js';

/**
 * Per-invocation values supplied independently of business input.
 *
 * `request` is the transport-installed request handle when execution occurs
 * inside `runAgentRequest`. Its identity axes are `Observed`, so an axis the
 * transport cannot know is unavailable with a typed reason rather than
 * fabricated.
 */
export interface RscOperationContext {
  readonly request?: AgentRequestContext;
  readonly signal: AbortSignal;
}

export interface RscCliDefinition<TInput, TResult> {
  readonly exitCode?: (result: TResult) => 0 | 1 | 2;
  readonly name: string;
  readonly parse: (argv: readonly string[]) => TInput;
  readonly summary: string;
  readonly usage: string;
}

export interface RscMcpDefinition {
  /** Listing-level metadata forwarded verbatim to tool registration, e.g. `{ ui: { resourceUri } }` for MCP Apps widget binding. */
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly destructive?: boolean;
  readonly description: string;
  readonly idempotent?: boolean;
  readonly name: string;
  readonly openWorld?: boolean;
  readonly readOnly: boolean;
  readonly server: string;
  /** Human-readable tool listing title. */
  readonly title?: string;
}

export interface RscOperationInput<TInput, TResult> {
  readonly cli?: RscCliDefinition<TInput, TResult>;
  /**
   * Receives validated business input separately from transport-owned request
   * identity. Fields in `input` cannot override `context.request`.
   */
  readonly execute: (input: TInput, context: RscOperationContext) => Promise<TResult>;
  readonly id: string;
  readonly inputSchema: ZodType<TInput>;
  readonly mcp?: RscMcpDefinition;
  readonly render: (result: TResult) => ReactNode;
  readonly resultSchema: ZodType<TResult>;
}

export interface RscCliOperation {
  readonly exitCode: (result: unknown) => 0 | 1 | 2;
  readonly name: string;
  readonly parse: (argv: readonly string[]) => unknown;
  readonly summary: string;
  readonly usage: string;
}

export interface RscOperationDefinition {
  readonly cli?: RscCliOperation;
  readonly execute: (input: unknown, context: RscOperationContext) => Promise<unknown>;
  readonly id: string;
  readonly inputSchema: ZodType;
  readonly mcp?: Readonly<RscMcpDefinition>;
  readonly render: (result: unknown) => ReactNode;
  readonly resultSchema: ZodType;
}

const operationName = /^[a-z][a-z0-9._-]{0,63}$/u;

const requireName = (value: string, label: string): string => {
  if (!operationName.test(value)) throw new Error(`${label} must be a canonical lowercase identifier`);
  return value;
};

const requireText = (value: string, label: string): string => {
  if (value.trim() === '' || Buffer.byteLength(value) > 4096) throw new Error(`${label} must be non-empty and bounded`);
  return value;
};

export const defineOperation = <TInput, TResult>(
  input: RscOperationInput<TInput, TResult>,
): Readonly<RscOperationDefinition> => {
  const id = requireName(input.id, 'Operation id');
  const cli = input.cli === undefined
    ? undefined
    : Object.freeze<RscCliOperation>({
        exitCode: (value) => input.cli?.exitCode?.(input.resultSchema.parse(value)) ?? 0,
        name: requireName(input.cli.name, `Operation ${id} CLI name`),
        parse: input.cli.parse,
        summary: requireText(input.cli.summary, `Operation ${id} CLI summary`),
        usage: requireText(input.cli.usage, `Operation ${id} CLI usage`),
      });
  const mcp = input.mcp === undefined
    ? undefined
    : Object.freeze<RscMcpDefinition>({
        ...(input.mcp._meta === undefined
          ? {}
          : { _meta: frozenJsonRecord(input.mcp._meta, `Operation ${id} MCP _meta must be JSON-serializable`) }),
        ...(input.mcp.destructive === undefined ? {} : { destructive: input.mcp.destructive }),
        description: requireText(input.mcp.description, `Operation ${id} MCP description`),
        ...(input.mcp.idempotent === undefined ? {} : { idempotent: input.mcp.idempotent }),
        name: requireName(input.mcp.name, `Operation ${id} MCP name`),
        ...(input.mcp.openWorld === undefined ? {} : { openWorld: input.mcp.openWorld }),
        readOnly: input.mcp.readOnly,
        server: requireName(input.mcp.server, `Operation ${id} MCP server`),
        ...(input.mcp.title === undefined ? {} : { title: requireText(input.mcp.title, `Operation ${id} MCP title`) }),
      });

  return Object.freeze<RscOperationDefinition>({
    ...(cli === undefined ? {} : { cli }),
    execute: async (value, context) => {
      const request = context.request ?? currentAgentRequest();
      const operationContext: RscOperationContext = request === undefined
        ? context
        : { ...context, request };
      return input.resultSchema.parse(
        await input.execute(input.inputSchema.parse(value), operationContext),
      );
    },
    id,
    inputSchema: input.inputSchema,
    ...(mcp === undefined ? {} : { mcp }),
    render: (value) => input.render(input.resultSchema.parse(value)),
    resultSchema: input.resultSchema,
  });
};
