import { expect, it } from '@rstest/core';

import { cliJson, invokeCli } from '../../../../src/test/cli.ts';
import { expectDocument } from '../../../../src/test/matchers.ts';
import { renderRoute } from '../../../../src/test/render.ts';
import { testManifest } from '../../../../src/test/registry.ts';

const expected = {
  name: 'meta-consumer',
  packageName: 'meta-consumer-fixture',
  packageVersion: '3.4.5',
  version: '3.4.5',
};

it('renderRoute reaches a route whose module imports agent-bundle/meta', async () => {
  const manifest = testManifest();
  const rendered = await renderRoute('tool:consumer/identity');

  expectDocument(rendered).toHaveStatus('success').toContainText('meta-consumer 3.4.5');
  expect(rendered.result).toEqual({ banner: 'meta-consumer 3.4.5', ...expected });
  // The identity the route observed is the one the compiler pass reported.
  expect(manifest.plugin).toEqual(expected);
});

it('invokeCli reaches a command whose module imports agent-bundle/meta', async () => {
  const run = await invokeCli(['version']);

  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe('');
  expect(cliJson(run)).toEqual(expected);
});
