import { expect, it } from '@rstest/core';

import {
  formatTraceDuration,
  formatTraceTime,
  groupTraceEntries,
  maximumTraceEntries,
  mergeTraceEntries,
  selectTraceEntry,
  selectTraceGroup,
  traceKindLabel,
  traceSourceGlyph,
} from '../src/trace/trace-model.ts';
import { sampleTraceEntries, traceEntry } from './support/trace-fixtures.ts';

const sequences = (entries: readonly { readonly sequence: number }[]): readonly number[] => entries.map((entry) => entry.sequence);

it('merges replay and live entries by sequence, keeps the first copy of a duplicate, and bounds the list', () => {
  const [first, second, third, fourth] = sampleTraceEntries;
  const merged = mergeTraceEntries([first!, third!], [second!, { ...third!, summary: 'a later duplicate' }, fourth!]);
  expect(sequences(merged)).toEqual([1, 2, 3, 4]);
  expect(merged[2]?.summary).toBe('render complete');
  expect(Object.isFrozen(merged)).toBe(true);

  const many = Array.from({ length: maximumTraceEntries + 2 }, (_value, index) => ({ ...first!, id: `trc_${String(index + 1)}`, sequence: index + 1 }));
  const bounded = mergeTraceEntries([], many);
  expect(bounded).toHaveLength(maximumTraceEntries);
  expect(bounded[0]?.sequence).toBe(3);
});

it('groups entries that share any join key transitively and names the group by its strongest key', () => {
  const groups = groupTraceEntries(sampleTraceEntries);
  expect(groups.map((group) => [group.key, group.keyKind, sequences(group.rows.map((row) => row.entry))])).toEqual([
    ['conversationId:conv-1', 'conversationId', [1, 2, 3, 4, 5, 6]],
    ['invocationId:inv_3', 'invocationId', [7]],
    ['entry:trc_8', 'entry', [8]],
  ]);
  const session = groups[0]!;
  expect(session.headline.kind).toBe('session.started');
  expect(session.status).toBe('ok');
  expect(session.spanMs).toBe(5_455);
  expect(session.startedAt).toBe(sampleTraceEntries[0]!.occurredAt);
  expect(session.endedAt).toBe(sampleTraceEntries[5]!.occurredAt);
  expect(session.rows.map((row) => [row.entry.source, row.depth])).toEqual([
    ['hook', 0], ['hook', 0], ['kernel', 1], ['hook', 0], ['mcp', 1], ['mcp', 1],
  ]);
  expect(groups[1]?.spanMs).toBe(sampleTraceEntries[6]!.durationMs);
  expect(groups[2]?.status).toBe('ok');
  expect(groups[2]?.rows[0]?.depth).toBe(0);
  expect(groups[2]?.spanMs).toBe(0);
  expect(Object.isFrozen(groups) && groups.every((group) => Object.isFrozen(group) && Object.isFrozen(group.rows))).toBe(true);
});

it('does not join on facets, treats an MCP request id as session-scoped, and reports a trailing running entry', () => {
  const entries = [
    traceEntry(1, { correlation: { host: 'claude', routeId: 'tool:a/b', epochId: 'e1' }, kind: 'invocation.started', occurredAt: '2026-09-05T07:00:00.000Z', source: 'invocation', status: 'running', summary: 'a' }),
    traceEntry(2, { correlation: { host: 'claude', routeId: 'tool:a/b', epochId: 'e1' }, kind: 'invocation.started', occurredAt: '2026-09-05T07:00:01.000Z', source: 'invocation', status: 'running', summary: 'b' }),
    traceEntry(3, { correlation: { mcpRequestId: '1', mcpSessionId: 's1' }, kind: 'mcp.request', occurredAt: '2026-09-05T07:00:02.000Z', source: 'mcp', summary: 'c' }),
    traceEntry(4, { correlation: { mcpRequestId: '1', mcpSessionId: 's2' }, kind: 'mcp.request', occurredAt: '2026-09-05T07:00:03.000Z', source: 'mcp', summary: 'd' }),
    traceEntry(5, { correlation: { mcpRequestId: '1' }, kind: 'mcp.request', occurredAt: '2026-09-05T07:00:04.000Z', source: 'mcp', summary: 'e' }),
  ];
  const groups = groupTraceEntries(entries);
  expect(groups.map((group) => [group.key, sequences(group.rows.map((row) => row.entry))])).toEqual([
    ['entry:trc_1', [1]],
    ['entry:trc_2', [2]],
    ['mcpSessionId:s1', [3]],
    ['mcpSessionId:s2', [4]],
    ['entry:trc_5', [5]],
  ]);
  expect(groups[0]?.status).toBe('running');
  expect(groupTraceEntries([])).toEqual([]);
});

it('joins the same correlation value across publisher-specific keys', () => {
  const groups = groupTraceEntries([
    traceEntry(1, {
      correlation: { mcpSessionId: 'session-1' },
      kind: 'mcp.request',
      occurredAt: '2026-09-05T12:00:00.000Z',
      source: 'mcp',
      summary: 'tools/call search_audible',
    }),
    traceEntry(2, {
      correlation: { sessionId: 'session-1' },
      kind: 'hook.received',
      occurredAt: '2026-09-05T12:00:00.001Z',
      source: 'hook',
      summary: 'hook receipt',
    }),
  ]);

  expect(groups).toHaveLength(1);
  expect(groups[0]?.key).toBe('sessionId:session-1');
  expect(sequences(groups[0]!.rows.map((row) => row.entry))).toEqual([1, 2]);
});

it('selects a group by any correlation value and an entry by its id or a PR 1 invocation id', () => {
  const groups = groupTraceEntries(sampleTraceEntries);
  expect(selectTraceGroup(groups, 'exec-1')?.key).toBe('conversationId:conv-1');
  expect(selectTraceGroup(groups, 'mcp-1')?.key).toBe('conversationId:conv-1');
  expect(selectTraceGroup(groups, 'corr-1')?.key).toBe('invocationId:inv_3');
  expect(selectTraceGroup(groups, 'nope')).toBeUndefined();

  expect(selectTraceEntry(sampleTraceEntries, 'trc_3')?.sequence).toBe(3);
  expect(selectTraceEntry(sampleTraceEntries, 'inv_3')?.sequence).toBe(7);
  expect(selectTraceEntry(sampleTraceEntries, 'exec-1')).toBeUndefined();
});

it('formats times to the millisecond, durations by magnitude, and kinds to short labels', () => {
  expect(formatTraceTime('2026-09-05T22:41:04.101Z', 'UTC')).toBe('22:41:04.101');
  expect(formatTraceTime('2026-09-05T00:00:00.000Z', 'UTC')).toBe('00:00:00.000');
  expect(formatTraceTime('not a date', 'UTC')).toBe('not a date');
  expect(formatTraceDuration(0.4)).toBe('<1 ms');
  expect(formatTraceDuration(3.21)).toBe('3.2 ms');
  expect(formatTraceDuration(14.7)).toBe('15 ms');
  expect(formatTraceDuration(1_250)).toBe('1.25 s');
  expect(formatTraceDuration(-1)).toBe('');
  expect(traceKindLabel(sampleTraceEntries[2]!)).toBe('render finished');
  expect(traceKindLabel(sampleTraceEntries[7]!)).toBe('build started');
  expect(traceKindLabel(traceEntry(1, { correlation: {}, kind: 'mcp.tasks.polled', occurredAt: '2026-09-05T07:00:00.000Z', source: 'mcp', summary: 'x' }))).toBe('tasks polled');
  expect(traceKindLabel(traceEntry(1, { correlation: {}, kind: 'session.started', occurredAt: '2026-09-05T07:00:00.000Z', source: 'hook', summary: 'x' }))).toBe('session started');
  expect(new Set(['invocation', 'kernel', 'mcp', 'hook', 'session', 'log', 'diagnostic'].map((source) => traceSourceGlyph(source as 'mcp'))).size).toBe(7);
});
