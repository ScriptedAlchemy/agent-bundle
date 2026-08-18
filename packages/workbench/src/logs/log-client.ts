import type {
  DevLogMessage,
  DevLogRecord,
  DevLogReplay,
  DevLogReplayGap,
} from '../../../agent-bundle/src/dev/dev-log-service.ts';
import { snapshotStrictJsonValue, type JsonValue } from '../../../agent-bundle/src/core/strict-json.ts';
import {
  ForegroundRouteClientError,
  type ForegroundRequestAuthority,
} from '../mcp/mcp-route-client.ts';

export interface LogClientOptions {
  /** Reuses Workbench's single foreground session and invalidation authority. */
  readonly foreground: ForegroundRequestAuthority;
}

export interface LogStream {
  close(): void;
  readonly done: Promise<void>;
}

export interface LogStreamOptions {
  readonly afterSequence: number;
  readonly onMessage: (message: DevLogMessage) => void;
}

export class LogClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LogClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const safeContextKeys = new Set(['buildId', 'diagnosticCode', 'epochId', 'hookId', 'projectId', 'runId', 'sessionId', 'target']);
const devLogProducers = Object.freeze(['project', 'build', 'diagnostic', 'mcp', 'hook', 'eval', 'playground'] as const);
const devLogLevels = Object.freeze(['debug', 'info', 'warning', 'error'] as const);
const devLogKinds = Object.freeze({
  build: Object.freeze(['artifact.available', 'build.failed', 'build.started']),
  diagnostic: Object.freeze([
    'artifact.available.diagnostic', 'artifact.status.diagnostic', 'build.failed.diagnostic', 'build.started.diagnostic',
    'invalidation.diagnostic', 'runtime.event.diagnostic', 'source.changed.diagnostic', 'source.status.diagnostic',
  ]),
  eval: Object.freeze(['eval.run.completed', 'eval.run.failed', 'eval.run.started']),
  hook: Object.freeze(['hook.simulate.completed', 'hook.simulate.failed', 'hook.simulate.started']),
  mcp: Object.freeze(['mcp.logging', 'mcp.stderr', 'mcp.operation.failed', 'mcp.operation.started', 'mcp.operation.succeeded']),
  playground: Object.freeze(['playground.event.appended']),
  project: Object.freeze([
    'artifact.status', 'dev.shutdown.completed', 'dev.shutdown.started', 'invalidation', 'project.events.replay-gap',
    'project.invalid-source', 'project.load', 'project.prepared', 'runtime.event', 'source.changed', 'source.status',
  ]),
});
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const isProducer = (value: unknown): value is keyof typeof devLogKinds =>
  typeof value === 'string' && (devLogProducers as readonly string[]).includes(value);
const isLevel = (value: unknown): boolean => typeof value === 'string' && (devLogLevels as readonly string[]).includes(value);
const isContext = (value: unknown): value is Readonly<Record<string, string>> => isRecord(value) && Object.entries(value).every(([key, entry]) =>
  safeContextKeys.has(key) && typeof entry === 'string' && safeIdentifier.test(entry));

const isDevRecord = (value: unknown): value is DevLogRecord => {
  if (!isRecord(value) || !isProducer(value.producer)) return false;
  return value.schemaVersion === 1 && safeInteger(value.sequence, 1) && isDate(value.occurredAt) && isLevel(value.level) &&
    typeof value.kind === 'string' && (devLogKinds[value.producer] as readonly string[]).includes(value.kind) &&
    typeof value.summary === 'string' && value.summary.length > 0 && isContext(value.context) && Object.hasOwn(value, 'details');
};

const isGap = (value: unknown): value is DevLogReplayGap => isRecord(value) && value.type === 'replay.gap' &&
  safeInteger(value.requestedAfterSequence) && safeInteger(value.earliestAvailableSequence, 1) && safeInteger(value.latestDroppedSequence) &&
  value.earliestAvailableSequence === value.latestDroppedSequence + 1 && value.requestedAfterSequence < value.earliestAvailableSequence;

const invalid = (): LogClientError => new LogClientError('AB8093', 'Dev Log route returned an invalid response.');

const snapshot = (value: unknown): JsonValue => {
  try { return snapshotStrictJsonValue(value); }
  catch { throw invalid(); }
};

const contiguous = (records: readonly DevLogRecord[], afterSequence: number): boolean => records.every((record, index) =>
  record.sequence === afterSequence + index + 1);

const replayFor = (value: unknown, afterSequence: number): DevLogReplay => {
  const detached = snapshot(value);
  if (!isRecord(detached) || !isRecord(detached.replay) || !isRecord(detached.replay.cursor) ||
    !safeInteger(detached.replay.cursor.afterSequence) || detached.replay.cursor.afterSequence < afterSequence ||
    !Array.isArray(detached.replay.records) || !detached.replay.records.every(isDevRecord) ||
    (detached.replay.gap !== undefined && !isGap(detached.replay.gap))) throw invalid();
  const replay = detached.replay as unknown as DevLogReplay;
  const records = replay.records;
  const gap = replay.gap;
  if (
    !contiguous(records, gap === undefined ? afterSequence : gap.earliestAvailableSequence - 1)
    || (gap !== undefined && gap.requestedAfterSequence !== afterSequence)
    || (records.length > 0 && replay.cursor.afterSequence !== records.at(-1)?.sequence)
    || (records.length === 0 && replay.cursor.afterSequence !== (gap?.latestDroppedSequence ?? afterSequence))
  ) throw invalid();
  return Object.freeze({
    cursor: Object.freeze({ afterSequence: replay.cursor.afterSequence }),
    ...(gap === undefined ? {} : { gap: Object.freeze({ ...gap }) }),
    records: Object.freeze(records.map((record) => Object.freeze({
      ...record,
      context: Object.freeze({ ...record.context }),
      details: record.details,
    }))),
  });
};

const messageFor = (line: string): DevLogMessage => {
  try {
    const parsed: unknown = snapshot(JSON.parse(line));
    if (isDevRecord(parsed) || isGap(parsed)) return parsed;
  } catch { /* The fixed client error below is the browser-visible boundary. */ }
  throw invalid();
};

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** Same-origin cursor client for redacted production logs; it has no raw attachment API. */
export class LogClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: LogClientOptions) {
    this.#foreground = options.foreground;
  }

  async replay(afterSequence = 0, signal?: AbortSignal): Promise<DevLogReplay> {
    if (!safeInteger(afterSequence)) throw invalid();
    const response = await this.#request(`/api/logs/replay?after=${String(afterSequence)}`, { signal });
    return replayFor(await response.json().catch(() => undefined), afterSequence);
  }

  stream(options: LogStreamOptions): LogStream {
    const controller = new AbortController();
    return Object.freeze({ close: () => controller.abort(), done: this.#stream(options, controller.signal) });
  }

  async #stream(options: LogStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#request(`/api/logs/stream?after=${String(options.afterSequence)}`, { signal });
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (response.body === null) throw invalid();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let expectedSequence = options.afterSequence + 1;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) {
            const message = messageFor(line);
            if ('sequence' in message) {
              if (message.sequence !== expectedSequence) throw invalid();
              expectedSequence += 1;
            } else {
              if (message.requestedAfterSequence !== options.afterSequence) throw invalid();
              expectedSequence = message.earliestAvailableSequence;
            }
            options.onMessage(message);
          }
          newline = buffered.indexOf('\n');
        }
      }
      if (buffered.length > 0) throw invalid();
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.#foreground.protectedRequest(path, init);
      if (!response.ok) {
        const error = ForegroundRouteClientError.fromResponse(await response.clone().json().catch(() => undefined), response.status);
        throw new LogClientError(error.code, error.message);
      }
      return response;
    } catch (error) {
      if (error instanceof LogClientError) throw error;
      if (error instanceof ForegroundRouteClientError) throw new LogClientError(error.code, error.message);
      throw error;
    }
  }
}
