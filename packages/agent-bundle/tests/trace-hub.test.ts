import { Buffer } from 'node:buffer';

import { expect, it } from '@rstest/core';

import { ProjectEventHub } from '../src/dev/events.ts';
import { TraceHub, TraceHubError } from '../src/dev/trace/trace-hub.ts';
import { attachProjectEventTrace } from '../src/dev/trace/trace-project-events.ts';

const input = (summary: string) => ({
  correlation: {},
  kind: 'diagnostic.build.failed',
  source: 'diagnostic' as const,
  summary,
});

it('sanitizes every wire string and bounds oversized details', () => {
  const hub = new TraceHub({
    entryByteLimit: 16 * 1024,
    now: () => new Date('2026-09-05T12:00:00.000Z'),
    projectRoot: '/work/project',
  });

  const entry = hub.publish({
    ...input('Failed\n/work/project/src/index.ts'),
    details: {
      nested: ['See\t/work/project/src/index.ts', 'x'.repeat(20 * 1024)],
    },
  });

  expect(entry.summary).toBe('Failed<project>/src/index.ts');
  expect(entry.details).toBe('[UNAVAILABLE]');
  expect(Buffer.byteLength(JSON.stringify(entry), 'utf8')).toBeLessThanOrEqual(16 * 1024);
  expect(JSON.stringify(entry)).not.toContain('/work/project');
});

it('rejects an unknown source at the runtime boundary', () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });

  expect(() => hub.publish({ ...input('ignored'), source: 'unknown' as never })).toThrow(TypeError);
  expect(hub.latestSequence).toBe(0);
});

it('evicts by total encoded bytes and reports the resulting replay gap', () => {
  const hub = new TraceHub({
    encodedHistoryByteLimit: 520,
    entryLimit: 10,
    projectRoot: '/work/project',
  });
  hub.publish({ ...input('one'), details: { value: 'x'.repeat(120) } });
  hub.publish({ ...input('two'), details: { value: 'x'.repeat(120) } });
  hub.publish({ ...input('three'), details: { value: 'x'.repeat(120) } });

  const replay = hub.replay({ afterSequence: 0 });

  expect(replay.gap).toMatchObject({
    requestedAfterSequence: 0,
    type: 'trace.gap',
  });
  expect(replay.entries.at(-1)?.summary).toBe('three');
  expect(Buffer.byteLength(JSON.stringify(replay.entries), 'utf8')).toBeLessThanOrEqual(520);
});

it('keeps replay and reentrant live delivery ordered without duplicates', () => {
  const hub = new TraceHub({ entryLimit: 2, projectRoot: '/work/project' });
  hub.publish(input('one'));
  hub.publish(input('two'));
  hub.publish(input('three'));
  const received: string[] = [];

  hub.subscribe((message) => {
    received.push('type' in message ? message.type : `${message.sequence}:${message.summary}`);
    if ('type' in message) hub.publish(input('four'));
  }, { afterSequence: 0 });

  expect(received).toEqual(['trace.gap', '2:two', '3:three', '4:four']);
});

it('closes only the slow subscriber when reentrant publication exceeds its pending cap', () => {
  const hub = new TraceHub({
    projectRoot: '/work/project',
    subscriberByteLimit: 4_096,
    subscriberEntryLimit: 2,
  });
  hub.publish(input('one'));
  const slow = hub.subscribe((message) => {
    if (!('type' in message) && message.sequence === 2) {
      for (let index = 0; index < 8; index += 1) hub.publish(input(`flood-${index}`));
    }
  }, { afterSequence: 1 });
  const healthy: number[] = [];
  hub.subscribe((message) => {
    if (!('type' in message)) healthy.push(message.sequence);
  }, { afterSequence: 1 });

  hub.publish(input('two'));

  expect(slow.closed).toBe(true);
  expect(healthy).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it('rejects invalid and ahead cursors and closes subscriptions with the hub', () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  hub.publish(input('one'));
  expect(() => hub.replay({ afterSequence: -1 })).toThrow(TraceHubError);
  expect(() => hub.replay({ afterSequence: 2 })).toThrow(TraceHubError);
  const subscription = hub.subscribe(() => undefined, { afterSequence: 1 });

  hub.close();

  expect(subscription.closed).toBe(true);
  expect(() => hub.replay()).toThrow(TraceHubError);
});

it('lowers failed project diagnostics with their available correlation', () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const events = new ProjectEventHub();
  const detach = attachProjectEventTrace(hub, events);

  events.publish({
    payload: {
      completedAt: '2026-09-05T12:00:01.000Z',
      diagnostics: [{ code: 'BUILD', message: 'Broken /work/project/src/index.ts', severity: 'error' }],
      id: 'build-1',
      outcome: 'failed',
      sourceRevision: 'source-1',
      startedAt: '2026-09-05T12:00:00.000Z',
    },
    type: 'build.failed',
  });
  events.publish({
    epochId: 'epoch-1',
    payload: {
      diagnostics: [{ code: 'CONTRACT', message: 'Route failed.', severity: 'error' }],
      epochId: 'epoch-1',
      failures: [{ checks: ['schema'], routeId: 'tool:status/report' }],
      state: 'failed',
      summary: 'Contract gate failed.',
    },
    type: 'dev.contract.status',
  });
  events.publish({
    epochId: 'epoch-1',
    payload: {
      diagnostics: [{ code: 'HOST', message: 'Host sync failed.', severity: 'error' }],
      epochId: 'epoch-1',
      host: 'claude',
      state: 'failed',
    },
    type: 'dev.host.sync',
  });
  detach();

  expect(hub.replay().entries).toMatchObject([
    {
      details: {
        buildId: 'build-1',
        diagnostics: [{ message: 'Broken <project>/src/index.ts' }],
      },
      href: '/problems',
      kind: 'diagnostic.build.failed',
      source: 'diagnostic',
      status: 'error',
    },
    {
      correlation: { epochId: 'epoch-1', routeId: 'tool:status/report' },
      href: '/problems',
      kind: 'diagnostic.contract.failed',
      status: 'error',
    },
    {
      correlation: { epochId: 'epoch-1', host: 'claude' },
      href: '/problems',
      kind: 'diagnostic.host.sync',
      status: 'error',
    },
  ]);
});

it('ignores successful diagnostics and route invocations owned by their publishing services', () => {
  const hub = new TraceHub({ projectRoot: '/work/project' });
  const events = new ProjectEventHub();
  attachProjectEventTrace(hub, events);

  events.publish({
    epochId: 'epoch-1',
    payload: {
      diagnostics: [],
      epochId: 'epoch-1',
      failures: [],
      state: 'passed',
      summary: 'Contract gate passed.',
    },
    type: 'dev.contract.status',
  });
  events.publish({
    payload: {
      invocation: {
        completedAt: '2026-09-05T12:00:01.000Z',
        diagnostics: [],
        id: 'inv_1',
        input: {},
        kind: 'tool',
        manifestDigest: 'manifest-1',
        outcome: { kind: 'success' },
        routeId: 'tool:status/report',
        source: 'src/mcp/status/tools/report.tsx',
        sourceRevision: 'source-1',
        startedAt: '2026-09-05T12:00:00.000Z',
        status: 'succeeded',
        surface: { kind: 'mcp' },
        timings: [],
      },
    },
    type: 'route.invocation',
  });

  expect(hub.replay().entries).toEqual([]);
});
