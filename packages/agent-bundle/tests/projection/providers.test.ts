import { describe, expect, it } from '@rstest/core';

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
describe('conventional providers through the harness', () => {
  it('names the compiled providers in the manifest in the generated execution order', () => {
    const manifest = testManifest();

    expect(manifest.providers).toEqual([{
      id: 'provider:library-tooling',
      key: 'libraryTooling',
      name: 'library-tooling',
      relativePath: 'src/providers/library-tooling.ts',
      source: expect.stringMatching(/route-harness[\\/]src[\\/]providers[\\/]library-tooling\.ts$/u),
    }]);
  });

  it('mounts providers for a plain routed CLI command with the cli invocation', async () => {
    const run = await invokeCli(['tooling', 'inspect']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(cliJson(run)).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'cli', surface: 'tooling inspect', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
    });
  });

  it('mounts providers for a rendered routed CLI command with the cli invocation', async () => {
    const run = await invokeCli(['tooling', 'report', '--json']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(cliJson(run)).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'cli', surface: 'tooling report', tool: 'ffprobe 6.1' },
    });
  });

  it('mounts providers for a projected MCP command with the tool invocation', async () => {
    const run = await invokeCli(['harness', 'tooling', '--json']);

    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
    });
  });

  it('mounts providers for an MCP route through the real in-memory server', async () => {
    const call = await invokeMcpTool('tooling');

    expect(call.isError).toBe(false);
    expect(call.structuredContent).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
    });
  });

  it('mounts providers for an MCP route at the route-unit level', async () => {
    const rendered = await renderRoute('tool:harness/tooling');

    expect(rendered.result).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
      processLifetime: { hits: 1, instanceId: expect.any(String), pid: process.pid },
    });
  });

  it('mounts providers for a rendered script with the script name the generated script passes', async () => {
    const rendered = await renderRoute('script:tooling-summary', { args: ['--fast', 'a.mp4'] });

    // The generated script passes `name: 'tooling-summary'`, never the route id.
    expect(rendered.result).toEqual({
      arguments: 2,
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'script', surface: 'tooling-summary', tool: 'ffprobe 6.1' },
    });
  });

  it('mounts providers for a rendered CLI route at the route-unit level with the command path', async () => {
    const rendered = await renderRoute('cli:tooling/report');

    // The generated executable passes `command.path.join(' ')`, never the route id.
    expect(rendered.result).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'cli', surface: 'tooling report', tool: 'ffprobe 6.1' },
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
