import { describe, expect, it } from '@rstest/core';

import type { NormalizedMcpServer } from '../src/core/types.ts';
import { eventRuntimeHosting, runtimeIgnoredRoot, selectedServerHosts } from '../src/build/entries.ts';

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

describe('selected server hosts', () => {
  // The selected hosts whose MCP documents list the server — the hosts that
  // can launch it. The entry bakes this set so a process one host can have
  // spawned assumes that host for lineage when the client does not name itself.
  const server = { targets: ['claude', 'cursor'] } as unknown as NormalizedMcpServer;

  it('keeps only the selected hosts the server targets, in selection order', () => {
    expect(selectedServerHosts(server, ['claude', 'codex', 'cursor', 'portable'])).toEqual(['claude', 'cursor']);
    expect(selectedServerHosts(server, ['cursor', 'claude'])).toEqual(['cursor', 'claude']);
  });

  it('yields no host when the server targets none of the selection', () => {
    expect(selectedServerHosts(server, ['codex'])).toEqual([]);
  });
});

describe('event runtime hosting', () => {
  // Each selected host reaches the composite root's shared event runtime
  // through the first generated-route server its MCP document lists (#555);
  // every hosting server accepts every host that reaches the runtime through
  // a hosting server, because the endpoint is the artifact's alone (#592).
  const generated = (id: string, targets: readonly string[]): NormalizedMcpServer =>
    ({ generatedRoutes: {}, id, source: `src/mcp/${id}.ts`, targets }) as unknown as NormalizedMcpServer;
  const plain = (id: string, targets: readonly string[]): NormalizedMcpServer =>
    ({ id, source: `src/mcp/${id}.ts`, targets }) as unknown as NormalizedMcpServer;

  it('hosts the runtime in the first generated server every selected host lists', () => {
    const hosting = eventRuntimeHosting([plain('bare', ['claude', 'codex']), generated('a', ['claude', 'codex'])], ['codex', 'claude']);
    expect(hosting.allowedTargets).toEqual(['codex', 'claude']);
    expect([...hosting.serverIds]).toEqual(['a']);
  });

  it('hosts the runtime in each server when the selected hosts list different generated servers', () => {
    // Claude's document lists only `a`, Codex's only `b`: before the roots
    // merged each per-host artifact hosted the runtime in its own server, and
    // the composite root keeps both so neither host's wrappers go unanswered.
    const hosting = eventRuntimeHosting([generated('a', ['claude']), generated('b', ['codex'])], ['claude', 'codex']);
    expect(hosting.allowedTargets).toEqual(['claude', 'codex']);
    expect([...hosting.serverIds].sort()).toEqual(['a', 'b']);
  });

  it('takes the first listed server for a host that lists several', () => {
    const hosting = eventRuntimeHosting([generated('a', ['claude']), generated('b', ['claude', 'codex'])], ['claude', 'codex']);
    expect(hosting.allowedTargets).toEqual(['claude', 'codex']);
    expect([...hosting.serverIds].sort()).toEqual(['a', 'b']);
  });

  it('leaves a host that lists no generated server out of the allowed set', () => {
    const hosting = eventRuntimeHosting([generated('a', ['claude'])], ['claude', 'cursor']);
    expect(hosting.allowedTargets).toEqual(['claude']);
    expect([...hosting.serverIds]).toEqual(['a']);
  });

  it('hosts nothing when no selected host lists a generated server', () => {
    const hosting = eventRuntimeHosting([plain('bare', ['claude']), generated('a', ['codex'])], ['claude']);
    expect(hosting.allowedTargets).toEqual([]);
    expect(hosting.serverIds.size).toBe(0);
  });
});
