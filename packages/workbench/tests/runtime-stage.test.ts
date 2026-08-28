import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { DevRuntimeRun, DevRuntimeSurface } from '../../agent-bundle/src/dev/runtime-protocol.ts';
import {
  RuntimeStage,
  type RuntimeAppPreviewRenderer,
  type RuntimeLiveMcpPageAdapter,
} from '../src/runtime-stage.tsx';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';
import type { RuntimeAppPreviewLifecycleRegistrar } from '../src/runtime-playground.tsx';

const profile = {
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable MCP Apps',
  version: 'agent-bundle:mcp-apps:2026-01-26',
} satisfies RuntimeProfileOption;

const surface = {
  fixtures: [],
  id: 'app/customer',
  kind: 'mcp-app',
  label: 'Customer App',
  readOnly: false,
  targets: ['portable'],
} satisfies DevRuntimeSurface;

const run = {
  completedAt: '2026-08-15T12:00:01.000Z',
  id: 'run-customer',
  input: { customer_id: 'cust_12345' },
  result: {
    agentVisible: { ok: true },
    app: {
      mcpBinding: {
        definitionDigest: 'definition', registryRevision: 1, serverDigest: 'server', serverName: 'customer', sessionId: 'session', sessionRevision: 1, target: 'portable', transportDigest: 'transport',
      },
      resourceUri: 'ui://customer/app.html',
      surfaceId: 'mcp.edit-customer',
    },
    modelVisible: { summary: 'Customer is active.' },
    native: { status: 200 },
    state: { identity: { stateStoreId: 'state-customer', stateVersion: 1 } },
    trace: [],
    tree: [],
  },
  startedAt: '2026-08-15T12:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'app/customer',
  target: 'portable',
  vector: { providerSessionId: 'provider', runtimeGenerationId: 'generation', sourceRevision: 'source', stateStoreId: 'state-customer', stateVersion: 1 },
} satisfies DevRuntimeRun;

const failedRun = {
  completedAt: '2026-08-15T12:00:02.000Z',
  diagnostics: [{ code: 'RSC_RENDER_FAILED', message: 'Selected run failed.', phase: 'rsc-render', severity: 'error' }],
  id: 'run-failed',
  input: { customer_id: 'cust_12345' },
  startedAt: '2026-08-15T12:00:01.000Z',
  status: 'failed',
  surfaceId: 'app/customer',
  target: 'portable',
  vector: { ...run.vector, stateVersion: 2 },
} satisfies DevRuntimeRun;

const runtimeStatus = (activeVector: DevRuntimeRun['vector']) => ({
  activeVector,
  descriptor: { environmentVariables: [], id: 'rsc', label: 'RSC Runtime', schemaVersion: 1 },
  diagnostics: [],
  hmrReady: true,
  state: 'active',
} as const);

describe('Runtime stage', () => {
  it('forwards one exact lifecycle registrar to the injected preview without becoming its owner', () => {
    let registrarCalls = 0;
    const registrar: RuntimeAppPreviewLifecycleRegistrar = (_handle) => {
      registrarCalls += 1;
      return () => undefined;
    };
    let rendererCalls = 0;
    let receivedRegistrar: unknown;
    const renderer: RuntimeAppPreviewRenderer = (props) => {
      rendererCalls += 1;
      receivedRegistrar = props.registerLifecycle;
      return createElement('div', { 'data-runtime-app-sentinel': 'lifecycle' }, 'Injected App');
    };

    const markup = renderToStaticMarkup(createElement(RuntimeStage, {
      profile,
      profileId: 'portable',
      renderAppPreview: renderer,
      run,
      registerAppPreviewLifecycle: registrar,
      surface,
    }));

    expect(rendererCalls).toBe(1);
    expect(receivedRegistrar).toBe(registrar);
    expect(registrarCalls).toBe(0);
    expect((markup.match(/data-runtime-app-sentinel/g) ?? [])).toHaveLength(1);
  });

  it('keeps the existing four preview fields when no lifecycle registrar is supplied', () => {
    let keys: readonly string[] = [];
    const renderer: RuntimeAppPreviewRenderer = (props) => {
      keys = Object.keys(props).sort();
      return createElement('div', { 'data-runtime-app-sentinel': 'without-lifecycle' });
    };

    renderToStaticMarkup(createElement(RuntimeStage, { profile, profileId: 'portable', renderAppPreview: renderer, run, surface }));

    expect(keys).toEqual(['profile', 'profileId', 'run', 'surface']);
  });

  it('places one injected App renderer beside model-visible output without Runtime App chrome', () => {
    const renderer: RuntimeAppPreviewRenderer = () => createElement('div', { 'data-runtime-app-sentinel': 'one' }, 'Injected App');
    const markup = renderToStaticMarkup(createElement(RuntimeStage, { profile, profileId: 'portable', renderAppPreview: renderer, run, surface }));

    expect((markup.match(/data-runtime-app-sentinel/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('Model-visible output');
    expect(markup.indexOf('Model-visible output')).toBeLessThan(markup.indexOf('data-runtime-app-sentinel'));
    expect(markup).not.toContain('MCP App preview');
    expect(markup).not.toContain('<iframe');
  });

  it('keeps model-visible output when the App renderer is absent or fails', () => {
    const absent = renderToStaticMarkup(createElement(RuntimeStage, { profile, profileId: 'portable', run, surface }));
    const failing = renderToStaticMarkup(createElement(RuntimeStage, {
      profile,
      profileId: 'portable',
      renderAppPreview: () => { throw new Error('preview failed'); },
      run,
      surface,
    }));

    for (const markup of [absent, failing]) {
      expect(markup).toContain('Model-visible output');
      expect(markup).not.toContain('MCP App preview');
      expect(markup).not.toContain('<iframe');
    }
  });

  it('keeps the disabled live MCP Page adapter inert', () => {
    const renderer: RuntimeAppPreviewRenderer = () => createElement('div', { 'data-runtime-app-sentinel': 'preview' }, 'Injected App');
    const disabled = Object.freeze({ kind: 'disabled' as const }) satisfies RuntimeLiveMcpPageAdapter;

    const markup = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: disabled,
      profile,
      profileId: 'portable',
      renderAppPreview: renderer,
      run,
      surface,
    }));

    expect((markup.match(/data-runtime-app-sentinel/g) ?? [])).toHaveLength(1);
    expect(markup).not.toContain('data-runtime-mcp-page-sentinel');
  });

  it('renders the host-owned handoff adjacent to one official preview with exact evidence and registrar identities', () => {
    let previewCalls = 0;
    let handoffCalls = 0;
    let received: unknown;
    const registrar: RuntimeAppPreviewLifecycleRegistrar = () => () => undefined;
    const renderer: RuntimeAppPreviewRenderer = () => {
      previewCalls += 1;
      return createElement('div', { 'data-runtime-app-sentinel': 'preview' }, 'Injected App');
    };
    const adapter = Object.freeze({
      kind: 'host-owned' as const,
      render: (props) => {
        handoffCalls += 1;
        received = props;
        return createElement('div', { 'data-runtime-mcp-page-sentinel': 'handoff' }, 'Host handoff');
      },
    }) satisfies RuntimeLiveMcpPageAdapter;

    const markup = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: adapter,
      profile,
      profileId: 'portable',
      registerAppPreviewLifecycle: registrar,
      renderAppPreview: renderer,
      run,
      surface,
    }));

    expect(previewCalls).toBe(1);
    expect(handoffCalls).toBe(1);
    const handoff = received as Record<string, unknown>;
    expect(Object.keys(handoff).sort()).toEqual(['mcpBinding', 'profile', 'profileId', 'registerLifecycle', 'run', 'surface']);
    expect(handoff.mcpBinding).toBe(run.result.app!.mcpBinding);
    expect(handoff.profile).toBe(profile);
    expect(handoff.profileId).toBe('portable');
    expect(handoff.registerLifecycle).toBe(registrar);
    expect(handoff.run).toBe(run);
    expect(handoff.surface).toBe(surface);
    expect(markup.indexOf('data-runtime-app-sentinel')).toBeLessThan(markup.indexOf('data-runtime-mcp-page-sentinel'));
    expect((markup.match(/data-runtime-app-sentinel/g) ?? [])).toHaveLength(1);
    expect((markup.match(/data-runtime-mcp-page-sentinel/g) ?? [])).toHaveLength(1);
  });

  it('fails closed for missing App evidence and throwing host handoffs without suppressing the official preview', () => {
    let handoffCalls = 0;
    const adapter = Object.freeze({
      kind: 'host-owned' as const,
      render: () => {
        handoffCalls += 1;
        throw new Error('handoff failed');
      },
    }) satisfies RuntimeLiveMcpPageAdapter;
    const preview: RuntimeAppPreviewRenderer = () => createElement('div', { 'data-runtime-app-sentinel': 'preview' }, 'Injected App');
    const noApp = Object.freeze({ ...run, result: Object.freeze({ ...run.result, app: undefined }) }) satisfies DevRuntimeRun;

    const missing = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: adapter,
      profile,
      profileId: 'portable',
      renderAppPreview: preview,
      run: noApp,
      surface,
    }));
    const throwing = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: adapter,
      profile,
      profileId: 'portable',
      renderAppPreview: preview,
      run,
      surface,
    }));

    expect(handoffCalls).toBe(1);
    expect(missing).toContain('Model-visible output');
    expect(missing).not.toContain('data-runtime-app-sentinel');
    expect(missing).not.toContain('data-runtime-mcp-page-sentinel');
    expect(throwing).toContain('Model-visible output');
    expect(throwing).toContain('data-runtime-app-sentinel');
    expect(throwing).not.toContain('data-runtime-mcp-page-sentinel');
  });

  it('fails closed when the selected App evidence does not match the selected surface or profile', () => {
    let handoffCalls = 0;
    const adapter = Object.freeze({
      kind: 'host-owned' as const,
      render: () => {
        handoffCalls += 1;
        return createElement('div', { 'data-runtime-mcp-page-sentinel': 'mismatch' });
      },
    }) satisfies RuntimeLiveMcpPageAdapter;
    const mismatchedSurface = Object.freeze({ ...surface, id: 'app/other' });
    const mismatchedProfile = Object.freeze({ ...profile, id: 'chatgpt' });

    const surfaceMismatch = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: adapter,
      profile,
      profileId: 'portable',
      run,
      surface: mismatchedSurface,
    }));
    const profileMismatch = renderToStaticMarkup(createElement(RuntimeStage, {
      liveMcpPageAdapter: adapter,
      profile: mismatchedProfile,
      profileId: 'portable',
      run,
      surface,
    }));

    expect(handoffCalls).toBe(0);
    expect(surfaceMismatch).not.toContain('data-runtime-mcp-page-sentinel');
    expect(profileMismatch).not.toContain('data-runtime-mcp-page-sentinel');
  });

  it('retains last-good output and its one injected App after a selected failure', () => {
    const renderer: RuntimeAppPreviewRenderer = ({ run: rendered }) => createElement('div', { 'data-runtime-app-sentinel': 'retained' }, rendered.id);
    const markup = renderToStaticMarkup(createElement(RuntimeStage, {
      lastGoodRun: run,
      profile,
      profileId: 'portable',
      renderAppPreview: renderer,
      run: failedRun,
      status: runtimeStatus(failedRun.vector),
      surface,
    }));

    expect(markup).toContain('Runtime run failed');
    expect(markup).toContain('RSC_RENDER_FAILED');
    expect(markup).toContain('Retained last-good output');
    expect(markup).toContain('stale evidence');
    expect(markup).toContain('Customer is active.');
    expect((markup.match(/data-runtime-app-sentinel/g) ?? [])).toHaveLength(1);
    expect(markup).toContain('run-customer');
    expect(markup).not.toContain('No model-visible output was returned for this run.');
  });

  it('never renders a host-owned MCP Page handoff from retained last-good evidence', () => {
    let handoffCalls = 0;
    const adapter = Object.freeze({
      kind: 'host-owned' as const,
      render: () => {
        handoffCalls += 1;
        return createElement('div', { 'data-runtime-mcp-page-sentinel': 'retained' });
      },
    }) satisfies RuntimeLiveMcpPageAdapter;
    const preview: RuntimeAppPreviewRenderer = () => createElement('div', { 'data-runtime-app-sentinel': 'retained' }, 'Injected App');

    const markup = renderToStaticMarkup(createElement(RuntimeStage, {
      lastGoodRun: run,
      liveMcpPageAdapter: adapter,
      profile,
      profileId: 'portable',
      renderAppPreview: preview,
      run: failedRun,
      surface,
    }));

    expect(handoffCalls).toBe(0);
    expect(markup).toContain('data-runtime-app-sentinel');
    expect(markup).not.toContain('data-runtime-mcp-page-sentinel');
  });

  it('treats state and provider identity changes as stale while an exact authoritative vector is current', () => {
    const current = renderToStaticMarkup(createElement(RuntimeStage, { run, status: runtimeStatus(run.vector), surface }));
    const changedState = renderToStaticMarkup(createElement(RuntimeStage, {
      run,
      status: runtimeStatus({ ...run.vector, stateVersion: run.vector.stateVersion + 1 }),
      surface,
    }));
    const changedProvider = renderToStaticMarkup(createElement(RuntimeStage, {
      run,
      status: runtimeStatus({ ...run.vector, providerSessionId: 'provider-restarted' }),
      surface,
    }));

    expect(current).toContain('No stale views.');
    for (const markup of [changedState, changedProvider]) {
      expect(markup).toContain('Selected output is from runtime generation');
      expect(markup).not.toContain('No stale views.');
    }
  });

  it('derives retained last-good currentness from the displayed evidence vector', () => {
    const current = renderToStaticMarkup(createElement(RuntimeStage, {
      lastGoodRun: run,
      run: failedRun,
      status: runtimeStatus(run.vector),
      surface,
    }));
    const changedState = renderToStaticMarkup(createElement(RuntimeStage, {
      lastGoodRun: run,
      run: failedRun,
      status: runtimeStatus({ ...run.vector, stateVersion: run.vector.stateVersion + 1 }),
      surface,
    }));
    const changedProvider = renderToStaticMarkup(createElement(RuntimeStage, {
      lastGoodRun: run,
      run: failedRun,
      status: runtimeStatus({ ...run.vector, providerSessionId: 'provider-restarted' }),
      surface,
    }));

    expect(current).toContain('runtime-stage-generation--current');
    expect(current).toContain('Retained last-good output (current evidence)');
    expect(current).not.toContain('stale evidence');
    for (const markup of [changedState, changedProvider]) {
      expect(markup).toContain('runtime-stage-generation--stale');
      expect(markup).toContain('Retained last-good output (stale evidence)');
      expect(markup).toContain('RSC_RENDER_FAILED');
    }
  });
});
