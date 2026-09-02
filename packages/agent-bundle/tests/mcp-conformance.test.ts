import { expect, it } from '@rstest/core';

import { runMcpConformance } from './support/mcp-conformance.ts';

const enabled = process.env['AGENT_BUNDLE_MCP_CONFORMANCE'] === '1';

it.skipIf(!enabled)(
  'passes the official active MCP server conformance suite against a generated route server',
  async () => {
    const report = await runMcpConformance();

    expect(report.runnerVersion).toBe('0.1.16');
    expect(report.specVersion).toBe('2025-11-25');
    expect(report.failed).toBe(report.expectedFailures.length);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.skipped).toBe(0);
  },
  180_000,
);
