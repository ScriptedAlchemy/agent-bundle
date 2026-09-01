import { describe, expect, it } from '@rstest/core';

import Echo from '../../fixtures/route-harness/src/mcp/harness/tools/echo.tsx';
import { AgentTestError } from '../../src/test/errors.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

const workspace = { source: 'native', state: 'available', value: { root: '/tmp/harness-library' } } as never;

/** The harness error one render rejected with; a resolved render is itself a failure. */
const rejection = async (render: Promise<unknown>): Promise<AgentTestError> => {
  try {
    await render;
  } catch (thrown: unknown) {
    return thrown as AgentTestError;
  }
  throw new Error('The render resolved, so no harness diagnostic was produced.');
};

describe('the registered route manifest', () => {
  it('is the manifest the one compiler pass produced, with no recompilation in the worker', () => {
    const manifest = testManifest();

    expect(manifest.proofLevel).toBe('route-unit');
    expect(Object.keys(manifest.routes)).toContain('tool:harness/echo');
    expect(manifest.targets).toEqual(['claude']);
  });
});

describe('renderRoute through the real renderer', () => {
  it('renders a compiled tool route into its final Agent Document', async () => {
    const rendered = await renderRoute('tool:harness/echo', {
      context: { workspace },
      input: { message: 'two files ready' },
    });

    expectDocument(rendered)
      .toHaveStatus('success')
      .toHaveNodeKinds(['result', 'markdown', 'text'])
      .toContainMarkdown('two files ready')
      .toContainText('workspace: /tmp/harness-library')
      .toHaveValue({
        message: 'two files ready',
        operationId: 'tool:harness/echo',
        workspace: '/tmp/harness-library',
      });
    expect(rendered.provenance).toMatchObject({
      kind: 'tool',
      proofLevel: 'route-unit',
      relativePath: 'src/mcp/harness/tools/echo.tsx',
      routeId: 'tool:harness/echo',
      serverId: 'mcp:harness',
      source: 'manifest',
      targets: ['claude'],
    });
  });

  it('runs the route inside a real request scope and captures its progress', async () => {
    const rendered = await renderRoute('tool:harness/echo', { input: { message: 'hello' } });

    expect(rendered.progress).toEqual([{ completed: 1, message: 'echoing', total: 1 }]);
    expect(rendered.invocation).toEqual({
      kind: 'tool',
      props: { input: { message: 'hello' }, operationId: 'tool:harness/echo' },
    });
  });

  it('records progress even when the caller supplies its own reporter', async () => {
    const delegated: unknown[] = [];
    const rendered = await renderRoute('tool:harness/echo', {
      context: {
        progress: {
          report: async (update) => {
            delegated.push(update);
          },
        },
      },
      input: { message: 'hello' },
    });

    expect(rendered.progress).toEqual([{ completed: 1, message: 'echoing', total: 1 }]);
    expect(delegated).toEqual([...rendered.progress]);
  });

  it('reports a represented error as the document status the runtime decided', async () => {
    const rendered = await renderRoute('tool:harness/unavailable');

    expectDocument(rendered)
      .toHaveStatus('represented-error')
      .toHaveError('AB9001')
      .toHaveValue({ available: false });
  });

  it('renders an MCP resource route the way the generated server dispatches it', async () => {
    const rendered = await renderRoute('resource:harness/notes', { input: { uri: 'harness://notes' } });

    expect(rendered.invocation).toEqual({
      kind: 'tool',
      props: { input: { uri: 'harness://notes' }, operationId: 'resource:harness/notes' },
    });
    expectDocument(rendered).toContainMarkdown('# Notes for harness://notes');
    expect(rendered.result).toEqual({ uri: 'harness://notes' });
  });

  it("validates the document value with the route's own resultSchema", async () => {
    const rendered = await renderRoute('tool:harness/echo', { input: { message: 'schema' } });

    expect(rendered.result).toEqual({
      message: 'schema',
      operationId: 'tool:harness/echo',
      workspace: null,
    });
  });

  it('renders an event route with the event invocation the runtime contract defines', async () => {
    const rendered = await renderRoute('event:tool/after', { input: { path: 'src/index.ts' } });

    expect(rendered.invocation.kind).toBe('event');
    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('Observed event:tool/after.')
      .toHaveValue({
        event: 'event:tool/after',
        invocationKind: 'event',
        payload: { path: 'src/index.ts' },
      });
  });

  it('renders a route module handed in directly, without the compiled manifest', async () => {
    const rendered = await renderRoute({ default: Echo }, {
      input: { message: 'module form' },
      routeId: 'tool:harness/echo (module)',
    });

    expectDocument(rendered).toHaveStatus('success').toContainMarkdown('module form');
    expect(rendered.provenance.source).toBe('module');
    expect(rendered.provenance.manifestDigest).toBeUndefined();
  });
});

describe('route-unit render failures', () => {
  it('names the route and the abort when the request was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await rejection(renderRoute('tool:harness/echo', { signal: controller.signal }));

    expect(error.code).toBe('render-failed');
    expect(error.message).toContain('AbortError');
    expect(error.message).toContain('route:        tool:harness/echo (tool)');
    expect(error.message).toContain('route-unit');
  });

  it('surfaces a document contract failure with the route that produced it', async () => {
    const error = await rejection(renderRoute('tool:harness/echo', { limits: { maxDocumentNodes: 1 } }));

    expect(error.code).toBe('render-failed');
    expect(error.message).toContain('node count exceeds 1');
    expect(error.message).toContain('src/mcp/harness/tools/echo.tsx');
  });
});
