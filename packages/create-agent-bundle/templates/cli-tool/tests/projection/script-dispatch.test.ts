import { expect, it } from '@rstest/core';
import { runScript, testManifest } from 'agent-bundle/test';

/**
 * The script-dispatch proof level: the conventional `src/scripts/hello.ts`
 * module run through the contract its generated `scripts/hello.mjs` carries —
 * `main(argv)` awaited, a numeric return adopted as the exit code, stdout and
 * stderr captured — as a Node process of its own over the source, with fresh
 * module state. The bundled artifact script itself is proven by
 * `npm run build`.
 */
it('compiles the hello script as a plain executable module', () => {
  expect(testManifest().scripts).toMatchObject([{ name: 'hello', rendered: false }]);
});

it('greets through the main process envelope', async () => {
  const run = await runScript('hello', ['World']);

  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('Hello, World!\n');
  expect(run.stderr).toBe('');
  expect(run.provenance).toMatchObject({ execution: 'main-envelope', proofLevel: 'script-dispatch' });
});

it('exits 2 with usage on stderr without a name', async () => {
  const run = await runScript('hello');

  expect(run.exitCode).toBe(2);
  expect(run.stdout).toBe('');
  expect(run.stderr).toBe('Usage: hello <name>\n');
});
