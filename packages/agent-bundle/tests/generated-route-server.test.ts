import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { eventRuntimeEndpoint } from '../src/events/ipc.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

const runHook = async (
  entry: string,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<NodeJS.ProcessEnv> = {},
): Promise<Readonly<Record<string, unknown>> | undefined> => new Promise((resolve, reject) => {
  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, [entry], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) {
      reject(new Error(stderr));
      return;
    }
    resolve(stdout === '' ? undefined : JSON.parse(stdout) as Readonly<Record<string, unknown>>);
  });
  child.stdin.end(JSON.stringify(input));
});

it('lists and calls a generated filesystem tool through final-only Flight', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-routes-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-routes-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-routes-fixture', version: '1.0.0' }, targets: ['portable'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/resources/catalog.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Read the catalog.', mimeType: 'application/json', uri: 'catalog://books' };",
      "export const inputSchema = z.object({ uri: z.string() }).strict();",
      "export const resultSchema = z.object({ contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })) }).strict();",
      'export default async function Catalog({ input }) {',
      "  const result = { contents: [{ mimeType: 'application/json', text: '{\"books\":1}', uri: input.uri }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Catalog ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/prompts/curate.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Curate one genre.' };",
      "export const inputSchema = z.object({ genre: z.string() }).strict();",
      "export const resultSchema = z.object({ messages: z.array(z.object({ content: z.object({ text: z.string(), type: z.literal('text') }), role: z.literal('user') })) }).strict();",
      'export default async function Curate({ input }) {',
      "  const result = { messages: [{ content: { text: `Curate ${input.genre}`, type: 'text' }, role: 'user' }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Prompt ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/apps/dashboard.ts', [
      "export const config = { resourceUri: 'ui://curator/dashboard.html' };",
      "document.body.textContent = 'Curator dashboard';",
      '',
    ].join('\n')),
    // Authored as JSX with no React import, the way the documented route
    // contract reads: the build has to select the automatic JSX runtime, or
    // the emitted module calls a `React` factory that is not in scope.
    writeProjectFile(root, 'src/mcp/curator/tools/inspect.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Inspect one source.' };",
      "export const inputSchema = z.object({ source: z.string() }).strict();",
      "export const resultSchema = z.object({ actor: z.unknown(), host: z.unknown(), invocationKind: z.literal('tool'), session: z.unknown(), source: z.string(), workspace: z.unknown() }).strict();",
      'export default async function Inspect({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  const result = { actor: context.actor, host: context.host, invocationKind: context.invocation.kind, session: context.session, source: input.source, workspace: context.workspace };',
      '  return (',
      '    <Agent.Result value={result}>',
      '      <Agent.Markdown>{`Inspected **${input.source}**.`}</Agent.Markdown>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const generatedTypes = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(generatedTypes).toContain('tool:curator/inspect');
  expect(generatedTypes).toContain('resource:curator/catalog');
  expect(generatedTypes).toContain('prompt:curator/curate');
  const server = compiled.model.mcpServers[0];
  expect(server).toMatchObject({ id: 'mcp:curator', name: 'curator' });
  const entry = join(output, 'portable', server!.args![0]!);
  const worker = entry.replace(/\.mjs$/u, '-flight.mjs');
  const statelessSources = await Promise.all([entry, worker].map((path) => readFile(path, 'utf8')));
  for (const source of statelessSources) {
    for (const forbidden of [
      '@agent-bundle/runtime/mount',
      'createGeneratedRuntimeState',
      'node:sqlite',
      'createSqliteStateDriver',
      'noticeLedger: bindings.noticeLedger',
      '@agent-bundle/runtime/notices/inbox-route',
      'agent-bundle:notice-inbox',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  }
  const client = new Client({ name: 'generated-route-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
    }
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ annotations: { readOnlyHint: true }, description: 'Inspect one source.', name: 'inspect' }],
    });
    const inspected = await client.callTool({ arguments: { source: 'library' }, name: 'inspect' }, { signal: AbortSignal.timeout(10_000) });
    expect(inspected).toMatchObject({
      content: [{ text: 'Inspected **library**.', type: 'text' }],
      structuredContent: { invocationKind: 'tool', source: 'library' },
    });
    expect(inspected.structuredContent).toMatchObject({
      actor: { reason: 'not-provided', state: 'unavailable' },
      host: { reason: 'not-provided', state: 'unavailable' },
      session: { reason: 'not-provided', state: 'unavailable' },
      workspace: { reason: 'not-provided', state: 'unavailable' },
    });
    const resources = await client.listResources();
    expect(resources).toMatchObject({ resources: [
      expect.objectContaining({ uri: 'catalog://books' }),
      expect.objectContaining({ uri: 'ui://curator/dashboard.html' }),
    ] });
    expect(resources.resources.map((resource) => resource.uri)).not.toContain('agent-bundle://notices/inbox');
    await expect(client.readResource({ uri: 'catalog://books' })).resolves.toEqual({
      contents: [{ mimeType: 'application/json', text: '{"books":1}', uri: 'catalog://books' }],
    });
    await expect(client.listPrompts()).resolves.toMatchObject({ prompts: [
      expect.objectContaining({ description: 'Curate one genre.', name: 'curate' }),
    ] });
    await expect(client.getPrompt({ arguments: { genre: 'mystery' }, name: 'curate' })).resolves.toEqual({
      messages: [{ content: { text: 'Curate mystery', type: 'text' }, role: 'user' }],
    });
  } finally {
    await client.close();
  }
});

const writeGeneratedProject = async (
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-routes-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-routes-fixture', version: '1.0.0' }, targets: ['portable'] });",
      '',
    ].join('\n')),
    ...Object.entries(files).map(([path, contents]) => writeProjectFile(root, path, contents)),
  ]);
};

const connectGeneratedServer = async (root: string): Promise<{
  readonly client: Client;
  readonly close: () => Promise<void>;
}> => {
  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const server = compiled.model.mcpServers[0];
  if (server?.args?.[0] === undefined) throw new Error('expected a generated MCP entry');
  const client = new Client({ name: 'generated-route-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [join(output, 'portable', server.args[0])],
    command: process.execPath,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
  }
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
};

const callGeneratedTool = async (client: Client, name: string): Promise<unknown> => {
  try {
    return await client.callTool({ arguments: {}, name }, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return error;
  }
};

const expectFailClosed = (outcome: unknown, message: RegExp): void => {
  if (outcome instanceof Error) {
    expect(`${outcome.name} ${outcome.message}`).toMatch(message);
    return;
  }
  expect(outcome).toMatchObject({ isError: true });
  expect(JSON.stringify(outcome)).toMatch(message);
};

it('observes one process-lifetime provider across consecutive generated tool calls', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-warm-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/state.ts': [
      "import { defineState } from '@agent-bundle/runtime/state';",
      "import { z } from 'zod';",
      "export default defineState({",
      "  events: { changed: z.object({ value: z.string() }).strict() },",
      "  id: 'generated-routes/process-state',",
      '  initial: { value: "" },',
      "  lifetime: 'process',",
      '  reduce: (_state, event) => ({ value: event.payload.value }),',
      '  schema: z.object({ value: z.string() }).strict(),',
      '});',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/warmth.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Observe process lifetime.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ hits: z.number(), instanceId: z.string(), pid: z.number() }).strict();',
      'export default async function Warmth() {',
      '  const context = await agent();',
      '  const processLifetime = context.providers.processLifetime;',
      "  if (processLifetime === undefined || typeof processLifetime !== 'object' || processLifetime === null) {",
      "    throw new Error('process-lifetime provider was not installed');",
      '  }',
      '  const value = processLifetime as { hits: number; instanceId: string; pid: number };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `hit ${String(value.hits)}`));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    const first = await session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) });
    const second = await session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) });
    expect(first).toMatchObject({
      content: [{ text: 'hit 1', type: 'text' }],
      structuredContent: { hits: 1 },
    });
    expect(second).toMatchObject({
      content: [{ text: 'hit 2', type: 'text' }],
      structuredContent: { hits: 2 },
    });
    const firstId = (first.structuredContent as { instanceId: string }).instanceId;
    const secondContent = second.structuredContent as { instanceId: string; pid: number };
    expect(secondContent.instanceId).toBe(firstId);
    expect(secondContent.pid).toBe((first.structuredContent as { pid: number }).pid);
    await expect(session.client.listResources()).resolves.toMatchObject({
      resources: [expect.objectContaining({ uri: 'agent-bundle://notices/inbox' })],
    });
    await expect(session.client.readResource({ uri: 'agent-bundle://notices/inbox' })).resolves.toEqual({
      contents: [{
        mimeType: 'application/json',
        text: '{"notices":[]}',
        uri: 'agent-bundle://notices/inbox',
      }],
    });
  } finally {
    await session.close();
  }
});

it('emits MCP progress notifications only when a progress token is supplied', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-progress-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/progress.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Report progress.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Progress() {',
      '  const context = await agent();',
      "  await context.progress.report({ completed: 1, message: 'halfway', total: 2 });",
      "  await context.progress.report({ completed: 2, message: 'done', total: 2 });",
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'finished'));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  const notifications: Array<{ readonly message?: string; readonly progress: number; readonly progressToken: string | number; readonly total?: number }> = [];
  session.client.setNotificationHandler('notifications/progress', (notification) => {
    notifications.push(notification.params);
  });
  try {
    await expect(session.client.callTool({ arguments: {}, name: 'progress' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      content: [{ text: 'finished', type: 'text' }],
      structuredContent: { ok: true },
    });
    expect(notifications).toEqual([]);
    await expect(session.client.callTool({
      arguments: {},
      name: 'progress',
      _meta: { progressToken: 'tok-1' },
    }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(notifications).toEqual([
      { message: 'halfway', progress: 1, progressToken: 'tok-1', total: 2 },
      { message: 'done', progress: 2, progressToken: 'tok-1', total: 2 },
    ]);
  } finally {
    await session.close();
  }
});

it('maps notifications/cancelled into the renderer AbortSignal', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-cancel-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/hang.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Hang until cancelled.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Hang({ signal }) {',
      '  await new Promise((_, reject) => {',
      "    const fail = () => reject(new DOMException('aborted', 'AbortError'));",
      '    if (signal.aborted) { fail(); return; }',
      "    signal.addEventListener('abort', fail, { once: true });",
      '  });',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'should not complete'));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    const controller = new AbortController();
    const pending = session.client.callTool({ arguments: {}, name: 'hang' }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  } finally {
    await session.close();
  }
});

it('fails closed when the generated runtime worker restarts', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-restart-'));
  roots.push(root);
  await writeGeneratedProject(root, {
    'src/mcp/curator/tools/warmth.tsx': [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Observe process lifetime.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ hits: z.number(), instanceId: z.string(), pid: z.number() }).strict();',
      'export default async function Warmth() {',
      '  const context = await agent();',
      '  const value = context.providers.processLifetime as { hits: number; instanceId: string; pid: number };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `hit ${String(value.hits)}`));",
      '}',
      '',
    ].join('\n'),
    'src/mcp/curator/tools/halt.tsx': [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Halt the Flight worker.' };",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Halt() {',
      '  process.exit(1);',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'halted'));",
      '}',
      '',
    ].join('\n'),
  });
  const session = await connectGeneratedServer(root);
  try {
    await expect(session.client.callTool({ arguments: {}, name: 'warmth' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      structuredContent: { hits: 1 },
    });
    const halted = await callGeneratedTool(session.client, 'halt');
    expectFailClosed(halted, /unavailable|restarted|exited/i);
    const afterRestart = await callGeneratedTool(session.client, 'warmth');
    expectFailClosed(afterRestart, /unavailable|restarted|exited|connection closed/i);
    expect(afterRestart).not.toMatchObject({ structuredContent: { hits: 2 } });
  } finally {
    await session.close();
  }
});

it('renders one tool/after event route through two native thin clients', { retry: 2, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-events-fixture', version: '1.0.0' }, targets: ['claude', 'cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/runtime/tools/status.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      "export const resultSchema = z.object({ providerKind: z.literal('tool'), providersFrozen: z.literal(true) }).strict();",
      'export default async function Status() {',
      '  const context = await agent();',
      '  const requestValue = context.providers.requestValue as { kind: string };',
      '  const value = { providerKind: requestValue.kind, providersFrozen: Object.isFrozen(context.providers) };',
      "  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, `provider:${requestValue.kind}`));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/runtime/tools/explode.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ ok: z.literal(true) }).strict();',
      'export default async function Explode() {',
      "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Agent.Text, null, 'unreachable'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/request-value.ts', [
      "import type { AgentProviderFactory } from 'agent-bundle';",
      'const provideRequest: AgentProviderFactory = ({ invocation }) => Object.freeze({ kind: invocation.kind });',
      'export default provideRequest;',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/providers/throwing.ts', [
      "import type { AgentProviderFactory } from 'agent-bundle';",
      'const provideFailure: AgentProviderFactory = ({ invocation }) => {',
      "  if (invocation.kind === 'tool' && invocation.props.operationId.endsWith('/explode')) {",
      "    throw new Error('provider exploded');",
      '  }',
      "  return 'ready';",
      '};',
      'export default provideFailure;',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { targets: ['claude', 'cursor'], tools: ['file.write'], timeoutMs: 5000 };",
      'export default async function AfterTool({ canonical, native }) {',
      '  const context = await agent();',
      '  const requestValue = context.providers.requestValue as { kind: string };',
      '  const tool = typeof native.tool_name === "string" ? native.tool_name : "unknown";',
      "  const actor = context.actor.state === 'unavailable' ? `unavailable:${context.actor.reason}` : `available:${context.actor.value.id}`;",
      "  const host = context.host.state === 'unavailable' ? `unavailable:${context.host.reason}` : `available:${context.host.source}:${context.host.value.name}`;",
      "  const session = context.session.state === 'unavailable' ? `unavailable:${context.session.reason}` : `available:${context.session.source}:${context.session.value.sessionId}`;",
      "  const workspace = context.workspace.state === 'unavailable' ? `unavailable:${context.workspace.reason}` : `available:${context.workspace.source}:${context.workspace.value.root}`;",
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${canonical.provenance.host}:${tool}:${requestValue.kind}:${String(Object.isFrozen(context.providers))}:host:${host}:session:${session}:workspace:${workspace}:actor:${actor}`));',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude', 'cursor'] });
  expect(compiled.model.hooks.filter((hook) => hook.eventRoute !== undefined)).toHaveLength(1);
  expect(compiled.build.compiledHooks.filter((hook) => hook.id === 'hook:event-route:tool-after')).toHaveLength(2);

  for (const target of ['claude', 'cursor'] as const) {
    const mcp = compiled.build.compiledMcpEntries.find((entry) => entry.target === target)!;
    const hook = compiled.build.compiledHooks.find((entry) => entry.target === target && entry.event === 'afterTool')!;
    await expect(readFile(mcp.output, 'utf8')).resolves.toContain('agent-bundle-event-');
    const client = new Client({ name: `generated-event-${target}`, version: '0.0.0' });
    const transport = new StdioClientTransport({ args: [mcp.output], command: process.execPath, stderr: 'pipe' });
    await client.connect(transport);
    try {
      await expect(client.callTool({ arguments: {}, name: 'status' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
        content: [{ text: 'provider:tool', type: 'text' }],
        structuredContent: { providerKind: 'tool', providersFrozen: true },
      });
      const exploded = await callGeneratedTool(client, 'explode');
      expectFailClosed(exploded, /throwing.*src[/\\]providers[/\\]throwing\.ts.*provider exploded/iu);

      const endpointId = `${compiled.build.manifest.project.revision}:${target}:${dirname(dirname(resolve(mcp.output)))}`;
      const expectedEndpoint = eventRuntimeEndpoint(endpointId);
      await expect(stat(expectedEndpoint)).resolves.toMatchObject({ mode: expect.any(Number) });
      const native = target === 'cursor'
        ? {
            conversation_id: 'conversation-1',
            cwd: root,
            hook_event_name: 'postToolUse',
            session_id: 'session-1',
            tool_input: { file_path: 'demo.ts' },
            tool_name: 'Write',
            tool_output: '{"ok":true}',
            tool_use_id: 'tool-1',
          }
        : {
            cwd: root,
            hook_event_name: 'PostToolUse',
            session_id: 'session-1',
            tool_input: { file_path: 'demo.ts' },
            tool_name: 'Write',
            tool_response: { ok: true },
            tool_use_id: 'tool-1',
            transcript_path: join(root, 'transcript.jsonl'),
          };
      const response = await runHook(hook.output, native);
      expect(response).toEqual(target === 'cursor'
        ? { additional_context: `cursor:Write:event:true:host:available:native:cursor:session:available:native:session-1:workspace:available:native:${root}:actor:unavailable:not-provided` }
        : {
            hookSpecificOutput: {
              additionalContext: `claude:Write:event:true:host:available:native:claude:session:available:native:session-1:workspace:available:native:${root}:actor:unavailable:not-provided`,
              hookEventName: 'PostToolUse',
            },
          });
    } finally {
      await client.close();
    }
  }
});

it('runs an explicitly standalone event route without a shared runtime', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-standalone-event-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'standalone-event-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'standalone-event-fixture', version: '1.0.0' }, targets: ['cursor'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/tool/after.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['cursor'] };",
      'const Context = async ({ tool }) => createElement(Agent.Context, null, `standalone:${tool}`);',
      'export default async function AfterTool({ native }) {',
      '  return createElement(Agent.Result, null, createElement(Context, { tool: native.tool_name }));',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['cursor'] });
  expect(compiled.build.compiledMcpEntries).toHaveLength(0);
  const hook = compiled.build.compiledHooks.find((entry) => entry.event === 'afterTool');
  expect(hook).toBeDefined();
  await expect(runHook(hook!.output, {
    conversation_id: 'conversation-1',
    cwd: root,
    hook_event_name: 'postToolUse',
    session_id: 'session-1',
    tool_input: { file_path: 'demo.ts' },
    tool_name: 'Write',
    tool_output: '{"ok":true}',
    tool_use_id: 'tool-1',
  })).resolves.toEqual({ additional_context: 'standalone:Write' });
});

it('replays Claude and Codex subagent fixtures through standalone event-route wrappers', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-subagent-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'subagent-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'subagent-events-fixture', version: '1.0.0' }, targets: ['claude', 'codex'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/start.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStart({ native }) {',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${native.session_id}:${native.agent_id}:${native.agent_type}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/stop.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['claude', 'codex'] };",
      'export default async function AgentStop({ native }) {',
      "  return createElement(Agent.Result, { value: { outcome: 'deny', reason: `Review ${native.agent_id} once more.` } });",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['claude', 'codex'] });
  expect(compiled.build.compiledHooks.filter((hook) => hook.event === 'agentStart')).toHaveLength(2);
  expect(compiled.build.compiledHooks.filter((hook) => hook.event === 'agentStop')).toHaveLength(2);

  for (const target of ['claude', 'codex'] as const) {
    const start = compiled.build.compiledHooks.find((hook) => hook.target === target && hook.event === 'agentStart')!;
    const stop = compiled.build.compiledHooks.find((hook) => hook.target === target && hook.event === 'agentStop')!;
    const startInput = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-start.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    const stopInput = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-stop.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;

    await expect(runHook(start.output, startInput)).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `${String(startInput.session_id)}:${String(startInput.agent_id)}:${String(startInput.agent_type)}`,
        hookEventName: 'SubagentStart',
      },
    });
    await expect(runHook(stop.output, stopInput)).resolves.toEqual({
      decision: 'block',
      reason: `Review ${String(stopInput.agent_id)} once more.`,
    });
  }
});

it('dispatches composite plugin event routes through the invoking host contract', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-plugin-subagent-events-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        react: '19.2.8',
      },
      name: 'plugin-subagent-events-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'plugin-subagent-events-fixture', version: '1.0.0' }, targets: ['plugin'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/start.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['plugin'] };",
      'export default async function AgentStart({ canonical, native }) {',
      '  return createElement(Agent.Result, null, createElement(Agent.Context, null, `${canonical.provenance.host}:${native.agent_id}`));',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/agent/stop.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "export const config = { runtime: 'standalone', targets: ['plugin'] };",
      'export default async function AgentStop() {',
      "  return createElement(Agent.Result, null, createElement(Agent.Context, null, 'Check the final result.'));",
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['plugin'] });
  const start = compiled.build.compiledHooks.find((hook) => hook.event === 'agentStart')!;
  const stop = compiled.build.compiledHooks.find((hook) => hook.event === 'agentStop')!;

  for (const target of ['claude', 'codex'] as const) {
    const input = JSON.parse(await readFile(
      new URL(`./fixtures/events/${target}-subagent-start.json`, import.meta.url),
      'utf8',
    )) as Record<string, unknown>;
    if (target === 'codex') input.transcript_path = null;
    const env = target === 'codex'
      ? { AGENT_BUNDLE_HOOK_HOST: undefined, PLUGIN_ROOT: output }
      : { AGENT_BUNDLE_HOOK_HOST: undefined, PLUGIN_ROOT: undefined };
    await expect(runHook(start.output, input, env)).resolves.toEqual({
      hookSpecificOutput: {
        additionalContext: `${target}:${String(input.agent_id)}`,
        hookEventName: 'SubagentStart',
      },
    });
  }

  const claudeStop = JSON.parse(await readFile(
    new URL('./fixtures/events/claude-subagent-stop.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  await expect(runHook(stop.output, claudeStop, {
    AGENT_BUNDLE_HOOK_HOST: undefined,
    PLUGIN_ROOT: undefined,
  })).resolves.toEqual({
    hookSpecificOutput: {
      additionalContext: 'Check the final result.',
      hookEventName: 'SubagentStop',
    },
  });

  const codexStop = JSON.parse(await readFile(
    new URL('./fixtures/events/codex-subagent-stop.json', import.meta.url),
    'utf8',
  )) as Record<string, unknown>;
  codexStop.transcript_path = null;
  await expect(runHook(stop.output, codexStop, {
    AGENT_BUNDLE_HOOK_HOST: undefined,
    PLUGIN_ROOT: output,
  })).rejects.toThrow(/not supported by the Codex SubagentStop output schema/u);
});
