import { describe, expect, it } from '@rstest/core';

import { cliJson, invokeCli } from '../../src/test/cli.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import { invokeMcpTool } from '../../src/test/mcp.ts';
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
      processLifetime: { hits: expect.any(Number), instanceId: expect.any(String), pid: process.pid },
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
    });
  });

  it('mounts providers for an MCP route through the real in-memory server', async () => {
    const call = await invokeMcpTool('tooling');

    expect(call.isError).toBe(false);
    expect(call.structuredContent).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
    });
  });

  it('mounts providers for an MCP route at the route-unit level', async () => {
    const rendered = await renderRoute('tool:harness/tooling');

    expect(rendered.result).toEqual({
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'tool', surface: 'tool:harness/tooling', tool: 'ffprobe 6.1' },
    });
  });

  it('mounts providers for a rendered script with the script invocation', async () => {
    const rendered = await renderRoute('script:tooling-summary', { args: ['--fast', 'a.mp4'] });

    expect(rendered.result).toEqual({
      arguments: 2,
      keys: ['libraryTooling', 'processLifetime'],
      libraryTooling: { kind: 'script', surface: 'script:tooling-summary', tool: 'ffprobe 6.1' },
    });
  });

  it('counts every harness request in one process identity', async () => {
    const first = cliJson(await invokeCli(['tooling', 'inspect'])) as { processLifetime: { hits: number; instanceId: string } };
    await renderRoute('tool:harness/tooling');
    const second = cliJson(await invokeCli(['tooling', 'inspect'])) as { processLifetime: { hits: number; instanceId: string } };

    expect(second.processLifetime.instanceId).toBe(first.processLifetime.instanceId);
    expect(second.processLifetime.hits).toBeGreaterThanOrEqual(first.processLifetime.hits + 2);
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
