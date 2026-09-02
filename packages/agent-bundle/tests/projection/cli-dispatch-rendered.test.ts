import { describe, expect, it } from '@rstest/core';

import { cliJson, cliNdjson, invokeCli } from '../../src/test/index.ts';

describe('rendered commands at the CLI dispatch level', () => {
  it('projects a rendered command to final Markdown when stdout is piped', async () => {
    const run = await invokeCli(['report', 'books']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('# Report: books\n\nGenerated for books.\n\nitems: 2\n');
    expect(run.stdout).not.toContain('preparing report');
    expect(run.value).toEqual({ count: 2, stateMounted: true, status: 'ready', topic: 'books' });
    expect(run.provenance.proofLevel).toBe('cli-dispatch');
  });

  it('updates rendered progress in place for an explicit TTY', async () => {
    const run = await invokeCli(['report', 'books'], { tty: true });

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('\r\u001B[2Kpreparing report (1/2)');
    expect(run.stdout).toContain('\r\u001B[2Kreport ready (2/2)');
    expect(run.stdout.endsWith('# Report: books\n\nGenerated for books.\n\nitems: 2\n')).toBe(true);
  });

  it('projects a rendered command to one canonical JSON line', async () => {
    const run = await invokeCli(['report', 'books', '--json']);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('{"count":2,"stateMounted":true,"status":"ready","topic":"books"}\n');
    expect(cliJson(run)).toEqual({ count: 2, stateMounted: true, status: 'ready', topic: 'books' });
  });

  it('returns the pure sequence-numbered CLI event stream as NDJSON', async () => {
    const run = await invokeCli(['report', 'books', '--ndjson']);
    const events = cliNdjson(run);
    const sequences = events.map((event) => event.sequence);

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
    expect(events.some((event) => event.type === 'progress')).toBe(true);
    expect(events.at(-1)).toMatchObject({
      document: {
        status: 'success',
        value: { count: 2, stateMounted: true, status: 'ready', topic: 'books' },
      },
      type: 'complete',
    });
    expect(JSON.stringify(events)).not.toContain('"jsonrpc"');
    expect(run.stdout.trim().split('\n')).toHaveLength(events.length);
  });

  it('reports cancellation through the shell after rendered progress begins', async () => {
    const controller = new AbortController();
    const run = await invokeCli(['report', 'books', '--mode', 'wait-for-abort'], {
      context: {
        progress: {
          report: async () => controller.abort(),
        },
      },
      signal: controller.signal,
    });

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Aborted.');
  });

  it('reports a component render error on stderr', async () => {
    const run = await invokeCli(['report', 'books', '--mode', 'render-error']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('report render exploded\n');
  });

  it("reports a rendered resultSchema rejection on stderr", async () => {
    const run = await invokeCli(['report', 'books', '--mode', 'invalid-result']);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('expected number');
  });

  it('maps a rendered inputSchema rejection to a usage failure', async () => {
    const run = await invokeCli(['report', '']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain("--help' for usage.");
  });

  it('rejects rendered-only and conflicting output flags at the shell boundary', async () => {
    const [plainNdjson, conflicting] = await Promise.all([
      invokeCli(['inventory', 'fiction', '--ndjson']),
      invokeCli(['report', 'books', '--json', '--ndjson']),
    ]);

    expect(plainNdjson.exitCode).toBe(2);
    expect(plainNdjson.stdout).toBe('');
    expect(plainNdjson.stderr).toContain('--ndjson requires a rendered command.');
    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.stdout).toBe('');
    expect(conflicting.stderr).toContain('Use either --json or --ndjson, not both.');
  });

  it('rejects Markdown as canonical JSON or NDJSON with honest diagnostics', async () => {
    const run = await invokeCli(['report', 'books']);

    expect(() => cliJson(run)).toThrow('did not write one canonical JSON line');
    expect(() => cliNdjson(run)).toThrow('did not write one JSON object per line');
  });
});
