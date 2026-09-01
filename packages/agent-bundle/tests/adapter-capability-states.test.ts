import { expect, it } from '@rstest/core';

import {
  capabilityBooleanView,
  capabilityEvidence,
  intersectCapabilityStates,
  supportedCapability,
} from '../src/adapters/capability-state.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import type { CapabilityEvidence, CapabilityState } from '../src/core/capabilities.ts';

const evidence = (target: string): CapabilityEvidence => Object.freeze({
  capabilityRevision: `${target}-capability-revision`,
  capabilitySha256: target.repeat(64).slice(0, 64),
  observedVersion: `${target}-version`,
  target,
});
const state = (value: CapabilityState): CapabilityState => Object.freeze(value);

it('keeps the plugin Boolean capability view as the Claude and Codex intersection', () => {
  const registry = createDefaultRegistry();

  for (const capability of ['marketplace', 'hooks', 'lsp', 'mcp', 'skills']) {
    expect(registry.supports('plugin', capability)).toBe(
      registry.supports('claude', capability) && registry.supports('codex', capability),
    );
  }
});

it('reports Claude LSP support and honest unavailable composite coverage', () => {
  const registry = createDefaultRegistry();

  expect(registry.get('claude').capabilities.lsp).toMatchObject({
    evidence: {
      observedVersion: '2.1.250',
      target: 'claude',
    },
    state: 'supported',
  });
  expect(registry.get('codex').capabilities.lsp).toMatchObject({
    reason: expect.stringContaining('no LSP server surface'),
    state: 'unavailable',
  });
  expect(registry.get('plugin').capabilities.lsp).toMatchObject({
    reason: expect.stringContaining('no LSP server surface'),
    state: 'unavailable',
  });
  expect(registry.supports('claude', 'lsp')).toBe(true);
  expect(registry.supports('codex', 'lsp')).toBe(false);
  expect(registry.supports('plugin', 'lsp')).toBe(false);
});

it('intersects supported composite capabilities and merges both evidence records', () => {
  const intersection = intersectCapabilityStates(
    supportedCapability(evidence('claude')),
    supportedCapability(evidence('codex')),
  );

  expect(intersection.state).toBe('supported');
  if (intersection.state !== 'supported') throw new Error('Expected a supported capability intersection.');
  expect(intersection.evidence).toMatchObject({
    capabilityRevision: 'claude@claude-capability-revision+codex@codex-capability-revision',
    observedVersion: 'claude@claude-version+codex@codex-version',
    target: 'claude+codex',
  });
  expect(intersection.evidence.capabilitySha256).toMatch(/^[0-9a-f]{64}$/);
});

it('applies prohibited, unavailable, degraded, and supported intersection precedence', () => {
  const supported = supportedCapability(evidence('supported'));
  const degraded = state({ state: 'degraded', reason: 'degraded host', evidence: evidence('degraded') });
  const unavailable = state({ state: 'unavailable', reason: 'unavailable host' });
  const prohibited = state({ state: 'prohibited', reason: 'prohibited host' });

  for (const other of [supported, degraded, unavailable]) {
    expect(intersectCapabilityStates(other, prohibited)).toEqual(prohibited);
    expect(intersectCapabilityStates(prohibited, other)).toEqual(prohibited);
  }
  for (const other of [supported, degraded]) {
    expect(intersectCapabilityStates(other, unavailable)).toEqual(unavailable);
    expect(intersectCapabilityStates(unavailable, other)).toEqual(unavailable);
  }
  expect(intersectCapabilityStates(supported, degraded)).toMatchObject({
    state: 'degraded',
    reason: 'degraded host',
  });
  expect(intersectCapabilityStates(degraded, supported)).toMatchObject({
    state: 'degraded',
    reason: 'degraded host',
  });
});

it('keeps the Boolean compatibility view thin and exhaustive', () => {
  expect(capabilityBooleanView({
    degraded: { state: 'degraded', reason: 'partial' },
    prohibited: { state: 'prohibited', reason: 'policy' },
    supported: supportedCapability(evidence('supported')),
    unavailable: { state: 'unavailable', reason: 'missing' },
  })).toEqual({
    degraded: false,
    prohibited: false,
    supported: true,
    unavailable: false,
  });
});

it('surfaces built-in adapter metadata as immutable capability evidence', () => {
  const registry = createDefaultRegistry();
  const cursor = registry.get('cursor');

  expect(cursor.capabilities.mcp).toEqual({
    evidence: capabilityEvidence('cursor', cursor.metadata),
    state: 'supported',
  });
  if (cursor.capabilities.mcp?.state !== 'supported') throw new Error('Expected Cursor MCP support evidence.');
  expect(cursor.capabilities.mcp.evidence).toEqual({
    capabilityRevision: '2026-08-28',
    capabilitySha256: '234920e63508664ae79db4e1a5422c1022d93ad572fae345a179bfd774f6f6d7',
    observedVersion: '2026-08-28',
    target: 'cursor',
  });
  expect(Object.isFrozen(cursor.capabilities.mcp.evidence)).toBe(true);
});
