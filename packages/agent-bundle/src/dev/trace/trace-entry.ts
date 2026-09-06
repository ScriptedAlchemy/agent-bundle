import type { JsonValue } from '../../core/strict-json.ts';

export const traceSources = Object.freeze([
  /** `RouteInvocation` lifecycle from `/api/routes/invocations`. */
  'invocation',
  /** `EventTraceEvent` from the execution kernel (`events/trace.ts`) observed inside a render. */
  'kernel',
  /** JSON-RPC frames, progress, and logging on a Workbench-owned MCP session. */
  'mcp',
  /** `devRuntime` provider runs and generations. */
  'runtime',
  /** A host-invoked hook or event route observed against the dev plugin. */
  'hook',
  /** A dev log record that carries a correlation key. */
  'log',
  /** Build, contract-gate, and host-attach diagnostics. */
  'diagnostic',
] as const);

export type TraceSource = (typeof traceSources)[number];

export type TraceStatus = 'ok' | 'error' | 'running';

/**
 * Every key a publisher can know. Entries join on any shared key; the
 * Workbench groups by `conversationId` → `sessionId` → `invocationId` /
 * `executionId` and falls back to `correlationId`.
 */
export interface TraceCorrelation {
  /** Browser-minted id the route workspace attaches to a run (`RouteInvocationRequest.correlationId`). */
  readonly correlationId?: string;
  readonly conversationId?: string;
  readonly epochId?: string;
  /** Kernel execution id (`EventTraceExecution.executionId`). */
  readonly executionId?: string;
  /** Compiled target name (`claude`, `codex`, `cursor`, `portable`). */
  readonly host?: string;
  /** `RouteInvocation.id` (`inv_…`). */
  readonly invocationId?: string;
  /** JSON-RPC `id` of the MCP request this entry belongs to. */
  readonly mcpRequestId?: string;
  readonly mcpSessionId?: string;
  readonly requestId?: string;
  /** Compiled route id (`tool:<server>/<name>`, `event:tool/before`, …). */
  readonly routeId?: string;
  /** `devRuntime` run id. */
  readonly runId?: string;
  readonly sessionId?: string;
}

export interface TraceEntryInput {
  readonly correlation: TraceCorrelation;
  /** Slim, already-safe details (no absolute paths, no credentials); bounded by the hub. */
  readonly details?: JsonValue;
  readonly durationMs?: number;
  /** Workbench path that opens the full record, e.g. `/routes/mcp/curator/tool/search?invocation=inv_1`. */
  readonly href?: string;
  /** Dotted, publisher-owned kind: `invocation.completed`, `kernel.render.finish`, `mcp.request`, … */
  readonly kind: string;
  readonly occurredAt?: string;
  readonly source: TraceSource;
  readonly status?: TraceStatus;
  /** One line, ≤ 240 characters. */
  readonly summary: string;
}

export interface TraceEntry extends TraceEntryInput {
  readonly id: string;
  readonly occurredAt: string;
  readonly sequence: number;
}

export interface TraceReplayGap {
  readonly droppedCount: number;
  readonly firstAvailableSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'trace.gap';
}

export type TraceMessage = TraceEntry | TraceReplayGap;

export interface TraceReplay {
  readonly entries: readonly TraceEntry[];
  readonly gap?: TraceReplayGap;
  readonly latestSequence: number;
}

export const isTraceSource = (value: unknown): value is TraceSource =>
  typeof value === 'string' && (traceSources as readonly string[]).includes(value);

export const isTraceReplayGap = (message: TraceMessage): message is TraceReplayGap =>
  'type' in message && message.type === 'trace.gap';
