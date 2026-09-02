import { describe, expect, it } from '@rstest/core';

import { cliJson, cliNdjson, invokeCli } from '../../src/test/cli.ts';
import { invokeMcpTool } from '../../src/test/mcp.ts';

const workspaceContext = {
  workspace: {
    source: 'native',
    state: 'available',
    value: { root: '/tmp/projected-cli' },
  } as never,
};

/**
 * Projected MCP commands at the `cli-dispatch` proof level. These tests run
 * the product shell and real route renderer in-process; the packed CLI suite
 * separately proves the generated executable and worker artifacts.
 */
describe('projected MCP tools at the CLI dispatch level', () => {
  it('renders a read-only tool as final piped Markdown without --yes', async () => {
    const run = await invokeCli([
      'harness',
      'echo',
      '--input',
      '{"message":"projected"}',
    ], { context: workspaceContext });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('# Echo\n\nprojected\n\nworkspace: /tmp/projected-cli\n');
    expect(run.routeId).toBe('tool:harness/echo');
  });

  it('emits the canonical tool result under --json', async () => {
    const run = await invokeCli([
      'harness',
      'echo',
      '--input',
      '{"message":"json"}',
      '--json',
    ], { context: workspaceContext });

    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toEqual({
      message: 'json',
      operationId: 'tool:harness/echo',
      workspace: '/tmp/projected-cli',
    });
  });

  it('emits monotonic NDJSON events ending in complete with no JSON-RPC framing', async () => {
    const run = await invokeCli([
      'harness',
      'echo',
      '--input',
      '{"message":"events"}',
      '--ndjson',
    ], { context: workspaceContext });
    const events = cliNdjson(run);

    expect(run.exitCode).toBe(0);
    expect(events.every((event, index) =>
      index === 0 || event.sequence > events[index - 1]!.sequence)).toBe(true);
    expect(events.at(-1)?.type).toBe('complete');
    expect(JSON.stringify(events)).not.toContain('"jsonrpc"');
  });

  it('fails closed without executing a mutation-capable route, then executes once with --yes', async () => {
    const denied = await invokeCli([
      'harness',
      'mutation-probe',
      '--input',
      '{"marker":"denied"}',
    ]);
    expect(denied.exitCode).toBe(2);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('requires --yes');
    expect(denied.value).toBeUndefined();

    const allowed = await invokeCli([
      'harness',
      'mutation-probe',
      '--input',
      '{"marker":"allowed"}',
      '--yes',
      '--json',
    ]);
    expect(allowed.exitCode).toBe(0);
    expect(cliJson(allowed)).toEqual({
      executions: 1,
      invocation: 'tool',
      marker: 'allowed',
      operationId: 'tool:harness/mutation-probe',
    });
  });

  it('maps invalid JSON and tool inputSchema rejection to usage exit 2', async () => {
    const invalidJson = await invokeCli(['harness', 'echo', '--input', '{']);
    expect(invalidJson.exitCode).toBe(2);
    expect(invalidJson.stderr).toContain('valid JSON object');

    const rejected = await invokeCli(['harness', 'echo', '--input', '{"message":42}']);
    expect(rejected.exitCode).toBe(2);
    expect(rejected.stderr).toContain("--help' for usage.");
    expect(rejected.value).toBeUndefined();
  });

  it('returns the same structured value as the in-memory MCP projection for identical input', async () => {
    const input = { message: 'parity' };
    const cli = await invokeCli([
      'harness',
      'echo',
      '--input',
      JSON.stringify(input),
      '--json',
    ], { context: workspaceContext });
    const mcp = await invokeMcpTool('echo', { context: workspaceContext, input });

    expect(cli.exitCode).toBe(0);
    expect(cliJson(cli)).toEqual(mcp.structuredContent);
  });
});
