import { describe, expect, it } from '@rstest/core';

import { runtimeIgnoredRoot } from '../src/build/runtime-path.ts';

describe('runtime ignored root', () => {
  it('anchors a source runtime to its package when the checkout is under dist', () => {
    expect(runtimeIgnoredRoot('/tmp/dist/checkout/packages/agent-bundle/src/cli-entry.ts'))
      .toBe('/tmp/dist/checkout/packages/agent-bundle');
  });

  it('resolves the normal source layout', () => {
    expect(runtimeIgnoredRoot('/work/agent-bundle/src/cli-entry.ts'))
      .toBe('/work/agent-bundle');
  });

  it('resolves the normal installed distribution layout', () => {
    expect(runtimeIgnoredRoot('/x/node_modules/agent-bundle/dist/cli-entry.js'))
      .toBe('/x/node_modules/agent-bundle');
  });

  it('uses the runtime file parent when an earlier dist segment is present', () => {
    expect(runtimeIgnoredRoot('/var/cache/dist/project/src/cli-entry.ts'))
      .toBe('/var/cache/dist/project');
  });
});
