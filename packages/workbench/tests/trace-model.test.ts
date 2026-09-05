import { expect, it } from '@rstest/core';

import {
  filterTraceGroups,
  formatTraceDuration,
  formatTraceTime,
  groupTraceEntries,
  isEmptyTraceFilter,
  matchesTraceFilter,
  maximumTraceEntries,
  mergeTraceEntries,
  selectTraceEntry,
  selectTraceGroup,
  traceEntryCorrelationValues,
  traceFacetsFor,
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
    ['runId:run_9', 'runId', [8]],
    ['entry:trc_9', 'entry', [9]],
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
  expect(groups[2]?.status).toBe('error');
  expect(groups[3]?.rows[0]?.depth).toBe(0);
  expect(groups[3]?.spanMs).toBe(0);
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
    ['mcpRequestId:s1/1', [3]],
    ['mcpRequestId:s2/1', [4]],
    ['entry:trc_5', [5]],
  ]);
  expect(groups[0]?.status).toBe('running');
  expect(groupTraceEntries([])).toEqual([]);
});

it('filters rows by source, host, route, status, and text while keeping group identity, and drops empty groups', () => {
  const groups = groupTraceEntries(sampleTraceEntries);
  const mcpOnly = filterTraceGroups(groups, { sources: new Set(['mcp']) });
  expect(mcpOnly.map((group) => [group.key, sequences(group.rows.map((row) => row.entry))])).toEqual([['conversationId:conv-1', [5, 6]]]);
  expect(mcpOnly[0]?.headline.kind).toBe('session.started');

  expect(filterTraceGroups(groups, { host: 'portable' }).map((group) => group.key)).toEqual(['runId:run_9']);
  expect(filterTraceGroups(groups, { routeId: 'tool:curator/search' }).map((group) => group.key)).toEqual(['invocationId:inv_3', 'runId:run_9']);
  expect(filterTraceGroups(groups, { status: 'error' }).map((group) => group.key)).toEqual(['runId:run_9']);
  expect(filterTraceGroups(groups, { status: 'ok' }).flatMap((group) => sequences(group.rows.map((row) => row.entry)))).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
  expect(filterTraceGroups(groups, { text: '  HAULER_status ' }).flatMap((group) => sequences(group.rows.map((row) => row.entry)))).toEqual([5, 6]);
  expect(filterTraceGroups(groups, { text: 'render.finish' }).flatMap((group) => sequences(group.rows.map((row) => row.entry)))).toEqual([3]);
  expect(filterTraceGroups(groups, { sources: new Set(['diagnostic']) })).toEqual([]);

  expect(filterTraceGroups(groups, {})).toBe(groups);
  expect(isEmptyTraceFilter({ sources: new Set(), text: '   ' })).toBe(true);
  expect(isEmptyTraceFilter({ host: 'claude' })).toBe(false);
  expect(matchesTraceFilter(sampleTraceEntries[7]!, { status: 'error', host: 'portable' })).toBe(true);
  expect(matchesTraceFilter(sampleTraceEntries[7]!, { status: 'error', host: 'claude' })).toBe(false);
});

it('exposes facets in a stable order', () => {
  expect(traceFacetsFor(sampleTraceEntries)).toEqual({
    hosts: ['claude', 'portable'],
    routeIds: ['event:session/start', 'event:tool/before', 'tool:curator/search', 'tool:hauler/hauler_status'],
    sources: ['hook', 'invocation', 'runtime', 'mcp', 'kernel', 'log'],
  });
});

it('selects a group by any correlation value and an entry by its id or a PR 1 invocation id', () => {
  const groups = groupTraceEntries(sampleTraceEntries);
  expect(selectTraceGroup(groups, 'exec-1')?.key).toBe('conversationId:conv-1');
  expect(selectTraceGroup(groups, 'mcp-1')?.key).toBe('conversationId:conv-1');
  expect(selectTraceGroup(groups, 'trc_8')?.key).toBe('runId:run_9');
  expect(selectTraceGroup(groups, 'corr-1')?.key).toBe('invocationId:inv_3');
  expect(selectTraceGroup(groups, 'nope')).toBeUndefined();

  expect(selectTraceEntry(sampleTraceEntries, 'trc_3')?.sequence).toBe(3);
  expect(selectTraceEntry(sampleTraceEntries, 'inv_3')?.sequence).toBe(7);
  expect(selectTraceEntry(sampleTraceEntries, 'run_9')?.sequence).toBe(8);
  expect(selectTraceEntry(sampleTraceEntries, 'exec-1')).toBeUndefined();
  expect(traceEntryCorrelationValues(sampleTraceEntries[5]!)).toEqual(['trc_6', '7', 'mcp-1']);
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
  expect(traceKindLabel(sampleTraceEntries[8]!)).toBe('build started');
  expect(traceKindLabel(traceEntry(1, { correlation: {}, kind: 'mcp.tasks.polled', occurredAt: '2026-09-05T07:00:00.000Z', source: 'mcp', summary: 'x' }))).toBe('tasks polled');
  expect(traceKindLabel(traceEntry(1, { correlation: {}, kind: 'session.started', occurredAt: '2026-09-05T07:00:00.000Z', source: 'hook', summary: 'x' }))).toBe('session started');
  expect(new Set(['invocation', 'kernel', 'mcp', 'runtime', 'hook', 'log', 'diagnostic'].map((source) => traceSourceGlyph(source as 'mcp'))).size).toBe(7);
});
