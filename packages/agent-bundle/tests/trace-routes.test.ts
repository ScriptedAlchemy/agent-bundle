import { expect, it } from '@rstest/core';

import { TraceHub } from '../src/dev/trace/trace-hub.ts';
import { TraceRoutes } from '../src/dev/trace/trace-routes.ts';
import {
  authorizeSession as authorize,
  sessionHeaders as headers,
  startRoutes as startRouteServer,
} from './support/route-harness.ts';

const startRoutes = async (hub: TraceHub) =>
  startRouteServer(new TraceRoutes({ authorize, hub }), { closeMode: 'awaited' });

const publish = (hub: TraceHub, summary: string) => hub.publish({
  correlation: {},
  kind: 'diagnostic.build.failed',
  source: 'diagnostic',
  summary,
});

it('requires the foreground session guard', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  publish(hub, 'Build failed.');
  const started = await startRoutes(hub);
  try {
    const response = await fetch(`${started.url}/api/trace`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });
  } finally {
    await started.close();
  }
});

it('maps invalid, ahead, and closed cursors to trace diagnostics', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  publish(hub, 'Build failed.');
  const started = await startRoutes(hub);
  try {
    const invalid = await fetch(`${started.url}/api/trace?after=-1`, { headers: headers() });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({
      diagnostic: { code: 'AB8240', message: 'Trace cursor is not valid.' },
    });

    const ahead = await fetch(`${started.url}/api/trace/stream?after=2`, { headers: headers() });
    expect(ahead.status).toBe(409);
    await expect(ahead.json()).resolves.toEqual({
      diagnostic: { code: 'AB8241', message: 'Trace cursor is ahead of retained history.' },
    });

    hub.close();
    const closed = await fetch(`${started.url}/api/trace`, { headers: headers() });
    expect(closed.status).toBe(503);
    await expect(closed.json()).resolves.toEqual({
      diagnostic: { code: 'AB8242', message: 'Trace routes are not available.' },
    });
  } finally {
    await started.close();
  }
});

it('replays the TraceReplay contract and streams ordered NDJSON messages', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  publish(hub, 'one');
  const started = await startRoutes(hub);
  try {
    const replay = await fetch(`${started.url}/api/trace?after=0`, { headers: headers() });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      entries: [{ sequence: 1, summary: 'one' }],
      latestSequence: 1,
    });

    const stream = await fetch(`${started.url}/api/trace/stream?after=1`, { headers: headers() });
    expect(stream.status).toBe(200);
    publish(hub, 'two');
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected an NDJSON stream body.');
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"sequence":2');
    await reader.cancel();
  } finally {
    await started.close();
  }
});

it('owns stream shutdown and releases the hub subscription', async () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const started = await startRoutes(hub);
  try {
    const stream = await fetch(`${started.url}/api/trace/stream?after=0`, { headers: headers() });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected an NDJSON stream body.');
    const pending = reader.read();

    await started.routes.close();

    await expect(pending).resolves.toMatchObject({ done: true });
    expect(hub.subscriptionCount).toBe(0);
  } finally {
    await started.close();
  }
});
