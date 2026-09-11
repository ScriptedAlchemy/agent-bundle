import type { AgentRequestContext } from '@agent-bundle/runtime';
import type { ReactNode } from 'react';

import type { RouteSchema, RouteSchemaOutput, ToolConfig, ToolRouteProps } from './public.ts';

/** One inferred handler; the generated projections own parsing and result validation. */
export const defineTool = <Input extends RouteSchema, Result extends RouteSchema>(
  config: ToolConfig & { readonly inputSchema: Input; readonly resultSchema: Result },
  handler: (input: RouteSchemaOutput<Input>, context: AgentRequestContext) => ReactNode | Promise<ReactNode>,
) => Object.assign(async (props: ToolRouteProps<Input>): Promise<ReactNode> => {
  const { agent } = await import('@agent-bundle/runtime/request');
  return handler(props.input, await agent());
}, config);

/** Normalize a definition into the module contract used by every projection. */
export const normalizeRouteModule = <Module extends { readonly default?: unknown }>(module: Module): Module => {
  const definition = module.default;
  if (typeof definition !== 'function' || !('inputSchema' in definition) || !('resultSchema' in definition)) return module;
  return Object.assign({}, definition, module);
};
