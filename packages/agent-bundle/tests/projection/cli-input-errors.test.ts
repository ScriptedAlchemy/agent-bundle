import { describe, expect, it } from '@rstest/core';

import { cliNdjson, invokeCli } from '../../src/test/cli.ts';

/**
 * Issue #465 at the `cli-dispatch` proof level: a route module's `inputSchema`
 * rejection must reach the operator as plain language that names the argument
 * they typed, never as the raw zod issue JSON. The `--json` and `--ndjson`
 * modes stay machine-only and carry the same issues as one structured error.
 */
describe('input-validation failures through the routed CLI shell (#465)', () => {
  it('names the flag, the expectation, and the received value, then the exact usage line', async () => {
    const run = await invokeCli(['inventory', 'fiction', '--limit', '9']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.value).toBeUndefined();
    expect(run.stderr).toBe([
      'Invalid value for --limit: expected number <= 8; received 9.',
      'Usage: route-harness inventory [options] <shelf>',
      "Run 'route-harness inventory --help' for usage.",
      '',
    ].join('\n'));
    expect(run.stderr).not.toContain('"code"');
    expect(run.stderr).not.toContain('too_big');
  });

  it('spells a positional as <name> and lists several issues one per line', async () => {
    const run = await invokeCli(['inventory', '', '--limit', '0']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr.split('\n')).toEqual([
      'Invalid value for --limit: expected number >= 1; received 0.',
      'Invalid value for <shelf>: expected non-empty string; received "".',
      'Usage: route-harness inventory [options] <shelf>',
      "Run 'route-harness inventory --help' for usage.",
      '',
    ]);
  });

  it('spells a projected MCP command input path as --input.<path> through the rendered path', async () => {
    const run = await invokeCli(['harness', 'echo', '--input', '{"message":42}']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe([
      'Invalid value for --input.message: expected string; received 42.',
      'Usage: route-harness harness echo [options]',
      "Run 'route-harness harness echo --help' for usage.",
      '',
    ].join('\n'));
  });

  it('keeps stdout empty under --json and writes one canonical error object to stderr', async () => {
    const run = await invokeCli(['inventory', 'fiction', '--limit', '9', '--json']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(run.stderr)).toEqual({
      error: {
        code: 'CLI_INPUT_INVALID',
        issues: [{
          expected: 'number <= 8',
          message: expect.stringContaining('8'),
          received: 9,
          target: '--limit',
        }],
        usage: 'Usage: route-harness inventory [options] <shelf>',
      },
    });
  });

  it('keeps the --ndjson stream machine-only with one canonical error event', async () => {
    const run = await invokeCli(['harness', 'echo', '--input', '{"message":42}', '--ndjson']);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toBe('');
    const events = cliNdjson(run);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      error: {
        code: 'CLI_INPUT_INVALID',
        issues: [{
          expected: 'string',
          message: expect.any(String),
          received: 42,
          target: '--input.message',
        }],
        message: 'Invalid value for --input.message: expected string; received 42.',
        usage: 'Usage: route-harness harness echo [options]',
      },
      sequence: 0,
      type: 'error',
    });
  });
});
