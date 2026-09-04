import { createRoot, type Root } from 'react-dom/client';
import React from 'react';

import {
  LifecycleStaleDigestError,
  type LifecycleListResponse,
  type LifecycleReplay,
  type LifecycleReplayRequest,
  type LifecycleReplayResult,
} from '../../src/lifecycles/lifecycle-client.ts';
import {
  LifecyclesPage,
  type LifecycleClientSurface,
} from '../../src/lifecycles/lifecycles-page.tsx';

type Scenario = 'abort' | 'normal' | 'stale';

interface FixtureApi {
  readonly rerender?: () => void;
  readonly resolveStale?: () => void;
  readonly stats: () => Readonly<{
    readonly listCalls: number;
    readonly requests: readonly LifecycleReplayRequest[];
    readonly staleSignalAborted?: boolean;
  }>;
}

declare global {
  var __lifecyclesPageFixture: FixtureApi;
}

const documentValue = {
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
  const sessionId = typeof request.native.session_id === 'string' ? request.native.session_id : undefined;
  const workspaceRoot = typeof request.native.cwd === 'string' ? request.native.cwd : undefined;
  return {
    binding: request.binding,
    canonical: {
      event: 'tool/after',
      idempotencyKey: `${request.binding.target}-receipt`,
      observedAt: '2026-09-01T12:00:00.000Z',
      payload: { toolName: { nativeKey: 'tool_name', value: 'Write' } },
      provenance: {
        host: request.binding.target,
        hostContractRevision: target.hostContractRevision,
        nativeEvent: target.nativeEvent,
        source: 'native',
      },
      sequence: 1,
    },
    document: documentValue,
    events: [
      { document: documentValue, sequence: 0, type: 'shell' },
      { document: documentValue, sequence: 1, type: 'complete' },
    ],
    nativeInput: request.native,
    nativeResponse: request.binding.target === 'claude'
      ? { hookSpecificOutput: { additionalContext: 'Recorded browser.txt' } }
      : { output: { context: 'Recorded browser.txt' } },
    requestContext: {
      actor: { reason: 'not-provided', state: 'unavailable' },
      host: { source: 'receipt', state: 'available', value: { name: request.binding.target } },
      invocation: {
        hostContractRevision: target.hostContractRevision,
        kind: 'event',
        operationId: request.binding.routeId,
        surface: 'tool/after',
      },
      lineage: sessionId === undefined
        ? { reason: 'no-shared-runtime', state: 'unavailable' }
        : { source: 'receipt', state: 'available', value: { conversation: sessionId, depth: 0, resolution: 'native', root: sessionId } },
      session: sessionId === undefined
        ? { reason: 'not-provided', state: 'unavailable' }
        : { source: 'receipt', state: 'available', value: { sessionId } },
      workspace: workspaceRoot === undefined
        ? { reason: 'not-provided', state: 'unavailable' }
        : { source: 'receipt', state: 'available', value: { root: workspaceRoot } },
    },
    source: request.source,
  };
};

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Lifecycle browser fixture requires the Rsbuild root element.');
const root = createRoot(rootElement);

const mountNormal = (target: Root): FixtureApi => {
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
  target.render(<LifecyclesPage client={client} />);
  return { stats: () => ({ listCalls: 1, requests: [...requests] }) };
};

const mountStale = (target: Root): FixtureApi => {
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
        throw new LifecycleStaleDigestError('AB8213', 'The compiled manifest changed.', 409);
      }
      return { replay: replayFor(request) };
    },
  };
  target.render(<LifecyclesPage client={client} />);
  return { stats: () => ({ listCalls, requests: [...requests] }) };
};

const mountAbort = (target: Root): FixtureApi => {
  let listCalls = 0;
  let staleSignal: AbortSignal | undefined;
  let resolveStale!: (value: LifecycleListResponse) => void;
  const staleList = new Promise<LifecycleListResponse>((resolvePromise) => { resolveStale = resolvePromise; });
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
  const client: LifecycleClientSurface = {
    list: async (signal) => {
      listCalls += 1;
      if (listCalls > 1) return current;
      staleSignal = signal;
      return staleList;
    },
    replay: async (request) => ({ replay: replayFor(request) }),
  };
  target.render(<LifecyclesPage client={client} manifestDigest="manifest-a" />);
  return {
    rerender: () => target.render(<LifecyclesPage client={client} manifestDigest="manifest-current" />),
    resolveStale: () => resolveStale(listing('manifest-stale')),
    stats: () => ({
      listCalls,
      requests: [],
      staleSignalAborted: staleSignal?.aborted === true,
    }),
  };
};

const rawScenario = new URLSearchParams(location.search).get('scenario');
const scenario: Scenario = rawScenario === 'normal' || rawScenario === 'stale' || rawScenario === 'abort'
  ? rawScenario
  : 'normal';

switch (scenario) {
  case 'normal':
    globalThis.__lifecyclesPageFixture = mountNormal(root);
    break;
  case 'stale':
    globalThis.__lifecyclesPageFixture = mountStale(root);
    break;
  case 'abort':
    globalThis.__lifecyclesPageFixture = mountAbort(root);
    break;
  default: {
    const exhaustive: never = scenario;
    throw new Error(`Unhandled lifecycle browser scenario: ${String(exhaustive)}`);
  }
}
