import { expect, it } from '@rstest/core';
import { runAgentRequest } from '@agent-bundle/runtime/request';
import { z } from 'zod';

import { extractRouteConfig } from '../src/routes/config-extract.ts';
import { validateRouteModuleContract } from '../src/routes/contract.ts';
import { defineTool, normalizeRouteModule } from '../src/routes/definitions.ts';
import { eventHandlerEntry } from '../src/routes/event-handler.ts';
import { events } from '../src/routes/event-definitions.ts';
import { extractInputSchema } from '../src/routes/input-schema.ts';
import { eventHandlerPreflight, executeEventPreflight } from '../src/events/preflight.ts';
import { createCanonicalEventProps, projectEventPreflightResult } from '../src/events/projection.ts';

const path = '/project/src/mcp/runtime/tools/status.tsx';
const source = `
import { defineTool as tool } from 'agent-bundle/routes';
import { z } from 'zod';
throw new Error('inspection must not execute application code');
export default tool({ description: 'Status', inputSchema: z.object({ verbose: z.boolean().default(false) }), resultSchema: z.object({ status: z.string() }) }, importedHandler);
`;

it('extracts a bounded definition without inspecting or evaluating its handler', () => {
  expect(extractRouteConfig(source, path, path)).toMatchObject({ config: { description: 'Status' }, diagnostics: [] });
  expect(extractInputSchema(source, path)).toBeDefined();
  expect(validateRouteModuleContract(source, path, path)).toEqual([]);
});

it('extracts shorthand schemas in their original module scope', () => {
  const shorthand = `import { defineTool } from 'agent-bundle/routes';
import { z } from 'zod';
const inputSchema = z.object({ verbose: z.boolean().default(false) });
export default defineTool({ inputSchema, resultSchema: z.string() }, async () => 'ok');`;
  expect(extractInputSchema(shorthand, path)?.schema).toEqual(extractInputSchema(source, path)?.schema);
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

it('isolates before() from JSX imports and top-level initialization, rejecting captures', () => {
  const entry = eventHandlerEntry(`
import { Agent } from '@agent-bundle/runtime';
import { check } from '../../policy.js';
throw new Error('heavy initialization');
export async function before({canonical}) { return check(canonical); }
export default async function View() { return <Agent.Result/>; }
`, 'src/events/tool/before.tsx', '/project/src/events/tool/before.tsx');
  expect(eventHandlerEntry('export default async function before() {}', 'before.tsx', '/before.tsx')).toBeUndefined();
  expect(entry?.mode).toBe('gate');
  expect(entry?.virtualSource).toContain('/project/src/policy.js');
  expect(entry?.virtualSource).not.toMatch(/heavy initialization|Agent|View/u);
  expect(() => eventHandlerEntry('const policy = true; export function before() { return { policy }; }', 'before.tsx', '/before.tsx')).toThrow('captures policy');
  expect(() => eventHandlerEntry("export { gate as before } from './gate.js';", 'before.tsx', '/before.tsx')).toThrow('function declaration');
});

it('uses one event projection for implicit continue, denial, and a rendered gate', async () => {
  const signal = new AbortController().signal;
  const native = { cwd: '/project', hook_event_name: 'PreToolUse', session_id: 's1', tool_input: {}, tool_name: 'Write' };
  const props = createCanonicalEventProps('tool/before', native, 'claude', 'PreToolUse', 'test', signal);
  const context = { ...props, host: { name: 'claude', nativeEvent: 'PreToolUse' }, terminal: { hostSurface: 'hook' as const, sharesTarget: false, stderr: { color: 'none' as const, kind: 'none' as const }, stdout: { color: 'none' as const, kind: 'none' as const } } };
  const handler = events.tool.before({}, async () => ({ outcome: 'deny', reason: 'Writes disabled' }));
  const denial = await executeEventPreflight(eventHandlerPreflight(() => handler({ ...props, provider: async () => undefined }), 'handler'), context);
  expect(denial).toEqual({ outcome: 'deny', reason: 'Writes disabled' });
  const continued = await executeEventPreflight(eventHandlerPreflight(() => undefined, 'handler'), context);
  expect(continued).toEqual({ outcome: 'continue' });
  expect(projectEventPreflightResult({ outcome: 'continue' }, 'tool/before', 'claude', 'PreToolUse', native)).toBeUndefined();
  expect(await executeEventPreflight(eventHandlerPreflight(() => ({ outcome: 'render' }), 'gate'), context)).toBe('execute');
  await expect(executeEventPreflight(eventHandlerPreflight(() => ({ outcome: 'render' }), 'handler'), context)).rejects.toThrow();
});
