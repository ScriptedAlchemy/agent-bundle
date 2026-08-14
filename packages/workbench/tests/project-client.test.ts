import { expect, it } from '@rstest/core';

import {
  ProjectClient,
  type EventSourceFactory,
  type EventSourceLike,
} from '../src/project-client.ts';

interface Listener {
  readonly listener: (event: { readonly data: string; readonly lastEventId: string }) => void;
  readonly type: string;
}

class RecordingEventSource implements EventSourceLike {
  readonly listeners: Listener[] = [];
  closed = false;

  addEventListener(type: string, listener: Listener['listener']): void {
    this.listeners.push({ listener, type });
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { readonly data: string; readonly lastEventId: string }): void {
    for (const listener of this.listeners.filter((candidate) => candidate.type === type)) listener.listener(event);
  }
}

const status = (state: 'active' | 'missing' | 'stale' = 'active') => ({
  artifact: state === 'missing'
    ? { state }
    : {
        activeEpoch: {
          configDigest: 'config',
          createdAt: '2026-08-14T12:00:00.000Z',
          diagnostics: { errors: 0, infos: 0, warnings: 0 },
          id: 'epoch-1',
          manifestPath: 'agent-bundle.manifest.json',
          modelDigest: 'model',
          projectRevision: 'revision-1',
          targetDigests: { claude: 'claude-digest', codex: 'codex-digest' },
        },
        currentSourceRevision: 'revision-1',
        state,
      },
  build: { state: 'idle' },
  source: { diagnostics: [], revision: 'revision-1', state: 'ready' },
});

it('refreshes Overview state after live named events and keeps the browser EventSource transport open', async () => {
  const stream = new RecordingEventSource();
  const requests: string[] = [];
  let sequence = 0;
  const client = new ProjectClient({
    events: (() => stream) satisfies EventSourceFactory,
    fetch: async (input) => {
      requests.push(String(input));
      sequence += 1;
      return Response.json({ status: status(sequence === 1 ? 'missing' : 'active') });
    },
  });
  const observed: string[] = [];

  await client.connect((next) => observed.push(next.artifact.state));
  stream.emit('artifact.status', {
    data: JSON.stringify({ payload: status('active').artifact, sequence: 7, type: 'artifact.status' }),
    lastEventId: '7',
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

  expect(observed).toEqual(['missing', 'active']);
  expect(requests).toEqual(['/api/project/status', '/api/project/status']);
  expect(client.lastEventId).toBe(7);
  expect(stream.closed).toBe(false);
  client.close();
  expect(stream.closed).toBe(true);
});

it('bootstraps a same-session token before posting an explicit rebuild through the shared typed route', async () => {
  const requests: Array<{ readonly body?: string; readonly headers?: HeadersInit; readonly input: string }> = [];
  const client = new ProjectClient({
    fetch: async (input, init) => {
      requests.push({ body: init?.body?.toString(), headers: init?.headers, input: String(input) });
      if (String(input) === '/api/project/session') return Response.json({ origin: 'http://127.0.0.1:3100', token: 'token-1' });
      return Response.json({ status: status('stale') });
    },
  });

  await expect(client.rebuild(['skills/review/SKILL.md'])).resolves.toMatchObject({ artifact: { state: 'stale' } });

  expect(requests).toHaveLength(2);
  expect(requests[0]?.input).toBe('/api/project/session');
  expect(requests[1]).toMatchObject({ body: '{"paths":["skills/review/SKILL.md"]}', input: '/api/project/rebuild' });
  expect(new Headers(requests[1]?.headers).get('x-agent-bundle-session')).toBe('token-1');
});
