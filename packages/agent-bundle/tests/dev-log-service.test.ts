import { Buffer } from 'node:buffer';

import { expect, it } from '@rstest/core';

import { DevLogService, type DevLogInput } from '../src/dev/dev-log-service.ts';

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
    details: '[UNAVAILABLE]',
    occurredAt: '2026-08-18T12:00:00.000Z',
    producer: 'build',
    schemaVersion: 1,
    sequence: 1,
    summary: 'Building <project>/src/index.ts',
  });
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.details)).toBe(true);
});

it('rejects hostile envelopes without breaking the producer', () => {
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

  expect(record).toBeUndefined();
  expect(service.replay({ afterSequence: 0 }).records).toHaveLength(0);
});

it('reports a replay gap and keeps replay and live delivery ordered without duplicates', () => {
  const service = new DevLogService({ projectRoot: '/work/project', recordLimit: 2 });
  for (const kind of ['project.load', 'project.prepared', 'project.invalid-source'] as const) {
    service.log({ kind, level: 'info', producer: 'project', summary: kind });
  }

  const received: Array<{ readonly sequence?: number; readonly type?: string }> = [];
  service.subscribe({ afterSequence: 0 }, (message) => {
    received.push('type' in message ? { type: message.type } : { sequence: message.sequence });
    if (!('type' in message) && message.sequence === 2) {
      service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'four' });
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

it('snapshots the complete input before touching any producer field', () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  let getterReads = 0;
  const accessorInput = Object.create(null) as DevLogInput;
  Object.defineProperty(accessorInput, 'producer', {
    enumerable: true,
    get: () => {
      getterReads += 1;
      throw new Error('producer getter must not run');
    },
  });

  expect(() => service.log(accessorInput)).not.toThrow();
  expect(getterReads).toBe(0);
  const proxyInput = new Proxy({}, {
    getOwnPropertyDescriptor: () => { throw new Error('proxy rejected'); },
    ownKeys: () => ['producer'],
  }) as DevLogInput;
  expect(() => service.log(proxyInput)).not.toThrow();
  expect(service.replay().records).toEqual([]);
});

it('reports a truthful gap even when byte eviction leaves no retained record', () => {
  const service = new DevLogService({ encodedHistoryByteLimit: 1, projectRoot: '/work/project' });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'Loaded project.' });

  expect(service.replay({ afterSequence: 0 })).toMatchObject({
    gap: {
      earliestAvailableSequence: 2,
      latestDroppedSequence: 1,
      requestedAfterSequence: 0,
      type: 'replay.gap',
    },
    records: [],
  });
});

it('installs a complete replay queue before a gap listener can publish', () => {
  const service = new DevLogService({ projectRoot: '/work/project', recordLimit: 2 });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'one' });
  service.log({ kind: 'project.prepared', level: 'info', producer: 'project', summary: 'two' });
  service.log({ kind: 'project.invalid-source', level: 'error', producer: 'project', summary: 'three' });
  const received: string[] = [];

  service.subscribe({ afterSequence: 0 }, (message) => {
    received.push('type' in message ? message.type : `${message.sequence}:${message.summary}`);
    if ('type' in message) service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'four' });
  });

  expect(received).toEqual(['replay.gap', '2:two', '3:three', '4:four']);
});

it('fails closed for arbitrary path and control-bearing strings while preserving project-relative paths', () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  const record = service.log({
    details: {
      comma: '/private/elsewhere.txt,still-here',
      file: 'file:///private/elsewhere.txt',
      project: 'see /work/project/src/index.ts, then continue',
      spaces: 'C:\\private\\elsewhere.txt has spaces',
      unc: '\\\\server\\share\\secret.txt',
    },
    kind: 'project.load',
    level: 'info',
    producer: 'project',
    summary: 'Loaded /work/project/src/index.ts.',
  });

  expect(record).toMatchObject({
    details: {
      comma: '[REDACTED]',
      file: '[REDACTED]',
      project: 'see <project>/src/index.ts, then continue',
      spaces: '[REDACTED]',
      unc: '[REDACTED]',
    },
    summary: 'Loaded <project>/src/index.ts.',
  });
});

it('rejects impossible record limits and never retains an oversized fallback record', () => {
  expect(() => new DevLogService({ projectRoot: '/work/project', recordByteLimit: 1 })).toThrow(RangeError);
  const service = new DevLogService({ projectRoot: '/work/project', recordByteLimit: 256 });
  const record = service.log({
    details: { payload: 'x'.repeat(10_000) },
    kind: 'project.load',
    level: 'info',
    producer: 'project',
    summary: 'y'.repeat(10_000),
  });
  if (record === undefined) throw new Error('Expected a bounded fallback record.');

  expect(Buffer.byteLength(JSON.stringify(record), 'utf8')).toBeLessThanOrEqual(256);
  expect(record.details).toBe('[UNAVAILABLE]');
  expect(record.summary).toBe('[UNAVAILABLE]');
});

it('rejects non-enumerated producer kinds and removes credentials, unsafe keys, and roots from the full wire record', () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  expect(service.log({
    kind: 'sk-proj-abcdefghijklmnopqrstuvwxyz' as never,
    level: 'info',
    producer: 'project',
    summary: 'ignored',
  })).toBeUndefined();

  const record = service.log({
    context: { buildId: 'sk-proj-abcdefghijklmnopqrstuvwxyz', target: '/work/project' },
    details: {
      apiToken: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      '/work/project/secret': 'value',
    },
    kind: 'project.load',
    level: 'info',
    producer: 'project',
    summary: 'token=sk-proj-abcdefghijklmnopqrstuvwxyz at /work/project',
  });
  if (record === undefined) throw new Error('Expected a safe record.');

  const wire = JSON.stringify(record);
  expect(wire).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
  expect(wire).not.toContain('/work/project');
  expect(wire).not.toContain('apiToken');
  expect(record.context).toEqual({});
  expect(record.details).toBe('[UNAVAILABLE]');
});

it('bounds a reentrant live flood by releasing only its offending subscriber', () => {
  const service = new DevLogService({
    projectRoot: '/work/project',
    subscriberByteLimit: 4_096,
    subscriberRecordLimit: 2,
  });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'one' });
  const bad = service.subscribe({ afterSequence: 1 }, (message) => {
    if ('sequence' in message && message.sequence === 2) {
      for (let index = 0; index < 8; index += 1) {
        service.log({ kind: 'project.prepared', level: 'info', producer: 'project', summary: `flood-${index}` });
      }
    }
  });
  const healthy: number[] = [];
  service.subscribe({ afterSequence: 1 }, (message) => {
    if ('sequence' in message) healthy.push(message.sequence);
  });

  service.log({ kind: 'project.invalid-source', level: 'error', producer: 'project', summary: 'two' });

  expect(bad.closed).toBe(true);
  expect(healthy).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

it('rejects nested credential-shaped detail keys before they reach the wire record', () => {
  const service = new DevLogService({ projectRoot: '/work/project' });
  const record = service.log({
    details: { nested: { 'sk-proj-abcdefghijklmnopqrstuvwxyz': 'safe-looking value' } },
    kind: 'project.load',
    level: 'info',
    producer: 'project',
    summary: 'Loaded project.',
  });
  if (record === undefined) throw new Error('Expected a safe record.');

  expect(record.details).toBe('[UNAVAILABLE]');
  expect(JSON.stringify(record)).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
});

it('reports a truthful recovery gap to healthy subscribers after a flood exceeds retained history', () => {
  const service = new DevLogService({
    projectRoot: '/work/project',
    recordLimit: 3,
    subscriberByteLimit: 4_096,
    subscriberRecordLimit: 2,
  });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'one' });
  service.subscribe({ afterSequence: 1 }, (message) => {
    if ('sequence' in message && message.sequence === 2) {
      for (let index = 0; index < 8; index += 1) {
        service.log({ kind: 'project.prepared', level: 'info', producer: 'project', summary: `flood-${index}` });
      }
    }
  });
  const healthy: Array<number | 'gap'> = [];
  service.subscribe({ afterSequence: 1 }, (message) => {
    healthy.push('type' in message ? 'gap' : message.sequence);
  });

  service.log({ kind: 'project.invalid-source', level: 'error', producer: 'project', summary: 'two' });

  expect(healthy).toEqual([2, 3, 4, 'gap', 8, 9, 10]);
});

it('snapshots recovered history before callbacks so a new record cannot skip its retained predecessor', () => {
  const service = new DevLogService({
    projectRoot: '/work/project',
    recordLimit: 3,
    subscriberByteLimit: 4_096,
    subscriberRecordLimit: 2,
  });
  service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'one' });
  service.subscribe({ afterSequence: 1 }, (message) => {
    if ('sequence' in message && message.sequence === 2) {
      for (let index = 0; index < 8; index += 1) {
        service.log({ kind: 'project.prepared', level: 'info', producer: 'project', summary: `flood-${index}` });
      }
    }
  });
  const healthy: Array<number | 'gap'> = [];
  service.subscribe({ afterSequence: 1 }, (message) => {
    healthy.push('type' in message ? 'gap' : message.sequence);
    if ('sequence' in message && message.sequence === 9) {
      service.log({ kind: 'project.load', level: 'info', producer: 'project', summary: 'eleven' });
    }
  });

  service.log({ kind: 'project.invalid-source', level: 'error', producer: 'project', summary: 'two' });

  expect(healthy).toEqual([2, 3, 4, 'gap', 8, 9, 10, 11]);
});
