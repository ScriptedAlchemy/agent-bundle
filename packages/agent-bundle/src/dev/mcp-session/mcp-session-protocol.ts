/**
 * The stable, browser-safe wire contract for persistent MCP sessions.
 *
 * A session id is intentionally opaque: consumers must use it only as a
 * handle for the session routes, never derive target, server, or epoch data
 * from its representation.
 */
export type McpSessionId = string;

export interface McpSessionBinding {
  readonly epochId: string;
  readonly serverName: string;
  readonly target: string;
}

export interface McpSessionReplayOverflow {
  /** The requested cursor is older than the retained trace window. */
  readonly afterSequence: number;
  /** Replaying from this cursor (or a later one) is complete. */
  readonly droppedThroughSequence: number;
}

interface McpSessionTraceEntryBase {
  /** A strictly increasing session-local cursor. */
  readonly sequence: number;
  /** Unix milliseconds captured when this trace entry was recorded. */
  readonly occurredAt: number;
  readonly kind: McpSessionTraceKind;
}

/**
 * Correlation keys lifted from a request's `params._meta`, lowered to the
 * vocabulary `docs/entry-conventions.md` gives each host: Claude's
 * `claudecode/toolUseId` is the `requestId`; Codex's `x-codex-turn-metadata`
 * names the `conversationId` (`thread_id`) and `sessionId` (`session_id`);
 * `agent-bundle/correlationId` is the Workbench-minted `correlationId`.
 */
export interface McpSessionTraceMeta {
  readonly correlationId?: string;
  readonly conversationId?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
}

export interface McpSessionFrameTraceEntry extends McpSessionTraceEntryBase {
  readonly direction: 'client' | 'server';
  /** The JSON-RPC `id` as a string; absent on notifications. */
  readonly id?: string;
  readonly kind: 'frame';
  /** The exact object observed by the MCP transport; it is never translated. */
  readonly message: unknown;
  /** Lifted from a request's `params._meta`; absent when it carries no known key. */
  readonly meta?: McpSessionTraceMeta;
  /** The JSON-RPC `method`; absent on responses. */
  readonly method?: string;
}

export interface McpSessionStderrTraceEntry extends McpSessionTraceEntryBase {
  readonly kind: 'stderr';
  readonly text: string;
}

export interface McpSessionNotificationTraceEntry extends McpSessionTraceEntryBase {
  readonly kind: 'progress' | 'logging';
  readonly payload: unknown;
}

export interface McpSessionOperationTraceEntry extends McpSessionTraceEntryBase {
  readonly kind: 'operation';
  readonly operation: McpSessionOperation;
  readonly phase: 'started' | 'succeeded' | 'failed';
}

export type McpSessionOperation =
  | 'callTool'
  /** A task-augmented `tools/call` (#369): answered by a `CreateTaskResult`. */
  | 'callToolTask'
  | 'cancel'
  /** `tasks/cancel` of one task the session created. */
  | 'cancelTask'
  | 'getPrompt'
  /** `tasks/get`: the status, progress, and retention of one task. */
  | 'getTask'
  /** `tasks/result`: the final `CallToolResult` of one task, blocking until it settles. */
  | 'getTaskResult'
  | 'initialize'
  | 'listPrompts'
  | 'listResources'
  | 'listResourceTemplates'
  /** `tasks/list`: every task the session still retains. */
  | 'listTasks'
  | 'listTools'
  | 'readResource'
  | 'restart'
  | 'close';

export type McpSessionTraceKind = 'frame' | 'stderr' | 'progress' | 'logging' | 'operation';

/** One ordered stream covering transport, notifications, stderr, and operations. */
export type McpSessionTraceEntry =
  | McpSessionFrameTraceEntry
  | McpSessionStderrTraceEntry
  | McpSessionNotificationTraceEntry
  | McpSessionOperationTraceEntry;

export interface McpSessionTraceReplay {
  readonly entries: readonly McpSessionTraceEntry[];
  readonly overflow?: McpSessionReplayOverflow;
}

export interface McpSessionTraceReplayGap {
  readonly earliestAvailableSequence: number;
  readonly latestDroppedSequence: number;
  readonly requestedAfterSequence: number;
  readonly type: 'replay.gap';
}

export interface McpSessionTraceSubscriptionOptions {
  /** Resume after this trace entry. Omit to replay the retained trace history. */
  readonly afterSequence?: number;
}

/** An atomic replay-plus-live subscription that resumes from a trace cursor. */
export interface McpSessionTraceSubscription {
  readonly unsubscribe: () => void;
}

export type McpSessionTraceMessage = McpSessionTraceEntry | McpSessionTraceReplayGap;

export type McpSessionTraceListener = (entry: McpSessionTraceMessage) => void;

/**
 * A display-only configuration derived from the validated generated artifact.
 * It deliberately omits inherited environment, remote headers, credentials,
 * and browser-provided launch configuration.
 */
export interface McpSessionInspectorConfig {
  readonly origin: 'artifact';
  readonly launch:
    | Readonly<{
      readonly args: readonly string[];
      readonly command: string;
      readonly cwd?: string;
      readonly env: Readonly<Record<string, string>>;
      readonly kind: 'stdio';
    }>
    | Readonly<{
      readonly kind: 'streamable-http';
      /** Credentials, fragments, and query parameters are redacted. */
      readonly url: string;
    }>;
}
