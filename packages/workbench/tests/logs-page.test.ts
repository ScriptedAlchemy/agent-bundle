import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { DevLogRecord } from '../../agent-bundle/src/dev/dev-log-service.ts';
import { LogsPage, LogsView } from '../src/logs/logs-page.tsx';
import { logsViewFor } from '../src/logs/logs-model.ts';

const records: readonly DevLogRecord[] = Object.freeze([
  Object.freeze({
    context: Object.freeze({ epochId: 'epoch-1', target: 'codex' }),
    details: Object.freeze({ changed: ['src/index.ts'] }),
    kind: 'build.started',
    level: 'info',
    occurredAt: '2026-08-18T12:00:00.000Z',
    producer: 'build',
    schemaVersion: 1,
    sequence: 1,
    summary: 'Project build started.',
  }),
  Object.freeze({
    context: Object.freeze({ diagnosticCode: 'BUILD_FAILED', epochId: 'epoch-1' }),
    details: Object.freeze({ message: 'Build failed.' }),
    kind: 'build.failed.diagnostic',
    level: 'error',
    occurredAt: '2026-08-18T12:01:00.000Z',
    producer: 'diagnostic',
    schemaVersion: 1,
    sequence: 2,
    summary: 'Project diagnostic was recorded.',
  }),
]);

it('renders producer-wide records newest first and filters producer, level, kind, and context', () => {
  const view = logsViewFor({
    context: 'epoch-1',
    gap: undefined,
    kind: 'build.failed.diagnostic',
    level: 'error',
    producer: 'diagnostic',
    records,
  });
  const markup = renderToStaticMarkup(createElement(LogsView, { view }));

  expect(markup).toContain('#2');
  expect(markup).not.toContain('#1');
  expect(markup).toContain('<summary>Details</summary>');
  expect(markup).toContain('error');
  expect(markup).not.toContain('Raw payload');
});

it('renders independent production log filters without a playground session', () => {
  const markup = renderToStaticMarkup(createElement(LogsPage, {
    client: {
      replay: async () => ({ cursor: { afterSequence: 0 }, records }),
      stream: () => ({ close: () => undefined, done: Promise.resolve() }),
    },
    records,
  }));

  expect(markup).toContain('id="logs-producer"');
  expect(markup).toContain('id="logs-level"');
  expect(markup).toContain('id="logs-kind"');
  expect(markup).toContain('id="logs-context"');
  expect(markup).toContain('Project diagnostic was recorded.');
});
