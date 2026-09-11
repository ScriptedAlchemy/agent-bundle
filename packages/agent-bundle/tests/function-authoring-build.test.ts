import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { runNodeScript } from './support/run-node-script.ts';

it('runs compiled function events, isolated JSX gates, and an inferred tool CLI without source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-function-authoring-'));
  try {
    await symlink(join(process.cwd(), 'examples/audiobook-curator/node_modules'), join(root, 'node_modules'), 'dir');
    const files = {
      'package.json': JSON.stringify({ name: 'function-authoring', type: 'module', version: '1.0.0', dependencies: { '@agent-bundle/runtime': 'workspace:*', react: '19.2.8', zod: '4.5.4' } }),
      'agent-bundle.config.ts': `import { defineConfig } from 'agent-bundle/config'; export default defineConfig({ plugin: { name: 'function-authoring', version: '1.0.0' }, targets: ['claude'] });`,
      'src/providers/unused.ts': `throw new Error('unused provider evaluated'); export default () => 'unused';`,
      'src/providers/policy.ts': `export default () => 'Writes disabled';`,
      'src/events/tool/before.ts': `import { events } from 'agent-bundle/routes'; export default events.tool.before({}, async ({canonical, provider}) => { if (canonical.payload.toolName?.value === 'Write') return { outcome: 'deny', reason: await provider('policy') }; });`,
      'src/events/prompt/submit.tsx': `
import { Agent } from '@agent-bundle/runtime';
import { message } from '../../heavy.js';
export function before({ canonical }) { return canonical.payload.prompt?.value === 'render' ? { outcome: 'render' } : { outcome: 'continue' }; }
export default async function Prompt() { return <Agent.Result value={{ outcome: 'deny', reason: message }} />; }
`,
      'src/heavy.ts': `export const message = 'Rendered decision';`,
      'src/mcp/runtime/tools/status.tsx': `
import { defineTool } from 'agent-bundle/routes';
import { Agent } from '@agent-bundle/runtime';
import { z } from 'zod';
export default defineTool({ description: 'Status', annotations: { readOnlyHint: true }, inputSchema: z.object({ verbose: z.boolean().default(false) }), resultSchema: z.object({ verbose: z.boolean() }) }, async (input) => <Agent.Result value={input}><Agent.Text>Ready</Agent.Text></Agent.Result>);
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
    expect(rendered.stdout).toContain('Rendered decision');
    const cli = await runNodeScript({ args: [result.build.compiledCliBins[0]!.output, 'status', '--json'], cwd: root });
    expect(cli.code, cli.stderr).toBe(0);
    expect(cli.stdout).toContain('"verbose":false');
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
