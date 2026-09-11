import { expect, it } from '@rstest/core';
import { runAgentRequest } from '@agent-bundle/runtime/request';
import { z } from 'zod';

import { extractRouteConfig } from '../src/routes/config-extract.ts';
import { validateRouteModuleContract } from '../src/routes/contract.ts';
import { defineTool, normalizeRouteModule } from '../src/routes/definitions.ts';
import { parseModule } from '../src/routes/syntax.ts';
import { readRouteDefinition } from '../src/routes/definition-syntax.ts';
import { eventHandlerEntry } from '../src/routes/event-handler.ts';
import { events } from '../src/routes/event-definitions.ts';
import { executeEventHandler } from '../src/events/handler.ts';
import { createCanonicalEventProps, projectEventHandlerResult } from '../src/events/projection.ts';

const path = '/project/src/mcp/runtime/tools/status.tsx';
const source = `
import { defineTool as tool } from 'agent-bundle/routes';
import { z } from 'zod';
throw new Error('inspection must not execute application code');
export default tool({ description: 'Status', inputSchema: z.object({ verbose: z.boolean().default(false) }), resultSchema: z.object({ status: z.string() }) }, importedHandler);
`;

it('extracts a bounded definition without inspecting or evaluating its handler', () => {
  expect(extractRouteConfig(source, path, path)).toMatchObject({ config: { description: 'Status' }, diagnostics: [] });
  expect(validateRouteModuleContract(source, path, path)).toEqual([]);
});

it('extracts shorthand schemas in their original module scope', () => {
  const shorthand = `import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';
const inputSchema = z.object({ verbose: z.boolean().default(false) });
export default defineTool({ inputSchema, resultSchema: z.string() }, async () => 'ok');`;
  expect(readRouteDefinition(parseModule(path, shorthand))?.inputSchema).toBeDefined();
  expect(validateRouteModuleContract(shorthand, path, path)).toEqual([]);
});

it('normalizes the same inferred handler for generated and source execution', async () => {
  const inputSchema = z.object({ verbose: z.boolean().default(false) });
  const definition = defineTool({ inputSchema, resultSchema: z.string() }, async (input, context) => {
    const flag: boolean = input.verbose;
    return `${flag}:${await context.provider('policy')}`;
  });
  const module = normalizeRouteModule({ default: definition });
  expect(Object.getOwnPropertyDescriptor(module, 'inputSchema')?.value).toBe(inputSchema);
  expect(await runAgentRequest({ invocation: { kind: 'tool' }, resolveProvider: async () => 'ready' },
    () => module.default({ input: inputSchema.parse({}), signal: new AbortController().signal }))).toBe('false:ready');
});

it('rejects closure extraction and dynamic definition composition', () => {
  expect(() => eventHandlerEntry('export function before() {} export default async function View() {}', 'before.tsx', '/before.tsx')).toThrow('no longer supported');
  for (const declaration of [
    'const tool = createMyTool(); export default tool;',
    'const opts = getOptions(); export default defineTool(opts, handler);',
    'export default wrapper(defineTool({}, handler));',
  ]) {
    expect(() => readRouteDefinition(parseModule(path, `import { defineTool } from 'agent-bundle/routes'; ${declaration}`))).toThrow('Unsupported route definition');
  }
});

it('uses one event projection for implicit continue, denial, and a rendered gate', async () => {
  const signal = new AbortController().signal;
  const native = { cwd: '/project', hook_event_name: 'PreToolUse', session_id: 's1', tool_input: {}, tool_name: 'Write' };
  const props = createCanonicalEventProps('tool/before', native, 'claude', 'PreToolUse', 'test', signal);
  const context = { ...props, host: { name: 'claude', nativeEvent: 'PreToolUse' }, terminal: { hostSurface: 'hook' as const, sharesTarget: false, stderr: { color: 'none' as const, kind: 'none' as const }, stdout: { color: 'none' as const, kind: 'none' as const } } };
  const handler = events.tool.before({}, async () => ({ outcome: 'deny', reason: 'Writes disabled' }));
  const denial = await executeEventHandler((ctx) => handler({ ...props, ...ctx, process: undefined, provider: async () => undefined }), context);
  expect(denial).toEqual({ outcome: 'deny', reason: 'Writes disabled' });
  const continued = await executeEventHandler(() => undefined, context);
  expect(continued).toEqual({ outcome: 'continue' });
  expect(projectEventHandlerResult({ outcome: 'continue' }, 'tool/before', 'claude', 'PreToolUse', native)).toBeUndefined();
  expect(await executeEventHandler(({ render }) => render('./before.view.js', { value: 1 }), context, undefined, './before.view.js')).toEqual({ outcome: 'render', module: './before.view.js', data: { value: 1 } });
  await expect(executeEventHandler(({ render }) => render('./missing.js', null), context)).rejects.toThrow('sibling');
});
