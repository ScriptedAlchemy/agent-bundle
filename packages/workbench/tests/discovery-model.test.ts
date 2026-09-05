import { expect, it } from '@rstest/core';

import type { HostDiscoveryReport } from '../src/discovery/discovery-client.ts';
import {
  hostDiagnosticsViewFor,
  hostLabelFor,
  isStaleReport,
  mcpProbePresentationFor,
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
  hosts: [{
    diagnostics: [{
      code: 'host.plugin.stale',
      message: 'The installed plugin is older than the published build.',
      recovery: 'Reinstall the development plugin from this Workbench.',
      severity: 'warning',
      target: 'codex',
    }],
    host: 'codex',
    inventory: { findings: [], status: 'unknown' },
    probe: { status: 'available', version: '0.4.0' },
    bundle: {
      bundleRoot: '/home/user/.codex/plugins/agent-bundle',
      mcpServers: [{ name: 'timeline', transport: 'stdio' }],
      name: 'agent-bundle',
      state: 'drifted',
      version: '1.2.2',
    },
  }, {
    diagnostics: [],
    host: 'claude',
    inventory: {
      findings: [{
        name: 'claude',
        path: '/usr/local/bin/claude',
        state: 'installed',
        version: '2.1.0',
      }],
      status: 'known',
    },
    probe: { status: 'unavailable' },
  }, {
    diagnostics: [],
    host: 'cursor',
    inventory: { findings: [], status: 'skipped' },
    probe: { evidence: 'directory', status: 'available' },
  }],
  ...(manifestDigest === undefined ? {} : { manifestDigest }),
  summary: { errors: 0, infos: 0, warnings: 1 },
});

it('presents an unavailable host probe as not installed', () => {
  expect(probePresentationFor({ status: 'unavailable' })).toEqual({
    label: 'Not installed',
    tone: 'neutral',
  });
  expect(probePresentationFor({ status: 'available' })).toEqual({
    label: 'Installed',
    tone: 'positive',
  });
});

it('labels hosts for the Host diagnostics cards', () => {
  expect(hostLabelFor('claude')).toBe('Claude Code');
  expect(hostLabelFor('codex')).toBe('Codex');
  expect(hostLabelFor('cursor')).toBe('Cursor');
});

it('marks a report stale only when both manifest digests are present and differ', () => {
  expect(isStaleReport('digest-a', report('digest-a'))).toBe(false);
  expect(isStaleReport('digest-a', report('digest-b'))).toBe(true);
  expect(isStaleReport(undefined, report('digest-b'))).toBe(false);
  expect(isStaleReport('digest-a', report())).toBe(false);
});

it('presents successful and down MCP handshake statuses honestly', () => {
  expect(mcpProbePresentationFor('ok')).toEqual({
    label: 'Handshake ok',
    tone: 'positive',
  });
  expect(mcpProbePresentationFor('unreachable')).toEqual({
    label: 'Handshake unreachable',
    tone: 'neutral',
  });
  expect(mcpProbePresentationFor('timed-out')).toEqual({
    label: 'Handshake timed out',
    tone: 'neutral',
  });
});

it('projects one diagnostics card per host without inventory or launch dumps', () => {
  const view = hostDiagnosticsViewFor(report('manifest-a'));
  const codex = view.hosts.find((host) => host.host === 'codex');
  const claude = view.hosts.find((host) => host.host === 'claude');

  expect(codex).toMatchObject({
    installed: true,
    label: 'Codex',
    version: '0.4.0',
    executablePath: '/home/user/.codex/plugins/agent-bundle',
    handshakeServer: 'timeline',
    attach: { state: 'stale', epochId: '1.2.2' },
  });
  expect(codex?.errors).toHaveLength(1);
  expect(claude).toMatchObject({
    installed: false,
    label: 'Claude Code',
    version: '2.1.0',
    executablePath: '/usr/local/bin/claude',
    attach: { state: 'detached' },
  });
  expect(claude?.handshakeServer).toBeUndefined();
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.hosts)).toBe(true);
});
