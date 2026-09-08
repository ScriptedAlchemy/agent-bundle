import { describe, expect, it } from '@rstest/core';

import { cliJson, invokeCli } from '../../src/test/cli.ts';
import { invokeMcpTool } from '../../src/test/mcp.ts';
import { testManifest } from '../../src/test/registry.ts';

/**
 * The JSON-mode CLI projection (#746) at the `cli-dispatch` proof level:
 * `src/mcp/harness/tools/select.cli.tsx` projects `tool:harness/select`, whose
 * discriminated union under a nested object no flag grammar can spell, onto
 * `route-harness select --input '<json>'`. The canonical object reaches the
 * tool's own inputSchema unchanged, so defaults, refusals, confirmation, and
 * exit behavior are the tool's and the bulk projection's, not a weaker copy.
 */
const helpHint = "Run 'route-harness select --help' for usage.";
const selection = { by: 'query', query: 'dune' } as const;

describe('the JSON-mode CLI projection of tool:harness/select', () => {
  it('compiles one --input command whose projection records the mode and no flag binding', () => {
    const command = testManifest().cliCommands.find((candidate) => candidate.routeId === 'tool:harness/select');

    expect(command).toEqual({
      aliases: [],
      description: 'Selects catalog entries from one JSON selection.',
      exitCode: 'zero',
      mcp: { confirm: true, server: 'harness', tool: 'select' },
      options: [
        expect.objectContaining({ description: 'Tool input as one JSON object.', key: 'input', kind: 'string', option: 'input', repeated: false, required: false }),
        expect.objectContaining({ key: 'yes', kind: 'boolean', option: 'yes', repeated: false, required: false }),
      ],
      path: ['select'],
      projection: { input: 'json', mapInput: false, module: 'src/mcp/harness/tools/select.cli.tsx' },
      rendered: true,
      routeId: 'tool:harness/select',
    });
  });

  it('hands the canonical JSON object to the tool unchanged, so the tool schema applies its nested defaults', async () => {
    const cli = await invokeCli(['select', '--input', JSON.stringify({ selection }), '--yes', '--json']);
    const mcp = await invokeMcpTool('select', { input: { selection } });

    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe('');
    expect(cli.routeId).toBe('tool:harness/select');
    expect(cliJson(cli)).toEqual({
      filters: { minRating: 0 },
      invocation: 'cli',
      selection: { by: 'query', limit: 10, query: 'dune' },
    });
    expect(mcp.isError).toBe(false);
    expect(mcp.structuredContent).toEqual({ ...(cliJson(cli) as object), invocation: 'tool' });
  });

  it('rejects a non-object --input before the tool runs, like the bulk projection', async () => {
    for (const raw of ['[]', 'null', '"dune"', '{not json']) {
      const run = await invokeCli(['select', '--input', raw, '--yes']);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.value).toBeUndefined();
      expect(run.stderr).toContain(raw === '{not json' ? '--input must be one valid JSON object.' : '--input must be a JSON object;');
      expect(run.stderr).toContain(helpHint);
    }
  });

  it('spells canonical schema issues under --input.<path>', async () => {
    const run = await invokeCli(['select', '--input', JSON.stringify({ selection: { by: 'query', query: '' } }), '--yes', '--json']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr)).toMatchObject({
      error: {
        code: 'CLI_INPUT_INVALID',
        issues: [expect.objectContaining({ target: '--input.selection.query' })],
      },
    });
  });

  it('keeps the tool annotations confirmation: --yes is required and never enters the input', async () => {
    const run = await invokeCli(['select', '--input', JSON.stringify({ selection })]);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('MCP tool harness:select is mutation-capable per its MCP annotations and requires --yes.');
  });

  it('prints help that names --input as the whole tool input and the projection module', async () => {
    const help = await invokeCli(['select', '--help']);

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Usage: route-harness select [options]');
    expect(help.stdout).toContain('--input');
    expect(help.stdout).toContain('Tool input as one JSON object.');
    expect(help.stdout).toContain('MCP tool: harness:select');
    expect(help.stdout).toContain('Mutation-capable; requires --yes.');
    expect(help.stdout).toContain('Projection: src/mcp/harness/tools/select.cli.tsx');
  });
});
