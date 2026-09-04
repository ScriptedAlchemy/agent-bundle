import { join } from 'node:path';

import { Agent, agent, useAgent } from '@agent-bundle/runtime';
import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import Echo from '../../fixtures/route-harness/src/mcp/harness/tools/echo.tsx';
import Wait from '../../fixtures/route-harness/src/mcp/harness/tools/wait.tsx';
import { AgentTestError } from '../../src/test/errors.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute } from '../../src/test/render.ts';
import { testManifest } from '../../src/test/registry.ts';

const workspace = { source: 'native', state: 'available', value: { root: '/tmp/harness-library' } } as never;
const notProvided = { reason: 'not-provided', state: 'unavailable' };
/** What every MCP request scope reports for `request.terminal` (#511). */
const noTerminal = {
  hostSurface: 'mcp',
  sharesTarget: false,
  stderr: { color: 'none', kind: 'none' },
  stdout: { color: 'none', kind: 'none' },
};

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
      lineage: notProvided,
      session: notProvided,
      // An MCP tool has no terminal, on every surface that serves it (#511).
      terminal: { source: 'derived', state: 'available', value: noTerminal },
      workspace: notProvided,
    });
  });

  it('lets a test inject the terminal capability through the context seam (#511)', async () => {
    const injected = await renderRoute('tool:harness/context', {
      context: {
        terminal: {
          source: 'native',
          state: 'available',
          value: {
            hostSurface: 'cli',
            sharesTarget: true,
            stderr: { color: 'truecolor', columns: 100, kind: 'tty', rows: 30 },
            stdout: { color: 'truecolor', columns: 100, kind: 'tty', rows: 30 },
          },
        },
      },
    });
    expect(injected.result).toMatchObject({
      terminal: {
        source: 'native',
        state: 'available',
        value: { hostSurface: 'cli', stdout: { color: 'truecolor', columns: 100, kind: 'tty', rows: 30 } },
      },
    });
  });

  it('preserves injected identity values and their observation sources', async () => {
    const lineage = {
      conversation: 'agent-child',
      depth: 1,
      parent: 'route-unit-session',
      resolution: 'registry',
      root: 'route-unit-session',
      subagent: { id: 'agent-child', toolCallId: 'toolu_spawn', type: 'general-purpose' },
    } as const;
    const rendered = await renderRoute('tool:harness/context', {
      context: {
        actor: { source: 'receipt', state: 'available', value: { id: 'actor-route-unit' } },
        host: { source: 'native', state: 'available', value: { name: 'route-unit-host' } },
        lineage: { source: 'derived', state: 'available', value: lineage },
        session: { source: 'native', state: 'available', value: { sessionId: 'route-unit-session' } },
        workspace: { source: 'derived', state: 'available', value: { root: '/tmp/route-unit' } },
      },
    });

    expect(rendered.result).toEqual({
      actor: { source: 'receipt', state: 'available', value: { id: 'actor-route-unit' } },
      host: { source: 'native', state: 'available', value: { name: 'route-unit-host' } },
      lineage: { source: 'derived', state: 'available', value: lineage },
      session: { source: 'native', state: 'available', value: { sessionId: 'route-unit-session' } },
      terminal: { source: 'derived', state: 'available', value: noTerminal },
      workspace: { source: 'derived', state: 'available', value: { root: '/tmp/route-unit' } },
    });
  });

  it('pins the typed per-host lineage unavailability reasons', async () => {
    const rendered = await renderRoute('tool:harness/context', {
      context: { lineage: { reason: 'no-shared-runtime', state: 'unavailable' } },
    });

    expect(rendered.result).toMatchObject({ lineage: { reason: 'no-shared-runtime', state: 'unavailable' } });
  });

  it('does not treat lookalike business input as request identity', async () => {
    const rendered = await renderRoute('tool:harness/context', {
      input: { host: 'spoofed-host', session: 'spoofed-session' },
    });

    expect(rendered.result).toEqual({
      actor: notProvided,
      host: notProvided,
      lineage: notProvided,
      session: notProvided,
      terminal: { source: 'derived', state: 'available', value: noTerminal },
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

  it('publishes with an author-declared sensitivity and defaults to internal (#99 redaction contract)', async () => {
    const state = {
      lifetime: 'workspace-durable',
      changes: async function*() {},
      dispatch: async () => ({ replayed: false, revision: 0, state: { entries: [] } }),
      read: async () => ({ revision: 0, state: { entries: [] } }),
    } as never;
    const defaulted = await renderRoute('tool:harness/publish-notice', {
      context: { state },
      input: { message: 'token=abc123 for the next session', recipientSession: 'sess-b' },
    });
    expectDocument(defaulted).toHaveStatus('success');
    expect(defaulted.result).toMatchObject({ sensitivity: 'internal', state: 'pending' });

    const classified = await renderRoute('tool:harness/publish-notice', {
      context: { state },
      input: { message: 'rotate the deploy key', recipientSession: 'sess-b', sensitivity: 'secret' },
    });
    expectDocument(classified).toHaveStatus('success');
    expect(classified.result).toMatchObject({ sensitivity: 'secret', state: 'pending' });
    expectDocument(classified).toContainText('(secret)');

    // The route's own input schema, not the ledger, refuses an unknown class.
    await expect(renderRoute('tool:harness/publish-notice', {
      context: { state },
      input: { message: 'x', recipientSession: 'sess-b', sensitivity: 'loud' } as never,
    })).rejects.toThrow();
  });

  it('auto-mounts state when the caller supplied noticeLedger alone', async () => {
    const noticeLedger = {
      expire: async () => ({ notices: [] }),
      openRequest: async () => Object.freeze({
        close: () => undefined,
        handle: Object.freeze({
          // The `request-view` fixture provider reads `published()` on every request (#459).
          inbox: async () => [],
          publish: async () => { throw new Error('unused in journal route'); },
          published: async () => [],
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

  describe('a route that declares its own render budget (#454)', () => {
    // `wait` declares `config.render.maxElapsedMs: 120_000`. The harness
    // `limits` are the dispatcher's base, so a base of 100ms shows whether the
    // route's compiled budget reached its render session: a 300ms hold
    // outlives the base and completes only because the route raised it.
    const limits = { maxElapsedMs: 100 };

    it('applies the compiled config.render budget over the base limits for a manifest route', async () => {
      const rendered = await renderRoute('tool:harness/wait', { input: { holdMs: 300 }, limits });

      expectDocument(rendered).toHaveStatus('success').toHaveValue({ waitedMs: 300 });
    });

    it('leaves the base limits alone for a module rendered directly, which has no compiled config', async () => {
      const error = await rejection(renderRoute({ default: Wait }, { input: { holdMs: 300 }, limits, routeId: 'tool:harness/wait' }));

      expect(error.code).toBe('render-failed');
      expect(error.message).toContain('elapsed time exceeds 100ms');
    });

    it('keeps forwarding progress reports for the whole raised budget', async () => {
      const rendered = await renderRoute('tool:harness/wait', { input: { holdMs: 300, tickMs: 100 }, limits });

      expect(rendered.progress).toEqual([
        { completed: 1, message: 'waiting', total: 3 },
        { completed: 2, message: 'waiting', total: 3 },
        { completed: 3, message: 'waiting', total: 3 },
      ]);
    });
  });

  describe('the plugin root axis (#468)', () => {
    const anchor = 'AGENT_BUNDLE_PLUGIN_ROOT';
    const withAnchor = async <T>(value: string | undefined, body: () => Promise<T>): Promise<T> => {
      const previous = process.env[anchor];
      if (value === undefined) delete process.env[anchor];
      else process.env[anchor] = value;
      try {
        return await body();
      } finally {
        if (previous === undefined) delete process.env[anchor];
        else process.env[anchor] = previous;
      }
    };

    it('observes the expanded AGENT_BUNDLE_PLUGIN_ROOT as the native anchor, with state one level below', async () => {
      const rendered = await withAnchor('/installs/harness', () => renderRoute('tool:harness/plugin-root'));

      expectDocument(rendered).toHaveStatus('success').toContainText('plugin root: /installs/harness');
      expect(rendered.result).toEqual({
        plugin: { source: 'native', state: 'available', value: { root: '/installs/harness', stateRoot: '/installs/harness/state' } },
      });
    });

    it("derives the project root's .agent-bundle when the anchor is unset, the npm bin's fallback", async () => {
      const root = join(testManifest().projectRoot, '.agent-bundle');
      const rendered = await withAnchor(undefined, () => renderRoute('tool:harness/plugin-root'));

      expect(rendered.result).toEqual({
        plugin: { source: 'derived', state: 'available', value: { root, stateRoot: join(root, 'state') } },
      });
    });

    it('treats an unexpanded host token as unset instead of joining it into a path', async () => {
      const root = join(testManifest().projectRoot, '.agent-bundle');
      const rendered = await withAnchor('${CLAUDE_PLUGIN_ROOT}', () => renderRoute('tool:harness/plugin-root'));

      expect(rendered.result).toEqual({
        plugin: { source: 'derived', state: 'available', value: { root, stateRoot: join(root, 'state') } },
      });
    });

    it('lets the context seam inject the axis like every other identity axis', async () => {
      const plugin = { source: 'receipt', state: 'available', value: { root: '/fixture', stateRoot: '/fixture/state' } } as never;
      const rendered = await renderRoute('tool:harness/plugin-root', { context: { plugin } });

      expect(rendered.result).toEqual({ plugin });
    });
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
      // An event route runs under a hook: no terminal, never probed (#511).
      .toContainContext('terminal available:derived hook/none/none')
      .toHaveValue(undefined);
  });

  it('mounts explicit provider fixture values through the context seam instead of discovering providers', async () => {
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

    // A module rendered directly has no compiled manifest, so there is nothing
    // to discover: it observes only the framework-owned process identity, the
    // same map a generated scope without providers mounts. Manifest routes
    // execute the project's conventional providers (projection/providers.test.ts).
    const unfixtured = await renderRoute({ default: Providers as never }, {
      routeId: 'tool:harness/providers (module)',
    });
    expectDocument(unfixtured).toHaveValue({ frozen: true, keys: ['processLifetime'], library: undefined });
  });

  it('serves useAgent() synchronously inside a rendered Server Component', async () => {
    // A synchronous component cannot await agent(); useAgent() hands it the
    // same request handle from the same store, so identity axes, providers,
    // and the invocation are observable without suspending.
    const Synchronous = (): unknown => {
      const context = useAgent();
      return createElement(Agent.Result, {
        value: {
          invocation: context.invocation.kind,
          library: context.providers['library'] as never,
          workspace: context.workspace.state === 'available' ? context.workspace.value.root : context.workspace.reason,
        },
      }, createElement(Agent.Text, null, 'synchronous context observed'));
    };

    const rendered = await renderRoute({ default: Synchronous as never }, {
      context: { providers: { library: { stages: ['discover'] } }, workspace },
      routeId: 'tool:harness/use-agent (module)',
    });

    expectDocument(rendered).toHaveStatus('success').toHaveValue({
      invocation: 'tool',
      library: { stages: ['discover'] },
      workspace: '/tmp/harness-library',
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

describe('layout composition at the route-unit level', () => {
  it('composes the root and server layouts around a manifest route without changing its projected nodes or value', async () => {
    const rendered = await renderRoute('tool:harness/echo', {
      context: { workspace },
      input: { message: 'wrapped' },
    });

    // Same node kinds and value as the layout-free render: the layouts'
    // container results merged into the route's valued result.
    expectDocument(rendered)
      .toHaveStatus('success')
      .toHaveNodeKinds(['result', 'markdown', 'text'])
      .toHaveValue({ message: 'wrapped', operationId: 'tool:harness/echo', workspace: '/tmp/harness-library' });
    // Root layout metadata wins conflicts; the server layout contributes its own keys.
    expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toEqual({
      invocation: 'tool',
      layout: 'harness',
      route: 'tool:harness/echo',
      server: 'mcp:harness',
      shell: 'route-harness',
      wrapped: 'tool',
    });
  });

  it('hands the server layout the route identity and merges route metadata beneath it', async () => {
    const rendered = await renderRoute('tool:harness/layout-probe', { input: { label: 'unit' } });

    expectDocument(rendered)
      .toHaveNodeKinds(['result', 'text', 'text'])
      .toContainText('probe: unit')
      .toContainText('layout: tool layout-probe via mcp:harness')
      .toHaveValue({ label: 'unit' });
    expect(rendered.result).toEqual({ label: 'unit' });
    expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toMatchObject({
      from: 'route',
      layout: 'harness',
      route: 'tool:harness/layout-probe',
      shell: 'route-harness',
    });
  });

  it('applies only the root layout to a rendered CLI command', async () => {
    const rendered = await renderRoute('cli:report', { input: { topic: 'layouts' } });

    expectDocument(rendered).toHaveStatus('success').toHaveValue({ count: 2, stateMounted: true, status: 'ready', topic: 'layouts' });
    expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toEqual({
      invocation: 'cli',
      shell: 'route-harness',
      wrapped: 'cli',
    });
  });

  it('composes no layout around a module rendered directly, because layouts are a compiler convention', async () => {
    const rendered = await renderRoute({ default: Echo }, { input: { message: 'direct' }, routeId: 'tool:harness/echo' });

    expectDocument(rendered).toHaveNodeKinds(['result', 'markdown', 'text']);
    expect(rendered.document.root.kind === 'result' ? rendered.document.root.metadata : undefined).toBeUndefined();
    expect(rendered.provenance.source).toBe('module');
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
