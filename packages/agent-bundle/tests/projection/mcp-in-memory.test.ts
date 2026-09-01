import { describe, expect, it } from '@rstest/core';

import { AgentTestError } from '../../src/test/errors.ts';
import {
  getMcpPrompt,
  invokeMcpTool,
  listMcpSurface,
  openInMemoryMcpServer,
  readMcpResource,
} from '../../src/test/mcp.ts';

/**
 * The `mcp-in-memory` proof level: the real generated MCP server, registered
 * by the same `mcp-server-runtime` module a built artifact runs, driven by a
 * real MCP SDK client over the SDK's in-memory transport pair.
 *
 * What a green run here does NOT prove: that a process starts, that stdio
 * framing is clean, or that a packed tarball contains the entry. Those are
 * the `packed-stdio` level's claims (packed-stdio-projection.test.ts).
 */
describe('the in-memory MCP projection level', () => {
  it('registers every compiled route kind on the real generated server', async () => {
    const surface = await listMcpSurface();

    expect(surface.tools).toEqual(['catalog', 'echo', 'unavailable']);
    expect(surface.prompts).toEqual(['summarize']);
    expect(surface.resources).toEqual(['harness://notes']);
    expect(surface.provenance).toMatchObject({
      proofLevel: 'mcp-in-memory',
      routeIds: [
        'prompt:harness/summarize',
        'resource:harness/notes',
        'tool:harness/catalog',
        'tool:harness/echo',
        'tool:harness/unavailable',
      ],
      serverName: 'harness',
    });
  });

  it('projects a rendered Agent Document into the protocol content the server returns', async () => {
    const invocation = await invokeMcpTool('echo', {
      context: { workspace: { source: 'native', state: 'available', value: { root: '/tmp/harness-library' } } as never },
      input: { message: 'two files ready' },
    });

    expect(invocation.isError).toBe(false);
    expect(invocation.content).toEqual([
      { text: '# Echo\n\ntwo files ready', type: 'text' },
      { text: 'workspace: /tmp/harness-library', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({
      message: 'two files ready',
      operationId: 'tool:harness/echo',
      workspace: '/tmp/harness-library',
    });
    expect(invocation.provenance.proofLevel).toBe('mcp-in-memory');
  });

  it('carries a represented error to the protocol as isError rather than a transport failure', async () => {
    const invocation = await invokeMcpTool('unavailable');

    expect(invocation.isError).toBe(true);
    expect(invocation.content).toContainEqual(expect.objectContaining({ type: 'text' }));
    expect(invocation.structuredContent).toEqual({ available: false });
  });

  it('resolves a suspended boundary before the server projects the result', async () => {
    const invocation = await invokeMcpTool('catalog', { input: { genre: 'mystery' } });

    expect(invocation.content).toEqual([
      { text: 'catalog: mystery', type: 'text' },
      { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
    ]);
    expect(invocation.structuredContent).toEqual({ genre: 'mystery', titles: ['Piranesi', 'Solaris'] });
  });

  it('reads a compiled resource route by its configured URI', async () => {
    const read = await readMcpResource('harness://notes');

    expect(read.contents).toEqual([
      { mimeType: 'text/markdown', text: '# Notes for harness://notes', uri: 'harness://notes' },
    ]);
    expect(read.provenance.proofLevel).toBe('mcp-in-memory');
  });

  it('gets a compiled prompt route with the arguments the client sent', async () => {
    const prompt = await getMcpPrompt('summarize', { input: { note: 'chapter one' } });

    expect(prompt.messages).toEqual([
      { content: { text: 'Summarize chapter one', type: 'text' }, role: 'user' },
    ]);
  });

  it('reuses one connected session for every call a suite makes', async () => {
    await using session = await openInMemoryMcpServer();

    const [first, second] = await Promise.all([
      session.client.callTool({ arguments: { message: 'first' }, name: 'echo' }),
      session.client.callTool({ arguments: { message: 'second' }, name: 'echo' }),
    ]);

    expect(first).toMatchObject({ structuredContent: { message: 'first' } });
    expect(second).toMatchObject({ structuredContent: { message: 'second' } });
  });

  it('leaves the browser App surface off the in-memory server', async () => {
    const surface = await listMcpSurface();

    expect(surface.resources).not.toContain('ui://route-harness/panel.html');
    expect(surface.provenance.routeIds).not.toContain('app:harness/panel');
  });

  it('names the compiled servers when the requested one does not exist', async () => {
    const error = await listMcpSurface({ server: 'missing' }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect((error as AgentTestError).code).toBe('server-not-found');
    expect((error as AgentTestError).message).toContain('harness');
    expect((error as AgentTestError).message).toContain('recovery:');
  });
});
