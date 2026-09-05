import { describe, expect, it } from '@rstest/core';

import { planHooks } from '../src/adapters/hook-contract.ts';
import { eventRuntimeHosting, planCompiledHooks, planHooksSurface, selectedServerHosts } from '../src/build/entries.ts';
import { runtimeIgnoredRoot } from '../src/build/runtime-path.ts';
import type { NormalizedHook, NormalizedMcpServer, NormalizedPlugin } from '../src/core/types.ts';
import type { CompiledEventPreflight } from '../src/routes/types.ts';

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

describe('event-route preflight source graph (#595)', () => {
  const preflight: CompiledEventPreflight = Object.freeze({
    provenance: Object.freeze({ kind: 'conventional' as const, relativePath: 'src/events/tool/before.preflight.ts' }),
    source: '/project/src/events/tool/before.preflight.ts',
  });
  const hook: NormalizedHook = {
    event: 'beforeTool',
    eventRoute: { event: 'tool/before', fallback: 'none', preflight, runtime: 'shared' },
    id: 'hook:event-route:tool-before',
    name: 'event-route-tool-before',
    provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/before.tsx' },
    source: '/project/src/events/tool/before.tsx',
    targets: ['claude'],
    tools: [],
  };
  const model: NormalizedPlugin = {
    extensions: {},
    hooks: [hook],
    mcpServers: [],
    metadata: {
      id: 'plugin:preflight-entries',
      name: 'preflight-entries',
      provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
      version: '1.0.0',
    },
    runtime: { node: '22.12.0' },
    scripts: [],
    skills: [],
    targets: [{
      id: 'target:claude',
      name: 'claude',
      provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
    }],
  };
  const planned = planHooks(model, 'claude', {
    commandRoot: '${CLAUDE_PLUGIN_ROOT}',
    encodePlaygroundInput: (input) => input,
    encodePlaygroundOutput: (result) => result,
    eventNames: {},
    eventRouteNames: { 'tool/before': 'PreToolUse' },
    hostContractRevision: '2026-09-02',
    manifestPath: 'hooks/hooks.json',
    matchers: {},
    wrapperPath: (candidate) => `hooks/${candidate.name}.claude.mjs`,
    wrapperSource: () => 'config-hook-only\n',
  }).hookEntries;

  it('names the preflight leaf among the wrapper source inputs and keeps the rendered route as the entry source', () => {
    const compiled = planCompiledHooks(planned, { outDir: '/tmp/artifact' });
    expect(compiled).toHaveLength(1);
    expect(compiled[0]!.source).toBe(hook.source);
    expect(compiled[0]!.sourceInputs).toEqual([
      hook.provenance.sourcePath,
      hook.source,
      preflight.source,
    ]);
    expect(compiled[0]!.target).toBe('claude');
    expect(compiled[0]!.output).toBe('/tmp/artifact/hooks/event-route-tool-before.claude.mjs');
  });

  it('aliases the cheap event runtimes onto the per-host wrapper and applies the operator env layer', () => {
    const surface = planHooksSurface(planned, {
      artifactEpoch: 'preflight-entries@1.0.0',
      outDir: '/tmp/artifact',
      plugin: { name: 'preflight-entries', version: '1.0.0' },
    });
    expect(surface.entries).toHaveLength(2);
    const entry = surface.entries[0]!;
    expect(entry.outputRelativePath).toBe('hooks/event-route-tool-before.claude.mjs');
    expect(entry.aliases).toMatchObject({
      'agent-bundle/event-ipc': expect.any(String),
      'agent-bundle/event-project': expect.any(String),
    });
    expect(entry.virtualSource).toContain('executeEventPreflight');
    expect(entry.virtualSource).toContain(preflight.source);
    expect(entry.virtualSource).not.toContain('__AGENT_BUNDLE_EVENT_ARTIFACT_EPOCH__');
    expect(entry.virtualModules).toBeDefined();
    expect(entry.rscManifest).toBeUndefined();
    const executor = surface.entries[1]!;
    expect(executor.outputRelativePath).toBe('hooks/event-route-tool-before.claude.execute.mjs');
    expect(executor.virtualSource).toContain('requestEventRuntime');
    expect(executor.virtualSource).toContain('preflight-entries@1.0.0');
  });
});
