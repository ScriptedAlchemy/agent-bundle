import type {
  EvalRunEventsReplay,
  EvalRunResult,
  EvalRunSelection,
  EvalSuiteListing,
} from '../../../agent-bundle/src/dev/eval-service.ts';
import { parseJsonWithoutDuplicateKeys, snapshotStrictJsonValue, type JsonValue } from '../../../agent-bundle/src/core/strict-json.ts';
import type { EvalRunEvent, EvalRunRecord } from '../../../agent-bundle/src/eval/run-store.ts';
import { awaitWithAbort, ForegroundTransport } from '../foreground-session.ts';

export interface EvalClientOptions {
  readonly fetch?: typeof fetch;
}

/** Exactly what a browser may choose: authored suites, authored cases, and a trial count. */
export interface EvalRunStart extends EvalRunSelection {
  readonly trials?: number;
}

export interface EvalEventStream {
  close(): void;
  readonly done: Promise<void>;
}

export interface EvalEventStreamOptions {
  readonly afterSequence: number;
  readonly onEvent: (event: EvalRunEvent) => void;
  readonly runId: string;
  readonly signal?: AbortSignal;
}

export interface EvalArtifact {
  readonly blob: Blob;
  readonly filename: string;
  readonly mediaType: string;
}

export class EvalClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'EvalClientError';
    this.code = code;
  }
}

const maximumArtifactBytes = 8 * 1024 * 1024;
const maximumEventFrameBytes = 256 * 1024;
const safeArtifactSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const invalidResponse = (): EvalClientError =>
  new EvalClientError('AB8073', 'Eval route returned an invalid response.');
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

const snapshot = (value: unknown): JsonValue => {
  try { return snapshotStrictJsonValue(value); }
  catch { throw invalidResponse(); }
};

const parseResponseJson = (bytes: Uint8Array): JsonValue => {
  try { return snapshot(parseJsonWithoutDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw invalidResponse(); }
};

const eventFor = (value: unknown): EvalRunEvent => {
  if (!exactKeys(value, ['kind', 'payload', 'schemaVersion', 'sequence', 'timestamp']) ||
    typeof value.kind !== 'string' || value.kind.length === 0 || value.kind.length > 512 ||
    value.schemaVersion !== 1 || !safeInteger(value.sequence, 1) || !isIsoTimestamp(value.timestamp)) {
    throw invalidResponse();
  }
  return value as unknown as EvalRunEvent;
};

const replayFor = (value: unknown, afterSequence: number): EvalRunEventsReplay => {
  if (!exactKeys(value, ['replay']) || !isRecord(value.replay)) throw invalidResponse();
  const replay = value.replay;
  if (!(exactKeys(replay, ['cursor', 'events']) || exactKeys(replay, ['cursor', 'events', 'incompleteTrailingRecord'])) ||
    !exactKeys(replay.cursor, ['afterSequence']) || !safeInteger(replay.cursor.afterSequence, afterSequence) ||
    !Array.isArray(replay.events) || !replay.events.every((event) => {
      try { eventFor(event); return true; } catch { return false; }
    }) ||
    (Object.hasOwn(replay, 'incompleteTrailingRecord') && replay.incompleteTrailingRecord !== true)) {
    throw invalidResponse();
  }
  const events = replay.events as readonly EvalRunEvent[];
  if (!events.every((event, index) => event.sequence === afterSequence + index + 1) ||
    replay.cursor.afterSequence !== (events.at(-1)?.sequence ?? afterSequence)) {
    throw invalidResponse();
  }
  return Object.freeze({
    cursor: Object.freeze({ afterSequence: replay.cursor.afterSequence }),
    events: Object.freeze([...events]),
    ...(replay.incompleteTrailingRecord === true ? { incompleteTrailingRecord: true as const } : {}),
  });
};

const suiteListing = (value: unknown): EvalSuiteListing => {
  if (!exactKeys(value, ['diagnostics', 'suites']) || !Array.isArray(value.diagnostics) || !Array.isArray(value.suites) ||
    !value.suites.every((entry) => isRecord(entry) && typeof entry.name === 'string' && Array.isArray(entry.cases))) {
    throw invalidResponse();
  }
  return value as unknown as EvalSuiteListing;
};

const runResult = (value: unknown): EvalRunResult => {
  if (!isRecord(value) || !isRecord(value.run) ||
    !exactKeys(value.run, ['aggregates', 'diagnostics', 'run', 'trials']) || !isRecord(value.run.run) ||
    !Array.isArray(value.run.aggregates) || !Array.isArray(value.run.diagnostics) || !Array.isArray(value.run.trials)) {
    throw invalidResponse();
  }
  return value.run as unknown as EvalRunResult;
};

const runRecords = (value: unknown): readonly EvalRunRecord[] => {
  if (!isRecord(value) || !Array.isArray(value.runs) ||
    !value.runs.every((entry) => isRecord(entry) && typeof entry.id === 'string')) {
    throw invalidResponse();
  }
  return Object.freeze([...value.runs]) as readonly EvalRunRecord[];
};

const opaqueArtifactRef = (reference: string): string => {
  const segments = reference.split('/');
  if (segments.length < 2 || segments[0] !== 'artifacts' || !segments.every((segment) => safeArtifactSegment.test(segment))) {
    throw invalidResponse();
  }
  try {
    return globalThis.btoa(reference).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  } catch {
    throw invalidResponse();
  }
};

const filenameFor = (value: string | null): string | undefined => {
  const match = /^attachment; filename="([A-Za-z0-9][A-Za-z0-9._-]*)"$/u.exec(value ?? '');
  return match?.[1];
};

/** A typed, credential-memory-only browser client for persisted Eval evidence. */
export class EvalClient {
  readonly #transport: ForegroundTransport;

  constructor(options: EvalClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new EvalClientError(code, message),
      fallbackCode: 'AB8073',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Eval',
    });
  }

  async suites(): Promise<EvalSuiteListing> {
    return suiteListing(await this.#json('/api/evals/suites'));
  }

  async runs(): Promise<readonly EvalRunRecord[]> {
    return runRecords(await this.#json('/api/evals/runs'));
  }

  async read(runId: string, signal?: AbortSignal): Promise<EvalRunResult> {
    return runResult(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}`, { signal }));
  }

  async start(selection: EvalRunStart, signal?: AbortSignal): Promise<EvalRunResult> {
    return runResult(await this.#json('/api/evals/runs', {
      body: JSON.stringify({
        ...(selection.caseIds === undefined ? {} : { caseIds: selection.caseIds }),
        ...(selection.suites === undefined ? {} : { suites: selection.suites }),
        ...(selection.trials === undefined ? {} : { trials: selection.trials }),
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async events(runId: string, afterSequence = 0, signal?: AbortSignal): Promise<EvalRunEventsReplay> {
    if (!safeInteger(afterSequence)) throw invalidResponse();
    return replayFor(await this.#json(`/api/evals/runs/${encodeURIComponent(runId)}/events?after=${String(afterSequence)}`, { signal }), afterSequence);
  }

  stream(options: EvalEventStreamOptions): EvalEventStream {
    if (!safeInteger(options.afterSequence)) throw invalidResponse();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    return Object.freeze({
      close: () => controller.abort(),
      done: this.#stream(options, controller.signal).finally(() => options.signal?.removeEventListener('abort', forwardAbort)),
    });
  }

  async artifact(runId: string, reference: string, signal?: AbortSignal): Promise<EvalArtifact> {
    const response = await this.#response(
      `/api/evals/runs/${encodeURIComponent(runId)}/artifacts/${opaqueArtifactRef(reference)}`,
      { signal },
    );
    const filename = filenameFor(response.headers.get('content-disposition'));
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase();
    const declaredSize = Number(response.headers.get('content-length'));
    if (filename === undefined || mediaType === undefined || !Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maximumArtifactBytes) {
      throw invalidResponse();
    }
    try {
      const bytes = new Uint8Array(await awaitWithAbort(signal, () => response.arrayBuffer()));
      if (bytes.byteLength !== declaredSize || bytes.byteLength > maximumArtifactBytes) throw invalidResponse();
      return Object.freeze({ blob: new Blob([bytes], { type: mediaType }), filename, mediaType });
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  /** Erases the short-lived foreground token once the owning page stops using it. */
  forgetAuthentication(): void { this.#transport.forget(); }

  async #json(path: string, init: RequestInit = {}): Promise<JsonValue> {
    try {
      const response = await this.#response(path, init);
      return parseResponseJson(new Uint8Array(await awaitWithAbort(init.signal, () => response.arrayBuffer())));
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  async #response(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await this.#transport.request(path, init);
      if (response.ok) return response;
      const body = parseResponseJson(new Uint8Array(await awaitWithAbort(init.signal, () => response.arrayBuffer())));
      if (exactKeys(body, ['diagnostic']) && exactKeys(body.diagnostic, ['code', 'message']) &&
        typeof body.diagnostic.code === 'string' && typeof body.diagnostic.message === 'string') {
        throw new EvalClientError(body.diagnostic.code, body.diagnostic.message);
      }
      throw new EvalClientError('AB8073', `Eval request failed with HTTP ${response.status}.`);
    } catch (error) {
      if (error instanceof EvalClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalidResponse();
    }
  }

  async #stream(options: EvalEventStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.#response(
        `/api/evals/runs/${encodeURIComponent(options.runId)}/stream?after=${String(options.afterSequence)}`,
        { signal },
      );
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/x-ndjson') || response.body === null) throw invalidResponse();
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const parts: Uint8Array[] = [];
    let partBytes = 0;
    let expected = options.afterSequence + 1;
    const append = (part: Uint8Array): void => {
      if (partBytes + part.byteLength > maximumEventFrameBytes) throw invalidResponse();
      if (part.byteLength > 0) parts.push(part);
      partBytes += part.byteLength;
    };
    const consume = (): void => {
      const bytes = new Uint8Array(partBytes);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      parts.length = 0;
      partBytes = 0;
      if (bytes.byteLength === 0) return;
      const event = eventFor(parseResponseJson(bytes));
      if (event.sequence !== expected) throw invalidResponse();
      expected += 1;
      options.onEvent(event);
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (signal.aborted) return;
        let start = 0;
        for (let index = 0; index < chunk.value.byteLength; index += 1) {
          if (chunk.value[index] !== 0x0a) continue;
          append(chunk.value.subarray(start, index));
          consume();
          if (signal.aborted) return;
          start = index + 1;
        }
        append(chunk.value.subarray(start));
      }
      if (partBytes > 0) throw invalidResponse();
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      if (error instanceof EvalClientError) throw error;
      throw invalidResponse();
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
    }
  }
}
