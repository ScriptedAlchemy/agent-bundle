import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentRenderEvent } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  renderEventBytes,
  routeInvocationRenderHistoryLimits,
} from '../src/dev/routes/route-invocation-render-history.ts';
import type { RouteInvocation, RouteInvocationResponse } from '../src/dev/routes/route-invocation-result.ts';
import type { RouteInvocationListResponse } from '../src/dev/routes/route-invocation.ts';
import type { RouteManifestResponse } from '../src/dev/routes/route-manifest.ts';
import type { TraceReplay } from '../src/dev/trace/trace-entry.ts';
import { readArtifactManifest } from '../src/build/manifest-file.ts';
import { serializeArtifactManifest } from '../src/build/manifest.ts';
import { confirmationRequiredMessage } from '../src/cli-entry.ts';
import { stableJson } from '../src/core/digest.ts';
import { pluginRootEnvAnchor, pluginStateRootEnvAnchor } from '../src/core/types.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { startDevServer } from '../src/dev/workbench-server.ts';
import { gatedRouteFiles } from './helpers/gated-routes.ts';
import { createProjectFixture } from './helpers/project-fixture.ts';
import { agentBundleNodeModules } from './helpers/workspace-paths.ts';
import { replaceWatchedSourceAndAwaitRebuild } from './support/watched-files.ts';
import { runNodeScript } from './support/run-node-script.ts';

const readEvent = async (
  response: Response,
  type: string,
  matches: (event: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error(`Project event stream ended before ${type}.`);
    buffered += next.value;
    const frames = buffered.split('\n\n');
    buffered = frames.pop() ?? '';
    for (const frame of frames) {
      if (!frame.includes(`event: ${type}\n`)) continue;
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data !== undefined) {
        const event = JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
        if (matches(event)) return event;
      }
    }
  }
};

type StreamMessage = Record<string, unknown>;

/** Reads one invocation SSE stream message at a time, so the test can act between messages. */
const invocationMessages = (response: Response): Readonly<{
  readonly next: (matches: (message: StreamMessage) => boolean) => Promise<StreamMessage>;
  readonly seen: readonly StreamMessage[];
}> => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const seen: StreamMessage[] = [];
  const queue: StreamMessage[] = [];
  let buffered = '';
  const pull = async (): Promise<StreamMessage> => {
    while (queue.length === 0) {
      const next = await reader.read();
      if (next.done) throw new Error('Invocation stream ended.');
      buffered += next.value;
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data !== undefined) queue.push(JSON.parse(data.slice('data: '.length)) as StreamMessage);
      }
    }
    const message = queue.shift()!;
    seen.push(message);
    return message;
  };
  return {
    next: async (matches) => {
      for (;;) {
        const message = await pull();
        if (matches(message)) return message;
      }
    },
    seen,
  };
};

const renderEvents = (messages: readonly StreamMessage[]): readonly AgentRenderEvent[] =>
  messages.filter((message) => message.type === 'render').map((message) => message.event as AgentRenderEvent);

const isFallbackRender = (fallback: string) => (message: StreamMessage): boolean =>
  message.type === 'render' && JSON.stringify(message.event).includes(JSON.stringify(fallback));

const isFinal = (message: StreamMessage): boolean => message.type === 'final';

/** Reads through `final` and returns every message seen. */
const readInvocationStream = async (response: Response): Promise<readonly StreamMessage[]> => {
  const stream = invocationMessages(response);
  await stream.next(isFinal);
  return stream.seen;
};

const renderBytes = (events: readonly AgentRenderEvent[]): number =>
  events.reduce((sum, event) => sum + renderEventBytes(event), 0);

it('invokes compiled tool and event routes through the foreground server', { timeout: 180_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      "import { join } from 'node:path';",
      '',
      'export default {',
      "  plugin: { name: 'route-invocation-dev-server', version: '1.0.0' },",
      "  targets: ['claude'],",
      '  tools: {',
      "    rsbuild: { source: { define: { __ROUTE_INVOCATION_DEFINE__: JSON.stringify('defined') } } },",
      "    rspack: { resolve: { alias: { '@fixture/value': join(import.meta.dirname, 'src/aliased.ts') } } },",
      '  },',
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/aliased.ts': "export const ALIAS_VALUE = 'aliased';\n",
      'src/cli/greet.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { description: 'Greets one name.', positionals: ['name'] };",
        "export const inputSchema = z.object({ name: z.string().min(1) }).strict();",
        "export const resultSchema = z.object({ message: z.string() }).strict();",
        '',
        'export default async function Greet({ input }) {',
        '  const message = `Hello, ${input.name}.`;',
        '  return createElement(Agent.Result, { value: { message } }, createElement(Agent.Text, null, message));',
        '}',
        '',
      ].join('\n'),
      'src/cli/exit.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { description: 'Exits with the requested code.', exitCode: 'result', positionals: ['code'] };",
        'export const inputSchema = z.object({ code: z.number().int().min(0).max(255) }).strict();',
        'export const resultSchema = z.object({ exitCode: z.number() }).strict();',
        '',
        'export default async function Exit({ input }) {',
        '  return createElement(Agent.Result, { value: { exitCode: input.code } }, createElement(Agent.Text, null, `Exiting ${input.code}.`));',
        '}',
        '',
      ].join('\n'),
      'src/cli/plain.ts': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ ok: z.boolean() }).strict();',
        '',
        'export default async function Plain() {',
        "  writeFileSync(join(process.cwd(), '.agent-bundle', 'plain-cli-handler.marker'), 'ran');",
        '  return { ok: true };',
        '}',
        '',
      ].join('\n'),
      'src/events/tool/after.preflight.ts': [
        "import { appendFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        '',
        'export default () => {',
        "  appendFileSync(join(process.cwd(), '.agent-bundle', 'defer-gate.marker'), 'gate\\n');",
        "  return { outcome: 'execute', data: { ticket: 'cc-7' } };",
        '};',
        '',
      ].join('\n'),
      'src/events/tool/after.tsx': [
        "import { appendFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { Agent, agent } from '@agent-bundle/runtime';",
        "import { createElement, Suspense } from 'react';",
        "import { awaitGate } from '../../gate.js';",
        "export { default as preflight } from './after.preflight.js';",
        '',
        "export const config = { providers: ['clock'], runtime: 'standalone' };",
        '',
        'const Observed = async ({ gate, signal, toolName }) => {',
        '  if (gate !== undefined) await awaitGate(gate, signal);',
        '  return createElement(Agent.Context, null, `Observed ${toolName}.`);',
        '};',
        '',
        'export default async function AfterTool({ canonical, preflight, signal }) {',
        '  const context = await agent();',
        "  appendFileSync(join(process.cwd(), '.agent-bundle', 'defer-handler.marker'), 'run\\n');",
        "  const value = { outcome: 'defer', providers: Object.keys(context.providers).sort(), ticket: preflight.ticket };",
        "  return createElement(Agent.Result, { value }, createElement(Suspense, { fallback: createElement(Agent.Progress, { completed: 0, message: 'event streaming', total: 1 }) }, createElement(Observed, { gate: canonical.payload.toolInput?.value?.gate, signal, toolName: canonical.payload.toolName?.value })));",
        '}',
        '',
      ].join('\n'),
      ...gatedRouteFiles,
      'src/events/prompt/submit.preflight.ts': "export default () => ({ outcome: 'continue' });\n",
      'src/events/prompt/submit.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export { default as preflight } from './submit.preflight.js';",
        "export const config = { runtime: 'standalone' };",
        "export default async function PromptSubmit() {",
        "  writeFileSync(join(process.cwd(), '.agent-bundle', 'continue-handler.marker'), 'ran');",
        "  throw new Error('continue preflight reached handler');",
        '}',
        '',
      ].join('\n'),
      'src/events/session/end.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "writeFileSync(join(process.cwd(), '.agent-bundle', 'session-worker.marker'), 'load\\n');",
        "export const config = { runtime: 'standalone' };",
        'export default async function SessionEnd() {',
        "  return createElement(Agent.Result, { value: { canonical: true } });",
        '}',
        '',
      ].join('\n'),
      'src/events/tool/before.preflight.ts': "export default () => ({ outcome: 'deny', reason: 'blocked by preflight' });\n",
      'src/events/tool/before.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export { default as preflight } from './before.preflight.js';",
        "export const config = { runtime: 'standalone' };",
        "export default async function BeforeTool() {",
        "  writeFileSync(join(process.cwd(), '.agent-bundle', 'deny-handler.marker'), 'ran');",
        "  throw new Error('deny preflight reached handler');",
        '}',
        '',
      ].join('\n'),
      'src/events/tool/failure.preflight.ts': [
        "import { appendFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export default () => {",
        "  appendFileSync(join(process.cwd(), '.agent-bundle', 'failure-gate.marker'), 'gate\\n');",
        "  throw new Error('Generated route must default-export from preflight.');",
        '};',
        '',
      ].join('\n'),
      'src/events/tool/failure.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export { default as preflight } from './failure.preflight.js';",
        "export const config = { runtime: 'standalone' };",
        'export default async function ToolFailure() {',
        "  writeFileSync(join(process.cwd(), '.agent-bundle', 'failure-handler.marker'), 'ran');",
        "  throw new Error('preflight failure reached handler');",
        '}',
        '',
      ].join('\n'),
      'src/mcp/alpha/tools/fail.tsx': [
        "import { appendFileSync } from 'node:fs';",
        "import { z } from 'zod';",
        '',
        "appendFileSync('.agent-bundle/alpha-worker.marker', 'load\\n');",
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ failed: z.boolean() }).strict();',
        '',
        'export default async function Fail() {',
        "  appendFileSync('.agent-bundle/alpha-handler.marker', 'run\\n');",
        "  throw new Error('Generated route must default-export an async Server Component.');",
        '}',
        '',
      ].join('\n'),
      'src/mcp/omega/tools/pass.tsx': [
        "import { appendFileSync } from 'node:fs';",
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "appendFileSync('.agent-bundle/omega-worker.marker', 'load\\n');",
        'export const inputSchema = z.object({}).strict();',
        "export const resultSchema = z.object({ selected: z.literal('omega') }).strict();",
        '',
        'export default async function Pass() {',
        "  return createElement(Agent.Result, { value: { selected: 'omega' } });",
        '}',
        '',
      ].join('\n'),
      'src/mcp/importer/tools/fail.tsx': [
        "import { appendFileSync } from 'node:fs';",
        "import { z } from 'zod';",
        '',
        "appendFileSync('.agent-bundle/importer-worker.marker', 'load\\n');",
        "throw new Error('Generated route must default-export from import.');",
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ failed: z.boolean() }).strict();',
        'export default async function Fail() { return undefined; }',
        '',
      ].join('\n'),
      'src/mcp/status/tools/counter.tsx': [
        "import { Agent, agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({ key: z.string() }).strict();',
        'export const resultSchema = z.object({ count: z.number() }).strict();',
        'export default async function Counter({ input }) {',
        '  const context = await agent();',
        "  if (context.state === undefined) throw new Error('state unavailable');",
        "  const committed = await context.state.dispatch('incremented', { by: 1 }, { idempotencyKey: `${input.key}:${crypto.randomUUID()}` });",
        '  return createElement(Agent.Result, { value: { count: committed.state.count } });',
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/refuse.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({ reason: z.string() }).strict();',
        'export const resultSchema = z.object({ refused: z.boolean() }).strict();',
        'export default async function Refuse({ input }) {',
        "  return createElement(Agent.Result, { value: { refused: true } }, createElement(Agent.Error, { code: 'refused' }, `Refused: ${input.reason}`));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/report.tsx': [
        "import { Agent, agent } from '@agent-bundle/runtime';",
        "import { ALIAS_VALUE } from '@fixture/value';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        "import { Panel } from './panel.js';",
        'declare const __ROUTE_INVOCATION_DEFINE__: string;',
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1), source: z.string() }).strict();",
        'export const resultSchema = z.object({ alias: z.string(), define: z.string(), pluginRoot: z.string(), service: z.string(), source: z.string(), stateRoot: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  const context = await agent();',
        "  if (context.plugin.state !== 'available') throw new Error('plugin unavailable');",
        '  const value = { alias: ALIAS_VALUE, define: __ROUTE_INVOCATION_DEFINE__, pluginRoot: context.plugin.value.root, service: input.service, source: input.source, stateRoot: context.plugin.value.stateRoot };',
        "  return createElement(Agent.Result, { value }, createElement(Panel), createElement(Agent.Text, null, './panel.js'), createElement(Agent.Text, null, `Service ${input.service}`));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/panel.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const Panel = () => createElement(Agent.Text, null, 'panel rendered');",
        "export const inputSchema = z.object({}).strict();",
        "export const resultSchema = z.object({ panel: z.literal(true) }).strict();",
        'export default async function PanelRoute() {',
        "  return createElement(Agent.Result, { value: { panel: true } }, createElement(Panel));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/crash.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement, Suspense } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ ok: z.boolean() }).strict();',
        "const Boom = async () => { throw new Error('render exploded'); };",
        '',
        'export default async function Crash() {',
        "  return createElement(Agent.Result, { value: { ok: true } }, createElement(Suspense, { fallback: createElement(Agent.Progress, { completed: 0, message: 'crashing', total: 1 }) }, createElement(Boom)));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/burst.tsx': [
        "import { Agent, agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({ messageBytes: z.number().int().min(1).max(65_536), ticks: z.number().int().min(1).max(900) }).strict();',
        'export const resultSchema = z.object({ ticks: z.number() }).strict();',
        '',
        'export default async function Burst({ input }) {',
        '  const { progress } = await agent();',
        '  for (let step = 1; step <= input.ticks; step += 1) {',
        "    await progress.report({ completed: step, message: `${step}:${'p'.repeat(input.messageBytes)}`, total: input.ticks });",
        '  }',
        "  return createElement(Agent.Result, { value: { ticks: input.ticks } }, createElement(Agent.Text, null, `Reported ${input.ticks} ticks.`));",
        '}',
        '',
      ].join('\n'),
      'src/mcp/status/tools/report.cli.ts': [
        "export const config = { command: ['report'], confirm: true, flags: { service: { name: 'name' }, source: { required: false } } };",
        "export const mapInput = (input) => ({ ...input, source: input.source ?? 'cli-projection' });",
        '',
      ].join('\n'),
      'src/mcp/status/tools/plain.cli.ts': "export const config = { command: ['plain-tool'] };\n",
      'src/mcp/status/tools/plain.ts': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        "export const resultSchema = z.object({ selected: z.literal('plain-tool') }).strict();",
        "export default async function PlainTool() { return createElement(Agent.Result, { value: { selected: 'plain-tool' } }); }",
        '',
      ].join('\n'),
      'src/providers/clock.ts': [
        'export default () => ({ now: 0 });',
        '',
      ].join('\n'),
      'src/state.ts': [
        "import { defineState } from '@agent-bundle/runtime/state';",
        "import { z } from 'zod';",
        'export default defineState({',
        "  events: { incremented: z.object({ by: z.number() }).strict() },",
        "  id: 'route-invocation/counter',",
        '  initial: { count: 0 },',
        "  lifetime: 'workspace-durable',",
        '  reduce: (state, event) => ({ count: state.count + event.payload.by }),',
        '  schema: z.object({ count: z.number() }).strict(),',
        '});',
        '',
      ].join('\n'),
      'src/scripts/summary.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        '',
        'export default async function Summary({ argv }) {',
        "  return createElement(Agent.Result, { value: { arguments: argv } }, createElement(Agent.Text, null, 'Summary ready.'));",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-dev-server-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route invocation</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    try {
      await expect.poll(
        async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
        { timeout: 10_000 },
      ).toBe(200);
    } catch (error) {
      throw new Error(`Route manifest did not become ready: ${JSON.stringify(server.status())}`, { cause: error });
    }

    const cookie = bootstrap.headers.get('set-cookie')!.split(';', 1)[0]!;
    const stream = await fetch(`${server.url}/api/project/events`, {
      headers: { cookie, origin: server.url },
    });
    const stateRoot = join(project.root, '.agent-bundle', 'state');
    const startStreaming = async (body: Record<string, unknown>) => {
      const response = await fetch(`${server!.url}/api/routes/invocations`, {
        body: JSON.stringify({ ...body, stream: true }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(202);
      const started = await response.json() as RouteInvocationResponse;
      expect(started.invocation.status).toBe('running');
      const stream = await fetch(`${server!.url}/api/routes/invocations/${started.invocation.id}/stream`, { headers });
      expect(stream.status).toBe(200);
      return { id: started.invocation.id, stream: invocationMessages(stream) };
    };
    const gatePath = (gate: string): string => join(project.root, '.agent-bundle', gate);
    // Releasing returns the release instant so a final envelope can prove the
    // render completed after it — the fallback was streamed from a blocked
    // render, not replayed from a finished one.
    const releaseGate = async (gate: string): Promise<number> => {
      expect(existsSync(gatePath(gate))).toBe(false);
      const releasedAt = Date.now();
      await writeFile(gatePath(gate), 'open\n');
      return releasedAt;
    };
    const completedAfter = (message: StreamMessage, releasedAt: number): void => {
      expect(Date.parse((message.invocation as RouteInvocationResponse['invocation']).completedAt)).toBeGreaterThanOrEqual(releasedAt);
    };

    // The compiled MCP tool streams its authored Suspense fallback to the
    // Workbench consumer while the child is still blocked on the gate; no
    // terminal event exists yet (#686).
    const live = await startStreaming({ input: { gate: 'live-gate' }, routeId: 'tool:status/live' });
    const liveFallback = await live.stream.next(isFallbackRender('streaming'));
    expect(liveFallback.event).toMatchObject({ type: 'shell' });
    expect(renderEvents(live.stream.seen).map((event) => event.type)).toEqual(['shell']);
    const liveReleasedAt = await releaseGate('live-gate');
    const liveFinal = await live.stream.next(isFinal);
    expect(liveFinal).toMatchObject({ invocation: { status: 'succeeded' }, type: 'final' });
    completedAfter(liveFinal, liveReleasedAt);
    const liveEvents = renderEvents(live.stream.seen);
    expect(liveEvents.map((event) => event.type)).toEqual(['shell', 'replace', 'complete']);
    const liveComplete = liveEvents.at(-1)!;
    if (liveComplete.type !== 'complete') throw new Error('Expected a complete render event.');
    expect(JSON.stringify(liveComplete.document)).toContain('stream complete');
    expect(JSON.stringify(liveComplete.document)).not.toContain('"streaming"');
    // Parity control: the same route completing without a gate renders the
    // same final document the streamed run replaced its fallback with.
    const controlResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: {}, routeId: 'tool:status/live' }),
      headers,
      method: 'POST',
    });
    expect(controlResponse.status).toBe(200);
    const control = await controlResponse.json() as RouteInvocationResponse;
    expect(control.invocation.status).toBe('succeeded');
    expect(stableJson(control.invocation.document)).toBe(stableJson(liveComplete.document));
    expect(stableJson((liveFinal.invocation as RouteInvocationResponse['invocation']).document)).toBe(stableJson(control.invocation.document));

    // Cancelling while blocked: the fallback is the only render published,
    // the terminal message says cancelled, and the released gate publishes
    // nothing afterwards because the stream has already closed.
    const cancelling = await startStreaming({ input: { gate: 'cancel-gate' }, routeId: 'tool:status/live' });
    await cancelling.stream.next(isFallbackRender('streaming'));
    const cancelResponse = await fetch(`${server.url}/api/routes/invocations/${cancelling.id}/cancel`, {
      headers,
      method: 'POST',
    });
    expect(cancelResponse.status).toBe(202);
    const cancelled = await cancelResponse.json() as RouteInvocationResponse;
    expect(cancelled.invocation).toMatchObject({ status: 'cancelled' });
    expect(cancelled.invocation).not.toHaveProperty('outcome');
    await expect(cancelling.stream.next(isFinal)).resolves.toMatchObject({
      invocation: { status: 'cancelled' },
      type: 'final',
    });
    expect(renderEvents(cancelling.stream.seen).map((event) => event.type)).toEqual(['shell']);
    await releaseGate('cancel-gate');
    await expect(cancelling.stream.next(() => true)).rejects.toThrow('Invocation stream ended.');

    // A render that fails behind its fallback settles once: one terminal
    // render event, one final message, and the same outcome the completed
    // (non-streamed) run reports.
    const crashing = await startStreaming({ input: {}, routeId: 'tool:status/crash' });
    const crashFinal = await crashing.stream.next(isFinal);
    const crashEvents = renderEvents(crashing.stream.seen);
    expect(crashEvents.filter((entry) => entry.type === 'complete')).toHaveLength(1);
    expect(crashEvents.at(-1)).toMatchObject({ type: 'complete' });
    expect(JSON.stringify(crashEvents.at(-1))).toContain('render exploded');
    await expect(crashing.stream.next(() => true)).rejects.toThrow('Invocation stream ended.');
    const crashControlResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: {}, routeId: 'tool:status/crash' }),
      headers,
      method: 'POST',
    });
    const crashControl = await crashControlResponse.json() as RouteInvocationResponse;
    const crashInvocation = crashFinal.invocation as RouteInvocationResponse['invocation'];
    expect(crashInvocation.status).toBe(crashControl.invocation.status);
    expect(crashInvocation.outcome).toEqual(crashControl.invocation.outcome);
    expect(stableJson(crashInvocation.document)).toBe(stableJson(crashControl.invocation.document));
    const finalCancelResponse = await fetch(`${server.url}/api/routes/invocations/${cancelling.id}/cancel`, {
      headers,
      method: 'POST',
    });
    expect(finalCancelResponse.status).toBe(409);
    await expect(finalCancelResponse.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8256' } });
    const unknownStream = await fetch(`${server.url}/api/routes/invocations/inv_missing/stream`, { headers });
    expect(unknownStream.status).toBe(404);

    // A compiled route that reports 400 progress ticks of 16 KiB each produces
    // far more render events, and far more bytes (6.4 MiB), than the
    // render-history window holds. Every reader must see the same bounded window.
    const burstResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ correlationId: 'burst-1', input: { messageBytes: 16 * 1024, ticks: 400 }, routeId: 'tool:status/burst' }),
      headers,
      method: 'POST',
    });
    expect(burstResponse.status).toBe(200);
    const burst = (await burstResponse.json() as RouteInvocationResponse).invocation;
    expect(burst.status, JSON.stringify(burst.diagnostics)).toBe('succeeded');
    expect(burst).toMatchObject({ correlationId: 'burst-1', outcome: { kind: 'success' }, result: { ticks: 400 } });
    const burstComplete = burst.events.at(-1);
    expect(burstComplete?.type).toBe('complete');
    expect(burst.document).toEqual(burstComplete?.type === 'complete' ? burstComplete.document : undefined);
    expect(JSON.stringify(burst.document)).toContain('Reported 400 ticks.');
    expect(burst.retention).toBeDefined();
    expect(burst.retention!.producedEvents).toBeGreaterThan(400);
    expect(burst.retention!.producedEvents).toBe(burst.retention!.evictedEvents + burst.events.length);
    expect(burst.events.length).toBeLessThan(routeInvocationRenderHistoryLimits.maxEvents);
    expect(burst.events.filter((event) => event.type === 'progress').length).toBeGreaterThan(64);
    expect(burst.events.at(-2)).toMatchObject({ completed: 400, total: 400, type: 'progress' });
    const burstBytes = burst.events.reduce((sum, event) => sum + renderEventBytes(event), 0);
    expect(burstBytes).toBeLessThanOrEqual(routeInvocationRenderHistoryLimits.maxBytes);
    expect(burst.retention!.retainedBytes).toBe(burstBytes);
    expect(burst.retention!.evictedBytes).toBeGreaterThan(4 * 1024 * 1024);
    const burstRead = await fetch(`${server.url}/api/routes/invocations/${burst.id}`, { headers });
    expect(burstRead.status).toBe(200);
    expect(await burstRead.json()).toEqual({ invocation: burst });
    const burstReplay = await fetch(`${server.url}/api/routes/invocations/${burst.id}/stream`, { headers });
    expect(burstReplay.status).toBe(200);
    const burstMessages = await readInvocationStream(burstReplay);
    expect(burstMessages.filter((message) => message.type === 'truncated')).toEqual([{ type: 'truncated' }]);
    expect(burstMessages[0]).toEqual({ type: 'truncated' });
    expect(burstMessages.flatMap((message) => message.type === 'render' ? [message.event] : [])).toEqual(burst.events);
    expect(burstMessages.at(-1)).toEqual({ invocation: burst, type: 'final' });
    const burstList = await fetch(`${server.url}/api/routes/invocations?limit=5`, { headers });
    const burstSummary = (await burstList.json() as RouteInvocationListResponse).invocations.find((entry) => entry.id === burst.id);
    expect(burstSummary).toBeDefined();
    expect(burstSummary).not.toHaveProperty('events');
    expect(burstSummary).not.toHaveProperty('retention');

    const activeEpoch = server.status().artifact;
    if (activeEpoch.state !== 'active') throw new Error('Expected an active compiled epoch.');
    const artifactRoot = join(project.root, '.agent-bundle', 'epochs', activeEpoch.activeEpoch.id);
    const alphaWorkerMarker = join(project.root, '.agent-bundle', 'alpha-worker.marker');
    const alphaHandlerMarker = join(project.root, '.agent-bundle', 'alpha-handler.marker');
    const importerWorkerMarker = join(project.root, '.agent-bundle', 'importer-worker.marker');
    const omegaWorkerMarker = join(project.root, '.agent-bundle', 'omega-worker.marker');
    const sessionWorkerMarker = join(project.root, '.agent-bundle', 'session-worker.marker');
    const candidateMarkers = [
      alphaWorkerMarker,
      alphaHandlerMarker,
      importerWorkerMarker,
      omegaWorkerMarker,
      sessionWorkerMarker,
    ];
    await Promise.all(candidateMarkers.map((path) =>
      rm(path, { force: true })));
    const exactSelectionResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:omega/pass' }),
      headers,
      method: 'POST',
    });
    expect(exactSelectionResponse.status).toBe(200);
    const exactSelection = await exactSelectionResponse.json() as RouteInvocationResponse;
    expect(exactSelection.invocation).toMatchObject({
      result: { selected: 'omega' },
      status: 'succeeded',
    });
    expect(existsSync(alphaWorkerMarker)).toBe(false);
    expect(existsSync(importerWorkerMarker)).toBe(false);
    expect(await readFile(omegaWorkerMarker, 'utf8')).toBe('load\n');

    await Promise.all(candidateMarkers.map((path) =>
      rm(path, { force: true })));
    const handlerFailureResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:alpha/fail' }),
      headers,
      method: 'POST',
    });
    expect(handlerFailureResponse.status).toBe(200);
    const handlerFailure = await handlerFailureResponse.json() as RouteInvocationResponse;
    expect(handlerFailure.invocation).toMatchObject({
      diagnostics: [{ code: 'AB8236' }],
      status: 'failed',
    });
    expect(await readFile(alphaWorkerMarker, 'utf8')).toBe('load\n');
    expect(await readFile(alphaHandlerMarker, 'utf8')).toBe('run\n');
    expect(existsSync(importerWorkerMarker)).toBe(false);
    expect(existsSync(omegaWorkerMarker)).toBe(false);

    await Promise.all(candidateMarkers.map((path) =>
      rm(path, { force: true })));
    const importFailureResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:importer/fail' }),
      headers,
      method: 'POST',
    });
    expect(importFailureResponse.status).toBe(200);
    const importFailure = await importFailureResponse.json() as RouteInvocationResponse;
    expect(importFailure.invocation).toMatchObject({
      diagnostics: [{ code: 'AB8236' }],
      status: 'failed',
    });
    expect(await readFile(importerWorkerMarker, 'utf8')).toBe('load\n');
    expect(existsSync(alphaWorkerMarker)).toBe(false);
    expect(existsSync(omegaWorkerMarker)).toBe(false);

    await Promise.all(candidateMarkers.map((path) => rm(path, { force: true })));
    const canonicalEventResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input: { event: 'session/end' },
        routeId: 'event:session/end',
        surface: { kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    expect(canonicalEventResponse.status).toBe(200);
    const canonicalEvent = await canonicalEventResponse.json() as RouteInvocationResponse;
    expect(canonicalEvent.invocation).toMatchObject({
      result: { canonical: true },
      status: 'succeeded',
    });
    expect(await readFile(sessionWorkerMarker, 'utf8')).toBe('load\n');
    expect(existsSync(alphaWorkerMarker)).toBe(false);
    expect(existsSync(importerWorkerMarker)).toBe(false);
    expect(existsSync(omegaWorkerMarker)).toBe(false);

    const toolResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'catalog', source: 'api' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(toolResponse.status).toBe(200);
    const tool = await toolResponse.json() as RouteInvocationResponse;
    expect(tool.invocation.status, JSON.stringify(tool.invocation.diagnostics)).toBe('succeeded');
    expect(tool.invocation.outcome).toEqual({ kind: 'success' });
    expect(tool.invocation.events.at(-1)?.type).toBe('complete');
    expect(tool.invocation.document).toBeDefined();
    expect(tool.invocation.projection.mcp).toBeDefined();
    expect(tool.invocation.surface).toEqual({ kind: 'mcp' });
    expect(tool.invocation.result).toEqual({
      alias: 'aliased',
      define: 'defined',
      pluginRoot: artifactRoot,
      service: 'catalog',
      source: 'api',
      stateRoot,
    });
    const mcpName = (await readdir(join(artifactRoot, 'mcp')))
      .find((name) => name.startsWith('mcp-status-') && name.endsWith('.mjs') && !name.endsWith('-flight.mjs'));
    if (mcpName === undefined) throw new Error('Expected a generated MCP server.');
    const mcpTransport = new StdioClientTransport({
      args: [join(artifactRoot, 'mcp', mcpName)],
      command: process.execPath,
      cwd: project.root,
      env: {
        [pluginRootEnvAnchor]: artifactRoot,
        [pluginStateRootEnvAnchor]: stateRoot,
      },
      stderr: 'pipe',
    });
    const mcpClient = new Client({ name: 'route-invocation-document-parity', version: '1.0.0' });
    await mcpClient.connect(mcpTransport);
    try {
      const generatedMcp = await mcpClient.callTool({
        arguments: { service: 'catalog', source: 'api' },
        name: 'report',
      });
      expect(stableJson(tool.invocation.projection.mcp)).toBe(stableJson(generatedMcp));
    } finally {
      await mcpClient.close();
    }
    expect(tool.invocation.providers).toEqual([
      expect.objectContaining({ durationMs: expect.any(Number), id: 'provider:clock', name: 'clock', status: 'mounted' }),
    ]);
    const toolTraceResponse = await fetch(`${server.url}/api/trace?after=0`, { headers });
    expect(toolTraceResponse.status).toBe(200);
    const toolTrace = await toolTraceResponse.json() as TraceReplay;
    const toolEntries = toolTrace.entries.filter((entry) =>
      entry.correlation.invocationId === tool.invocation.id && entry.source === 'invocation');
    expect(toolEntries.map((entry) => entry.kind)).toEqual([
      'invocation.started',
      'invocation.completed',
    ]);
    expect(toolEntries).toEqual([
      expect.objectContaining({
        correlation: expect.objectContaining({
          invocationId: tool.invocation.id,
          routeId: 'tool:status/report',
        }),
        href: expect.stringMatching(new RegExp(`\\?invocation=${tool.invocation.id}$`, 'u')),
      }),
      expect.objectContaining({
        correlation: expect.objectContaining({
          invocationId: tool.invocation.id,
          routeId: 'tool:status/report',
        }),
        href: expect.stringMatching(new RegExp(`\\?invocation=${tool.invocation.id}$`, 'u')),
      }),
    ]);
    expect(tool.invocation.timings.map((entry) => entry.phase)).toEqual([
      'provider:clock',
      'providers',
      'handler',
      'render',
      'projection',
    ]);
    for (const entry of tool.invocation.timings) expect(entry.durationMs).toBeGreaterThanOrEqual(0);

    // A completed run whose document represents an error: the boundary
    // succeeded, the MCP projection says `isError`, and the outcome says so too.
    const refuseResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { reason: 'policy' }, routeId: 'tool:status/refuse' }),
      headers,
      method: 'POST',
    });
    expect(refuseResponse.status).toBe(200);
    const refuse = await refuseResponse.json() as RouteInvocationResponse;
    expect(refuse.invocation.status, JSON.stringify(refuse.invocation.diagnostics)).toBe('succeeded');
    expect(refuse.invocation.document?.status).toBe('represented-error');
    expect(refuse.invocation.projection.mcp).toMatchObject({ isError: true });
    expect(refuse.invocation.outcome).toEqual({
      kind: 'represented-error',
      summary: '[refused] Refused: policy',
    });
    expect(refuse.invocation.result).toEqual({ refused: true });

    const eventResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input: {
          cwd: project.root,
          hook_event_name: 'PostToolUse',
          session_id: 'session-1',
          tool_input: {},
          tool_name: 'Write',
          tool_response: { ok: true },
          tool_use_id: 'use-1',
          transcript_path: join(project.root, 'transcript.json'),
        },
        routeId: 'event:tool/after',
        surface: { host: 'claude', kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    const eventFailure = eventResponse.status === 200 ? undefined : await eventResponse.clone().text();
    expect(eventResponse.status, eventFailure).toBe(200);
    const event = await eventResponse.json() as RouteInvocationResponse;
    expect(event.invocation.status, JSON.stringify(event.invocation.diagnostics)).toBe('succeeded');
    expect(event.invocation.outcome).toEqual({ kind: 'success' });
    expect(event.invocation.events.at(-1)?.type).toBe('complete');
    expect(event.invocation.document).toBeDefined();
    expect(event.invocation.result).toEqual({
      outcome: 'defer',
      providers: ['clock', 'processLifetime'],
      ticket: 'cc-7',
    });
    expect(await readFile(join(project.root, '.agent-bundle', 'defer-gate.marker'), 'utf8')).toBe('gate\n');
    expect(await readFile(join(project.root, '.agent-bundle', 'defer-handler.marker'), 'utf8')).toBe('run\n');
    expect(event.invocation.projection.hosts?.[0]).toMatchObject({ host: 'claude' });
    // The same compiled event route, streamed: the manifest-selected host's
    // preflight runs, the authored fallback arrives while the child is gated,
    // and the released render matches the completed run's document (#686).
    const gatedEvent = await startStreaming({
      input: {
        cwd: project.root,
        hook_event_name: 'PostToolUse',
        session_id: 'session-1',
        tool_input: { gate: 'event-gate' },
        tool_name: 'Write',
        tool_response: { ok: true },
        tool_use_id: 'use-2',
        transcript_path: join(project.root, 'transcript.json'),
      },
      routeId: 'event:tool/after',
      surface: { host: 'claude', kind: 'event' },
    });
    const eventFallback = await gatedEvent.stream.next(isFallbackRender('event streaming'));
    expect(eventFallback.event).toMatchObject({ type: 'shell' });
    expect(renderEvents(gatedEvent.stream.seen).map((entry) => entry.type)).toEqual(['shell']);
    const eventReleasedAt = await releaseGate('event-gate');
    const gatedEventFinal = await gatedEvent.stream.next(isFinal);
    expect(gatedEventFinal).toMatchObject({ invocation: { status: 'succeeded' }, type: 'final' });
    completedAfter(gatedEventFinal, eventReleasedAt);
    expect(renderEvents(gatedEvent.stream.seen).map((entry) => entry.type)).toEqual(['shell', 'replace', 'complete']);
    const gatedEventInvocation = gatedEventFinal.invocation as RouteInvocationResponse['invocation'];
    expect(gatedEventInvocation.result).toEqual(event.invocation.result);
    expect(stableJson(gatedEventInvocation.document)).toBe(stableJson(event.invocation.document));
    expect(gatedEventInvocation.projection.hosts?.[0]).toMatchObject({ host: 'claude' });
    expect(gatedEventInvocation.trace?.map((trace) => trace.kind)).toEqual(event.invocation.trace?.map((trace) => trace.kind));
    expect(event.invocation.context.session).toEqual({
      source: 'receipt',
      state: 'available',
      value: { sessionId: 'session-1' },
    });
    expect(event.invocation.context.lineage).toMatchObject({
      source: 'receipt',
      state: 'available',
      value: { conversation: 'session-1', root: 'session-1' },
    });
    const eventTraceResponse = await fetch(`${server.url}/api/trace?after=0`, { headers });
    expect(eventTraceResponse.status).toBe(200);
    const eventTrace = await eventTraceResponse.json() as TraceReplay;
    const eventEntries = eventTrace.entries.filter((entry) =>
      entry.correlation.invocationId === event.invocation.id);
    expect(eventEntries.filter((entry) => entry.source === 'invocation').map((entry) => entry.kind)).toEqual([
      'invocation.started',
      'invocation.completed',
    ]);
    expect(eventEntries.filter((entry) => entry.source === 'invocation')).toEqual([
      expect.objectContaining({
        correlation: expect.objectContaining({
          invocationId: event.invocation.id,
          routeId: 'event:tool/after',
        }),
        href: expect.stringMatching(new RegExp(`\\?invocation=${event.invocation.id}$`, 'u')),
      }),
      expect.objectContaining({
        correlation: expect.objectContaining({
          invocationId: event.invocation.id,
          routeId: 'event:tool/after',
        }),
        href: expect.stringMatching(new RegExp(`\\?invocation=${event.invocation.id}$`, 'u')),
      }),
    ]);
    const kernelEntries = eventEntries.filter((entry) => entry.source === 'kernel');
    expect(kernelEntries.length).toBeGreaterThan(0);
    expect(kernelEntries.every((entry) => entry.kind.startsWith('kernel.'))).toBe(true);
    expect(new Set(kernelEntries.map((entry) => entry.correlation.executionId)).size).toBe(1);
    expect(kernelEntries[0]?.correlation.executionId).toBeDefined();
    expect(event.invocation.trace?.map((trace) => trace.kind)).toEqual([
      'preflight.start',
      'preflight.outcome',
      'execute.start',
      'providers.start',
      'providers.finish',
      'render.start',
      'render.finish',
    ]);

    const failureHandlerMarker = join(project.root, '.agent-bundle', 'failure-handler.marker');
    await Promise.all([...candidateMarkers, failureHandlerMarker].map((path) => rm(path, { force: true })));
    const preflightFailureResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input: {
          cwd: project.root,
          error: 'Exit code 9',
          hook_event_name: 'PostToolUseFailure',
          session_id: 'session-preflight-failure',
          tool_input: {},
          tool_name: 'Write',
          tool_use_id: 'use-preflight-failure',
          transcript_path: join(project.root, 'transcript.json'),
        },
        routeId: 'event:tool/failure',
        surface: { host: 'claude', kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    expect(preflightFailureResponse.status).toBe(200);
    const preflightFailure = await preflightFailureResponse.json() as RouteInvocationResponse;
    expect(preflightFailure.invocation).toMatchObject({
      diagnostics: [{ code: 'AB8252' }],
      status: 'failed',
    });
    expect(existsSync(failureHandlerMarker)).toBe(false);
    expect(candidateMarkers.every((path) => !existsSync(path))).toBe(true);

    const preflightCases = [
      [
        'event:tool/before',
        {
          cwd: project.root,
          hook_event_name: 'PreToolUse',
          permission_mode: 'default',
          session_id: 'session-preflight-deny',
          tool_input: { file_path: 'blocked.txt' },
          tool_name: 'Write',
          tool_use_id: 'use-deny',
          transcript_path: join(project.root, 'transcript.json'),
        },
        { outcome: 'deny', reason: 'blocked by preflight' },
      ],
      [
        'event:prompt/submit',
        {
          cwd: project.root,
          hook_event_name: 'UserPromptSubmit',
          permission_mode: 'default',
          prompt: 'continue',
          session_id: 'session-preflight-continue',
          transcript_path: join(project.root, 'transcript.json'),
        },
        { outcome: 'continue' },
      ],
    ] as const;
    for (const [routeId, input, expected] of preflightCases) {
      const response = await fetch(`${server.url}/api/routes/invocations`, {
        body: JSON.stringify({ input, routeId, surface: { host: 'claude', kind: 'event' } }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const invoked = await response.json() as RouteInvocationResponse;
      expect(invoked.invocation.status, JSON.stringify(invoked.invocation.diagnostics)).toBe('succeeded');
      expect(invoked.invocation.result).toEqual(expected);
      expect(invoked.invocation.outcome).toEqual(
        expected.outcome === 'deny'
          ? { kind: 'represented-error', summary: 'deny: blocked by preflight' }
          : { kind: 'success' },
      );
      expect(invoked.invocation.events).toEqual([]);
      expect(invoked.invocation.trace?.map((trace) => trace.kind)).toEqual([
        'preflight.start',
        'preflight.outcome',
      ]);
      expect(existsSync(join(
        project.root,
        '.agent-bundle',
        routeId === 'event:tool/before' ? 'deny-handler.marker' : 'continue-handler.marker',
      ))).toBe(false);
      if (routeId === 'event:tool/before') {
        expect(invoked.invocation.projection.hosts?.[0]?.native).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'blocked by preflight',
          },
        });
      } else {
        expect(invoked.invocation.projection.hosts?.[0]?.native).toBeUndefined();
      }
    }

    const artifactManifest = await readArtifactManifest(artifactRoot);
    if (artifactManifest.status !== 'ok') throw new Error('Expected a readable artifact manifest.');
    const preparation = artifactManifest.manifest.executables.hooks.find((hook) =>
      hook.kind === 'event-route' && hook.routeId === 'event:tool/before' && hook.host === 'claude');
    if (preparation === undefined) throw new Error('Expected the compiled Claude event preparation.');
    const preparationPath = join(artifactRoot, preparation.path);
    const preparationSource = await readFile(preparationPath);
    const denyHandlerMarker = join(project.root, '.agent-bundle', 'deny-handler.marker');
    await writeFile(preparationPath, 'export const unrelated = true;\n');
    try {
      await Promise.all([...candidateMarkers, denyHandlerMarker].map((path) => rm(path, { force: true })));
      const response = await fetch(`${server.url}/api/routes/invocations`, {
        body: JSON.stringify({
          input: preflightCases[0][1],
          routeId: preflightCases[0][0],
          surface: { host: 'claude', kind: 'event' },
        }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(200);
      const missingPreparation = await response.json() as RouteInvocationResponse;
      expect(missingPreparation.invocation).toMatchObject({
        diagnostics: [{ code: 'AB8252' }],
        status: 'failed',
      });
      expect(existsSync(denyHandlerMarker)).toBe(false);
      expect(candidateMarkers.every((path) => !existsSync(path))).toBe(true);
    } finally {
      await writeFile(preparationPath, preparationSource);
    }

    const workerlessMcpServers = artifactManifest.manifest.executables.mcpServers.map((executable) => {
      if (executable.id !== 'mcp:omega' || executable.launch === undefined) return executable;
      return {
        ...executable,
        launch: {
          args: executable.launch.args,
          entry: executable.launch.entry,
          env: executable.launch.env,
        },
      };
    });
    await writeFile(artifactManifest.path, serializeArtifactManifest({
      ...artifactManifest.manifest,
      executables: {
        ...artifactManifest.manifest.executables,
        hooks: artifactManifest.manifest.executables.hooks.filter((hook) =>
          hook.routeId !== 'event:tool/before' && hook.routeId !== 'event:prompt/submit'),
        mcpServers: workerlessMcpServers,
      },
    }));
    try {
      await Promise.all(candidateMarkers.map((path) =>
        rm(path, { force: true })));
      const unavailableExecutableResponse = await fetch(`${server.url}/api/routes/invocations`, {
        body: JSON.stringify({ routeId: 'tool:omega/pass' }),
        headers,
        method: 'POST',
      });
      expect(unavailableExecutableResponse.status).toBe(200);
      const unavailableExecutable = await unavailableExecutableResponse.json() as RouteInvocationResponse;
      expect(unavailableExecutable.invocation).toMatchObject({
        diagnostics: [{ code: 'AB8251' }],
        status: 'failed',
      });
      expect(existsSync(alphaWorkerMarker)).toBe(false);
      expect(existsSync(importerWorkerMarker)).toBe(false);
      expect(existsSync(omegaWorkerMarker)).toBe(false);

      for (const [routeId, input] of preflightCases) {
        const response = await fetch(`${server.url}/api/routes/invocations`, {
          body: JSON.stringify({ input, routeId, surface: { host: 'claude', kind: 'event' } }),
          headers,
          method: 'POST',
        });
        expect(response.status).toBe(200);
        const invoked = await response.json() as RouteInvocationResponse;
        expect(invoked.invocation).toMatchObject({
          diagnostics: [{ code: 'AB8251' }],
          status: 'failed',
        });
        expect(existsSync(join(
          project.root,
          '.agent-bundle',
          routeId === 'event:tool/before' ? 'deny-handler.marker' : 'continue-handler.marker',
        ))).toBe(false);
      }
    } finally {
      await writeFile(artifactManifest.path, serializeArtifactManifest(artifactManifest.manifest));
    }

    const cliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'cli:greet', surface: { args: ['Ada'], command: 'greet', kind: 'cli' } }),
      headers,
      method: 'POST',
    });
    expect(cliResponse.status).toBe(200);
    const cli = await cliResponse.json() as RouteInvocationResponse;
    expect(cli.invocation).toMatchObject({
      kind: 'cli',
      projection: {
        cli: {
          exitCode: 0,
          text: expect.stringContaining('Hello, Ada.'),
        },
      },
      outcome: { kind: 'success' },
      result: { message: 'Hello, Ada.' },
      status: 'succeeded',
      surface: { args: ['Ada'], command: 'greet', kind: 'cli' },
    });

    const plainCliHandlerMarker = join(project.root, '.agent-bundle', 'plain-cli-handler.marker');
    const plainCliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'cli:plain', surface: { args: [], command: 'plain', kind: 'cli' } }),
      headers,
      method: 'POST',
    });
    expect(plainCliResponse.status).toBe(200);
    await expect(plainCliResponse.json()).resolves.toMatchObject({
      invocation: { diagnostics: [{ code: 'AB8251' }], status: 'failed' },
    });
    expect(existsSync(plainCliHandlerMarker)).toBe(false);

    // A completed run whose bin exits non-zero: `status` stays `succeeded`
    // (the boundary completed), the outcome carries the bin's own exit code,
    // and the generated bin agrees when run as a real process. `unit-render`
    // has no bin and no argv parser, so it takes the parsed input and applies
    // the same `cli-entry.ts` exit-code rule to the route's policy.
    const exitInvocation = async (unitRender = false): Promise<RouteInvocationResponse> => {
      const response = await fetch(`${server!.url}/api/routes/invocations`, {
        body: JSON.stringify({
          ...(unitRender
            ? { input: { code: 3 }, surface: { kind: 'unit-render' } }
            : { surface: { args: ['3'], command: 'exit', kind: 'cli' } }),
          routeId: 'cli:exit',
        }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<RouteInvocationResponse>;
    };
    for (const exit of [await exitInvocation(), await exitInvocation(true)]) {
      expect(exit.invocation, JSON.stringify(exit.invocation.diagnostics)).toMatchObject({
        kind: 'cli',
        outcome: { exitCode: 3, kind: 'process-exit' },
        projection: { cli: { exitCode: 3, text: expect.stringContaining('Exiting 3.') } },
        result: { exitCode: 3 },
        status: 'succeeded',
      });
    }

    const confirmationMessage = confirmationRequiredMessage('status', 'report');
    const unconfirmedProjectedCliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        routeId: 'tool:status/report',
        surface: { args: ['--name', 'projection'], command: 'report', kind: 'cli' },
      }),
      headers,
      method: 'POST',
    });
    expect(unconfirmedProjectedCliResponse.status).toBe(200);
    const unconfirmedProjectedCli = await unconfirmedProjectedCliResponse.json() as RouteInvocationResponse;
    expect(unconfirmedProjectedCli.invocation.status).toBe('failed');
    expect(unconfirmedProjectedCli.invocation.diagnostics[0]?.message).toContain(confirmationMessage);

    const projectedCliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        routeId: 'tool:status/report',
        surface: { args: ['--name', 'projection', '--yes'], command: 'report', kind: 'cli' },
      }),
      headers,
      method: 'POST',
    });
    expect(projectedCliResponse.status).toBe(200);
    const projectedCli = await projectedCliResponse.json() as RouteInvocationResponse;
    expect(projectedCli.invocation.result).toMatchObject({
      alias: 'aliased',
      define: 'defined',
      pluginRoot: artifactRoot,
      service: 'projection',
      source: 'cli-projection',
      stateRoot,
    });
    expect(projectedCli.invocation.projection.cli).toMatchObject({
      exitCode: 0,
      text: expect.stringContaining('Service projection'),
    });
    expect(projectedCli.invocation.projection.mcp).toBeUndefined();
    expect(projectedCli.invocation.surface).toEqual({
      args: ['--name', 'projection', '--yes'],
      command: 'report',
      kind: 'cli',
    });

    const plainToolCliResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        routeId: 'tool:status/plain',
        surface: { args: ['--yes'], command: 'plain-tool', kind: 'cli' },
      }),
      headers,
      method: 'POST',
    });
    expect(plainToolCliResponse.status).toBe(200);
    const plainToolCli = await plainToolCliResponse.json() as RouteInvocationResponse;
    expect(plainToolCli.invocation, JSON.stringify(plainToolCli.invocation.diagnostics)).toMatchObject({
      projection: { cli: { exitCode: 0 } },
      result: { selected: 'plain-tool' },
      status: 'succeeded',
    });

    const binName = (await readdir(join(artifactRoot, 'bin')))
      .find((name) => name.endsWith('.mjs') && !name.endsWith('-flight.mjs'));
    if (binName === undefined) throw new Error('Expected a generated routed CLI bin.');
    const generatedUnconfirmed = await runNodeScript({
      args: [join(artifactRoot, 'bin', binName), 'report', '--name', 'projection', '--json'],
      cwd: project.root,
      env: {
        [pluginRootEnvAnchor]: artifactRoot,
        [pluginStateRootEnvAnchor]: stateRoot,
      },
    });
    expect(generatedUnconfirmed.code).toBe(2);
    expect(generatedUnconfirmed.stderr).toContain(confirmationMessage);
    const generatedBin = await runNodeScript({
      args: [join(artifactRoot, 'bin', binName), 'report', '--name', 'projection', '--yes', '--json'],
      cwd: project.root,
      env: {
        [pluginRootEnvAnchor]: artifactRoot,
        [pluginStateRootEnvAnchor]: stateRoot,
      },
    });
    expect(generatedBin.code, generatedBin.stderr).toBe(0);
    expect(projectedCli.invocation.result).toEqual(JSON.parse(generatedBin.stdout));
    const generatedExit = await runNodeScript({
      args: [join(artifactRoot, 'bin', binName), 'exit', '3'],
      cwd: project.root,
      env: {
        [pluginRootEnvAnchor]: artifactRoot,
        [pluginStateRootEnvAnchor]: stateRoot,
      },
    });
    expect(generatedExit.code, generatedExit.stderr).toBe(3);

    const mismatchedCommand = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        routeId: 'tool:status/report',
        surface: { args: [], command: 'greet', kind: 'cli' },
      }),
      headers,
      method: 'POST',
    });
    expect(mismatchedCommand.status).toBe(400);
    await expect(mismatchedCommand.json()).resolves.toMatchObject({
      diagnostic: { code: 'AB8253' },
    });

    const duplicateCliOperation = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'cli:report' }),
      headers,
      method: 'POST',
    });
    expect(duplicateCliOperation.status).toBe(400);
    await expect(duplicateCliOperation.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8254',
        message: 'CLI operation "cli:report" is a projection of canonical operation "tool:status/report"; invoke that route with surface {"kind":"cli","command":"report","args":[]}.',
      },
    });

    const counter = async (unitRender = false): Promise<RouteInvocationResponse> => {
      const response = await fetch(`${server!.url}/api/routes/invocations`, {
        body: JSON.stringify({
          input: { key: unitRender ? 'unit-render' : 'production' },
          routeId: 'tool:status/counter',
          ...(unitRender ? { surface: { kind: 'unit-render' } } : {}),
        }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<RouteInvocationResponse>;
    };
    const firstCounter = await counter();
    const secondCounter = await counter();
    const isolatedCounter = await counter(true);
    expect(firstCounter.invocation.result).toEqual({ count: 1 });
    expect(secondCounter.invocation.result).toEqual({ count: 2 });
    expect(isolatedCounter.invocation.result).toEqual({ count: 1 });

    const nonStreamingCounter = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input: { key: 'stream-false' },
        routeId: 'tool:status/counter',
        stream: false,
      }),
      headers,
      method: 'POST',
    });
    expect(nonStreamingCounter.status).toBe(200);
    const nonStreaming = await nonStreamingCounter.json() as RouteInvocationResponse;
    expect(nonStreaming).toMatchObject({
      invocation: { status: 'succeeded' },
    });

    const scriptResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'script:summary' }),
      headers,
      method: 'POST',
    });
    expect(scriptResponse.status).toBe(200);
    const script = await scriptResponse.json() as RouteInvocationResponse;
    expect(script.invocation).toMatchObject({
      kind: 'script',
      projection: {
        cli: {
          exitCode: 0,
          text: expect.stringContaining('Summary ready.'),
        },
      },
      status: 'succeeded',
    });

    const listedResponse = await fetch(`${server.url}/api/routes/invocations?limit=4`, { headers });
    const listed = await listedResponse.json() as RouteInvocationListResponse;
    expect(listed.invocations.map((invocation) => invocation.id)).toEqual([
      script.invocation.id,
      nonStreaming.invocation.id,
      isolatedCounter.invocation.id,
      secondCounter.invocation.id,
    ]);
    const read = await fetch(`${server.url}/api/routes/invocations/${tool.invocation.id}`, { headers });
    await expect(read.json()).resolves.toEqual(tool);

    const published = await readEvent(stream, 'route.invocation', (event) => {
      const invocation = (event.payload as { readonly invocation?: { readonly routeId?: string; readonly status?: string } } | undefined)?.invocation;
      return invocation?.routeId === 'tool:status/report' && invocation.status === 'succeeded';
    });
    expect(published).toMatchObject({
      payload: { invocation: { outcome: { kind: 'success' }, routeId: 'tool:status/report', status: 'succeeded' } },
      type: 'route.invocation',
    });

    const shell = await fetch(`${server.url}/routes/mcp/status/tool/report`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<title>Route invocation</title>');

    const reportRoutePath = join(project.root, 'src/mcp/status/tools/report.tsx');
    const failedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        "import './missing.js';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1) }).strict();",
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  const service = `rebuilt-${input.service}`;',
        '  return createElement(Agent.Result, { value: { service } }, createElement(Agent.Text, null, `Service ${service}`));',
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 20_000 },
    );
    expect(failedAttempt.outcome).toBe('failed');
    expect(server.status().build.state).toBe('failed');

    const staleManifestResponse = await fetch(`${server.url}/api/routes/manifest`, { headers });
    const staleManifest = await staleManifestResponse.json() as RouteManifestResponse;
    const staleRouteIds = staleManifest.manifest.servers.flatMap((manifestServer) =>
      manifestServer.routes.map((route) => route.id));
    expect(staleRouteIds).toContain('tool:status/report');

    const staleInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'published' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(staleInvocationResponse.status).toBe(409);
    await expect(staleInvocationResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'The source is newer than the published build. Rebuild before invoking routes.',
      },
    });

    const repairedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one service.' };",
        "export const inputSchema = z.object({ service: z.string().min(1), source: z.string().optional() }).strict();",
        'export const resultSchema = z.object({ service: z.string() }).strict();',
        '',
        'export default async function Report({ input }) {',
        '  const service = `rebuilt-${input.service}`;',
        '  return createElement(Agent.Result, { value: { service } }, createElement(Agent.Text, null, `Service ${service}`));',
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 20_000 },
    );
    expect(repairedAttempt.outcome, JSON.stringify(repairedAttempt.diagnostics)).toBe('succeeded');
    const repairedInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 'published' }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(repairedInvocationResponse.status).toBe(200);
    const repairedInvocation = await repairedInvocationResponse.json() as RouteInvocationResponse;
    expect(repairedInvocation.invocation).toMatchObject({
      result: { service: 'rebuilt-published' },
      status: 'succeeded',
    });
    const republishedEpoch = server.status().artifact;
    if (republishedEpoch.state !== 'active') throw new Error('Expected an active rebuilt epoch.');
    expect(republishedEpoch.activeEpoch.id).not.toBe(activeEpoch.activeEpoch.id);
    const republishedCounter = await counter();
    const republishedIsolatedCounter = await counter(true);
    expect(republishedCounter.invocation.result).toEqual({ count: 4 });
    expect(republishedIsolatedCounter.invocation.result).toEqual({ count: 1 });

    const missingApi = await fetch(`${server.url}/api/nope`);
    expect(missingApi.status).toBe(404);
    await expect(missingApi.json()).resolves.toEqual({
      diagnostic: { code: 'AB8007', message: 'Route was not found.' },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('fails closed when a valid host is ineligible for the compiled event route', { timeout: 180_000 }, async () => {
  const project = await createProjectFixture({
    config: "export default { plugin: { name: 'route-invocation-host-binding', version: '1.0.0' }, targets: ['claude', 'codex'] };\n",
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*"},"type":"module"}\n',
      'src/events/tool/before.preflight.ts': "export default () => ({ outcome: 'deny', reason: 'blocked' });\n",
      'src/events/tool/before.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "export { default as preflight } from './before.preflight.js';",
        "writeFileSync(join(process.cwd(), '.agent-bundle', 'ineligible-import.marker'), 'loaded');",
        "export const config = { runtime: 'standalone', targets: ['claude'] };",
        'export default async function BeforeTool() {',
        "  writeFileSync(join(process.cwd(), '.agent-bundle', 'ineligible-handler.marker'), 'ran');",
        "  throw new Error('ineligible event handler ran');",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-host-binding-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route invocation host binding</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    await expect.poll(
      async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
      { timeout: 10_000 },
    ).toBe(200);

    const input = {
      cwd: project.root,
      hook_event_name: 'PreToolUse',
      permission_mode: 'default',
      session_id: 'session-host-binding',
      tool_input: { file_path: 'blocked.txt' },
      tool_name: 'Write',
      tool_use_id: 'use-host-binding',
      transcript_path: join(project.root, 'transcript.json'),
    };
    const importMarker = join(project.root, '.agent-bundle', 'ineligible-import.marker');
    const handlerMarker = join(project.root, '.agent-bundle', 'ineligible-handler.marker');
    const ineligibleResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input,
        routeId: 'event:tool/before',
        surface: { host: 'codex', kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    expect(ineligibleResponse.status).toBe(200);
    await expect(ineligibleResponse.json()).resolves.toMatchObject({
      invocation: {
        diagnostics: [{ code: 'AB8251' }],
        status: 'failed',
      },
    });
    expect(existsSync(importMarker)).toBe(false);
    expect(existsSync(handlerMarker)).toBe(false);

    const deniedResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input,
        routeId: 'event:tool/before',
        surface: { host: 'claude', kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    expect(deniedResponse.status).toBe(200);
    await expect(deniedResponse.json()).resolves.toMatchObject({
      invocation: {
        result: { outcome: 'deny', reason: 'blocked' },
        status: 'succeeded',
      },
    });
    expect(existsSync(importMarker)).toBe(false);
    expect(existsSync(handlerMarker)).toBe(false);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('enforces compiled preflight, MCP schemas, and operator env across production surfaces', { timeout: 180_000 }, async () => {
  const project = await createProjectFixture({
    config: "export default { plugin: { name: 'route-parity', version: '1.0.0' }, targets: ['claude'] };\n",
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/events/tool/before.preflight.ts': "export default () => ({ outcome: 'deny', reason: 'blocked' });\n",
      'src/events/tool/before.tsx': [
        "export { default as preflight } from './before.preflight.js';",
        "export const config = { runtime: 'standalone' };",
        "export default async function BeforeTool() { throw new Error('preflight handler ran'); }",
        '',
      ].join('\n'),
      'src/mcp/status/tools/report.cli.ts': [
        "export const config = { command: ['report'], confirm: false, flags: { service: { name: 'service' } } };",
        '',
      ].join('\n'),
      'src/mcp/status/tools/report.tsx': [
        "import { writeFileSync } from 'node:fs';",
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const inputSchema = z.object({ service: z.string().min(1) }).strict();",
        "export const resultSchema = z.object({ operator: z.string(), service: z.string() }).strict();",
        '',
        'export default async function Report({ input }) {',
        "  writeFileSync('.agent-bundle/handler-ran', 'yes');",
        "  return createElement(Agent.Result, { value: { operator: process.env.OPERATOR_VALUE ?? 'missing', service: input.service } });",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-parity-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route parity</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    await expect.poll(
      async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
      { timeout: 10_000 },
    ).toBe(200);

    const invalidResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: { service: 1 }, routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(invalidResponse.status).toBe(200);
    const invalid = await invalidResponse.json() as RouteInvocationResponse;
    expect(invalid.invocation.status, JSON.stringify(invalid.invocation.diagnostics)).toBe('succeeded');
    expect(invalid.invocation).toMatchObject({
      document: { status: 'represented-error' },
      outcome: { kind: 'represented-error', summary: expect.stringContaining('Input validation error') },
      projection: { mcp: { isError: true } },
      status: 'succeeded',
    });
    expect(await readdir(join(project.root, '.agent-bundle'))).not.toContain('handler-ran');

    const artifact = server.status().artifact;
    if (artifact.state !== 'active') throw new Error('Expected an active compiled epoch.');
    await writeFile(join(project.root, '.agent-bundle', 'epochs', artifact.activeEpoch.id, '.env'), 'OPERATOR_VALUE=layered\n');
    const invoke = async (surface: { readonly args: readonly string[]; readonly command: string; readonly kind: 'cli' } | { readonly kind: 'mcp' }) => {
      const response = await fetch(`${server!.url}/api/routes/invocations`, {
        body: JSON.stringify({
          ...(surface.kind === 'mcp' ? { input: { service: 'mcp' } } : {}),
          routeId: 'tool:status/report',
          surface,
        }),
        headers,
        method: 'POST',
      });
      expect(response.status).toBe(200);
      return (await response.json() as RouteInvocationResponse).invocation;
    };
    const mcp = await invoke({ kind: 'mcp' });
    const cli = await invoke({ args: ['--service', 'cli'], command: 'report', kind: 'cli' });
    expect(mcp.result).toEqual({ operator: 'layered', service: 'mcp' });
    expect(cli.result).toEqual({ operator: 'layered', service: 'cli' });

    const canonical = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ input: {}, routeId: 'event:tool/before', surface: { kind: 'event' } }),
      headers,
      method: 'POST',
    });
    expect(canonical.status).toBe(400);
    await expect(canonical.json()).resolves.toMatchObject({ diagnostic: { code: 'AB8255' } });

    const deniedResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({
        input: {
          cwd: project.root,
          hook_event_name: 'PreToolUse',
          permission_mode: 'default',
          session_id: 'session-deny',
          tool_input: {},
          tool_name: 'Write',
          tool_use_id: 'use-deny',
          transcript_path: join(project.root, 'transcript.json'),
        },
        routeId: 'event:tool/before',
        surface: { host: 'claude', kind: 'event' },
      }),
      headers,
      method: 'POST',
    });
    const denied = await deniedResponse.json() as RouteInvocationResponse;
    expect(deniedResponse.status, JSON.stringify(denied)).toBe(200);
    expect(denied.invocation.timings.map((entry) => entry.phase)).toEqual(['projection']);
    expect(denied.invocation.providers).toEqual([]);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('publishes invocation routes only after a successful initial or recovered build', { timeout: 90_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'route-invocation-publication-gate', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      'src/mcp/status/tools/report.tsx': [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        "import './missing.js';",
        '',
        "export const inputSchema = z.object({}).strict();",
        'export const resultSchema = z.object({ version: z.string() }).strict();',
        '',
        'export default async function Report() {',
        "  return createElement(Agent.Result, { value: { version: 'published' } }, createElement(Agent.Text, null, 'Published route.'));",
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-publication-gate-',
  });
  const assetsRoot = join(project.root, 'workbench');
  const reportRoutePath = join(project.root, 'src/mcp/status/tools/report.tsx');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route publication gate</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    let bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    let session = await bootstrap.json() as { readonly token: string };
    let headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };

    await expect.poll(
      () => server!.status().build.state,
      { timeout: 10_000 },
    ).toBe('failed');
    const unavailableManifest = await fetch(`${server.url}/api/routes/manifest`, { headers });
    expect(unavailableManifest.status).toBe(409);
    const unavailableInvocation = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(unavailableInvocation.status).toBe(409);
    await expect(unavailableInvocation.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'No published build and route manifest are available.',
      },
    });

    const repairedAttempt = await replaceWatchedSourceAndAwaitRebuild(
      server,
      project.root,
      reportRoutePath,
      [
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement } from 'react';",
        "import { z } from 'zod';",
        '',
        'export const inputSchema = z.object({}).strict();',
        'export const resultSchema = z.object({ version: z.string() }).strict();',
        '',
        'export default async function Report() {',
        "  return createElement(Agent.Result, { value: { version: 'published' } }, createElement(Agent.Text, null, 'Published route.'));",
        '}',
        '',
      ].join('\n'),
      { timeoutMs: 10_000 },
    );
    expect(repairedAttempt.outcome, JSON.stringify(repairedAttempt.diagnostics)).toBe('succeeded');
    const publishedInvocationResponse = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(publishedInvocationResponse.status).toBe(200);
    const publishedInvocation = await publishedInvocationResponse.json() as RouteInvocationResponse;
    expect(publishedInvocation.invocation, JSON.stringify(publishedInvocation.invocation.diagnostics)).toMatchObject({
      result: { version: 'published' },
      status: 'succeeded',
    });

    await server.close();
    server = undefined;
    await writeFile(reportRoutePath, [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "import './missing.js';",
      '',
      'export const inputSchema = z.object({}).strict();',
      'export const resultSchema = z.object({ version: z.string() }).strict();',
      '',
      'export default async function Report() {',
      "  return createElement(Agent.Result, { value: { version: 'unpublished' } }, createElement(Agent.Text, null, 'Unpublished route.'));",
      '}',
      '',
    ].join('\n'));
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    session = await bootstrap.json() as { readonly token: string };
    headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };

    expect(server.status().artifact.state).toBe('stale');
    const recoveredManifestResponse = await fetch(`${server.url}/api/routes/manifest`, { headers });
    expect(recoveredManifestResponse.status).toBe(409);
    await expect(recoveredManifestResponse.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8121',
        message: 'Route manifest is not available.',
      },
    });
    const recoveredInvocation = await fetch(`${server.url}/api/routes/invocations`, {
      body: JSON.stringify({ routeId: 'tool:status/report' }),
      headers,
      method: 'POST',
    });
    expect(recoveredInvocation.status).toBe(409);
    await expect(recoveredInvocation.json()).resolves.toEqual({
      diagnostic: {
        code: 'AB8232',
        message: 'No published build and route manifest are available.',
      },
    });
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});

it('bounds the render history a compiled child produces by count and bytes across the envelope, reads, replay, and cancellation', { timeout: 180_000 }, async () => {
  const project = await createProjectFixture({
    config: [
      'export default {',
      "  plugin: { name: 'route-invocation-retention', version: '1.0.0' },",
      "  targets: ['claude'],",
      '};',
      '',
    ].join('\n'),
    files: {
      'package.json': '{"dependencies":{"@agent-bundle/runtime":"workspace:*","react":"19.2.8","zod":"4.5.4"},"type":"module"}\n',
      // One Suspense boundary per cell settles per macrotask, so the stream
      // grows one `replace` snapshot at a time; `gate` names a file the last
      // boundary waits for, or `none`.
      'src/cli/flood.tsx': [
        "import { existsSync } from 'node:fs';",
        "import { Agent } from '@agent-bundle/runtime';",
        "import { createElement, Suspense } from 'react';",
        "import { z } from 'zod';",
        '',
        "export const config = { description: 'Streams many boundaries.', positionals: ['boundaries', 'bytes', 'gate'] };",
        'export const inputSchema = z.object({ boundaries: z.number().int().min(1).max(900), bytes: z.number().int().min(1).max(4096), gate: z.string() }).strict();',
        'export const resultSchema = z.object({ boundaries: z.number() }).strict();',
        '',
        'let turn = Promise.resolve();',
        'const Cell = async ({ bytes, index }) => {',
        '  const mine = turn.then(() => new Promise((resolve) => setImmediate(resolve)));',
        '  turn = mine;',
        '  await mine;',
        "  return createElement(Agent.Text, null, `${index}:`.padEnd(bytes, 'x'));",
        '};',
        'const Gate = async ({ path }) => {',
        '  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 20));',
        "  return createElement(Agent.Text, null, 'released');",
        '};',
        '',
        'export default async function Flood({ input }) {',
        "  const cells = Array.from({ length: input.boundaries }, (_, index) => createElement(Suspense, { fallback: createElement(Agent.Text, null, 'pending'), key: index }, createElement(Cell, { bytes: input.bytes, index })));",
        "  const gate = input.gate === 'none' ? [] : [createElement(Suspense, { fallback: createElement(Agent.Text, null, 'waiting'), key: 'gate' }, createElement(Gate, { path: input.gate }))];",
        '  return createElement(Agent.Result, { value: { boundaries: input.boundaries } }, ...cells, ...gate);',
        '}',
        '',
      ].join('\n'),
    },
    prefix: 'agent-bundle-route-invocation-retention-',
  });
  const assetsRoot = join(project.root, 'workbench');
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  await mkdir(assetsRoot, { recursive: true });
  await Promise.all([
    symlink(agentBundleNodeModules, join(project.root, 'node_modules'), 'dir'),
    writeFile(join(assetsRoot, 'index.html'), '<!doctype html><title>Route invocation retention</title>'),
  ]);
  try {
    server = await startDevServer({
      assets: createWorkbenchAssetSource({ root: assetsRoot }),
      open: false,
      port: 0,
      root: project.root,
    });
    const bootstrap = await fetch(`${server.url}/api/project/session`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    const session = await bootstrap.json() as { readonly token: string };
    const headers = {
      'content-type': 'application/json',
      origin: server.url,
      'x-agent-bundle-session': session.token,
    };
    await expect.poll(
      async () => fetch(`${server!.url}/api/routes/manifest`, { headers }).then((response) => response.status),
      { timeout: 20_000 },
    ).toBe(200);
    const boundaries = 300;
    const flood = (args: readonly string[], stream: boolean) => fetch(`${server!.url}/api/routes/invocations`, {
      body: JSON.stringify({
        correlationId: 'retention-1',
        routeId: 'cli:flood',
        ...(stream ? { stream: true } : {}),
        surface: { args, command: 'flood', kind: 'cli' },
      }),
      headers,
      method: 'POST',
    });
    const expectBounded = (invocation: RouteInvocation): void => {
      expect(invocation.events.length).toBeLessThanOrEqual(routeInvocationRenderHistoryLimits.maxEvents);
      expect(renderBytes(invocation.events)).toBeLessThanOrEqual(routeInvocationRenderHistoryLimits.maxBytes);
      expect(invocation.retention?.evictedEvents).toBeGreaterThan(0);
      expect(invocation.retention?.producedEvents).toBe(invocation.retention!.evictedEvents + invocation.events.length);
      // shell, one replace per settled boundary, then complete or the pending gate
      expect(invocation.retention?.producedEvents).toBeGreaterThanOrEqual(boundaries + 1);
      expect(invocation.correlationId).toBe('retention-1');
    };

    // Large intermediate snapshots: every replace carries the whole document,
    // so bytes bound the window long before the event count does.
    const completedResponse = await flood([String(boundaries), '256', 'none'], false);
    expect(completedResponse.status).toBe(200);
    const completed = (await completedResponse.json() as RouteInvocationResponse).invocation;
    expect(completed.status, JSON.stringify(completed.diagnostics)).toBe('succeeded');
    expectBounded(completed);
    expect(completed.events.length).toBeLessThan(routeInvocationRenderHistoryLimits.maxEvents);
    expect(completed.events.at(-1)?.type).toBe('complete');
    expect(completed.outcome).toEqual({ kind: 'success' });
    expect(completed.result).toEqual({ boundaries });
    expect(JSON.stringify(completed.document)).toContain(`${String(boundaries - 1)}:`);
    const read = (await (await fetch(`${server.url}/api/routes/invocations/${completed.id}`, { headers })).json() as RouteInvocationResponse).invocation;
    expect(read).toEqual(completed);
    const replayed = await readInvocationStream(await fetch(`${server.url}/api/routes/invocations/${completed.id}/stream`, { headers }));
    expect(replayed[0]).toEqual({ type: 'truncated' });
    expect(renderEvents(replayed)).toEqual(completed.events);
    expect(replayed.at(-1)).toEqual({ invocation: completed, type: 'final' });

    // Reconnect once the shell has been evicted, then cancel behind the gate.
    const gate = join(project.root, '.agent-bundle', 'flood-gate');
    const startedResponse = await flood([String(boundaries), '16', gate], true);
    expect(startedResponse.status).toBe(202);
    const started = await startedResponse.json() as { readonly invocation: { readonly id: string } };
    const live = invocationMessages(await fetch(`${server.url}/api/routes/invocations/${started.invocation.id}/stream`, { headers }));
    await live.next(() => renderEvents(live.seen).length >= boundaries + 1);
    const reconnectedResponse = await fetch(`${server.url}/api/routes/invocations/${started.invocation.id}/stream`, { headers });
    expect(reconnectedResponse.status).toBe(200);
    const cancelResponse = await fetch(`${server.url}/api/routes/invocations/${started.invocation.id}/cancel`, { headers, method: 'POST' });
    expect(cancelResponse.status).toBe(202);
    const cancelled = (await cancelResponse.json() as RouteInvocationResponse).invocation;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('outcome');
    expectBounded(cancelled);
    expect(cancelled.events[0]?.type).not.toBe('shell');
    expect(JSON.stringify(cancelled.document)).toContain(`${String(boundaries - 1)}:`);
    const reconnected = await readInvocationStream(reconnectedResponse);
    expect(reconnected[0]).toEqual({ type: 'truncated' });
    // A live reconnect may include replay events evicted before the terminal envelope.
    expect(renderEvents(reconnected).slice(-cancelled.events.length)).toEqual(cancelled.events);
    expect(reconnected.at(-1)).toEqual({ invocation: cancelled, type: 'final' });
    await live.next(isFinal);
    expect(live.seen.filter((message) => message.type === 'truncated')).toHaveLength(1);
    expect(renderEvents(live.seen).length).toBeGreaterThan(routeInvocationRenderHistoryLimits.maxEvents);
  } finally {
    await server?.close().catch(() => undefined);
    await rm(project.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
});
