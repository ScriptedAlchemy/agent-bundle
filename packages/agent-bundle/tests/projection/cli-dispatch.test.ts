import { describe, expect, it } from '@rstest/core';

import { cliJson, invokeCli } from '../../src/test/cli.ts';

/**
 * The `cli-dispatch` proof level: one argv vector run through the routed CLI's
 * own shell (#102 stage 2) over the compiled command graph, in this process.
 * No binary is spawned, so a green run here is not evidence that the packaged
 * executable starts — `packed-stdio` owns that.
 *
 * What this level does prove is that the product's dispatcher, argv
 * projection, and exit-code policy agree with the compiled commands: the
 * harness contributes only the `execute` bridge, and that mirrors the one the
 * generated executable inlines.
 */
describe('the CLI dispatch level', () => {
  it('resolves an argv vector to the compiled command and returns its canonical JSON line', async () => {
    const run = await invokeCli(['inventory', 'fiction', '--format', 'json']);

    expect(run.command).toBe('inventory');
    expect(run.routeId).toBe('cli:inventory');
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
    expect(cliJson(run)).toEqual({ format: 'json', shelf: 'fiction', titles: ['Piranesi', 'Solaris'] });
    expect(run.value).toEqual({ format: 'json', shelf: 'fiction', titles: ['Piranesi', 'Solaris'] });
    expect(run.provenance).toMatchObject({ commands: ['db migrate', 'inventory'], proofLevel: 'cli-dispatch' });
  });

  it('dispatches a nested command through its compiled path', async () => {
    const run = await invokeCli(['db', 'migrate']);

    expect(run.command).toBe('db migrate');
    expect(run.routeId).toBe('cli:db/migrate');
    expect(cliJson(run)).toEqual({ applied: 2, dryRun: false, exitCode: 0 });
  });

  it('maps the validated result exit code under the result policy', async () => {
    const run = await invokeCli(['db', 'migrate', '--dry-run']);

    expect(run.exitCode).toBe(3);
    expect(run.value).toEqual({ applied: 0, dryRun: true, exitCode: 3 });
  });

  it('projects a schema default and a positional key from the argv the compiler derived', async () => {
    const run = await invokeCli(['inv', 'history', '--limit', '1']);

    expect(run.command).toBe('inventory');
    expect(cliJson(run)).toEqual({ format: 'text', shelf: 'history', titles: ['SPQR'] });
  });

  it('reports a missing required positional as a usage failure without executing the command', async () => {
    const run = await invokeCli(['inventory']);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain("--help' for usage.");
    expect(run.value).toBeUndefined();
  });

  it('reports an unknown command as a usage failure that names the argv', async () => {
    const run = await invokeCli(['nope']);

    expect(run.exitCode).toBe(2);
    expect(run.command).toBeUndefined();
    expect(run.stderr).toContain('Unknown command: nope.');
  });

  it('answers help and version from the generated shell rather than a command', async () => {
    const [help, version] = await Promise.all([invokeCli(['--help']), invokeCli(['--version'])]);

    expect(help.exitCode).toBe(0);
    expect(help.command).toBeUndefined();
    expect(help.stdout).toContain('inventory');
    expect(help.stdout).toContain('db');
    expect(version.stdout.trim()).toBe('route-harness 1.0.0');
  });

  it('runs the command inside a cli request scope', async () => {
    const progress: { readonly completed?: number; readonly message?: string }[] = [];
    const run = await invokeCli(['inventory', 'fiction'], {
      context: { progress: { report: async (update) => void progress.push(update) } },
    });

    expect(run.exitCode).toBe(0);
    expect(progress.map((update) => update.message)).toEqual(['reading inventory', 'inventory ready']);
  });
});
