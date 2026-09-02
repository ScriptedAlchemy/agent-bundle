import { page } from '@rstest/browser';
import { render } from '@rstest/browser-react';
import { expect, test } from '@rstest/core';
import React from 'react';

import {
  LifecycleStaleDigestError,
  type LifecycleListResponse,
  type LifecycleReplay,
  type LifecycleReplayRequest,
  type LifecycleReplayResult,
} from '../src/lifecycles/lifecycle-client.ts';
import { LifecyclesPage, type LifecycleClientSurface } from '../src/lifecycles/lifecycles-page.tsx';

const document = {
  root: {
    children: [{ kind: 'context' as const, text: 'Recorded browser.txt from lifecycle replay.' }],
    kind: 'result' as const,
  },
  status: 'success' as const,
  version: 1 as const,
};

const listing = (manifestDigest = 'manifest-a'): LifecycleListResponse => ({
  lifecycles: [{
    diagnostics: [{
      code: 'lifecycle.target.unsupported',
      message: 'Portable cannot project tool/after.',
      severity: 'error',
      target: 'portable',
    }],
    event: 'tool/after',
    routeId: 'event:tool/after',
    routePath: 'src/events/tool/after.tsx',
    targets: [
      {
        fixture: { label: 'Claude PostToolUse', native: { hook_event_name: 'PostToolUse', tool_name: 'Write' } },
        hostContractRevision: 'claude-hooks@1',
        nativeEvent: 'PostToolUse',
        target: 'claude',
      },
      {
        fixture: { label: 'Codex tool completion', native: { event: 'tool-complete', tool: 'write' } },
        hostContractRevision: 'codex-events@2',
        nativeEvent: 'tool-complete',
        target: 'codex',
      },
    ],
  }],
  manifestDigest,
});

const replayFor = (request: LifecycleReplayRequest): LifecycleReplay => {
  const target = listing().lifecycles[0]!.targets.find((candidate) => candidate.target === request.binding.target)!;
  return {
    binding: request.binding,
    canonical: {
      event: 'tool/after',
      idempotencyKey: `${request.binding.target}-receipt`,
      observedAt: '2026-09-01T12:00:00.000Z',
      provenance: {
        host: request.binding.target,
        hostContractRevision: target.hostContractRevision,
        nativeEvent: target.nativeEvent,
        source: 'native',
      },
      sequence: 1,
    },
    document,
    events: [
      { document, sequence: 0, type: 'shell' },
      { document, sequence: 1, type: 'complete' },
    ],
    nativeInput: request.native,
    nativeResponse: request.binding.target === 'claude'
      ? { hookSpecificOutput: { additionalContext: 'Recorded browser.txt' } }
      : { output: { context: 'Recorded browser.txt' } },
    requestContext: {
      hostContractRevision: target.hostContractRevision,
      invocationKind: 'event',
      nativeEvent: target.nativeEvent,
      routeId: request.binding.routeId,
      target: request.binding.target,
    },
    source: request.source,
  };
};

test('replays fixture and observed receipts across two materially different hosts', async () => {
  const requests: LifecycleReplayRequest[] = [];
  const client: LifecycleClientSurface = {
    list: async () => listing(),
    replay: async (request): Promise<LifecycleReplayResult> => {
      requests.push(request);
      if (request.native.unsupported === true) {
        return {
          diagnostics: [{
            code: 'lifecycle.native.unsupported',
            event: 'tool/after',
            message: 'The native receipt is unsupported.',
            severity: 'error',
            target: request.binding.target,
          }],
        };
      }
      return { replay: replayFor(request) };
    },
  };

  await render(<LifecyclesPage client={client} />);
  await expect.element(page.getByLabel('Lifecycle and target')).toHaveValue('claude/event:tool/after');
  await expect.element(page.getByText('Portable cannot project tool/after.')).toBeVisible();
  await expect.element(page.getByText('Fixture', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByLabel('Replay provenance')).toContainText('Fixture');
  await expect.element(page.getByLabel('Replay provenance')).toContainText('not evidence that claude dispatched this event');
  await expect.element(page.getByLabel('Agent Document', { exact: true })).toContainText('Recorded browser.txt from lifecycle replay.');
  await expect.element(page.getByLabel('Agent Document event timeline')).toContainText('Complete');
  expect(requests[0]).toMatchObject({ binding: { target: 'claude' }, source: 'fixture' });

  const input = page.locator('#lifecycle-native-input');
  await input.fill('{"edited":true}');
  await expect.element(page.getByText(/Edited fixture JSON is treated as observed input/u)).toBeVisible();
  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByLabel('Replay provenance')).toContainText('Observed');
  expect(requests[1]).toMatchObject({ native: { edited: true }, source: 'observed' });

  await page.getByLabel('Lifecycle and target').selectOption('codex/event:tool/after');
  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByLabel('Replay provenance')).toContainText('codex');
  await expect.element(page.getByText('tool-complete', { exact: true }).first()).toBeVisible();
  expect(requests[2]).toMatchObject({ binding: { target: 'codex' }, source: 'fixture' });

  await page.getByRole('radio', { name: 'Observed native receipt' }).click();
  await input.fill('{"event":"observed-tool-complete"}');
  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByLabel('Replay provenance')).toContainText('Observed');
  expect(requests[3]).toMatchObject({ native: { event: 'observed-tool-complete' }, source: 'observed' });

  await input.fill('{"unsupported":true}');
  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByText('The native receipt is unsupported.')).toBeVisible();
  await expect.element(page.getByText('lifecycle.native.unsupported')).toBeVisible();
});

test('repairs a stale digest without silently rebinding or discarding the draft', async () => {
  let listCalls = 0;
  const requests: LifecycleReplayRequest[] = [];
  const client: LifecycleClientSurface = {
    list: async () => {
      listCalls += 1;
      return listing(listCalls === 1 ? 'manifest-a' : 'manifest-b');
    },
    replay: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new LifecycleStaleDigestError(
          'AB8213',
          'The compiled manifest changed.',
          409,
        );
      }
      return { replay: replayFor(request) };
    },
  };

  await render(<LifecyclesPage client={client} />);
  const input = page.locator('#lifecycle-native-input');
  await expect.element(input).toHaveValue(/PostToolUse/u);
  await input.fill('{"custom":"preserved"}');
  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByRole('heading', { name: 'Stale compiled manifest' })).toBeVisible();
  await expect.element(page.getByText('The compiled manifest changed.')).toBeVisible();

  await page.getByRole('button', { name: 'Refresh lifecycle list' }).click();
  await expect.element(page.getByText(/run replay explicitly against the current manifest/u)).toBeVisible();
  await expect.element(input).toHaveValue('{"custom":"preserved"}');
  expect(requests).toHaveLength(1);

  await page.getByRole('button', { name: 'Run replay' }).click();
  await expect.element(page.getByLabel('Replay provenance')).toContainText('Observed');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    binding: { manifestDigest: 'manifest-b' },
    native: { custom: 'preserved' },
    source: 'observed',
  });
});

test('aborts and ignores a lifecycle list superseded by a manifest change', async () => {
  let staleSignal: AbortSignal | undefined;
  let resolveStale!: (value: LifecycleListResponse) => void;
  let listCalls = 0;
  const staleList = new Promise<LifecycleListResponse>((resolve) => { resolveStale = resolve; });
  const client: LifecycleClientSurface = {
    list: async (signal) => {
      listCalls += 1;
      if (listCalls > 1) return current;
      staleSignal = signal;
      return staleList;
    },
    replay: async (request) => ({ replay: replayFor(request) }),
  };
  const current: LifecycleListResponse = {
    lifecycles: [{
      diagnostics: [],
      event: 'session/start',
      routeId: 'event:session/start',
      routePath: 'src/events/session/start.tsx',
      targets: [{
        hostContractRevision: 'codex-events@2',
        nativeEvent: 'message-created',
        target: 'codex',
      }],
    }],
    manifestDigest: 'manifest-current',
  };
  const mounted = await render(<LifecyclesPage client={client} manifestDigest="manifest-a" />);
  await mounted.rerender(<LifecyclesPage client={client} manifestDigest="manifest-current" />);
  await expect.element(page.getByLabel('Lifecycle and target')).toHaveValue('codex/event:session/start');
  expect(staleSignal?.aborted).toBe(true);

  resolveStale(listing('manifest-stale'));
  await Promise.resolve();
  await expect.element(page.getByLabel('Lifecycle and target')).toHaveValue('codex/event:session/start');
});
