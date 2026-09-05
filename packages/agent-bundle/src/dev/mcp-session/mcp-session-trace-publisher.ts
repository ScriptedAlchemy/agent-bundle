import { isRecord, type JsonValue } from '../../core/strict-json.ts';
import { mcpCorrelationMetaKey } from '../../contracts/mcp-session.ts';
import { nonemptyString } from '../http.ts';
import { hasControlOrSeparators } from '../logs/dev-log-kinds.ts';
import { safeDevWireText } from '../logs/dev-log-service.ts';
import { applicationNodePath, applicationNodeRefForRouteId } from '../routes/application-node.ts';
import type { TraceCorrelation, TraceEntryInput, TraceStatus } from '../trace/trace-entry.ts';
import type { TracePublisher } from '../trace/trace-hub.ts';
import type {
  McpSessionBinding,
  McpSessionFrameTraceEntry,
  McpSessionId,
  McpSessionNotificationTraceEntry,
  McpSessionOperationTraceEntry,
  McpSessionStderrTraceEntry,
  McpSessionTraceEntry,
  McpSessionTraceMeta,
} from './mcp-session-protocol.ts';
import type { McpSessionTraceSink } from './mcp-session-trace.ts';

/** The `_meta` keys lifted onto a frame and their trace vocabulary, per `docs/entry-conventions.md`. */
const claudeToolUseIdKey = 'claudecode/toolUseId';
const codexTurnMetadataKey = 'x-codex-turn-metadata';

const maxKeyLength = 256;
const maxStderrSummaryLength = 200;
const maxPendingRequests = 1_024;

/** Notification methods the session already records as their own trace entry; their frame is not lowered twice. */
const dedicatedNotificationMethods: ReadonlySet<string> = new Set(['notifications/message', 'notifications/progress']);

export interface LiftedMcpFrame {
  readonly id?: string;
  readonly meta?: McpSessionTraceMeta;
  readonly method?: string;
}

export interface McpSessionTracePublisherOptions {
  readonly binding: McpSessionBinding;
  /** Redaction root for stderr and error text (`safeDevWireText`). */
  readonly projectRoot: string;
  readonly sessionId: McpSessionId;
  readonly trace: TracePublisher;
}

interface PendingRequest {
  readonly at: number;
  readonly correlation: TraceCorrelation;
  readonly label: string;
  readonly method: string;
  readonly progressToken?: string;
}

/** A bounded, NUL-free label such as a method or tool name. */
const wireText = (value: unknown): string | undefined =>
  nonemptyString(value) && value.length <= maxKeyLength ? value : undefined;

/** A correlation key: a label that is also free of control characters and path separators. */
const wireKey = (value: unknown): string | undefined => {
  const text = wireText(value);
  return text !== undefined && !hasControlOrSeparators(text) ? text : undefined;
};

const jsonRpcId = (value: unknown): string | undefined => {
  if (typeof value === 'string') return wireKey(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return undefined;
};

const liftMeta = (meta: unknown): McpSessionTraceMeta | undefined => {
  if (!isRecord(meta)) return undefined;
  const turn = meta[codexTurnMetadataKey];
  const correlationId = wireKey(meta[mcpCorrelationMetaKey]);
  const conversationId = isRecord(turn) ? wireKey(turn.thread_id) : undefined;
  const requestId = wireKey(meta[claudeToolUseIdKey]);
  const sessionId = isRecord(turn) ? wireKey(turn.session_id) : undefined;
  if (correlationId === undefined && conversationId === undefined && requestId === undefined && sessionId === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
};

/** Lifts the JSON-RPC `id`, `method`, and the known `params._meta` keys off one frame; never fails on a foreign shape. */
export const liftMcpFrame = (message: unknown): LiftedMcpFrame => {
  if (!isRecord(message)) return Object.freeze({});
  const id = jsonRpcId(message.id);
  const method = wireText(message.method);
  const meta = isRecord(message.params) ? liftMeta(message.params._meta) : undefined;
  return Object.freeze({
    ...(id === undefined ? {} : { id }),
    ...(meta === undefined ? {} : { meta }),
    ...(method === undefined ? {} : { method }),
  });
};

/** `tool:<server>/<name>` and `prompt:<server>/<name>` from the request; a resource read names a URI, not a route. */
const routeIdFor = (method: string, params: unknown, serverName: string): string | undefined => {
  if (!isRecord(params)) return undefined;
  const name = wireKey(params.name);
  if (name === undefined) return undefined;
  if (method === 'tools/call') return `tool:${serverName}/${name}`;
  if (method === 'prompts/get') return `prompt:${serverName}/${name}`;
  return undefined;
};

const hrefFor = (routeId: string | undefined, sessionId: McpSessionId): string => {
  const node = routeId === undefined ? undefined : applicationNodeRefForRouteId(routeId);
  const path = node === undefined ? '/advanced/protocol' : applicationNodePath(node);
  return `${path}?session=${encodeURIComponent(sessionId)}`;
};

const byteLength = (value: unknown): number => {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : Buffer.byteLength(encoded);
};

const firstLine = (text: string): string => {
  const line = text.trimStart().split(/\r?\n/u, 1)[0] ?? '';
  return line.length <= maxStderrSummaryLength ? line : `${line.slice(0, maxStderrSummaryLength - 1)}…`;
};

const isoTime = (occurredAt: number): string => new Date(occurredAt).toISOString();

/** A frame with a lifted `id` or `method` is a record; a foreign shape reads as empty. */
const messageOf = (entry: McpSessionFrameTraceEntry): Readonly<Record<string, unknown>> =>
  isRecord(entry.message) ? entry.message : {};

/**
 * Lowers one session's `McpSessionTraceEntry` stream onto the unified trace.
 * Each frame becomes one `TraceEntry`; a response inherits its request's
 * correlation by JSON-RPC `id` and measures `durationMs` from it. The full
 * frame stays on the session's own trace behind `href`.
 */
export const createMcpSessionTraceSink = (options: McpSessionTracePublisherOptions): McpSessionTraceSink => {
  const { binding, projectRoot, sessionId, trace } = options;
  const base: TraceCorrelation = Object.freeze({ epochId: binding.epochId, host: binding.target, mcpSessionId: sessionId });
  const pending = new Map<string, PendingRequest>();
  const progressTokens = new Map<string, string>();
  const protocolHref = hrefFor(undefined, sessionId);
  let started = false;
  let closed = false;

  const publish = (input: Omit<TraceEntryInput, 'source'>): void => {
    trace.publish({ ...input, source: 'mcp' });
  };

  const remember = (id: string, request: PendingRequest): void => {
    if (pending.size >= maxPendingRequests) {
      const oldest = pending.keys().next();
      if (!oldest.done) {
        const evicted = pending.get(oldest.value);
        pending.delete(oldest.value);
        if (evicted?.progressToken !== undefined) progressTokens.delete(evicted.progressToken);
      }
    }
    pending.set(id, request);
    if (request.progressToken !== undefined) progressTokens.set(request.progressToken, id);
  };

  const forget = (id: string): PendingRequest | undefined => {
    const request = pending.get(id);
    if (request === undefined) return undefined;
    pending.delete(id);
    if (request.progressToken !== undefined) progressTokens.delete(request.progressToken);
    return request;
  };

  const request = (entry: McpSessionFrameTraceEntry, id: string, method: string): void => {
    const message = messageOf(entry);
    const params = message.params;
    const name = isRecord(params) ? wireText(params.name) : undefined;
    const routeId = routeIdFor(method, params, binding.serverName);
    const meta = entry.meta;
    const correlation: TraceCorrelation = Object.freeze({
      ...base,
      ...(meta?.correlationId === undefined ? {} : { correlationId: meta.correlationId }),
      ...(meta?.conversationId === undefined ? {} : { conversationId: meta.conversationId }),
      mcpRequestId: id,
      ...(meta?.requestId === undefined ? {} : { requestId: meta.requestId }),
      ...(routeId === undefined ? {} : { routeId }),
      ...(meta?.sessionId === undefined ? {} : { sessionId: meta.sessionId }),
    });
    const label = name === undefined ? method : `${method} ${name}`;
    const progressToken = isRecord(params) && isRecord(params._meta) ? jsonRpcId(params._meta.progressToken) : undefined;
    remember(id, {
      at: entry.occurredAt,
      correlation,
      label,
      method,
      ...(progressToken === undefined ? {} : { progressToken }),
    });
    publish({
      correlation,
      details: { method, ...(name === undefined ? {} : { name }), paramsBytes: byteLength(params) },
      href: hrefFor(routeId, sessionId),
      kind: 'mcp.request',
      occurredAt: isoTime(entry.occurredAt),
      status: 'running',
      summary: label,
    });
  };

  const response = (entry: McpSessionFrameTraceEntry, id: string): void => {
    const message = messageOf(entry);
    const matched = forget(id);
    const correlation = matched?.correlation ?? Object.freeze({ ...base, mcpRequestId: id });
    const label = matched?.label ?? 'response';
    const error = isRecord(message.error) ? message.error : undefined;
    const result = message.result;
    const toolError = isRecord(result) && result.isError === true;
    const status: TraceStatus = error !== undefined || toolError ? 'error' : 'ok';
    const details: JsonValue = error === undefined
      ? { ...(toolError ? { isError: true } : {}), resultBytes: byteLength(result) }
      : {
        error: {
          ...(typeof error.code === 'number' && Number.isFinite(error.code) ? { code: error.code } : {}),
          message: typeof error.message === 'string' ? safeDevWireText(error.message, projectRoot) : '',
        },
      };
    publish({
      correlation,
      details,
      ...(matched === undefined ? {} : { durationMs: Math.max(0, entry.occurredAt - matched.at) }),
      href: hrefFor(correlation.routeId, sessionId),
      kind: 'mcp.response',
      occurredAt: isoTime(entry.occurredAt),
      status,
      summary: error === undefined
        ? `${label} ${toolError ? 'tool error' : 'ok'}`
        : `${label} error${typeof error.code === 'number' ? ` ${error.code}` : ''}`,
    });
  };

  const notification = (entry: McpSessionFrameTraceEntry, method: string): void => {
    const message = messageOf(entry);
    const params = message.params;
    const cancelled = method === 'notifications/cancelled' && isRecord(params) ? jsonRpcId(params.requestId) : undefined;
    const matched = cancelled === undefined ? undefined : pending.get(cancelled);
    const correlation = matched?.correlation ?? Object.freeze({ ...base, ...(cancelled === undefined ? {} : { mcpRequestId: cancelled }) });
    publish({
      correlation,
      details: { direction: entry.direction, method },
      href: hrefFor(correlation.routeId, sessionId),
      kind: 'mcp.notification',
      occurredAt: isoTime(entry.occurredAt),
      summary: method,
    });
  };

  const frame = (entry: McpSessionFrameTraceEntry): void => {
    const { id, method } = entry;
    if (method !== undefined && dedicatedNotificationMethods.has(method)) return;
    if (id !== undefined && method !== undefined) return request(entry, id, method);
    if (id !== undefined) return response(entry, id);
    if (method !== undefined) return notification(entry, method);
  };

  const progress = (entry: McpSessionNotificationTraceEntry): void => {
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    const token = payload === undefined ? undefined : jsonRpcId(payload.progressToken);
    const matched = token === undefined ? undefined : pending.get(progressTokens.get(token) ?? token);
    const correlation = matched?.correlation ?? base;
    const current = typeof payload?.progress === 'number' && Number.isFinite(payload.progress) ? payload.progress : undefined;
    const total = typeof payload?.total === 'number' && Number.isFinite(payload.total) ? payload.total : undefined;
    publish({
      correlation,
      details: {
        ...(current === undefined ? {} : { progress: current }),
        ...(token === undefined ? {} : { progressToken: token }),
        ...(total === undefined ? {} : { total }),
      },
      href: hrefFor(correlation.routeId, sessionId),
      kind: 'mcp.progress',
      occurredAt: isoTime(entry.occurredAt),
      status: 'running',
      summary: current === undefined ? 'progress' : `progress ${current}${total === undefined ? '' : `/${total}`}`,
    });
  };

  const logging = (entry: McpSessionNotificationTraceEntry): void => {
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    const level = wireText(payload?.level);
    const logger = wireText(payload?.logger);
    publish({
      correlation: base,
      details: { ...(level === undefined ? {} : { level }), ...(logger === undefined ? {} : { logger }) },
      href: protocolHref,
      kind: 'mcp.logging',
      occurredAt: isoTime(entry.occurredAt),
      summary: `log${level === undefined ? '' : ` ${level}`}${logger === undefined ? '' : ` ${logger}`}`,
    });
  };

  const stderr = (entry: McpSessionStderrTraceEntry): void => {
    publish({
      correlation: base,
      details: { bytes: Buffer.byteLength(entry.text) },
      href: protocolHref,
      kind: 'mcp.stderr',
      occurredAt: isoTime(entry.occurredAt),
      summary: `stderr: ${safeDevWireText(firstLine(entry.text), projectRoot)}`,
    });
  };

  const operation = (entry: McpSessionOperationTraceEntry): void => {
    const label = `${binding.serverName} (${binding.target})`;
    if ((entry.operation === 'initialize' && !started) || entry.operation === 'restart') {
      if (entry.phase !== 'succeeded') return;
      const restarted = started && entry.operation === 'restart';
      started = true;
      publish({
        correlation: base,
        details: { operation: entry.operation },
        href: protocolHref,
        kind: 'mcp.session.started',
        occurredAt: isoTime(entry.occurredAt),
        status: 'ok',
        summary: `MCP session ${label} ${restarted ? 'restarted' : 'started'}`,
      });
      return;
    }
    if (entry.operation === 'close' && entry.phase !== 'started' && !closed) {
      closed = true;
      publish({
        correlation: base,
        details: { operation: entry.operation },
        href: protocolHref,
        kind: 'mcp.session.closed',
        occurredAt: isoTime(entry.occurredAt),
        status: entry.phase === 'failed' ? 'error' : 'ok',
        summary: `MCP session ${label} closed${entry.phase === 'failed' ? ' with cleanup failure' : ''}`,
      });
    }
  };

  return (_binding: McpSessionBinding, entry: McpSessionTraceEntry): void => {
    switch (entry.kind) {
      case 'frame':
        return frame(entry);
      case 'progress':
        return progress(entry);
      case 'logging':
        return logging(entry);
      case 'stderr':
        return stderr(entry);
      case 'operation':
        return operation(entry);
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  };
};
