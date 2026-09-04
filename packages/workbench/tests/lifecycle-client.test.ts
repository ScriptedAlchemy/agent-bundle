import { expect, it } from '@rstest/core';

import {
  LifecycleClient,
  LifecycleClientError,
  LifecycleStaleDigestError,
  type LifecycleReplayRequest,
} from '../src/lifecycles/lifecycle-client.ts';
import type { ForegroundRequestAuthority } from '../src/mcp/mcp-route-client.ts';

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly signal?: AbortSignal;
  readonly url: string;
}

const document = {
  root: {
    children: [{ kind: 'context' as const, text: 'Recorded README.md from claude.' }],
    kind: 'result' as const,
  },
  status: 'success' as const,
  version: 1 as const,
};

const replay = {
  binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
  canonical: {
    event: 'tool/after',
    idempotencyKey: 'receipt-a',
    observedAt: '2026-09-01T12:00:00.000Z',
    payload: { toolName: { nativeKey: 'tool_name', value: 'Write' } },
    provenance: {
      host: 'claude',
      hostContractRevision: 'claude-hooks@1',
      nativeEvent: 'PostToolUse',
      source: 'native' as const,
    },
    sequence: 1,
  },
  document,
  events: [
    { document, sequence: 0, type: 'shell' as const },
    { document, sequence: 1, type: 'complete' as const },
  ],
  nativeInput: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
  nativeResponse: { hookSpecificOutput: { additionalContext: 'Recorded README.md' } },
  requestContext: {
    actor: { reason: 'not-provided' as const, state: 'unavailable' as const },
    host: { source: 'receipt' as const, state: 'available' as const, value: { name: 'claude' } },
    invocation: {
      hostContractRevision: 'claude-hooks@1',
      kind: 'event' as const,
      operationId: 'event:tool/after',
      surface: 'tool/after',
    },
    lineage: { reason: 'not-provided' as const, state: 'unavailable' as const },
    session: { reason: 'not-provided' as const, state: 'unavailable' as const },
    workspace: { reason: 'not-provided' as const, state: 'unavailable' as const },
  },
  source: 'fixture' as const,
};

const listing = {
  lifecycles: [{
    diagnostics: [{
      code: 'lifecycle.target.partial',
      message: 'Codex projection is unavailable.',
      severity: 'warning' as const,
      target: 'codex',
    }],
    event: 'tool/after',
    routeId: 'event:tool/after',
    routePath: 'src/events/tool/after.tsx',
    targets: [{
      fixture: {
        label: 'Claude PostToolUse fixture',
        native: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
      },
      hostContractRevision: 'claude-hooks@1',
      nativeEvent: 'PostToolUse',
      target: 'claude',
    }],
  }],
  manifestDigest: 'manifest-a',
};

const jsonResponse = (body: unknown, status = 200): Response => ({
  json: async () => body,
  ok: status >= 200 && status < 300,
  status,
}) as Response;

const authority = (
  calls: RecordedRequest[],
  reply: (path: string, init: RequestInit) => Response,
): ForegroundRequestAuthority => ({
  protectedRequest: async (path, init = {}) => {
    calls.push({
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init.method ?? 'GET',
      ...(init.signal === null || init.signal === undefined ? {} : { signal: init.signal }),
      url: String(path),
    });
    return reply(String(path), init);
  },
});

const request: LifecycleReplayRequest = {
  binding: { manifestDigest: 'manifest-a', routeId: 'event:tool/after', target: 'claude' },
  native: { hook_event_name: 'PostToolUse', tool_name: 'Write' },
  source: 'fixture',
};

it('lists lifecycle targets through the foreground authority and deeply freezes the decoded response', async () => {
  const calls: RecordedRequest[] = [];
  const signal = new AbortController().signal;
  const client = new LifecycleClient({ foreground: authority(calls, () => jsonResponse(listing)) });

  const result = await client.list(signal);

  expect(result).toEqual(listing);
  expect(calls).toEqual([{ body: undefined, method: 'GET', signal, url: '/api/lifecycles' }]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.lifecycles)).toBe(true);
  expect(Object.isFrozen(result.lifecycles[0]!.targets[0]!.fixture!.native)).toBe(true);
});

it('posts the exact replay binding, native receipt, and honest source', async () => {
  const calls: RecordedRequest[] = [];
  const client = new LifecycleClient({ foreground: authority(calls, () => jsonResponse({ replay })) });

  await expect(client.replay(request)).resolves.toMatchObject({
    replay: {
      binding: request.binding,
      canonical: { provenance: { host: 'claude', nativeEvent: 'PostToolUse' } },
      requestContext: {
        actor: { reason: 'not-provided', state: 'unavailable' },
        host: { source: 'receipt', state: 'available', value: { name: 'claude' } },
        lineage: { reason: 'not-provided', state: 'unavailable' },
        session: { reason: 'not-provided', state: 'unavailable' },
        workspace: { reason: 'not-provided', state: 'unavailable' },
      },
      source: 'fixture',
    },
  });
  expect(calls).toEqual([{
    body: request,
    method: 'POST',
    url: '/api/lifecycles/replays',
  }]);
});

it('returns a supported unsupported-combination diagnostic response', async () => {
  const diagnostics = [{
    code: 'lifecycle.target.unsupported',
    event: 'tool/after',
    message: 'The target cannot project this lifecycle.',
    severity: 'error' as const,
    target: 'portable',
  }];
  const client = new LifecycleClient({
    foreground: authority([], () => jsonResponse({ diagnostics })),
  });

  await expect(client.replay(request)).resolves.toEqual({ diagnostics });
});

it('rejects surplus fields at every lifecycle response boundary', async () => {
  const malformed = [
    { ...listing, version: 1 },
    { ...listing, lifecycles: [{ ...listing.lifecycles[0], version: 1 }] },
    {
      ...listing,
      lifecycles: [{
        ...listing.lifecycles[0],
        targets: [{ ...listing.lifecycles[0]!.targets[0], version: 1 }],
      }],
    },
    {
      ...listing,
      lifecycles: [{
        ...listing.lifecycles[0],
        diagnostics: [{ ...listing.lifecycles[0]!.diagnostics[0], event: 'tool/after' }],
      }],
    },
    { replay: { ...replay, version: 1 } },
    { replay: { ...replay, canonical: { ...replay.canonical, version: 1 } } },
    // A payload field is exactly `{ nativeKey, value }`; a stray member is rejected like any other drift.
    { replay: { ...replay, canonical: { ...replay.canonical, payload: { toolName: { nativeKey: 'tool_name', value: 'Write', version: 1 } } } } },
    { replay: { ...replay, canonical: { ...replay.canonical, payload: { toolName: { value: 'Write' } } } } },
    { replay: { ...replay, requestContext: { ...replay.requestContext, version: 1 } } },
    {
      replay: {
        ...replay,
        requestContext: {
          ...replay.requestContext,
          host: { ...replay.requestContext.host, version: 1 },
        },
      },
    },
    { replay: { ...replay, events: [{ ...replay.events[0], version: 1 }] } },
    { replay: { ...replay, document: { ...replay.document, version: 1, extra: true } } },
    {
      diagnostics: [{
        code: 'lifecycle.target.unsupported',
        event: 'tool/after',
        message: 'Unsupported.',
        severity: 'error',
        target: 'portable',
        version: 1,
      }],
    },
  ];

  for (const body of malformed) {
    const client = new LifecycleClient({
      foreground: authority([], () => jsonResponse(body)),
    });
    const operation = 'manifestDigest' in body ? client.list() : client.replay(request);
    await expect(operation).rejects.toMatchObject({
      code: 'AB8233',
      message: 'Lifecycle replay route returned an invalid response.',
    });
  }
});

it('rejects hostile accessors without invoking them', async () => {
  let reads = 0;
  const hostile = { lifecycles: [] } as Record<string, unknown>;
  Object.defineProperty(hostile, 'manifestDigest', {
    enumerable: true,
    get: () => {
      reads += 1;
      return 'manifest-a';
    },
  });
  const client = new LifecycleClient({
    foreground: authority([], () => jsonResponse(hostile)),
  });

  await expect(client.list()).rejects.toMatchObject({ code: 'AB8233' });
  expect(reads).toBe(0);
});

it('types a stale manifest diagnostic distinctly', async () => {
  const client = new LifecycleClient({
    foreground: authority([], () => jsonResponse({
      diagnostic: {
        code: 'AB8213',
        message: 'The compiled manifest changed.',
      },
    }, 409)),
  });

  const failure = await client.replay(request).catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(LifecycleStaleDigestError);
  expect(failure).toMatchObject({
    code: 'AB8213',
    status: 409,
  });
});

it('keeps native validation and response-budget failures coded but non-stale', async () => {
  for (const [status, code, message] of [
    [400, 'lifecycle.native.invalid', 'tool_name is required.'],
    [413, 'lifecycle.response.too-large', 'Lifecycle replay exceeded its response budget.'],
  ] as const) {
    const client = new LifecycleClient({
      foreground: authority([], () => jsonResponse({ diagnostic: { code, message } }, status)),
    });

    const failure = await client.replay(request).catch((reason: unknown) => reason);
    expect(failure).toBeInstanceOf(LifecycleClientError);
    expect(failure).not.toBeInstanceOf(LifecycleStaleDigestError);
    expect(failure).toMatchObject({ code, message, status });
  }
});

it('rejects malformed diagnostic error envelopes without trusting their fields', async () => {
  const client = new LifecycleClient({
    foreground: authority([], () => jsonResponse({
      diagnostic: {
        code: 'lifecycle.native.invalid',
        message: 'Invalid.',
        surplus: true,
      },
    }, 400)),
  });

  await expect(client.replay(request)).rejects.toMatchObject({
    code: 'AB8233',
    message: 'Lifecycle replay request failed with HTTP 400.',
    status: 400,
  });
});
