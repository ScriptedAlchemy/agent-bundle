import { expect, it } from '@rstest/core';

import { DevLogService } from '../src/dev/dev-log-service.ts';

it('records detached redacted details and replaces its own project root', () => {
  const service = new DevLogService({
    now: () => new Date('2026-08-18T12:00:00.000Z'),
    projectRoot: '/work/project',
  });

  const record = service.log({
    context: { buildId: 'build-1', target: 'codex' },
    details: {
      apiToken: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      projectFile: '/work/project/src/index.ts',
      unrelatedFile: '/private/elsewhere.txt',
    },
    kind: 'build.started',
    level: 'info',
    producer: 'build',
    summary: 'Building /work/project/src/index.ts',
  });

  if (record === undefined) throw new Error('Expected a Dev Log record.');

  expect(record).toMatchObject({
    context: { buildId: 'build-1', target: 'codex' },
    details: {
      apiToken: '[REDACTED]',
      projectFile: '<project>/src/index.ts',
      unrelatedFile: '[REDACTED]',
    },
    occurredAt: '2026-08-18T12:00:00.000Z',
    producer: 'build',
    schemaVersion: 1,
    sequence: 1,
    summary: 'Building <project>/src/index.ts',
  });
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.details)).toBe(true);
});

it('makes hostile detail payloads unavailable without breaking the producer', () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  const hostile = Object.create(null) as { readonly payload?: unknown };
  Object.defineProperty(hostile, 'payload', {
    enumerable: true,
    get: () => { throw new Error('must not run'); },
  });

  const record = service.log({
    details: hostile,
    kind: 'mcp.stderr',
    level: 'warning',
    producer: 'mcp',
    summary: 'MCP stderr was captured.',
  });

  expect(record?.details).toBe('[UNAVAILABLE]');
  expect(service.replay({ afterSequence: 0 }).records).toHaveLength(1);
});

it('reports a replay gap and keeps replay and live delivery ordered without duplicates', () => {
  const service = new DevLogService({ projectRoot: '/work/project', recordLimit: 2 });
  for (const kind of ['one', 'two', 'three']) {
    service.log({ kind, level: 'info', producer: 'project', summary: kind });
  }

  const received: Array<{ readonly sequence?: number; readonly type?: string }> = [];
  service.subscribe({ afterSequence: 0 }, (message) => {
    received.push('type' in message ? { type: message.type } : { sequence: message.sequence });
    if (!('type' in message) && message.sequence === 2) {
      service.log({ kind: 'four', level: 'info', producer: 'project', summary: 'four' });
    }
    return true;
  });

  expect(received).toEqual([
    { type: 'replay.gap' },
    { sequence: 2 },
    { sequence: 3 },
    { sequence: 4 },
  ]);
});
