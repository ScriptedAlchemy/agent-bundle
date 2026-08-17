import type {
  DraftEvalCase,
  PlaygroundDurableOutcome,
  PlaygroundEventInput,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundSelectedAssertion,
  PlaygroundSession,
  PlaygroundSessionInput,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';

export interface PlaygroundClientOptions {
  readonly fetch?: typeof fetch;
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

interface ForegroundSession {
  readonly origin: string;
  readonly token: string;
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

const isTraceEvent = (value: unknown): boolean =>
  isRecord(value) && typeof value.kind === 'string' && typeof value.rawEventRef === 'string' &&
  typeof value.sequence === 'number' && typeof value.source === 'string' &&
  typeof value.summary === 'string' && typeof value.timestamp === 'string' && Object.hasOwn(value, 'raw');

const sessionBody = (value: unknown): PlaygroundSession => {
  const session = asRecord(value).session;
  if (!isSession(session)) throw invalidResponse();
  return frozenJson(session) as PlaygroundSession;
};

const eventBody = (value: unknown): PlaygroundTraceEvent => {
  const event = asRecord(value).event;
  if (!isTraceEvent(event)) throw invalidResponse();
  return frozenJson(event) as PlaygroundTraceEvent;
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
  readonly #fetch: typeof fetch;
  #authentication: Promise<ForegroundSession> | undefined;

  constructor(options: PlaygroundClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async openSession(input: PlaygroundSessionInput, signal?: AbortSignal): Promise<PlaygroundSession> {
    return sessionBody(await this.#json('/api/playground/sessions', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async session(sessionId: string): Promise<PlaygroundSession> {
    return sessionBody(await this.#json(this.#path(sessionId)));
  }

  async closeSession(sessionId: string): Promise<void> {
    const body = asRecord(await this.#json(this.#path(sessionId), { method: 'DELETE' }));
    if (body.closed !== true) throw invalidResponse();
  }

  async reopen(sessionId: string): Promise<PlaygroundSession> {
    return sessionBody(await this.#json(`${this.#path(sessionId)}/reopen`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async append(sessionId: string, input: PlaygroundEventInput): Promise<PlaygroundTraceEvent> {
    return eventBody(await this.#json(`${this.#path(sessionId)}/events`, {
      body: JSON.stringify({ kind: input.kind, raw: input.raw, source: input.source, summary: input.summary }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async finalize(sessionId: string, outcome: PlaygroundDurableOutcome): Promise<PlaygroundSession> {
    return sessionBody(await this.#json(`${this.#path(sessionId)}/finalize`, {
      body: JSON.stringify(outcome),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  /** The cursor stays exactly where the caller left it, so replayed order and epoch binding survive. */
  async replay(sessionId: string, afterSequence?: number): Promise<PlaygroundReplay> {
    const query = afterSequence === undefined ? '' : `?after=${String(afterSequence)}`;
    return replayBody(await this.#json(`${this.#path(sessionId)}/replay${query}`));
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    return exportBody(await this.#json(`${this.#path(sessionId)}/export`));
  }

  async promoteToDraftEval(
    sessionId: string,
    assertions: readonly PlaygroundSelectedAssertion[],
  ): Promise<DraftEvalCase> {
    return draftEvalBody(await this.#json(`${this.#path(sessionId)}/draft-eval`, {
      body: JSON.stringify({ assertions }),
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

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#authentication = undefined;
  }

  #path(sessionId: string): string {
    return `/api/playground/sessions/${encodeURIComponent(sessionId)}`;
  }

  async #stream(sessionId: string, options: PlaygroundStreamOptions, signal: AbortSignal): Promise<void> {
    const after = options.afterSequence ?? 0;
    const authentication = await this.#authenticate();
    let response: Response;
    try {
      response = await this.#fetch(`${this.#path(sessionId)}/stream?after=${String(after)}`, {
        headers: { 'x-agent-bundle-session': authentication.token },
        signal,
      });
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
    const authentication = await this.#authenticate();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await this.#fetch(path, { ...init, headers });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    return body;
  }

  async #authenticate(): Promise<ForegroundSession> {
    if (this.#authentication === undefined) this.#authentication = this.#bootstrap();
    try {
      return await this.#authentication;
    } catch (error) {
      this.#authentication = undefined;
      throw error;
    }
  }

  async #bootstrap(): Promise<ForegroundSession> {
    const response = await this.#fetch('/api/project/session', { credentials: 'same-origin' });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw diagnosticError(body, response.status);
    const session = asRecord(body);
    if (typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) {
      throw new PlaygroundClientError('AB8043', 'Foreground session bootstrap returned an invalid response.');
    }
    let origin: URL;
    try {
      origin = new URL(session.origin);
    } catch {
      throw new PlaygroundClientError('AB8043', 'Foreground session bootstrap returned an invalid origin.');
    }
    if (origin.origin !== session.origin) {
      throw new PlaygroundClientError('AB8043', 'Foreground session bootstrap returned an invalid origin.');
    }
    const browserOrigin = globalThis.location?.origin;
    if (browserOrigin !== undefined && browserOrigin !== 'null' && browserOrigin !== session.origin) {
      throw new PlaygroundClientError('AB8003', 'Foreground session bootstrap origin does not match this browser.');
    }
    return Object.freeze({ origin: session.origin, token: session.token });
  }
}
