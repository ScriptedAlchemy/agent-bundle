import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from '@rstest/core';
import { available } from '@agent-bundle/runtime';
import { createAgentLineageRegistry } from '@agent-bundle/runtime/lineage';
import { createMemoryStateDriver, defineState, type AgentStateDriver } from '@agent-bundle/runtime/state';
import { z } from 'zod';

import { cliJson, invokeCli } from '../../src/test/cli.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import { invokeMcpTool, openInMemoryMcpServer } from '../../src/test/mcp.ts';
import { renderRoute } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

/**
 * Conventional request context providers reach every harness request scope
 * the way they reach every generated request scope (#313, #366): discovered
 * from the compiled manifest, executed once per request in the generated
 * order, and mounted at `providers.<key>` beside the framework-owned
 * `processLifetime`. A test that passes `context.providers` opts out and the
 * explicit map is used verbatim.
 */
const keys = ['libraryTooling', 'processLifetime', 'requestView'];

/**
 * What the `request-view` fixture provider reports on a surface that mounts
 * no host conversation (#459): the identity axes as the route reads them (the
 * plugin root is the harness's `.agent-bundle/state` anchor, #468), the
 * runtime error `useAgent()` raises inside a provider, and — where the harness
 * mounts state — the `read`-only state handle and the `inbox`/`published`-only
 * notice handle, nothing more.
 */
const requestView = (surface: { readonly host?: string; readonly mounted: boolean; readonly workspace?: string }) => ({
  handle: 'outside-invocation',
  host: surface.host ?? 'unsupported-surface',
  lineage: 'not-provided',
  notices: surface.mounted ? { keys: ['inbox', 'published'], published: [] } : null,
  plugin: expect.stringMatching(/[\\/]\.agent-bundle[\\/]state$/u),
  session: 'not-provided',
  state: surface.mounted ? { keys: ['lifetime', 'read'], lifetime: 'workspace-durable', revision: 0 } : null,
  workspace: surface.workspace ?? process.cwd(),
});
/** A route-unit render injects no identity unless the test does, so a provider sees the typed absence the route sees. */
const routeUnitView = requestView({ host: 'not-provided', mounted: true, workspace: 'not-provided' });

describe('conventional providers through the harness', () => {
  it('names the compiled providers in the manifest in the generated execution order', () => {
    const manifest = testManifest();

    expect(manifest.providers).toEqual([
      {
        id: 'provider:library-tooling',
        key: 'libraryTooling',
        name: 'library-tooling',
        relativePath: 'src/providers/library-tooling.ts',
        source: expect.stringMatching(/route-harness[\\/]src[\\/]providers[\\/]library-tooling\.ts$/u),
      },
      {
        id: 'provider:request-view',
        key: 'requestView',
        name: 'request-view',
        relativePath: 'src/providers/request-view.ts',
        source: expect.stringMatching(/route-harness[\\/]src[\\/]providers[\\/]request-view\.ts$/u),
      },
    ]);
  });

  it('mounts providers for a plain routed CLI command with the cli invocation', async () => {
    const run = await invokeCli(['tooling', 'inspect']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(cliJson(run)).toEqual({
      keys,
      libraryTooling: { kind: 'cli', surface: 'tooling inspect', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
      // The plain-command harness mounts no state, like a stateless executable.
      requestView: requestView({ mounted: false }),
    });
  });

  it('mounts providers for a rendered routed CLI command with the cli invocation', async () => {
    const run = await invokeCli(['tooling', 'report', '--json']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(cliJson(run)).toEqual({
      keys,
      libraryTooling: { kind: 'cli', surface: 'tooling report', tool: 'ffprobe 6.1' },
      requestView: requestView({ mounted: true }),
    });
  });

  it('mounts providers for a bulk-projected MCP command with the cli invocation', async () => {
    const run = await invokeCli(['harness', 'tooling', '--json']);

    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toEqual({
      keys,
      libraryTooling: { kind: 'cli', surface: 'harness tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
      requestView: requestView({ mounted: true }),
    });
  });

  it('mounts providers for an MCP route through the real in-memory server', async () => {
    const call = await invokeMcpTool('tooling');

    expect(call.isError).toBe(false);
    expect(call.structuredContent).toEqual({
      keys,
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
      // The server publishes the negotiated client as the host; a session
      // opened without `state` mounts neither handle. `useAgent()` still throws
      // although the in-process host scope wraps the render: the runtime runs
      // the resolver outside every request context, as a worker boundary would.
      requestView: requestView({ host: 'agent-bundle-in-memory-projection', mounted: false }),
    });
  });

  it('hands providers the lineage the call resolved to — tree included — and the read-only handles on the in-memory server (#459)', async () => {
    const registry = createAgentLineageRegistry();
    const observe = (event: string, native: Record<string, unknown>) =>
      registry.observe({ event, host: 'claude', idempotencyKey: `${event}:${JSON.stringify(native)}`, native, observedAt: '2026-09-03T00:00:00.000Z' });
    await observe('session/start', { hook_event_name: 'SessionStart', session_id: 'root' });
    await observe('tool/before', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: {}, tool_name: 'Agent', tool_use_id: 'spawn' });
    await observe('agent/start', { agent_id: 'child', agent_type: 'general-purpose', hook_event_name: 'SubagentStart', session_id: 'root' });
    await observe('tool/before', { hook_event_name: 'PreToolUse', session_id: 'root', tool_input: { inbox: true }, tool_name: 'mcp__plugin_harness_harness__tooling', tool_use_id: 'toolu_tooling' });
    const definition = defineState({
      events: { noted: z.object({ note: z.string() }).strict() },
      id: 'providers/request-view',
      initial: { notes: [] as string[] },
      lifetime: 'process',
      reduce: (state, event) => ({ notes: [...state.notes, event.payload.note] }),
      schema: z.object({ notes: z.array(z.string()) }).strict(),
    });
    await using session = await openInMemoryMcpServer({
      lineage: registry,
      lineageHost: 'claude',
      state: { definition, driver: createMemoryStateDriver({ lifetime: 'process' }) },
    });
    const result = await session.client.callTool({ _meta: { 'claudecode/toolUseId': 'toolu_tooling' }, arguments: { inbox: true }, name: 'tooling' });

    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect((result.structuredContent as { requestView: unknown }).requestView).toEqual({
      handle: 'outside-invocation',
      host: 'agent-bundle-in-memory-projection',
      // The same registry answer the route reads from `request.lineage`, live tree included (#457).
      lineage: { conversation: 'root', depth: 0, siblings: ['child'] },
      // `inbox()` and `published()` are the real request-scoped reads: nothing
      // is addressed to this principal and it published nothing.
      notices: { inbox: [], keys: ['inbox', 'published'], published: [] },
      plugin: expect.stringMatching(/[\\/]\.agent-bundle[\\/]state$/u),
      session: 'not-provided',
      state: { keys: ['lifetime', 'read'], lifetime: 'process', revision: 0 },
      workspace: process.cwd(),
    });
  });

  it('mounts providers for an MCP route at the route-unit level, including when it is also a projected CLI command', async () => {
    // `harness tooling` is projected onto the CLI from this tool; its command
    // carries the tool's route id, so rendering it takes the tool branch the
    // generated entry takes for `command.mcp !== undefined`.
    expect(testManifest().cliCommands.find((command) => command.mcp?.tool === 'tooling')?.routeId).toBe('tool:harness/tooling');
    const rendered = await renderRoute('tool:harness/tooling');

    expect(rendered.result).toEqual({
      keys,
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
      requestView: routeUnitView,
    });
  });

  it('hands providers the injected identity axes and lineage a route-unit render mounts (#459)', async () => {
    const rendered = await renderRoute('tool:harness/tooling', {
      context: {
        host: available({ name: 'route-unit-host' }, 'native'),
        lineage: available({
          conversation: 'child',
          depth: 1,
          parent: 'root',
          resolution: 'registry',
          root: 'root',
          subagent: { id: 'child' },
          tree: { children: [], roots: [], siblings: [{ conversation: 'root', depth: 0, resolution: 'native', startedAt: '2026-09-03T00:00:00.000Z' }] },
        }, 'derived'),
        session: available({ sessionId: 'root' }, 'native'),
        workspace: available({ root: '/tmp/route-unit' }, 'derived'),
      },
    });

    expect((rendered.result as { requestView: unknown }).requestView).toEqual({
      handle: 'outside-invocation',
      host: 'route-unit-host',
      lineage: { conversation: 'child', depth: 1, siblings: ['root'] },
      notices: { keys: ['inbox', 'published'], published: [] },
      plugin: expect.stringMatching(/[\\/]\.agent-bundle[\\/]state$/u),
      session: 'root',
      state: { keys: ['lifetime', 'read'], lifetime: 'workspace-durable', revision: 0 },
      workspace: '/tmp/route-unit',
    });
  });

  it('mounts providers for a rendered script with the script name the generated script passes', async () => {
    const rendered = await renderRoute('script:tooling-summary', { args: ['--fast', 'a.mp4'] });

    // The generated script passes `name: 'tooling-summary'`, never the route id.
    expect(rendered.result).toEqual({
      arguments: 2,
      keys,
      libraryTooling: { kind: 'script', surface: 'tooling-summary', tool: 'ffprobe 6.1' },
      requestView: routeUnitView,
    });
  });

  it('mounts providers for a rendered CLI route at the route-unit level with the command path', async () => {
    const rendered = await renderRoute('cli:tooling/report');

    // The generated executable passes `command.path.join(' ')`, never the route id.
    expect(rendered.result).toEqual({
      keys,
      libraryTooling: { kind: 'cli', surface: 'tooling report', tool: 'ffprobe 6.1' },
      requestView: routeUnitView,
    });
  });

  it('gives every CLI invocation its own fresh process identity, like a separate generated executable', async () => {
    type Lifetime = { processLifetime: { hits: number; instanceId: string; pid: number } };
    const first = cliJson(await invokeCli(['tooling', 'inspect'])) as Lifetime;
    const second = cliJson(await invokeCli(['tooling', 'inspect'])) as Lifetime;

    expect(first.processLifetime).toEqual({ hits: 1, instanceId: expect.any(String), pid: process.pid });
    expect(second.processLifetime).toEqual({ hits: 1, instanceId: expect.any(String), pid: process.pid });
    expect(second.processLifetime.instanceId).not.toBe(first.processLifetime.instanceId);
  });

  it('shares one process identity across the requests of one open in-memory MCP server only', async () => {
    type Lifetime = { processLifetime: { hits: number; instanceId: string; pid: number } };
    const lifetimeOf = (result: unknown): Lifetime['processLifetime'] =>
      ((result as { structuredContent: Lifetime }).structuredContent).processLifetime;

    await using session = await openInMemoryMcpServer();
    const first = lifetimeOf(await session.client.callTool({ arguments: {}, name: 'tooling' }));
    const second = lifetimeOf(await session.client.callTool({ arguments: {}, name: 'tooling' }));
    await using other = await openInMemoryMcpServer();
    const elsewhere = lifetimeOf(await other.client.callTool({ arguments: {}, name: 'tooling' }));
    const convenience = lifetimeOf(await invokeMcpTool('tooling'));

    // The same warm server serves both calls, exactly like the artifact's
    // Flight worker; a second server, and the open-call-close convenience
    // helper, are separate processes that start at hit 1.
    expect(first).toEqual({ hits: 1, instanceId: expect.any(String), pid: process.pid });
    expect(second).toEqual({ hits: 2, instanceId: first.instanceId, pid: process.pid });
    expect(elsewhere).toEqual({ hits: 1, instanceId: expect.any(String), pid: process.pid });
    expect(elsewhere.instanceId).not.toBe(first.instanceId);
    expect(convenience).toEqual({ hits: 1, instanceId: expect.any(String), pid: process.pid });
    expect(convenience.instanceId).not.toBe(first.instanceId);
  });

  it('hands concurrent requests on one server distinct hit counts, snapshotted before provider loading', async () => {
    type Lifetime = { processLifetime: { hits: number; instanceId: string } };
    await using session = await openInMemoryMcpServer();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => session.client.callTool({ arguments: {}, name: 'tooling' })),
    );
    const lifetimes = results.map((result) => (result as { structuredContent: Lifetime }).structuredContent.processLifetime);

    // Like the generated worker, each request captures its own hit right after
    // the increment; awaiting provider loaders must not let a concurrent
    // request move it.
    expect(lifetimes.map((lifetime) => lifetime.hits).sort((left, right) => left - right)).toEqual([1, 2, 3, 4]);
    expect(new Set(lifetimes.map((lifetime) => lifetime.instanceId)).size).toBe(1);
  });

  it('claims the hit before awaiting state bindings, so hits follow arrival order like the generated worker', async () => {
    type Lifetime = { processLifetime: { hits: number; instanceId: string } };
    const definition = defineState({
      events: { changed: z.object({ value: z.string() }).strict() },
      id: 'providers/request-state',
      initial: { value: '' },
      lifetime: 'request',
      reduce: (_state, event) => ({ value: event.payload.value }),
      schema: z.object({ value: z.string() }).strict(),
    });
    const inner = createMemoryStateDriver({ lifetime: 'request' });
    let projectOpens = 0;
    const driver: AgentStateDriver = {
      ...inner,
      open: async (opened) => {
        // Only the first request's project store is slow to open; the second
        // request's bindings resolve first.
        if (opened.id === definition.id && projectOpens++ === 0) await sleep(150);
        return inner.open(opened);
      },
    };
    await using session = await openInMemoryMcpServer({ state: { definition, driver } });

    const [first, second] = await Promise.all([
      session.client.callTool({ arguments: {}, name: 'tooling' }),
      session.client.callTool({ arguments: {}, name: 'tooling' }),
    ]);
    const lifetimeOf = (result: unknown): Lifetime['processLifetime'] =>
      (result as { structuredContent: Lifetime }).structuredContent.processLifetime;

    // The generated worker increments and snapshots before `requestBindings`;
    // the request that arrived first keeps hit 1 even though its state
    // bindings resolved last.
    expect(lifetimeOf(first).hits).toBe(1);
    expect(lifetimeOf(second).hits).toBe(2);
    expect(projectOpens).toBe(2);
  });

  it('gives every route-unit render a fresh process identity', async () => {
    type Result = { processLifetime: { hits: number; instanceId: string } };
    const first = (await renderRoute('tool:harness/tooling')).result as Result;
    const second = (await renderRoute('tool:harness/tooling')).result as Result;

    expect(first.processLifetime.hits).toBe(1);
    expect(second.processLifetime.hits).toBe(1);
    expect(second.processLifetime.instanceId).not.toBe(first.processLifetime.instanceId);
  });

  it('uses an explicit context.providers map verbatim instead of discovering providers', async () => {
    const [plain, rendered, tool] = await Promise.all([
      invokeCli(['tooling', 'inspect'], {
        context: { providers: { libraryTooling: 'stubbed', processLifetime: { hits: 1, instanceId: 'test', pid: 1 } } },
      }),
      renderRoute('script:tooling-summary', { context: { providers: { other: true } } }),
      invokeMcpTool('tooling', { context: { providers: {} } }),
    ]);

    expect(cliJson(plain)).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: 'stubbed',
      processLifetime: { hits: 1, instanceId: 'test', pid: 1 },
    });
    expect(rendered.result).toEqual({ arguments: 0, keys: ['other'] });
    expect(tool.structuredContent).toEqual({ keys: [] });
  });

  it('fails a request closed when a provider factory throws, naming the provider like the generated scope', async () => {
    const message = 'Context provider "libraryTooling" (src/providers/library-tooling.ts) failed: ffprobe is not installed';

    const run = await invokeCli(['harness', 'tooling', '--input', '{"failProvider":true}']);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(message);

    let error: unknown;
    try {
      await renderRoute('tool:harness/tooling', { input: { failProvider: true } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('render-failed');
    expect((error as AgentTestError).message).toContain(message);
  });
});
