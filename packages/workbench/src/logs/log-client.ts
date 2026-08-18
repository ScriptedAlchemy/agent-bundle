import type { DevLogMessage, DevLogRecord, DevLogReplay, DevLogReplayGap } from '../../../agent-bundle/src/dev/dev-log-service.ts';
import { ForegroundTransport } from '../foreground-session.ts';

export interface LogClientOptions {
  readonly fetch?: typeof fetch;
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

const isDevRecord = (value: unknown): value is DevLogRecord => isRecord(value) &&
  value.schemaVersion === 1 && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
  typeof value.occurredAt === 'string' && typeof value.producer === 'string' && typeof value.level === 'string' &&
  typeof value.kind === 'string' && typeof value.summary === 'string' && isRecord(value.context) && Object.hasOwn(value, 'details');

const isGap = (value: unknown): value is DevLogReplayGap => isRecord(value) && value.type === 'replay.gap' &&
  typeof value.requestedAfterSequence === 'number' && typeof value.earliestAvailableSequence === 'number' && typeof value.latestDroppedSequence === 'number';

const invalid = (): LogClientError => new LogClientError('AB8093', 'Dev Log route returned an invalid response.');

const replayFor = (value: unknown): DevLogReplay => {
  if (!isRecord(value) || !isRecord(value.replay) || !isRecord(value.replay.cursor) ||
    typeof value.replay.cursor.afterSequence !== 'number' || !Array.isArray(value.replay.records) ||
    !value.replay.records.every(isDevRecord) || (value.replay.gap !== undefined && !isGap(value.replay.gap))) throw invalid();
  return value.replay as unknown as DevLogReplay;
};

const messageFor = (line: string): DevLogMessage => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isDevRecord(parsed) || isGap(parsed)) return parsed;
  } catch { /* The fixed client error below is the browser-visible boundary. */ }
  throw invalid();
};

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** Same-origin cursor client for redacted production logs; it has no raw attachment API. */
export class LogClient {
  readonly #transport: ForegroundTransport;

  constructor(options: LogClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new LogClientError(code, message),
      fallbackCode: 'AB8093',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Dev Log',
    });
  }

  async replay(afterSequence = 0, signal?: AbortSignal): Promise<DevLogReplay> {
    return replayFor(await this.#transport.json(`/api/logs/replay?after=${String(afterSequence)}`, { signal }));
  }

  stream(options: LogStreamOptions): LogStream {
    const controller = new AbortController();
    return Object.freeze({ close: () => controller.abort(), done: this.#stream(options, controller.signal) });
  }

  async #stream(options: LogStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#transport.request(`/api/logs/stream?after=${String(options.afterSequence)}`, { signal });
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (!response.ok) throw this.#transport.diagnosticError(await response.json().catch(() => undefined), response.status);
    if (response.body === null) throw invalid();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline >= 0) {
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line.length > 0) options.onMessage(messageFor(line));
          newline = buffered.indexOf('\n');
        }
      }
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
