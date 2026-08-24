import type {
  McpSessionOperation,
  McpSessionTraceEntry,
  McpSessionTraceReplayGap,
} from '../../../agent-bundle/src/contracts/mcp-session.ts';
import { isRecord, parseStrictResponseJson } from '../client-helpers.ts';
import { abortableNdjsonStream, readNdjsonResponseFrames, type NdjsonStream } from '../ndjson.ts';
import type { McpRouteTrace } from './mcp-route-client.ts';

export type McpSessionTraceMessage = McpSessionTraceEntry | McpSessionTraceReplayGap;

/** Live frames buffered while a replay snapshot request for the same generation is in flight. */
interface TraceRefresh {
  readonly generation: number;
  readonly live: McpSessionTraceMessage[];
}

export interface McpSessionTraceRefresh {
  /** Stops buffering if this refresh still owns the buffer; for early-exit and failure paths. */
  end(): void;
  /** Publishes the buffered live entries, then stops buffering unconditionally. */
  flush(): void;
}

export interface McpSessionTraceClientOptions {
  createError(message: string): Error;
  isCurrent(generation: number): boolean;
  lastSequence(): number;
  publishEntry(entry: McpSessionTraceMessage): void;
  publishFailure(code: string, reason: unknown): void;
  stream(sessionId: string, after: number, signal?: AbortSignal): Promise<Response>;
}

// Matches the foreground MCP session route's per-subscriber stream byte budget.
const maximumTraceFrameBytes = 256 * 1024;

const validCursor = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const traceOperations = new Set<string>([
  'callTool', 'cancel', 'close', 'getPrompt', 'initialize', 'listPrompts', 'listResources', 'listResourceTemplates', 'listTools', 'readResource', 'restart',
]);
const tracePhases = new Set<string>(['started', 'succeeded', 'failed']);
const isTraceOperation = (value: unknown): value is McpSessionOperation =>
  typeof value === 'string' && traceOperations.has(value);
const isTracePhase = (value: unknown): value is 'failed' | 'started' | 'succeeded' =>
  typeof value === 'string' && tracePhases.has(value);

const traceEntry = (value: unknown, invalid: () => Error): McpSessionTraceMessage => {
  if (!isRecord(value)) throw invalid();
  if (value.type === 'replay.gap') {
    if (
      !validCursor(value.earliestAvailableSequence) || !validCursor(value.latestDroppedSequence) ||
      typeof value.requestedAfterSequence !== 'number' || !Number.isSafeInteger(value.requestedAfterSequence) ||
      value.requestedAfterSequence < 0
    ) throw invalid();
    return {
      earliestAvailableSequence: value.earliestAvailableSequence,
      latestDroppedSequence: value.latestDroppedSequence,
      requestedAfterSequence: value.requestedAfterSequence,
      type: 'replay.gap',
    };
  }
  if (!validCursor(value.sequence) || typeof value.occurredAt !== 'number' || !Number.isFinite(value.occurredAt)) throw invalid();
  if (value.kind === 'frame' && (value.direction === 'client' || value.direction === 'server')) {
    return { direction: value.direction, kind: 'frame', message: value.message, occurredAt: value.occurredAt, sequence: value.sequence };
  }
  if (value.kind === 'stderr' && typeof value.text === 'string') {
    return { kind: 'stderr', occurredAt: value.occurredAt, sequence: value.sequence, text: value.text };
  }
  if (value.kind === 'logging' || value.kind === 'progress') {
    return { kind: value.kind, occurredAt: value.occurredAt, payload: value.payload, sequence: value.sequence };
  }
  if (value.kind === 'operation' && isTraceOperation(value.operation) && isTracePhase(value.phase)) return {
    kind: 'operation',
    occurredAt: value.occurredAt,
    operation: value.operation,
    phase: value.phase,
    sequence: value.sequence,
  };
  throw invalid();
};

const traceOverflow = (value: unknown, invalid: () => Error): McpSessionTraceReplayGap | undefined => {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.afterSequence !== 'number' || !Number.isSafeInteger(value.afterSequence) ||
    typeof value.droppedThroughSequence !== 'number' || !Number.isSafeInteger(value.droppedThroughSequence)
  ) {
    throw invalid();
  }
  if (value.afterSequence < 0 || value.droppedThroughSequence < value.afterSequence) throw invalid();
  return {
    earliestAvailableSequence: value.droppedThroughSequence + 1,
    latestDroppedSequence: value.droppedThroughSequence,
    requestedAfterSequence: value.afterSequence,
    type: 'replay.gap',
  };
};

const isReplayGap = (entry: McpSessionTraceMessage): entry is McpSessionTraceReplayGap =>
  'type' in entry && entry.type === 'replay.gap';

const traceCursor = (entry: McpSessionTraceMessage): number =>
  isReplayGap(entry) ? entry.latestDroppedSequence : entry.sequence;

/** Owns the NDJSON trace subscription, replay-gap validation, and cursor-ordered publishing for one controller. */
export class McpSessionTraceClient {
  readonly #options: McpSessionTraceClientOptions;
  #refresh: TraceRefresh | undefined;
  #stream: NdjsonStream | undefined;
  #task: Promise<void> | undefined;

  constructor(options: McpSessionTraceClientOptions) {
    this.#options = options;
  }

  get task(): Promise<void> | undefined {
    return this.#task;
  }

  abort(): void {
    this.#stream?.close();
  }

  beginRefresh(generation: number): McpSessionTraceRefresh {
    const refresh: TraceRefresh = { generation, live: [] };
    this.#refresh = refresh;
    return {
      end: () => {
        if (this.#refresh === refresh) this.#refresh = undefined;
      },
      flush: () => {
        this.publish(refresh.live);
        this.#refresh = undefined;
      },
    };
  }

  publish(entries: readonly McpSessionTraceMessage[]): void {
    const ordered = entries.length === 1
      ? entries
      : [...entries].sort((left, right) => traceCursor(left) - traceCursor(right));
    for (const entry of ordered) {
      const cursor = traceCursor(entry);
      if (cursor <= this.#options.lastSequence()) continue;
      this.#options.publishEntry(entry);
    }
  }

  replayMessages(trace: McpRouteTrace): readonly McpSessionTraceMessage[] {
    const overflow = traceOverflow(trace.overflow, this.#invalid);
    return Object.freeze([
      ...(overflow === undefined ? [] : [overflow]),
      ...trace.entries.map((entry) => traceEntry(entry, this.#invalid)),
    ]);
  }

  reset(): void {
    this.#stream = undefined;
    this.#task = undefined;
  }

  subscribe(sessionId: string, generation: number): void {
    if (this.#stream !== undefined) return;
    const stream = abortableNdjsonStream(undefined, (signal) => this.#subscribe(sessionId, generation, signal));
    this.#stream = stream;
    const task = stream.done;
    this.#task = task;
    void task.finally(() => {
      if (this.#task === task) this.#task = undefined;
    });
  }

  readonly #invalid = (): Error => this.#options.createError('Foreground MCP trace stream contained an invalid entry.');

  #receive(entry: McpSessionTraceMessage, generation: number): void {
    if (!this.#options.isCurrent(generation)) return;
    if (this.#refresh?.generation === generation) {
      this.#refresh.live.push(entry);
      return;
    }
    this.publish([entry]);
  }

  async #subscribe(sessionId: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.#options.stream(sessionId, this.#options.lastSequence(), signal);
      const receiveLine = (bytes: Uint8Array): void => {
        if (bytes.byteLength === 0) return;
        this.#receive(traceEntry(parseStrictResponseJson(bytes, this.#invalid), this.#invalid), generation);
      };
      await readNdjsonResponseFrames(response, receiveLine, {
        invalidFrameError: this.#invalid,
        maxFrameBytes: maximumTraceFrameBytes,
        missingBodyError: () => this.#options.createError('Foreground MCP trace stream did not include a body.'),
        signal,
      });
      if (!signal.aborted && this.#options.isCurrent(generation)) {
        this.#options.publishFailure('mcp.trace.stream.closed', 'Foreground MCP trace stream closed unexpectedly.');
      }
    } catch (reason) {
      if (!signal.aborted && this.#options.isCurrent(generation)) {
        this.#options.publishFailure('mcp.trace.stream.error', reason);
      }
    }
  }
}
