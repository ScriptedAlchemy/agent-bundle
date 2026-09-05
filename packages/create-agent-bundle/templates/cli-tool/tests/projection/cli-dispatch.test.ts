import { expect, it } from '@rstest/core';
import { cliJson, invokeCli, testManifest } from 'agent-bundle/test';

/**
 * The cli-dispatch proof level: argv resolved and executed through the routed
 * CLI's own shell — command resolution, the compiled argv grammar, generated
 * help, input validation, and exit-code mapping are the product's — in this
 * process. Nothing is bundled or spawned; the generated
 * `dist/bin/my-agent-plugin.mjs` executable is proven by `npm run build`.
 */
it('compiles the greet command without a build', () => {
  const manifest = testManifest();

  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(manifest.cliCommands.map((command) => command.path.join(' '))).toEqual(['greet']);
  expect(manifest.cliCommands[0]?.options.map((option) => option.option)).toEqual(['name', 'shout']);
});

it('greets through the routed CLI shell and prints one canonical JSON line', async () => {
  const run = await invokeCli(['greet', 'World']);

  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe('');
  expect(cliJson(run)).toEqual({ message: 'Hello, World!', name: 'World' });
  expect(run.provenance.proofLevel).toBe('cli-dispatch');
});

it('applies boolean flags from the compiled argv grammar', async () => {
  const run = await invokeCli(['greet', 'World', '--shout']);

  expect(run.exitCode).toBe(0);
  expect(cliJson(run)).toEqual({ message: 'HELLO, WORLD!', name: 'World' });
});

it('maps a missing name to a usage failure with generated help', async () => {
  const run = await invokeCli(['greet']);

  expect(run.exitCode).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr).toContain('Missing required argument: <name>.');
  expect(run.stderr).toContain("Run 'my-agent-plugin greet --help' for usage.");
});

it('documents the command from its schema', async () => {
  const run = await invokeCli(['greet', '--help']);

  expect(run.exitCode).toBe(0);
  expect(run.stdout).toContain('Usage: my-agent-plugin greet [options] <name>');
  expect(run.stdout).toContain('Upper-case the greeting.');
});
