import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type {
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../agent-bundle/src/services/playground-service.ts';
import { PlaygroundClient } from '../src/playground/playground-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { playgroundLogsViewFor } from '../src/playground/playground-model.ts';
import { LogsPage, LogsTraceView, loadPlaygroundLogTrace } from '../src/playground/logs-page.tsx';

const epoch = { digest: 'sha256-epoch', id: 'epoch-1' };

const session: PlaygroundSession = {
  cleanupFailures: [],
  createdAt: '2026-08-14T10:00:00.000Z',
  id: 'session-1',
  identity: {
    epoch,
    fixture: { digest: 'sha256-fixture', id: 'fixture-1' },
    invocation: { intent: { operation: 'build' }, kind: 'whole-plugin' },
    target: { digest: 'sha256-claude', name: 'claude' },
    task: { id: 'task-1', text: 'Review the emitted bundle.' },
  },
  state: 'open',
};

const events: readonly PlaygroundTraceEvent[] = [
  {
    kind: 'build.started',
    raw: { target: 'claude' },
    rawEventRef: 'events.jsonl#1',
    sequence: 1,
    source: 'build',
    summary: 'Build started',
    timestamp: '2026-08-14T10:00:01.000Z',
  },
  {
    kind: 'mcp.request',
    raw: { method: 'tools/list' },
    rawEventRef: 'events.jsonl#2',
    sequence: 2,
    source: 'mcp',
    summary: 'Listed tools',
    timestamp: '2026-08-14T10:00:02.000Z',
  },
];

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('renders log entries most recent first with their raw payload inspectable', () => {
  const markup = renderToStaticMarkup(createElement(LogsTraceView, {
    view: playgroundLogsViewFor({ epoch, events, kind: undefined, session, source: undefined }),
  }));

  expect(markup.indexOf('events.jsonl#2')).toBeLessThan(markup.indexOf('events.jsonl#1'));
  expect(markup).toContain('<details');
  expect(markup).toContain('tools/list');
  expect(markup).toContain('epoch-1');
  expect(markup).toContain('2 of 2');
});

it('renders only the entries that pass the source and kind filters', () => {
  const markup = renderToStaticMarkup(createElement(LogsTraceView, {
    view: playgroundLogsViewFor({ epoch, events, kind: 'mcp.request', session, source: 'mcp' }),
  }));

  expect(markup).toContain('events.jsonl#2');
  expect(markup).not.toContain('events.jsonl#1');
  expect(markup).toContain('1 of 2');
});

it('renders the source and kind filter controls for an open session', () => {
  const client = new PlaygroundClient({ foreground: foreground(async (input) => String(input) === '/api/project/session'
    ? response({
      cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
      origin: 'http://127.0.0.1:5173',
      token: 'foreground-token',
    })
    : response({ replay: { cursor: { afterSequence: 0 }, events, session } })) });
  const markup = renderToStaticMarkup(createElement(LogsPage, { client, epoch, sessionId: 'session-1' }));

  expect(markup).toContain('id="logs-source"');
  expect(markup).toContain('id="logs-kind"');
});

it('renders the no-session state before a playground session exists', () => {
  const client = new PlaygroundClient({ foreground: foreground(async () => { throw new Error('No session may issue a playground request.'); }) });
  const markup = renderToStaticMarkup(createElement(LogsPage, { client, epoch, sessionId: undefined }));

  expect(markup).toContain('No playground session');
  expect(markup).not.toContain('id="logs-source"');
});

it('reads the log through the shared playground replay route', async () => {
  const urls: string[] = [];
  const client = new PlaygroundClient({
    foreground: foreground(async (input) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      urls.push(url);
      return response({ replay: { cursor: { afterSequence: 2 }, events, session } });
    }),
  });

  const replay = await loadPlaygroundLogTrace(client, 'session-1');

  expect(urls).toEqual(['/api/playground/sessions/session-1/replay']);
  expect(replay.events.map((entry) => entry.rawEventRef)).toEqual(['events.jsonl#1', 'events.jsonl#2']);
});
