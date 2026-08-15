import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@rstest/core';

import type { DevRuntimeRun, DevRuntimeSurface } from '../../agent-bundle/src/dev/runtime-protocol.ts';
import { RuntimeStage, type RuntimeAppPreviewRenderer } from '../src/runtime-stage.tsx';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';

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
      surfaceId: 'app/customer',
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

describe('Runtime stage', () => {
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
});
