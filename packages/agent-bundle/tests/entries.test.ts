import { describe, expect, it } from '@rstest/core';

import type { NormalizedMcpServer } from '../src/core/types.ts';
import { eventAllowedTargets, runtimeIgnoredRoot } from '../src/build/entries.ts';

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

describe('event allowed targets', () => {
  // The server's own target set bounds which selected hosts may deliver events
  // to it in a composite root (#555); the build bakes this set into the entry
  // and `inspect --bundler` describes the same one.
  const server = { targets: ['claude', 'cursor'] } as unknown as NormalizedMcpServer;

  it('keeps only the selected hosts the server targets, in selection order', () => {
    expect(eventAllowedTargets(server, ['claude', 'codex', 'cursor', 'portable'])).toEqual(['claude', 'cursor']);
    expect(eventAllowedTargets(server, ['cursor', 'claude'])).toEqual(['cursor', 'claude']);
  });

  it('yields no host when the server targets none of the selection', () => {
    expect(eventAllowedTargets(server, ['codex'])).toEqual([]);
  });
});
