import { describe, expect, it } from '@rstest/core';

import { cliJson, invokeCli } from '../../src/test/cli.ts';
import { invokeMcpTool } from '../../src/test/mcp.ts';
import { testManifest } from '../../src/test/registry.ts';

/**
 * The explicit CLI surface projection (#596) at the `cli-dispatch` proof
 * level: `src/mcp/harness/tools/submit.cli.tsx` projects `tool:harness/submit`
 * onto `route-harness submit` with an idiomatic grammar (`--lane`, a
 * repeatable `--tag`, trailing `argv` with `--` passthrough, `cwd` derived by
 * `mapInput`). The operation itself is invoked once per surface — the routed
 * CLI shell and the in-memory MCP server — and the two structured results are
 * compared; every mapping the projection performs is its own case and
 * exercises only the CLI grammar.
 */
const cwd = process.cwd();
const usage = 'Usage: route-harness submit [options] <argv...>';
const helpHint = "Run 'route-harness submit --help' for usage.";
/** The `library-tooling` fixture provider's report, keyed by the surface it observed. */
const providerLine = (kind: 'cli' | 'tool', surface: string): string =>
  `provider: ${JSON.stringify({ kind, surface, tool: 'ffprobe 6.1' })}`;

describe('the CLI surface projection of tool:harness/submit', () => {
  it('compiles the projection module into one command whose route is the tool', () => {
    const manifest = testManifest();
    const command = manifest.cliCommands.find((candidate) => candidate.routeId === 'tool:harness/submit');

    expect(command).toEqual({
      aliases: [],
      // No `description` in the projection: the tool's config.description serves.
      description: 'Submits one command line as lane work and echoes the accepted request.',
      exitCode: 'zero',
      mcp: { confirm: false, server: 'harness', tool: 'submit' },
      // `options` is the mapping: canonical `key` ↔ CLI `option`, sorted by spelling.
      options: [
        expect.objectContaining({ description: 'The command line to run.', key: 'argv', kind: 'string', option: 'argv', positional: 0, repeated: true, required: true }),
        expect.objectContaining({ description: 'Working directory of the command (default: the current directory).', key: 'cwd', kind: 'string', option: 'cwd', repeated: false, required: false }),
        expect.objectContaining({ description: 'Lane the work is queued under.', key: 'laneKey', kind: 'string', option: 'lane', repeated: false, required: false }),
        expect.objectContaining({ description: 'Tag attached to the request (repeatable; duplicates are dropped).', key: 'tags', kind: 'string', option: 'tag', repeated: true, required: false }),
      ],
      path: ['submit'],
      projection: { mapInput: true, module: 'src/mcp/harness/tools/submit.cli.tsx', relaxed: ['cwd'] },
      rendered: true,
      routeId: 'tool:harness/submit',
    });
    // One command per operation: the bulk `mcpCommands: true` projection
    // skips a tool that carries its own projection module.
    expect(manifest.cliCommands.map((candidate) => candidate.path.join(' '))).not.toContain('harness submit');
    // The projection module is never a route.
    expect(Object.keys(manifest.routes).filter((id) => id.includes('submit'))).toEqual(['tool:harness/submit']);
  });

  it('reaches the same operation with the same structured result from the projected grammar and the MCP surface', async () => {
    const input = { argv: ['cargo', 'check'], cwd, laneKey: 'x', tags: ['a'] };
    const cli = await invokeCli(['submit', '--lane', 'x', '--tag', 'a', '--tag', 'a', '--json', '--', 'cargo', 'check']);
    const mcp = await invokeMcpTool('submit', { input });

    expect(cli.exitCode).toBe(0);
    expect(cli.stderr).toBe('');
    expect(cli.command).toBe('submit');
    expect(cli.routeId).toBe('tool:harness/submit');
    expect(mcp.isError).toBe(false);
    expect(cliJson(cli)).toEqual({ argv: ['cargo', 'check'], cwd, laneKey: 'x', operation: 'submit', tags: ['a'] });
    expect(cliJson(cli)).toEqual(mcp.structuredContent);
    expect(cli.value).toEqual(mcp.structuredContent);
    // The MCP surface ran the same route as a tool; only the rendered surface
    // wording differs, never the value.
    expect(mcp.content).toEqual([
      { text: 'submit: cargo check', type: 'text' },
      { text: 'invocation: tool tool:harness/submit submit', type: 'text' },
      { text: providerLine('tool', 'tool:harness/submit'), type: 'text' },
    ]);
  });

  it('spells the canonical laneKey as --lane and accepts no other spelling', async () => {
    const run = await invokeCli(['submit', '--lane', 'x', '--json', '--', 'cargo', 'check']);
    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toMatchObject({ laneKey: 'x' });

    const canonical = await invokeCli(['submit', '--lane-key', 'x', '--', 'cargo', 'check']);
    expect(canonical.exitCode).toBe(2);
    expect(canonical.stdout).toBe('');
    expect(canonical.stderr).toBe(['Unknown option: --lane-key.', helpHint, ''].join('\n'));
  });

  it('collects a repeated --tag into the canonical tags array in argv order', async () => {
    const run = await invokeCli(['submit', '--tag', 'b', '--tag', 'a', '--json', '--', 'cargo', 'check']);

    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toMatchObject({ tags: ['b', 'a'] });
  });

  it('takes argv from the trailing positionals and passes everything after -- through untouched', async () => {
    const bare = await invokeCli(['submit', 'cargo', 'check', '--json']);
    expect(bare.exitCode).toBe(0);
    expect(cliJson(bare)).toMatchObject({ argv: ['cargo', 'check'] });

    const passthrough = await invokeCli(['submit', '--lane', 'x', '--json', '--', 'cargo', 'check', '-p', 'core', '--lane', 'literal']);
    expect(passthrough.exitCode).toBe(0);
    expect(cliJson(passthrough)).toMatchObject({ argv: ['cargo', 'check', '-p', 'core', '--lane', 'literal'], laneKey: 'x' });

    // Without the separator a single-dash token belongs to the shell, which
    // is why the projection documents `-- <argv...>`.
    const unknown = await invokeCli(['submit', 'cargo', 'check', '-p', 'core']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toBe(['Unknown option: -p.', helpHint, ''].join('\n'));

    const missing = await invokeCli(['submit', '--lane', 'x']);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe('');
    expect(missing.value).toBeUndefined();
    expect(missing.stderr).toBe(['Missing required argument: <argv...>.', helpHint, ''].join('\n'));
  });

  it('derives the relaxed cwd from the process through mapInput unless the CLI names one', async () => {
    const derived = await invokeCli(['submit', '--json', '--', 'cargo', 'check']);
    expect(derived.exitCode).toBe(0);
    expect(cliJson(derived)).toMatchObject({ cwd });

    const explicit = await invokeCli(['submit', '--cwd', '/tmp/elsewhere', '--json', '--', 'cargo', 'check']);
    expect(explicit.exitCode).toBe(0);
    expect(cliJson(explicit)).toMatchObject({ cwd: '/tmp/elsewhere' });
  });

  it('de-duplicates tags in mapInput before the canonical schema sees them', async () => {
    const run = await invokeCli(['submit', '--tag', 'a', '--tag', 'b', '--tag', 'a', '--json', '--', 'cargo', 'check']);

    expect(run.exitCode).toBe(0);
    expect(cliJson(run)).toMatchObject({ tags: ['a', 'b'] });
  });

  it('reports a thrown mapInput as an input failure: exit 2, nothing written to stdout, no value', async () => {
    const run = await invokeCli(['submit', '--tag', '!boom', '--', 'cargo', 'check']);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.value).toBeUndefined();
    expect(run.stderr).toBe(['Tag "!boom" must not start with "!".', helpHint, ''].join('\n'));

    const json = await invokeCli(['submit', '--tag', '!boom', '--json', '--', 'cargo', 'check']);
    expect(json.exitCode).toBe(2);
    expect(json.stdout).toBe('');
    expect(json.value).toBeUndefined();
  });

  it('validates the mapped input against the canonical schema and spells issues with the CLI spelling', async () => {
    const run = await invokeCli(['submit', '--lane', '', '--', 'cargo', 'check']);
    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe([
      'Invalid value for --lane: expected non-empty string; received "".',
      usage,
      helpHint,
      '',
    ].join('\n'));

    const json = await invokeCli(['submit', '--lane', '', '--json', '--', 'cargo', 'check']);
    expect(json.exitCode).toBe(2);
    expect(json.stdout).toBe('');
    expect(JSON.parse(json.stderr)).toEqual({
      error: {
        code: 'CLI_INPUT_INVALID',
        issues: [{ expected: 'non-empty string', message: expect.any(String), received: '', target: '--lane' }],
        usage,
      },
    });
  });

  it('runs without --yes because the projection sets confirm: false, and knows no --yes option', async () => {
    // The tool's `readOnlyHint: false` would make the bulk projection fail
    // closed; the projection's explicit `confirm: false` wins.
    const run = await invokeCli(['submit', '--', 'cargo', 'check']);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');

    const yes = await invokeCli(['submit', '--yes', '--', 'cargo', 'check']);
    expect(yes.exitCode).toBe(2);
    expect(yes.stderr).toBe(['Unknown option: --yes.', helpHint, ''].join('\n'));
  });

  it('prints help with the short path, the projected spellings, the tool provenance, and the projection module', async () => {
    const help = await invokeCli(['submit', '--help']);

    expect(help.exitCode).toBe(0);
    expect(help.command).toBeUndefined();
    expect(help.stdout).toContain(`${usage}\n`);
    expect(help.stdout).toContain('Submits one command line as lane work and echoes the accepted request.');
    expect(help.stdout).toContain('MCP tool: harness:submit');
    expect(help.stdout).toContain('Projection: src/mcp/harness/tools/submit.cli.tsx');
    expect(help.stdout).toMatch(/^ +<argv\.\.\.> +The command line to run\.$/mu);
    expect(help.stdout).toMatch(/^ +--cwd <string> +Working directory of the command \(default: the current directory\)\.$/mu);
    expect(help.stdout).toMatch(/^ +--lane <string> +Lane the work is queued under\.$/mu);
    expect(help.stdout).toMatch(/^ +--tag <string> \.\.\. +Tag attached to the request \(repeatable; duplicates are dropped\)\.$/mu);
    expect(help.stdout).not.toContain('(required)');
    expect(help.stdout).not.toContain('requires --yes');
    for (const absent of ['--lane-key', '--tags', '--input', '--yes', 'route-harness harness submit']) {
      expect(help.stdout).not.toContain(absent);
    }
  });

  it('runs the tool under the cli invocation kind with the tool id as operationId, as the route and its provider observe', async () => {
    const run = await invokeCli(['submit', '--', 'cargo', 'check']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe([
      'submit: cargo check',
      '',
      'invocation: cli tool:harness/submit submit',
      '',
      providerLine('cli', 'submit'),
      '',
    ].join('\n'));
  });
});
