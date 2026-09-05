import type { TraceEntry, TraceEntryInput } from '../../../agent-bundle/src/contracts/trace.ts';

/** Builds an entry the way `TraceHub.publish` would, from a publisher's input plus its sequence. */
export const traceEntry = (sequence: number, input: TraceEntryInput & { readonly occurredAt: string }): TraceEntry => Object.freeze({
  ...input,
  id: `trc_${String(sequence)}`,
  sequence,
});

const at = (millis: number): string => new Date(Date.UTC(2026, 8, 5, 22, 41, 4, 101) + millis).toISOString();

/**
 * The owner's sample timeline from the PR 2 brief: one Claude session whose
 * hook, kernel, and MCP entries share a conversation, a Workbench-invoked tool
 * on its own, a failed runtime run, and a log line with no correlation.
 */
export const sampleTraceEntries: readonly TraceEntry[] = Object.freeze([
  traceEntry(1, {
    correlation: { conversationId: 'conv-1', host: 'claude', sessionId: 'sess-1' },
    kind: 'session.started',
    occurredAt: at(0),
    source: 'hook',
    summary: 'Claude session started',
  }),
  traceEntry(2, {
    correlation: { conversationId: 'conv-1', executionId: 'exec-1', host: 'claude', invocationId: 'inv_1', routeId: 'event:session/start', sessionId: 'sess-1' },
    details: { result: 'continue' },
    href: '/routes/events/session/start?invocation=inv_1',
    kind: 'hook.completed',
    occurredAt: at(17),
    source: 'hook',
    status: 'ok',
    summary: 'event session/start · result = continue + context',
  }),
  traceEntry(3, {
    correlation: { executionId: 'exec-1' },
    durationMs: 8.1,
    kind: 'kernel.render.finish',
    occurredAt: at(25),
    source: 'kernel',
    summary: 'render complete',
  }),
  traceEntry(4, {
    correlation: { conversationId: 'conv-1', host: 'claude', invocationId: 'inv_2', routeId: 'event:tool/before', sessionId: 'sess-1' },
    href: '/routes/events/tool/before?invocation=inv_2',
    kind: 'hook.completed',
    occurredAt: at(5_431),
    source: 'hook',
    summary: 'tool/before · tool = Bash',
  }),
  traceEntry(5, {
    correlation: { conversationId: 'conv-1', mcpRequestId: '7', mcpSessionId: 'mcp-1', routeId: 'tool:hauler/hauler_status' },
    details: { input: { lane: 'all' } },
    href: '/advanced/protocol?session=mcp-1',
    kind: 'mcp.request',
    occurredAt: at(5_440),
    source: 'mcp',
    summary: 'MCP tools/call hauler_status',
  }),
  traceEntry(6, {
    correlation: { mcpRequestId: '7', mcpSessionId: 'mcp-1' },
    durationMs: 14.7,
    href: '/advanced/protocol?session=mcp-1',
    kind: 'mcp.response',
    occurredAt: at(5_455),
    source: 'mcp',
    summary: 'MCP tools/call hauler_status · complete',
  }),
  traceEntry(7, {
    correlation: { correlationId: 'corr-1', invocationId: 'inv_3', routeId: 'tool:curator/search' },
    durationMs: 120,
    href: '/routes/mcp/curator/tool/search?invocation=inv_3',
    kind: 'invocation.completed',
    occurredAt: at(9_000),
    source: 'invocation',
    status: 'ok',
    summary: 'tool:curator/search succeeded',
  }),
  traceEntry(8, {
    correlation: { host: 'portable', routeId: 'tool:curator/search', runId: 'run_9' },
    href: '/routes/mcp/curator/tool/search?invocation=run_9',
    kind: 'runtime.run.failed',
    occurredAt: at(12_000),
    source: 'runtime',
    status: 'error',
    summary: 'devRuntime run failed: fixture invalid',
  }),
  traceEntry(9, {
    correlation: {},
    kind: 'log.build.started',
    occurredAt: at(15_000),
    source: 'log',
    summary: 'Project build started.',
  }),
]);
