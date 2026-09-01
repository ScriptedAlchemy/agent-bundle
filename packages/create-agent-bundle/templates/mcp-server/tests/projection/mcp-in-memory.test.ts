import { expect, it } from '@rstest/core';
import { invokeMcpTool, listMcpSurface, renderRoute } from 'agent-bundle/test';

/**
 * The mcp-in-memory proof level: the real generated MCP server — the same
 * registration and Agent Document projection a built artifact runs — driven by
 * a real MCP client over the SDK's in-memory transport pair. It proves the
 * protocol contract and only that: no process starts, no stdio framing is
 * exercised, and a pass here says nothing about the packed artifact.
 */
it('registers the compiled route on the generated status server', async () => {
  const surface = await listMcpSurface();

  expect(surface.tools).toEqual(['report-status']);
  expect(surface.provenance).toMatchObject({
    proofLevel: 'mcp-in-memory',
    routeIds: ['tool:status/report-status'],
    serverName: 'status',
  });
});

it('projects the rendered document into the protocol result the server returns', async () => {
  const invocation = await invokeMcpTool('report-status', { input: { service: 'docs' } });
  // The same input at the route-unit level, so the assertion below is parity
  // between the rendered document and what the protocol carried, not a second
  // hand-written copy of the expected value.
  const rendered = await renderRoute('tool:status/report-status', { input: { service: 'docs' } });

  expect(invocation.isError).toBe(false);
  expect(invocation.content).toEqual([{ text: 'docs is ready.', type: 'text' }]);
  expect(invocation.structuredContent).toEqual(rendered.document.value);
  expect(invocation.provenance.proofLevel).toBe('mcp-in-memory');
});
