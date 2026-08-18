import type {
  DraftEvalCase,
  PlaygroundExport,
  PlaygroundReplay,
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/services/playground-service.ts';
import type { PlaygroundOperationRequest, PlaygroundRun } from '../../../agent-bundle/src/dev/playground-contract.ts';
import { ForegroundTransport } from '../foreground-session.ts';

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

const invalidJson = Symbol('invalid playground JSON');

/** Decodes only own data properties, so boundary values cannot retain getters, prototypes, or mutable references. */
const detachedJson = (value: unknown, seen = new WeakSet<object>()): unknown | typeof invalidJson => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalidJson;
  if (typeof value !== 'object') return invalidJson;
  try {
    if (seen.has(value)) return invalidJson;
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return invalidJson;
      const keys = Reflect.ownKeys(value);
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 ||
        keys.some((key) => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9]\d*)$/u.test(key)))) return invalidJson;
      const detached: unknown[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalidJson;
        const entry = detachedJson(descriptor.value, seen);
        if (entry === invalidJson) return invalidJson;
        detached.push(entry);
      }
      return Object.freeze(detached);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidJson;
    const detached = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return invalidJson;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return invalidJson;
      const entry = detachedJson(descriptor.value, seen);
      if (entry === invalidJson) return invalidJson;
      Object.defineProperty(detached, key, { configurable: false, enumerable: true, value: entry, writable: false });
    }
    return Object.freeze(detached);
  } catch {
    return invalidJson;
  }
};

const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const optionalKeys = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[]): boolean =>
  optional.some((key) => exactKeys(value, [...required, key])) || exactKeys(value, required) ||
  (optional.length === 2 && exactKeys(value, [...required, ...optional]));

const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const jsonObject = (value: unknown): value is Readonly<Record<string, unknown>> => isRecord(value);

const isIdentity = (value: unknown): boolean => {
  if (!isRecord(value) || !exactKeys(value, ['epoch', 'fixture', 'invocation', 'target', 'task'])) return false;
  const { epoch, fixture, invocation, target, task } = value;
  return isRecord(epoch) && exactKeys(epoch, ['digest', 'id']) && nonemptyString(epoch.digest) && nonemptyString(epoch.id) &&
    isRecord(fixture) && exactKeys(fixture, ['digest', 'id']) && nonemptyString(fixture.digest) && nonemptyString(fixture.id) &&
    isRecord(invocation) && exactKeys(invocation, ['intent', 'kind']) && jsonObject(invocation.intent) && nonemptyString(invocation.kind) &&
    isRecord(target) && optionalKeys(target, ['name'], ['digest']) && nonemptyString(target.name) &&
      (target.digest === undefined || nonemptyString(target.digest)) &&
    isRecord(task) && exactKeys(task, ['id', 'text']) && nonemptyString(task.id) && nonemptyString(task.text);
};

const isOutcome = (value: unknown): boolean => {
  if (!isRecord(value) || !optionalKeys(value, ['status'], ['response', 'workspace']) || !nonemptyString(value.status)) return false;
  return (value.response === undefined || nonemptyString(value.response)) && (value.workspace === undefined || jsonObject(value.workspace));
};

const traceSources = new Set([
  'build', 'diagnostics', 'hook', 'host-preflight', 'mcp', 'project', 'response', 'script', 'skill-evidence', 'workspace-change',
]);

const isTraceEvent = (value: unknown): value is PlaygroundTraceEvent => {
  if (!isRecord(value) || !exactKeys(value, ['kind', 'raw', 'rawEventRef', 'sequence', 'source', 'summary', 'timestamp'])) return false;
  const sequence = value.sequence;
  return nonemptyString(value.kind) && nonemptyString(value.summary) && nonemptyString(value.timestamp) &&
    typeof value.source === 'string' && traceSources.has(value.source) && typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) && sequence > 0 && value.rawEventRef === `events.jsonl#${String(sequence)}` && Object.hasOwn(value, 'raw');
};

const isCleanupFailure = (value: unknown): boolean =>
  isRecord(value) && exactKeys(value, ['message', 'operation']) && nonemptyString(value.message) &&
  (value.operation === 'admission' || value.operation === 'subscriber');

const diagnosticError = (value: unknown, status: number): PlaygroundClientError => {
  if (isRecord(value) && isRecord(value.diagnostic) &&
    typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return new PlaygroundClientError(value.diagnostic.code, value.diagnostic.message);
  }
  return new PlaygroundClientError('AB8043', `Playground request failed with HTTP ${status}.`);
};

const isSession = (value: unknown): boolean =>
  isRecord(value) && optionalKeys(value, ['cleanupFailures', 'createdAt', 'id', 'identity', 'state'], ['outcome']) &&
  nonemptyString(value.id) && nonemptyString(value.createdAt) && isIdentity(value.identity) &&
  Array.isArray(value.cleanupFailures) && value.cleanupFailures.every(isCleanupFailure) &&
  (value.state === 'open' || value.state === 'closed' || value.state === 'finalized') &&
  (value.outcome === undefined || isOutcome(value.outcome));

const isRun = (value: unknown): boolean =>
  isRecord(value) && exactKeys(value, ['id', 'session']) && nonemptyString(value.id) && isSession(value.session);

const detachedRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  const detached = detachedJson(value);
  if (detached === invalidJson || !isRecord(detached)) throw invalidResponse();
  return detached;
};

const sessionBody = (value: unknown): PlaygroundSession => {
  const body = detachedRecord(value);
  const session = body.session;
  if (!exactKeys(body, ['session'])) throw invalidResponse();
  if (!isSession(session)) throw invalidResponse();
  return session as PlaygroundSession;
};

const runBody = (value: unknown): PlaygroundRun => {
  const body = detachedRecord(value);
  const run = body.run;
  if (!exactKeys(body, ['run'])) throw invalidResponse();
  if (!isRun(run)) throw invalidResponse();
  return run as PlaygroundRun;
};

const cancelledBody = (value: unknown): boolean => {
  const body = detachedRecord(value);
  const cancelled = body.cancelled;
  if (!exactKeys(body, ['cancelled'])) throw invalidResponse();
  if (typeof cancelled !== 'boolean') throw invalidResponse();
  return cancelled;
};

const traceEvents = (value: unknown): readonly PlaygroundTraceEvent[] => {
  if (!Array.isArray(value) || !value.every(isTraceEvent)) throw invalidResponse();
  const sequences = new Set<number>();
  const refs = new Set<string>();
  for (const event of value) {
    if (sequences.has(event.sequence) || refs.has(event.rawEventRef)) throw invalidResponse();
    sequences.add(event.sequence);
    refs.add(event.rawEventRef);
  }
  return value as readonly PlaygroundTraceEvent[];
};

const replayBody = (value: unknown): PlaygroundReplay => {
  const envelope = detachedRecord(value);
  const replay = envelope.replay;
  const cursor = isRecord(replay) ? replay.cursor : undefined;
  const afterSequence = isRecord(cursor) ? cursor.afterSequence : undefined;
  if (!exactKeys(envelope, ['replay']) || !isRecord(replay) || !exactKeys(replay, ['cursor', 'events', 'session']) ||
    !isRecord(cursor) || !exactKeys(cursor, ['afterSequence']) || typeof afterSequence !== 'number' ||
    !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !isSession(replay.session)) {
    throw invalidResponse();
  }
  traceEvents(replay.events);
  return replay as unknown as PlaygroundReplay;
};

const exportBody = (value: unknown): PlaygroundExport => {
  const envelope = detachedRecord(value);
  const body = envelope.export;
  if (!exactKeys(envelope, ['export']) || !isRecord(body) || !exactKeys(body, ['events', 'schemaVersion', 'session']) ||
    body.schemaVersion !== 1 || !isSession(body.session)) throw invalidResponse();
  traceEvents(body.events);
  return body as unknown as PlaygroundExport;
};

const draftEvalBody = (value: unknown): DraftEvalCase => {
  const envelope = detachedRecord(value);
  const body = envelope.draftEvalCase;
  if (!exactKeys(envelope, ['draftEvalCase']) || !isRecord(body) ||
    !exactKeys(body, ['assertions', 'epoch', 'fixture', 'invocation', 'outcome', 'schemaVersion', 'target', 'task']) ||
    body.schemaVersion !== 1 || !Array.isArray(body.assertions) || !isRecord(body.epoch) || !exactKeys(body.epoch, ['digest', 'id']) ||
    !nonemptyString(body.epoch.digest) || !nonemptyString(body.epoch.id) || !isRecord(body.fixture) || !exactKeys(body.fixture, ['digest', 'id']) ||
    !nonemptyString(body.fixture.digest) || !nonemptyString(body.fixture.id) || !isRecord(body.invocation) ||
    !exactKeys(body.invocation, ['intent', 'kind']) || !jsonObject(body.invocation.intent) || !nonemptyString(body.invocation.kind) ||
    !isRecord(body.target) || !optionalKeys(body.target, ['name'], ['digest']) || !nonemptyString(body.target.name) ||
    (body.target.digest !== undefined && !nonemptyString(body.target.digest)) || !isRecord(body.task) ||
    !exactKeys(body.task, ['id', 'text']) || !nonemptyString(body.task.id) || !nonemptyString(body.task.text) || !isOutcome(body.outcome) ||
    !body.assertions.every((assertion) => isRecord(assertion) && exactKeys(assertion, ['evidence', 'expectation', 'id', 'kind']) &&
      Object.hasOwn(assertion, 'evidence') && Object.hasOwn(assertion, 'expectation') && nonemptyString(assertion.id) && nonemptyString(assertion.kind))) {
    throw invalidResponse();
  }
  return body as unknown as DraftEvalCase;
};

const traceEventLine = (line: string): PlaygroundTraceEvent => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw invalidResponse();
  }
  const detached = detachedJson(parsed);
  if (detached === invalidJson || !isTraceEvent(detached)) throw invalidResponse();
  return detached;
};

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** A typed, credential-memory-only browser client for the durable playground trace routes. */
export class PlaygroundClient {
  readonly #transport: ForegroundTransport;

  constructor(options: PlaygroundClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new PlaygroundClientError(code, message),
      fallbackCode: 'AB8043',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Playground',
    });
  }

  /** Starts a server-owned operation and receives its live run and session identity promptly. */
  async run(input: PlaygroundOperationRequest, signal?: AbortSignal): Promise<PlaygroundRun> {
    return runBody(await this.#transport.json('/api/playground/runs', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Cancellation is an operation-level action; callers refresh the durable session afterwards. */
  async cancel(runId: string, signal?: AbortSignal): Promise<boolean> {
    return cancelledBody(await this.#transport.json(`${this.#runPath(runId)}/cancel`, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async session(sessionId: string, signal?: AbortSignal): Promise<PlaygroundSession> {
    return sessionBody(await this.#transport.json(this.#path(sessionId), { signal }));
  }

  /** The cursor stays exactly where the caller left it, so replayed order and epoch binding survive. */
  async replay(sessionId: string, afterSequence?: number, signal?: AbortSignal): Promise<PlaygroundReplay> {
    const query = afterSequence === undefined ? '' : `?after=${String(afterSequence)}`;
    return replayBody(await this.#transport.json(`${this.#path(sessionId)}/replay${query}`, { signal }));
  }

  async export(sessionId: string): Promise<PlaygroundExport> {
    return exportBody(await this.#transport.json(`${this.#path(sessionId)}/export`));
  }

  async promoteToDraftEval(
    sessionId: string,
    rawEventRefs: readonly string[],
  ): Promise<DraftEvalCase> {
    return draftEvalBody(await this.#transport.json(`${this.#path(sessionId)}/draft-eval`, {
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

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void {
    this.#transport.forget();
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
      response = await this.#transport.request(`${this.#path(sessionId)}/stream?after=${String(after)}`, { signal });
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

}
