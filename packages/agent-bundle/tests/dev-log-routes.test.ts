import { expect, it } from '@rstest/core';

import { DevLogRoutes } from '../src/dev/logs/dev-log-routes.ts';
import { DevLogService } from '../src/dev/logs/dev-log-service.ts';
import {
  authorizeSession as authorize,
  sessionHeaders as headers,
  startRoutes as startRouteServer,
} from './support/route-harness.ts';

const startRoutes = async (service: DevLogService) =>
  startRouteServer(new DevLogRoutes({ authorize, service }), { closeMode: 'awaited' });

it('requires the existing session guard before replaying records', async () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'Loaded project.' });
  const started = await startRoutes(service);
  try {
    const response = await fetch(`${started.url}/api/logs/replay`);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      diagnostic: { code: 'AB8004', message: 'A valid same-session token is required.' },
    });
  } finally {
    await started.close();
  }
});

it('rejects invalid and ahead cursors before opening an NDJSON stream', async () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'Loaded project.' });
  const started = await startRoutes(service);
  try {
    const invalid = await fetch(`${started.url}/api/logs/stream?after=-1`, { headers: headers() });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-type')).toContain('application/json');
    await expect(invalid.json()).resolves.toEqual({
      diagnostic: { code: 'AB8091', message: 'Dev Log cursor is not valid.' },
    });

    const ahead = await fetch(`${started.url}/api/logs/stream?after=2`, { headers: headers() });
    expect(ahead.status).toBe(409);
    expect(ahead.headers.get('content-type')).toContain('application/json');
    await expect(ahead.json()).resolves.toEqual({
      diagnostic: { code: 'AB8092', message: 'Dev Log cursor is ahead of retained history.' },
    });
  } finally {
    await started.close();
  }
});

it('replays and streams the ordered production record contract', async () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'Loaded project.' });
  const started = await startRoutes(service);
  try {
    const replay = await fetch(`${started.url}/api/logs/replay?after=0`, { headers: headers() });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      replay: { cursor: { afterSequence: 1 }, records: [{ kind: 'project.load', sequence: 1 }] },
    });

    const stream = await fetch(`${started.url}/api/logs/stream?after=1`, { headers: headers() });
    expect(stream.status).toBe(200);
    service.log({ kind: 'build.started', level: 'info', producer: 'build', summary: 'Building.' });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected an NDJSON stream body.');
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toContain('"sequence":2');
    await reader.cancel();
  } finally {
    await started.close();
  }
});

it('owns live stream shutdown and resolves readers without waiting for the foreground server', async () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  const started = await startRoutes(service);
  try {
    const stream = await fetch(`${started.url}/api/logs/stream?after=0`, { headers: headers() });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected an NDJSON stream body.');
    const pending = reader.read();

    await started.routes.close();

    await expect(pending).resolves.toMatchObject({ done: true });
    expect(service.subscriptionCount).toBe(0);
  } finally {
    await started.close();
  }
});

it('terminates a stream promptly when an initial replay exceeds its bounded subscriber queue', async () => {
  const service = new DevLogService({ projectRoot: '/work/project', subscriberRecordLimit: 1 });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'one' });
  service.log({ kind: 'project.prepared', level: 'info', producer: 'project', summary: 'two' });
  const started = await startRoutes(service);
  try {
    const stream = await fetch(`${started.url}/api/logs/stream?after=0`, { headers: headers() });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error('Expected an NDJSON stream body.');
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    expect(service.subscriptionCount).toBe(0);
  } finally {
    await started.close();
  }
});
