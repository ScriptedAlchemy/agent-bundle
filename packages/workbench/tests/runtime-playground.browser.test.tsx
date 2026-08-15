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

const client = (resetState: () => Promise<DevRuntimeStateIdentity>): RuntimePlaygroundClient => ({
  bootstrap: async () => bootstrap(),
  createRun: async (_request: DevRuntimeInvocationRequest) => run('created'),
  readRun: async (id) => run(id),
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

    await page.getByRole('radio', { name: 'Raw JSON' }).click();
    const raw = page.locator('#runtime-input-raw');
    await raw.fill('{"city":');
    await expect.element(page.getByRole('alert')).toHaveText('Draft JSON is invalid. Repair the raw input before running.');
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
    const failure = page.getByRole('alert');
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
