import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { runNodeScript } from './support/run-node-script.ts';

it('runs compiled function events, explicit JSX views, and CLI metadata and JSON input without source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-function-authoring-'));
  try {
    await symlink(join(process.cwd(), 'examples/audiobook-curator/node_modules'), join(root, 'node_modules'), 'dir');
    const files = {
      'package.json': JSON.stringify({ name: 'function-authoring', type: 'module', version: '1.0.0', dependencies: { '@agent-bundle/runtime': 'workspace:*', react: '19.2.8', zod: '4.5.4' } }),
      'agent-bundle.config.ts': `import { defineConfig } from 'agent-bundle/config'; export default defineConfig({ plugin: { name: 'function-authoring', version: '1.0.0' }, targets: ['claude'] });`,
      'src/providers/unused.ts': `throw new Error('unused provider evaluated'); export default () => 'unused';`,
      'src/providers/policy.ts': `export default () => 'Writes disabled';`,
      'src/events/tool/before.ts': `import { events } from 'agent-bundle/routes'; export default events.tool.before({}, async ({canonical, provider}) => { if (canonical.payload.toolName?.value === 'Write') return { outcome: 'deny', reason: await provider('policy') }; });`,
      'src/events/prompt/submit.ts': `import { events } from 'agent-bundle/routes';
export default events.prompt.submit({}, async (ctx) => {
  if (ctx.canonical.payload.prompt?.value === 'render') return ctx.render('./submit.view.js', { detail: 'from handler' });
});`,
      'src/events/prompt/submit.view.tsx': `
import { Agent } from '@agent-bundle/runtime';
import { message } from '../../heavy.js';
export default async function Prompt({ renderInput }) { return <Agent.Result value={{ outcome: 'deny', reason: message + ':' + renderInput.detail }} />; }
`,
      'src/heavy.ts': `export const message = 'Rendered decision';`,
      'src/mcp/runtime/tools/status.tsx': `
import { defineTool } from 'agent-bundle/routes';
import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';
export default defineTool({ inputJsonSchema: { type: 'object', additionalProperties: false, properties: { verbose: { type: 'boolean' } } }, description: 'Status', annotations: { readOnlyHint: true }, inputSchema: z.object({ verbose: z.boolean().default(false) }), resultSchema: z.object({ verbose: z.boolean() }) }, async (input) => <Agent.Result value={input}><Agent.Text>Ready</Agent.Text></Agent.Result>);
`,
      'src/cli/convert.ts': `import { z } from 'zod';
let calls = 0;
export const config = { input: 'json' };
const makeSchema = () => z.object({ amount: z.string().default('5') }).transform(({amount}) => ({ value: Number(amount), calls: ++calls }));
export const inputSchema = makeSchema();
export const resultSchema = z.object({ value: z.number(), calls: z.literal(1) });
export default function Convert({input}) { return input; }
`,
      'src/mcp/runtime/tools/status.cli.ts': `export const config = { command: ['status'], confirm: false };`,
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const result = await build({ root, output: join(root, 'artifact') });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    const tool = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:tool-before')!;
    const prompt = result.build.compiledHooks.find((hook) => hook.id === 'hook:event-route:prompt-submit')!;
    expect(await readFile(prompt.output, 'utf8')).not.toContain('Rendered decision');
    expect(await readFile(tool.output, 'utf8')).not.toContain('react.transitional.element');
    await rm(join(root, 'src'), { recursive: true });
    const invoke = (output: string, input: object) => runNodeScript({ args: [output], cwd: root, input: JSON.stringify(input) });
    const base = { permission_mode: 'default', cwd: root, session_id: 'session', transcript_path: join(root, 'transcript.json') };
    const denial = await invoke(tool.output, { ...base, hook_event_name: 'PreToolUse', tool_use_id: 'use-1', tool_name: 'Write', tool_input: {} });
    expect(denial.code, denial.stderr).toBe(0);
    expect(JSON.parse(denial.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Writes disabled' } });
    expect(await invoke(tool.output, { ...base, hook_event_name: 'PreToolUse', tool_use_id: 'use-1', tool_name: 'Read', tool_input: {} })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await invoke(prompt.output, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'skip' })).toEqual({ code: 0, stdout: '', stderr: '' });
    const rendered = await invoke(prompt.output, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'render' });
    expect(rendered.code, rendered.stderr).toBe(0);
    expect(rendered.stdout).toContain('Rendered decision:from handler');
    const cli = await runNodeScript({ args: [result.build.compiledCliBins[0]!.output, 'status', '--json'], cwd: root });
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('"verbose":false');
    const flagged = await runNodeScript({ args: [result.build.compiledCliBins[0]!.output, 'status', '--verbose', '--json'], cwd: root });
    expect(flagged.code, flagged.stderr).toBe(0);
    expect(flagged.stdout).toContain('"verbose":true');
    for (const [args, value] of [[[], 5], [['--input', '{"amount":"7"}'], 7]] as const) {
      const converted = await runNodeScript({ args: [result.build.compiledCliBins[0]!.output, 'convert', ...args, '--json'], cwd: root });
      expect(converted.code, converted.stderr).toBe(0);
      expect(JSON.parse(converted.stdout)).toEqual({ value, calls: 1 });
    }
    await mkdir(join(root, 'src/events/session'), { recursive: true });
    await writeFile(join(root, 'src/events/session/start.tsx'), `import { Agent } from '@agent-bundle/runtime'; export default async function SessionStart() { return <Agent.Result><Agent.Context>Check the release checklist.</Agent.Context></Agent.Result>; }`);
    const eventOnly = await build({ root, output: join(root, 'event-only') });
    expect(eventOnly.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    expect(eventOnly.build.compiledMcpEntries).toHaveLength(0);
    const session = await invoke(eventOnly.build.compiledHooks[0]!.output, { ...base, hook_event_name: 'SessionStart', source: 'startup', model: 'test' });
    expect(session.code, session.stderr).toBe(0);
    expect(session.stdout).toContain('Check the release checklist.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

it('mounts identities, state, notices, and provider observations in a compiled lightweight event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-event-context-'));
  try {
    await symlink(join(process.cwd(), 'examples/audiobook-curator/node_modules'), join(root, 'node_modules'), 'dir');
    const files = {
      'package.json': JSON.stringify({ name: 'event-context', type: 'module', version: '1.0.0', dependencies: { '@agent-bundle/runtime': 'workspace:*', zod: '4.5.4' } }),
      'agent-bundle.config.ts': `import { defineConfig } from 'agent-bundle/config'; export default defineConfig({ plugin: { name: 'event-context', version: '1.0.0' }, targets: ['claude'] });`,
      'src/state.ts': `import { defineState } from '@agent-bundle/runtime/state'; import { z } from 'zod';
export default defineState({ id: 'event-context/state', lifetime: 'workspace-durable', initial: { count: 7 }, schema: z.object({ count: z.number() }), events: { tick: z.object({}) }, reduce: (state) => state });`,
      'src/providers/context.ts': `export default async (ctx) => JSON.stringify({ session: ctx.session, workspace: ctx.workspace, lineage: ctx.lineage, plugin: ctx.plugin, snapshot: await ctx.state.read(), notices: ctx.notices !== undefined });`,
      'src/events/tool/before.ts': `import { events } from 'agent-bundle/routes'; export default events.tool.before({}, async ({ provider, process }) => ({ outcome: 'deny', reason: JSON.stringify({ ...JSON.parse(await provider('context')), process }) }));`,
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const built = await build({ root, output: join(root, 'artifact') });
    const output = built.build.compiledHooks[0]!.output;
    await rm(join(root, 'src'), { recursive: true });
    const native = { hook_event_name: 'PreToolUse', permission_mode: 'default', cwd: root, session_id: 'session', transcript_path: join(root, 'transcript.json'), tool_use_id: 'use-1', tool_name: 'Write', tool_input: {} };
    const probe = await runNodeScript({
      args: ['--input-type=module', '-e', `const { prepareRouteInvocation } = await import(${JSON.stringify(output)}); const trace = []; const result = await prepareRouteInvocation(${JSON.stringify(native)}, new AbortController().signal, event => trace.push(event)); const again = await prepareRouteInvocation(${JSON.stringify(native)}, new AbortController().signal); console.log(JSON.stringify({ value: JSON.parse(result.gate.reason), next: JSON.parse(again.gate.reason).process.hits, providers: result.providerObservations, trace }));`],
      cwd: root,
      env: { AGENT_BUNDLE_STATE_ROOT: join(root, 'state') },
    });
    expect(probe.code, probe.stderr).toBe(0);
    const observed = JSON.parse(probe.stdout);
    expect(observed.value).toMatchObject({
      session: { state: 'available', value: { sessionId: 'session' } },
      workspace: { state: 'available', value: { root } },
      plugin: { state: 'available', value: { stateRoot: join(root, 'state') } },
      snapshot: { state: { count: 7 } },
      notices: true,
    });
    expect(observed.value.process.hits).toBe(1);
    expect(observed.next).toBe(2);
    expect(observed.value.lineage).toHaveProperty('state');
    expect(observed.providers).toEqual([expect.objectContaining({ key: 'context', status: 'mounted', durationMs: expect.any(Number) })]);
    expect(observed.trace.map((event: { kind: string }) => event.kind)).toEqual(['handler.start', 'providers.start', 'providers.finish', 'handler.outcome']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
