import { expect, it } from '@rstest/core';

import type { HostDiscoveryReport } from '../src/discovery/discovery-client.ts';
import {
  findingPresentationFor,
  inventoryPresentationFor,
  isStaleReport,
  mcpProbePresentationFor,
  mcpProbeViewFor,
  probePresentationFor,
} from '../src/discovery/discovery-model.ts';

const report = (manifestDigest?: string): HostDiscoveryReport => ({
  diagnostics: [],
  endpoints: {
    diagnostics: [],
    directory: '/tmp/agent-bundle',
    findings: [],
    status: 'healthy',
    summary: { live: 0, staleLocks: 0, staleSockets: 0 },
  },
  generatedAt: '2026-09-01T12:00:00.000Z',
  hosts: [],
  ...(manifestDigest === undefined ? {} : { manifestDigest }),
  summary: { errors: 0, infos: 0, warnings: 0 },
});

it('presents an unavailable host probe as honestly neutral', () => {
  expect(probePresentationFor({ status: 'unavailable' })).toEqual({
    label: 'Not installed',
    tone: 'neutral',
  });
  expect(probePresentationFor({ status: 'unavailable' }).tone).not.toBe('error');
});

it('explains unknown host-owned inventory without implying failure', () => {
  expect(inventoryPresentationFor('codex', 'unknown')).toEqual({
    label: 'Unknown — codex owns its registry',
    tone: 'neutral',
  });
});

it('marks a report stale only when both manifest digests are present and differ', () => {
  expect(isStaleReport('digest-a', report('digest-a'))).toBe(false);
  expect(isStaleReport('digest-a', report('digest-b'))).toBe(true);
  expect(isStaleReport(undefined, report('digest-b'))).toBe(false);
  expect(isStaleReport('digest-a', report())).toBe(false);
});

it('maps risky and healthy finding states to honest tones', () => {
  expect(findingPresentationFor('drifted').tone).toBe('warning');
  expect(findingPresentationFor('failed').tone).toBe('error');
  expect(findingPresentationFor('installed').tone).toBe('neutral');
});

it('presents successful and down MCP probe statuses honestly', () => {
  expect(mcpProbePresentationFor('ok')).toEqual({
    label: 'Connected',
    tone: 'positive',
  });
  expect(mcpProbePresentationFor('unreachable')).toEqual({
    label: 'Unreachable',
    tone: 'neutral',
  });
  expect(mcpProbePresentationFor('timed-out')).toEqual({
    label: 'Timed out',
    tone: 'neutral',
  });
});

it('derives a frozen MCP probe view with capability names', () => {
  const report = {
    durationMs: 42,
    generatedAt: '2026-09-01T12:01:00.000Z',
    host: 'claude' as const,
    launch: {
      args: ['dist/timeline.js'],
      command: 'node',
      env: {},
      kind: 'stdio' as const,
    },
    serverName: 'timeline',
    snapshot: {
      capabilities: { prompts: false, tools: true },
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'timeline-server', version: '1.0.0' },
      tools: [],
      toolsTruncated: false,
    },
    status: 'ok' as const,
  };

  const view = mcpProbeViewFor(report);

  expect(view.presentation).toEqual({ label: 'Connected', tone: 'positive' });
  expect(view.capabilityNames).toEqual(['prompts', 'tools']);
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.capabilityNames)).toBe(true);
});
