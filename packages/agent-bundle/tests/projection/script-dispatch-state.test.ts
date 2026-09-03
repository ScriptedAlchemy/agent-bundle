import { createRequire } from 'node:module';

import { expect, it } from '@rstest/core';

import { runScript, scriptJson } from '../../src/test/index.ts';

/**
 * The generated rendered-script executable validates argv in its shell before
 * it starts the render worker; only the worker loads the renderer (React, the
 * runtime, the Flight server) and the project's state module, and opens its
 * driver. The harness keeps that order: this file runs in a worker of its own
 * so neither React nor the fixture's state module has been evaluated when the
 * first run rejects, and the fixture's evaluation counter plus the CommonJS
 * module cache prove both stay that way until a run the shell accepts.
 */
const stateLoads = (): number => (globalThis as { routeHarnessStateLoads?: number }).routeHarnessStateLoads ?? 0;

const reactLoaded = (): boolean => Object.keys(createRequire(import.meta.url).cache)
  .some((filename) => /[\\/]node_modules[\\/]react[\\/]/u.test(filename));

it('loads no renderer and mounts no state for a rendered run the shell rejects, then both once the shell accepts', async () => {
  expect(stateLoads()).toBe(0);
  expect(reactLoaded()).toBe(false);

  const rejected = await runScript('summary', ['--json', '--ndjson']);
  expect(rejected.exitCode).toBe(2);
  expect(rejected.stderr).toBe('Use either --json or --ndjson, not both.\n');
  expect(stateLoads()).toBe(0);
  expect(reactLoaded()).toBe(false);

  const accepted = await runScript('summary', ['--json', 'after-reject']);
  expect(accepted.exitCode).toBe(0);
  expect(scriptJson(accepted)).toMatchObject({ arguments: ['after-reject'], stateMounted: true });
  expect(stateLoads()).toBe(1);
  expect(reactLoaded()).toBe(true);
});
