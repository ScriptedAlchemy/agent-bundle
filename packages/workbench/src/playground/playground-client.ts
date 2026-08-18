import type {
  DraftEvalCase,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from '../../../agent-bundle/src/dev/playground-contract.ts';

export interface PlaygroundClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export interface PlaygroundStreamOptions {
  readonly afterSequence?: number;
  readonly onEvent: (event: PlaygroundTraceEvent) => void;
}

export interface PlaygroundStream {
  close(): void;
  /** Settles when the ndjson body ends, the stream is closed, or the transport fails. */
  readonly done: Promise<void>;
}

export class PlaygroundClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlaygroundClientError';
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): PlaygroundClientError =>
  new PlaygroundClientError('AB8043', 'Playground route returned an invalid response.');

const frozenJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenJson(entry)])));
  }
  return value;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw invalidResponse();
  return value;
};

const diagnosticError = (value: unknown, status: number): PlaygroundClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new PlaygroundClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new PlaygroundClientError('AB8043', `Playground request failed with HTTP ${status}.`);
};

const isSession = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && typeof value.state === 'string' && isRecord(value.identity);

const isRun = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && isSession(value.session);

const isTraceEvent = (value: unknown): boolean =>
  isRecord(value) && typeof value.kind === 'string' && typeof value.rawEventRef === 'string' &&
  typeof value.sequence === 'number' && typeof value.source === 'string' &&
  typeof value.summary === 'string' && typeof value.timestamp === 'string' && Object.hasOwn(value, 'raw');

const sessionBody = (value: unknown): PlaygroundSession => {
  const session = asRecord(value).session;
  if (!isSession(session)) throw invalidResponse();
  return frozenJson(session) as PlaygroundSession;
};

const runBody = (value: unknown): PlaygroundRun => {
  const run = asRecord(value).run;
  if (!isRun(run)) throw invalidResponse();
  return frozenJson(run) as PlaygroundRun;
};

const cancelledBody = (value: unknown): boolean => {
  const cancelled = asRecord(value).cancelled;
  if (typeof cancelled !== 'boolean') throw invalidResponse();
  return cancelled;
};

const traceEvents = (value: unknown): readonly PlaygroundTraceEvent[] => {
  if (!Array.isArray(value) || !value.every(isTraceEvent)) throw invalidResponse();
  return frozenJson(value) as readonly PlaygroundTraceEvent[];
};

const replayBody = (value: unknown): PlaygroundReplay => {
  const replay = asRecord(value).replay;
  const body = asRecord(replay);
  if (!isRecord(body.cursor) || typeof body.cursor.afterSequence !== 'number' || !isSession(body.session)) {
    throw invalidResponse();
  }
  traceEvents(body.events);
  return frozenJson(body) as PlaygroundReplay;
};

const exportBody = (value: unknown): PlaygroundExport => {
  const body = asRecord(asRecord(value).export);
  if (body.schemaVersion !== 1 || !isSession(body.session)) throw invalidResponse();
  traceEvents(body.events);
  return frozenJson(body) as PlaygroundExport;
};

const draftEvalBody = (value: unknown): DraftEvalCase => {
  const body = asRecord(asRecord(value).draftEvalCase);
  if (body.schemaVersion !== 1 || !Array.isArray(body.assertions) || !isRecord(body.epoch) || !isRecord(body.outcome)) {
    throw invalidResponse();
  }
  return frozenJson(body) as DraftEvalCase;
};

const traceEventLine = (line: string): PlaygroundTraceEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw invalidResponse();
  }
  if (!isTraceEvent(parsed)) throw invalidResponse();
  return frozenJson(parsed) as PlaygroundTraceEvent;
};

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** A typed, credential-memory-only browser client for the durable playground trace routes. */
export class PlaygroundClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: PlaygroundClientOptions) {
    this.#foreground = options.foreground;
  }

  /** Starts a server-owned operation and receives its live run and session identity promptly. */
  async run(input: PlaygroundOperationRequest, signal?: AbortSignal): Promise<PlaygroundRun> {
    return runBody(await this.#json('/api/playground/runs', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Cancellation is an operation-level action; callers refresh the durable session afterwards. */
  async cancel(runId: string, signal?: AbortSignal): Promise<boolean> {
    return cancelledBody(await this.#json(`${this.#runPath(runId)}/cancel`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async session(sessionId: string, signal?: AbortSignal): Promise<PlaygroundSession> {
    return sessionBody(await this.#json(this.#path(sessionId), { signal }));
  }

  /** The cursor stays exactly where the caller left it, so replayed order and epoch binding survive. */
  async replay(sessionId: string, afterSequence?: number, signal?: AbortSignal): Promise<PlaygroundReplay> {
    const query = afterSequence === undefined ? '' : `?after=${String(afterSequence)}`;
    return replayBody(await this.#json(`${this.#path(sessionId)}/replay${query}`, { signal }));
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    return exportBody(await this.#json(`${this.#path(sessionId)}/export`));
  }

  async promoteToDraftEval(
    sessionId: string,
    rawEventRefs: readonly string[],
  ): Promise<DraftEvalCase> {
    return draftEvalBody(await this.#json(`${this.#path(sessionId)}/draft-eval`, {
      body: JSON.stringify({ rawEventRefs }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  /** Reads the ndjson trace stream frame by frame; closing aborts the request itself. */
  stream(sessionId: string, options: PlaygroundStreamOptions): PlaygroundStream {
    const controller = new AbortController();
    const done = this.#stream(sessionId, options, controller.signal);
    return Object.freeze({ close: () => controller.abort(), done });
  }

  #path(sessionId: string): string {
    return `/api/playground/sessions/${encodeURIComponent(sessionId)}`;
  }

  #runPath(runId: string): string {
    return `/api/playground/runs/${encodeURIComponent(runId)}`;
  }

  async #stream(sessionId: string, options: PlaygroundStreamOptions, signal: AbortSignal): Promise<void> {
    const after = options.afterSequence ?? 0;
    let response: Response;
    try {
      response = await this.#foreground.protectedRequest(`${this.#path(sessionId)}/stream?after=${String(after)}`, { signal });
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (!response.ok) {
      throw diagnosticError(await response.json().catch(() => undefined), response.status);
    }
    const body = response.body;
    if (body === null) throw invalidResponse();
    const reader = body.getReader();
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
          if (line.length > 0) options.onEvent(traceEventLine(line));
          newline = buffered.indexOf('\n');
        }
      }
      const tail = buffered.trim();
      if (tail.length > 0) options.onEvent(traceEventLine(tail));
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) throw error;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }
}
