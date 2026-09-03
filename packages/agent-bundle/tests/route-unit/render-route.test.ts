import { Agent, agent } from '@agent-bundle/runtime';
import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import Echo from '../../fixtures/route-harness/src/mcp/harness/tools/echo.tsx';
import { AgentTestError } from '../../src/test/errors.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

const workspace = { source: 'native', state: 'available', value: { root: '/tmp/harness-library' } } as never;
const notProvided = { reason: 'not-provided', state: 'unavailable' };

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

  it('reports typed unavailable identity axes when the harness receives no context injection', async () => {
    const rendered = await renderRoute('tool:harness/context');

    expect(rendered.result).toEqual({
      actor: notProvided,
      host: notProvided,
      session: notProvided,
      workspace: notProvided,
    });
  });

  it('preserves injected identity values and their observation sources', async () => {
    const rendered = await renderRoute('tool:harness/context', {
      context: {
        actor: { source: 'receipt', state: 'available', value: { id: 'actor-route-unit' } },
        host: { source: 'native', state: 'available', value: { name: 'route-unit-host' } },
        session: { source: 'native', state: 'available', value: { sessionId: 'route-unit-session' } },
        workspace: { source: 'derived', state: 'available', value: { root: '/tmp/route-unit' } },
      },
    });

    expect(rendered.result).toEqual({
      actor: { source: 'receipt', state: 'available', value: { id: 'actor-route-unit' } },
      host: { source: 'native', state: 'available', value: { name: 'route-unit-host' } },
      session: { source: 'native', state: 'available', value: { sessionId: 'route-unit-session' } },
      workspace: { source: 'derived', state: 'available', value: { root: '/tmp/route-unit' } },
    });
  });

  it('does not treat lookalike business input as request identity', async () => {
    const rendered = await renderRoute('tool:harness/context', {
      input: { host: 'spoofed-host', session: 'spoofed-session' },
    });

    expect(rendered.result).toEqual({
      actor: notProvided,
      host: notProvided,
      session: notProvided,
      workspace: notProvided,
    });
  });

  it('auto-mounts isolated declared state into each route-unit render', async () => {
    const first = await renderRoute('tool:harness/journal', { input: { note: 'route-unit proof' } });
    const second = await renderRoute('tool:harness/journal');

    expectDocument(first)
      .toHaveStatus('success')
      .toContainMarkdown('route-unit proof')
      .toHaveValue({ entries: [{ note: 'route-unit proof' }], revision: 1 });
    expectDocument(second)
      .toHaveStatus('success')
      .toHaveValue({ entries: [], revision: 0 });
  });

  it('preserves caller-supplied state instead of auto-mounting the manifest definition', async () => {
    const entries: Array<{ readonly note: string }> = [];
    const state = {
      lifetime: 'workspace-durable',
      changes: async function*() {},
      dispatch: async (_name: string, payload: { readonly note: string }) => {
        entries.push(payload);
        return { replayed: false, revision: 41, state: { entries } };
      },
      read: async () => ({ revision: 41, state: { entries } }),
    } as never;
    const rendered = await renderRoute('tool:harness/journal', {
      context: { state },
      input: { note: 'caller-owned' },
    });

    expectDocument(rendered).toHaveValue({
      entries: [{ note: 'caller-owned' }],
      revision: 41,
    });
  });

  it('auto-mounts noticeLedger when the caller supplied state alone', async () => {
    const state = {
      lifetime: 'workspace-durable',
      changes: async function*() {},
      dispatch: async () => ({ replayed: false, revision: 0, state: { entries: [] } }),
      read: async () => ({ revision: 0, state: { entries: [] } }),
    } as never;
    const rendered = await renderRoute('tool:harness/publish-notice', {
      context: { state },
      input: { message: 'partial mount', recipientSession: 'sess-a' },
    });

    expectDocument(rendered).toHaveStatus('success');
    expect(rendered.result).toMatchObject({ state: 'pending' });
    expect(typeof (rendered.result as { noticeId: unknown }).noticeId).toBe('string');
  });

  it('auto-mounts state when the caller supplied noticeLedger alone', async () => {
    const noticeLedger = {
      expire: async () => ({ notices: [] }),
      openRequest: async () => Object.freeze({
        close: () => undefined,
        handle: Object.freeze({
          publish: async () => { throw new Error('unused in journal route'); },
          read: async () => ({ notices: [] }),
        }),
      }),
      read: async () => ({ notices: [] }),
      withdraw: async () => ({ notices: [] }),
    } as never;
    const rendered = await renderRoute('tool:harness/journal', {
      context: { noticeLedger },
      input: { note: 'partial mount' },
    });

    expectDocument(rendered).toHaveValue({
      entries: [{ note: 'partial mount' }],
      revision: 1,
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
    expect(rendered.result).toEqual({
      contents: [{ mimeType: 'text/markdown', text: '# Notes for harness://notes', uri: 'harness://notes' }],
    });
  });

  it("validates the document value with the route's own resultSchema", async () => {
    const rendered = await renderRoute('tool:harness/echo', { input: { message: 'schema' } });

    expect(rendered.result).toEqual({
      message: 'schema',
      operationId: 'tool:harness/echo',
      workspace: null,
    });
  });

  it('renders an event route with the canonical props the runtime contract defines', async () => {
    const rendered = await renderRoute('event:tool/after', {
      input: {
        canonical: {
          event: 'tool/after',
          idempotencyKey: 'route-unit',
          observedAt: '2026-09-01T00:00:00.000Z',
          provenance: {
            host: 'claude',
            hostContractRevision: 'route-unit',
            nativeEvent: 'PostToolUse',
            source: 'native',
          },
          sequence: 1,
        },
        native: { tool_name: 'Write' },
      },
    });

    expect(rendered.invocation.kind).toBe('event');
    expectDocument(rendered)
      .toHaveStatus('success')
      .toContainMarkdown('Observed tool/after from claude.')
      .toContainContext('actor unavailable:not-provided')
      .toHaveValue(undefined);
  });

  it('mounts provider fixture values through the context seam instead of executing provider modules', async () => {
    const library = { stages: ['discover', 'curate'], tooling: { ffmpeg: { available: false } } };
    const Providers = async (): Promise<unknown> => {
      const { providers } = await agent();
      return createElement(Agent.Result, {
        value: {
          frozen: Object.isFrozen(providers),
          keys: Object.keys(providers).sort(),
          library: providers['library'] as never,
        },
      }, createElement(Agent.Text, null, 'providers observed'));
    };

    const rendered = await renderRoute({ default: Providers as never }, {
      context: { providers: { library } },
      routeId: 'tool:harness/providers (module)',
    });

    expectDocument(rendered).toHaveStatus('success').toHaveValue({
      frozen: true,
      keys: ['library'],
      library,
    });

    // A render without fixtures observes an empty, frozen provider map — the
    // harness never runs conventional src/providers modules on the test's behalf.
    const unfixtured = await renderRoute({ default: Providers as never }, {
      routeId: 'tool:harness/providers (module)',
    });
    expectDocument(unfixtured).toHaveValue({ frozen: true, keys: [], library: undefined });
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
