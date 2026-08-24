import { z } from 'zod';

import type {
  DraftEvalCase,
  NativePlaygroundCatalog,
  PlaygroundExport,
  PlaygroundOperationRequest,
  PlaygroundReplay,
  PlaygroundRun,
  PlaygroundSession,
  PlaygroundTraceEvent,
} from '../../../agent-bundle/src/contracts/playground.ts';
import { isAbortError as isAbort, CodedClientError, exactKeys, isRecord, nonemptyString } from '../client-helpers.ts';
import { ForegroundSessionAuthority, ForegroundTransport } from '../foreground-session.ts';
import { abortableNdjsonStream, readNdjsonResponseFrames, type NdjsonStream } from '../ndjson.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';

export interface PlaygroundClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

export interface PlaygroundStreamOptions {
  readonly afterSequence?: number;
  readonly onEvent: (event: PlaygroundTraceEvent) => void;
}

/** Settles when the ndjson body ends, the stream is closed, or the transport fails. */
export type PlaygroundStream = NdjsonStream;

export class PlaygroundClientError extends CodedClientError {
  constructor(code: string, message: string) {
    super('PlaygroundClientError', code, message);
  }
}

const invalidResponse = (): PlaygroundClientError =>
  new PlaygroundClientError('AB8043', 'Playground route returned an invalid response.');

// Matches the foreground playground route's per-subscriber stream byte budget.
const maximumTraceFrameBytes = 1024 * 1024;

const invalidJson = Symbol('invalid playground JSON');

/** Decodes only own data properties, so boundary values cannot retain getters, prototypes, or mutable references. */
const detachedJson = (value: unknown): unknown | typeof invalidJson => {
  try {
    return snapshotStrictJsonValue(value, { nullPrototype: true });
  } catch {
    return invalidJson;
  }
};

const optionalKeys = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[]): boolean =>
  optional.some((key) => exactKeys(value, [...required, key])) || exactKeys(value, required) ||
  (optional.length === 2 && exactKeys(value, [...required, ...optional]));

const textSchema = z.string().min(1);
const nativeHostSchema = z.enum(['claude', 'codex']);
const nativeCatalogItemSchema = z.strictObject({ id: textSchema, label: textSchema });
const nativeModelPinSchema = nativeCatalogItemSchema.extend({ host: nativeHostSchema });
const nativeCatalogSelectionSchema = z.strictObject({
  caseId: textSchema,
  fixtureId: textSchema,
  host: nativeHostSchema,
  modelPinId: textSchema,
});
const nativeCatalogSchema = z.strictObject({
  cases: z.array(nativeCatalogItemSchema),
  epochId: textSchema,
  fixtures: z.array(nativeCatalogItemSchema),
  modelPins: z.array(nativeModelPinSchema),
  selections: z.array(nativeCatalogSelectionSchema),
});

/** Zod receives only inert plain JSON after the hostile boundary value has been detached. */
const zodJsonSnapshot = (value: unknown): unknown | typeof invalidJson => {
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return invalidJson; }
};

const nativeCatalogCoherent = (catalog: NativePlaygroundCatalog): boolean => {
  const uniqueIds = (entries: readonly { readonly id: string }[]): Set<string> | undefined => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) return undefined;
      ids.add(entry.id);
    }
    return ids;
  };
  const caseIds = uniqueIds(catalog.cases);
  const fixtureIds = uniqueIds(catalog.fixtures);
  const modelPins = new Map<string, 'claude' | 'codex'>();
  for (const modelPin of catalog.modelPins) {
    if (modelPins.has(modelPin.id)) return false;
    modelPins.set(modelPin.id, modelPin.host);
  }
  if (caseIds === undefined || fixtureIds === undefined) return false;
  const tuples = new Set<string>();
  for (const selection of catalog.selections) {
    const tuple = `${selection.caseId}\u0000${selection.fixtureId}\u0000${selection.host}\u0000${selection.modelPinId}`;
    if (tuples.has(tuple) || !caseIds.has(selection.caseId) || !fixtureIds.has(selection.fixtureId) ||
      modelPins.get(selection.modelPinId) !== selection.host) return false;
    tuples.add(tuple);
  }
  return true;
};

const isIdentity = (value: unknown): boolean => {
  if (!isRecord(value) || !exactKeys(value, ['epoch', 'fixture', 'invocation', 'target', 'task'])) return false;
  const { epoch, fixture, invocation, target, task } = value;
  return isRecord(epoch) && exactKeys(epoch, ['digest', 'id']) && nonemptyString(epoch.digest) && nonemptyString(epoch.id) &&
    isRecord(fixture) && exactKeys(fixture, ['digest', 'id']) && nonemptyString(fixture.digest) && nonemptyString(fixture.id) &&
    isRecord(invocation) && exactKeys(invocation, ['intent', 'kind']) && isRecord(invocation.intent) && nonemptyString(invocation.kind) &&
    isRecord(target) && optionalKeys(target, ['name'], ['digest']) && nonemptyString(target.name) &&
      (target.digest === undefined || nonemptyString(target.digest)) &&
    isRecord(task) && exactKeys(task, ['id', 'text']) && nonemptyString(task.id) && nonemptyString(task.text);
};

const isOutcome = (value: unknown): boolean => {
  if (!isRecord(value) || !optionalKeys(value, ['status'], ['response', 'workspace']) || !nonemptyString(value.status)) return false;
  return (value.response === undefined || nonemptyString(value.response)) && (value.workspace === undefined || isRecord(value.workspace));
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

const catalogBody = (value: unknown, requestedEpochId: string | undefined): NativePlaygroundCatalog => {
  const envelope = detachedRecord(value);
  const catalog = envelope.catalog;
  const zodCatalog = zodJsonSnapshot(catalog);
  if (!exactKeys(envelope, ['catalog']) || zodCatalog === invalidJson || !nativeCatalogSchema.safeParse(zodCatalog).success) throw invalidResponse();
  const decoded = catalog as NativePlaygroundCatalog;
  if ((requestedEpochId !== undefined && decoded.epochId !== requestedEpochId) || !nativeCatalogCoherent(decoded)) throw invalidResponse();
  return decoded;
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
  if (!exactKeys(envelope, ['export']) || !isRecord(body) || !exactKeys(body, ['events', 'session']) ||
    !isSession(body.session)) throw invalidResponse();
  traceEvents(body.events);
  return body as unknown as PlaygroundExport;
};

const draftEvalBody = (value: unknown): DraftEvalCase => {
  const envelope = detachedRecord(value);
  const body = envelope.draftEvalCase;
  if (!exactKeys(envelope, ['draftEvalCase']) || !isRecord(body) ||
    !exactKeys(body, ['assertions', 'epoch', 'fixture', 'invocation', 'outcome', 'target', 'task']) ||
    !Array.isArray(body.assertions) || !isRecord(body.epoch) || !exactKeys(body.epoch, ['digest', 'id']) ||
    !nonemptyString(body.epoch.digest) || !nonemptyString(body.epoch.id) || !isRecord(body.fixture) || !exactKeys(body.fixture, ['digest', 'id']) ||
    !nonemptyString(body.fixture.digest) || !nonemptyString(body.fixture.id) || !isRecord(body.invocation) ||
    !exactKeys(body.invocation, ['intent', 'kind']) || !isRecord(body.invocation.intent) || !nonemptyString(body.invocation.kind) ||
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

/** A typed, credential-memory-only browser client for the durable playground trace routes. */
export class PlaygroundClient {
  readonly #transport: ForegroundTransport;

  constructor(options: PlaygroundClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new PlaygroundClientError(code, message),
      fallbackCode: 'AB8043',
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Playground',
    });
  }

  /** Starts a server-owned operation and receives its live run and session identity promptly. */
  async run(input: PlaygroundOperationRequest, signal?: AbortSignal): Promise<PlaygroundRun> {
    const body = input.operation === 'native.prompt'
      ? this.#nativePromptBody(input)
      : input;
    return runBody(await this.#transport.json('/api/playground/runs', {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Reads the immutable server-owned native choices for exactly one active or retained epoch. */
  async catalog(epochId?: string, signal?: AbortSignal): Promise<NativePlaygroundCatalog> {
    const query = epochId === undefined ? '' : `?epochId=${encodeURIComponent(epochId)}`;
    return catalogBody(await this.#transport.json(`/api/playground/catalog${query}`, { signal }), epochId);
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

  async export(sessionId: string, signal?: AbortSignal): Promise<PlaygroundExport> {
    return exportBody(await this.#transport.json(`${this.#path(sessionId)}/export`, { signal }));
  }

  async promoteToDraftEval(
    sessionId: string,
    rawEventRefs: readonly string[],
    signal?: AbortSignal,
  ): Promise<DraftEvalCase> {
    return draftEvalBody(await this.#transport.json(`${this.#path(sessionId)}/draft-eval`, {
      body: JSON.stringify({ rawEventRefs }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  /** Reads the ndjson trace stream frame by frame; closing aborts the request itself. */
  stream(sessionId: string, options: PlaygroundStreamOptions): PlaygroundStream {
    return abortableNdjsonStream(undefined, (signal) => this.#stream(sessionId, options, signal));
  }

  #path(sessionId: string): string {
    return `/api/playground/sessions/${encodeURIComponent(sessionId)}`;
  }

  #runPath(runId: string): string {
    return `/api/playground/runs/${encodeURIComponent(runId)}`;
  }

  #nativePromptBody(input: Extract<PlaygroundOperationRequest, { readonly operation: 'native.prompt' }>): PlaygroundOperationRequest {
    if (!nonemptyString(input.caseId) || !nonemptyString(input.epochId) || !nonemptyString(input.fixtureId) ||
      !nonemptyString(input.modelPinId) || !nonemptyString(input.prompt) || !nonemptyString(input.target) ||
      (input.host !== 'claude' && input.host !== 'codex')) {
      throw new PlaygroundClientError('AB8043', 'Native Playground requires one complete catalog-backed prompt selection.');
    }
    return Object.freeze({
      caseId: input.caseId,
      epochId: input.epochId,
      fixtureId: input.fixtureId,
      host: input.host,
      modelPinId: input.modelPinId,
      operation: 'native.prompt' as const,
      prompt: input.prompt,
      target: input.target,
    });
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
      throw this.#transport.diagnosticError(await response.json().catch(() => undefined), response.status);
    }
    const decoder = new TextDecoder();
    const emitLine = (bytes: Uint8Array): void => {
      const line = decoder.decode(bytes).trim();
      if (line.length > 0) options.onEvent(traceEventLine(line));
    };
    try {
      await readNdjsonResponseFrames(response, emitLine, {
        invalidFrameError: invalidResponse,
        maxFrameBytes: maximumTraceFrameBytes,
        onIncomplete: emitLine,
        signal,
      });
    } catch (error) {
      if (!isAbort(error) && !signal.aborted) throw error;
    }
  }

}
