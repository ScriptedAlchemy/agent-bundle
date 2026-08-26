import type { ReactNode } from 'react';
import type { ZodType } from 'zod';

export interface RscOperationContext {
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
  readonly destructive?: boolean;
  readonly description: string;
  readonly idempotent?: boolean;
  readonly name: string;
  readonly openWorld?: boolean;
  readonly readOnly: boolean;
  readonly server: string;
}

export interface RscOperationInput<TInput, TResult> {
  readonly cli?: RscCliDefinition<TInput, TResult>;
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
        ...(input.mcp.destructive === undefined ? {} : { destructive: input.mcp.destructive }),
        description: requireText(input.mcp.description, `Operation ${id} MCP description`),
        ...(input.mcp.idempotent === undefined ? {} : { idempotent: input.mcp.idempotent }),
        name: requireName(input.mcp.name, `Operation ${id} MCP name`),
        ...(input.mcp.openWorld === undefined ? {} : { openWorld: input.mcp.openWorld }),
        readOnly: input.mcp.readOnly,
        server: requireName(input.mcp.server, `Operation ${id} MCP server`),
      });

  return Object.freeze<RscOperationDefinition>({
    ...(cli === undefined ? {} : { cli }),
    execute: async (value, context) => input.resultSchema.parse(
      await input.execute(input.inputSchema.parse(value), context),
    ),
    id,
    inputSchema: input.inputSchema,
    ...(mcp === undefined ? {} : { mcp }),
    render: (value) => input.render(input.resultSchema.parse(value)),
    resultSchema: input.resultSchema,
  });
};
