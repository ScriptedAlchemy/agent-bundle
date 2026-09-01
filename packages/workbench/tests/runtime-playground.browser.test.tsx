import { page } from '@rstest/browser';
import { render } from '@rstest/browser-react';
import { expect, test } from '@rstest/core';
import React from 'react';

import type {
  DevRuntimeInvocationRequest,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
} from '../../agent-bundle/src/dev/runtime-protocol.ts';
import type { ProjectEventMessage } from '../../agent-bundle/src/dev/types.ts';
import type { AgentRenderEvent } from '../src/runtime/agent-document-client.ts';
import { createRuntimePlaygroundController, RuntimePlayground, type RuntimePlaygroundClient } from '../src/runtime-playground.tsx';
import type { RuntimeProfileOption } from '../src/runtime-model.ts';
import type { RuntimeBootstrap } from '../src/runtime-client.ts';

const vector = Object.freeze({
  providerSessionId: 'browser-provider',
  runtimeGenerationId: 'browser-generation',
  sourceRevision: 'browser-source',
  stateStoreId: 'browser-state',
  stateVersion: 1,
});

const status = Object.freeze({
  activeVector: vector,
  descriptor: Object.freeze({ environmentVariables: [], id: 'rsc', label: 'RSC Runtime', schemaVersion: 1 as const }),
  diagnostics: Object.freeze([]),
  hmrReady: true,
  lastGoodVector: vector,
  state: 'active' as const,
}) satisfies DevRuntimeStatus;

const surface = Object.freeze({
  defaultTarget: 'portable',
  fixtures: Object.freeze([{ id: 'browser-fixture', label: 'Browser fixture' }]),
  id: 'mcp.browser',
  inputSchema: Object.freeze({
    properties: Object.freeze({ city: Object.freeze({ title: 'City', type: 'string' as const }) }),
    required: Object.freeze(['city']),
    type: 'object' as const,
  }),
  kind: 'mcp-tool' as const,
  label: 'Browser tool',
  readOnly: false,
  targets: Object.freeze(['portable']),
}) satisfies DevRuntimeSurface;

const run = (id: string): DevRuntimeRun => Object.freeze({
  completedAt: '2026-08-15T12:00:01.000Z',
  fixtureId: 'browser-fixture',
  id,
  input: Object.freeze({ city: 'London' }),
  result: Object.freeze({
    agentVisible: Object.freeze({ city: 'London' }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'browser-state', stateVersion: 1 }) }),
    trace: Object.freeze([]),
    tree: Object.freeze([]),
  }),
  startedAt: '2026-08-15T12:00:00.000Z',
  status: 'succeeded',
  surfaceId: 'mcp.browser',
  target: 'portable',
  vector,
});

const evidenceRun = (id: string): DevRuntimeRun => Object.freeze({
  ...run(id),
  result: Object.freeze({
    agentVisible: Object.freeze({ city: 'London' }),
    flight: Object.freeze({ bytes: 2, downloadPath: `/api/runtime/runs/${id}/flight`, preview: 'FL', truncated: false }),
    state: Object.freeze({ identity: Object.freeze({ stateStoreId: 'browser-state', stateVersion: 1 }) }),
    trace: Object.freeze([Object.freeze({
      details: Object.freeze({ step: 'render' }),
      id: 'span-a',
      phase: 'render',
      startedAt: '2026-08-15T12:00:00.500Z',
      status: 'succeeded' as const,
    })]),
    tree: Object.freeze([]),
  }),
}) as DevRuntimeRun;

const profiles = Object.freeze([{
  claimsRealHostParity: false,
  evidence: 'simulated',
  id: 'portable',
  label: 'Portable MCP Apps',
  version: 'agent-bundle:mcp-apps:2026-01-26',
}] satisfies readonly RuntimeProfileOption[]);

const bootstrap = (): RuntimeBootstrap => Object.freeze({
  history: Object.freeze([run('initial')]),
  kind: 'available' as const,
  providerSessionId: vector.providerSessionId,
  status,
  surfaces: Object.freeze([surface]),
});

const generationFailedEvent = Object.freeze({
  occurredAt: '2026-08-15T12:00:00.000Z',
  payload: Object.freeze({
    providerSessionId: vector.providerSessionId,
    runtimeGenerationId: vector.runtimeGenerationId,
    type: 'runtime.generation.failed' as const,
  }),
  sequence: 1,
  type: 'runtime.event' as const,
}) satisfies ProjectEventMessage;

const client = (resetState: () => Promise<DevRuntimeStateIdentity>): RuntimePlaygroundClient => ({
  bootstrap: async () => bootstrap(),
  createRun: async (_request: DevRuntimeInvocationRequest) => run('created'),
  readRun: async (id) => run(id),
  readRunDocument: async () => [],
  readRunFlight: async () => new Blob(['flight'], { type: 'application/octet-stream' }),
  replayRun: async (_request: DevRuntimeReplayRequest) => run('replayed'),
  resetState: async (_request: DevRuntimeStateResetRequest) => resetState(),
});

test('mounts Runtime controls in a supported browser and fences reset interactions through its correlated success', { timeout: 15_000 }, async () => {
  let resetAttempts = 0;
  const controller = createRuntimePlaygroundController({
    bootstrap: bootstrap(),
    client: client(async () => {
      resetAttempts += 1;
      if (resetAttempts === 1) throw new Error('The provider rejected this reset.');
      return Object.freeze({ stateStoreId: 'browser-state', stateVersion: 2 });
    }),
    profiles,
  });
  try {
    await render(<RuntimePlayground controller={controller} />);
    await expect.element(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible();
    await expect.element(page.locator('[data-runtime-run-id="initial"]')).toBeVisible();
    controller.dispatch({ event: generationFailedEvent, type: 'event.received' });
    await expect.element(page.locator('.runtime-announcement[role="alert"]')).toHaveText('Runtime generation failed. The last good result remains available.');
    await expect.element(page.getByRole('tab', { name: 'Result', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.element(page.getByLabel('Runtime output stage')).toContainText('Agent-visible output');

    await page.getByRole('radio', { name: 'Raw JSON' }).click();
    const raw = page.locator('#runtime-input-raw');
    await raw.fill('{"city":');
    await expect.element(page.locator('#runtime-input-raw-error')).toHaveText('Draft JSON is invalid. Repair the raw input before running.');
    await raw.fill('{"city":"Paris"}');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
    await expect.element(raw).toBeDisabled();
    await expect.element(page.getByRole('button', { name: 'Replay exact' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect.element(page.getByRole('dialog')).not.toBeVisible();

    await page.getByRole('button', { name: 'Reset fixture state' }).click();
    await expect.element(page.getByRole('dialog')).toHaveText(/State store.*browser-state/su);
    await expect.element(page.getByRole('button', { name: 'Reset fixture state' })).toBeDisabled();
    await expect.element(page.getByLabel('Runtime surface')).toBeDisabled();
    await page.getByRole('button', { name: 'Confirm' }).click();
    const failure = page.locator('.runtime-request-error');
    await expect.element(failure).toHaveText('The provider rejected this reset.');
    await expect.element(failure).toBeFocused();
    await expect.element(page.locator('.runtime-status')).not.toBeFocused();
    await expect.element(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
    controller.dispatch({ tab: 'tree', type: 'selection.tab' });
    await expect.element(failure).toBeFocused();

    await page.getByRole('button', { name: 'Reset fixture state' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect.element(failure).not.toBeVisible();
    await expect.element(page.getByText('2', { exact: true })).toBeVisible();
    expect(controller.model.resetCompletion?.state).toEqual({ stateStoreId: 'browser-state', stateVersion: 2 });
    expect(controller.model.activeEffect).toBeUndefined();
    expect((document.activeElement as HTMLElement | null)?.className).toBe('runtime-status');
    await expect.element(page.locator('.runtime-status')).toBeFocused();
    controller.dispatch({ tab: 'diagnostics', type: 'selection.tab' });
    await expect.element(page.locator('.runtime-status')).toBeFocused();
  } finally {
    controller.close();
  }
});

test('downloads the selected Flight payload through the authenticated client and toggles trace span details', { timeout: 15_000 }, async () => {
  const documentRequests: string[] = [];
  const flightRequests: string[] = [];
  let rejectDownload = true;
  const controller = createRuntimePlaygroundController({
    bootstrap: Object.freeze({
      history: Object.freeze([evidenceRun('evidence')]),
      kind: 'available' as const,
      providerSessionId: vector.providerSessionId,
      status,
      surfaces: Object.freeze([surface]),
    }),
    client: {
      ...client(async () => Object.freeze({ stateStoreId: 'browser-state', stateVersion: 2 })),
      readRunDocument: async (id) => {
        documentRequests.push(id);
        const document = {
          root: {
            children: [{ kind: 'markdown' as const, text: '# Browser document' }],
            kind: 'result' as const,
          },
          status: 'success' as const,
          version: 1 as const,
        };
        return [
          { document, sequence: 0, type: 'shell' as const },
          { completed: 1, message: 'Rendered', sequence: 1, total: 1, type: 'progress' as const },
          { document, sequence: 2, type: 'complete' as const },
        ] satisfies readonly AgentRenderEvent[];
      },
      readRunFlight: async (id) => {
        flightRequests.push(id);
        if (rejectDownload) throw new Error('The Flight payload is unavailable.');
        return new Blob(['FL'], { type: 'application/octet-stream' });
      },
    },
    profiles,
  });
  try {
    await render(<RuntimePlayground controller={controller} />);
    await expect.element(page.getByRole('heading', { name: 'Runtime Playground' })).toBeVisible();

    await page.getByRole('tab', { name: 'Flight', exact: true }).click();
    const download = page.getByRole('button', { name: 'Download Flight payload' });
    await expect.element(download).toBeVisible();
    await download.click();
    await expect.element(page.locator('.runtime-request-error[role="alert"]')).toHaveText('The Flight payload is unavailable.');
    rejectDownload = false;
    await download.click();
    await expect.element(page.locator('.runtime-request-error[role="alert"]')).not.toBeVisible();
    expect(flightRequests).toEqual(['evidence', 'evidence']);

    await page.getByRole('tab', { name: 'Document', exact: true }).click();
    await expect.element(page.getByRole('heading', { name: 'Browser document' })).toBeVisible();
    await expect.element(page.getByLabel('Agent Document')).toContainText('Rendered · 1 / 1');
    await expect.element(page.getByLabel('Agent Document')).toContainText('Version 1 · success');
    expect(documentRequests).toEqual(['evidence']);

    await page.getByRole('tab', { name: 'Diagnostics', exact: true }).click();
    const toggle = page.getByRole('button', { name: 'Show span details' });
    await expect.element(toggle).toBeVisible();
    await expect.element(page.getByLabel('Runtime render trace')).not.toContainText('"step": "render"');
    await toggle.click();
    await expect.element(page.getByRole('button', { name: 'Hide span details' })).toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByLabel('Runtime render trace')).toContainText('"step": "render"');
    await page.getByRole('button', { name: 'Hide span details' }).click();
    await expect.element(page.getByLabel('Runtime render trace')).not.toContainText('"step": "render"');
  } finally {
    controller.close();
  }
});
