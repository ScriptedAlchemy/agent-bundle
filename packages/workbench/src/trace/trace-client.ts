/**
 * Same-origin client for the unified trace (#600 PR 2): `GET /api/trace?after=`
 * replays the retained window, `GET /api/trace/stream?after=` follows it as
 * NDJSON. Every wire shape is decoded strictly before the page sees it — an
 * unknown `source`, a stray key, a non-contiguous sequence, or path-like text
 * is a `TraceClientError`, never a crash and never a rendered row.
 */
import { isCredentialKey, redactEvalCredentialText } from '../../../agent-bundle/src/contracts/credentials.ts';
import { parseJsonWithoutDuplicateKeys, type JsonValue } from '../../../agent-bundle/src/contracts/strict-json.ts';
import {
  isTraceSource,
  type TraceCorrelation,
  type TraceEntry,
  type TraceMessage,
  type TraceReplay,
  type TraceReplayGap,
  type TraceStatus,
} from '../../../agent-bundle/src/contracts/trace.ts';
import { isWorkbenchShellPath } from '../../../agent-bundle/src/contracts/workbench-shell.ts';
import { errorMessage, exactKeys, hasAllowedKeys, isAbortError, isRecord, parseStrictResponseJson, strictJsonSnapshot } from '../client-helpers.ts';
import { deepFreeze } from '../freeze.ts';
import { awaitWithAbort, ForegroundRouteClientError, type ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import { readNdjsonResponseFrames } from '../ndjson.ts';
import { mergeTraceEntries } from './trace-model.ts';

/** What the Trace page and the route workspace (T6) code against; `ForegroundTraceClient` is the production implementation. */
export interface TraceClient {
  replay(after?: number): Promise<TraceReplay>;
  /** Resolves when the stream ends or `signal` aborts; rejects on a malformed frame or a refused request. */
  stream(after: number | undefined, onMessage: (message: TraceMessage) => void, signal: AbortSignal): Promise<void>;
}

export interface TraceClientOptions {
  /** Reuses Workbench's single foreground session and invalidation authority. */
  readonly foreground: ForegroundRequestAuthority;
}

/** `AB8243`: the route answered with bytes this client refuses to interpret. Other codes are the server's own refusals. */
export class TraceClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TraceClientError';
    this.code = code;
  }
}

export const TRACE_INVALID_RESPONSE_CODE = 'AB8243';

const maximumFrameBytes = 64 * 1024;
const maximumSummaryLength = 240;
const maximumKindLength = 128;
const maximumIdentifierLength = 256;
const maximumHrefLength = 2_048;
const maximumDurationMs = 1_000 * 60 * 60 * 24 * 365;
const traceStatuses: readonly TraceStatus[] = Object.freeze(['ok', 'error', 'running']);
const correlationKeys: readonly (keyof TraceCorrelation)[] = Object.freeze([
  'correlationId', 'conversationId', 'epochId', 'executionId', 'host', 'invocationId',
  'mcpRequestId', 'mcpSessionId', 'requestId', 'routeId', 'runId', 'sessionId',
]);
const entryKeys: readonly string[] = Object.freeze(['correlation', 'id', 'kind', 'occurredAt', 'sequence', 'source', 'summary']);
const optionalEntryKeys: readonly string[] = Object.freeze(['details', 'durationMs', 'href', 'status']);
const gapKeys: readonly string[] = Object.freeze(['droppedCount', 'firstAvailableSequence', 'requestedAfterSequence', 'type']);

const invalid = (): TraceClientError => new TraceClientError(TRACE_INVALID_RESPONSE_CODE, 'Trace route returned an invalid response.');

const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};
const identifier = /^[A-Za-z0-9_][A-Za-z0-9._:@+/-]*$/u;
/** A token that is an absolute POSIX path (two or more segments), a Windows path, a UNC path, or a `file:` URL. */
const pathLikeText = /(?:^|[\s"'`([=:,])(?:\/[^\s/]+){2,}|file:|(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]|\\\\/u;

/**
 * Free text the server promised was already safe (`safeDevWireText`): no
 * control characters, no credential-shaped tokens, and no absolute path. Route
 * ids (`tool:curator/search`), MCP methods (`tools/call`), and event names
 * (`tool/before`) keep their single slash.
 */
const isSafeText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !hasControlCharacters(value) &&
  redactEvalCredentialText(value) === value && !pathLikeText.test(value);
const isIdentifier = (value: unknown): value is string =>
  isSafeText(value, maximumIdentifierLength) && identifier.test(value);
const isSafeDetail = (value: JsonValue): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return value.length === 0 || isSafeText(value, maximumFrameBytes);
  if (Array.isArray(value)) return value.every(isSafeDetail);
  return Object.entries(value).every(([key, entry]) => !isCredentialKey(key) && !hasControlCharacters(key) && isSafeDetail(entry));
};
const isCorrelation = (value: unknown): value is TraceCorrelation =>
  isRecord(value) && Object.entries(value).every(([key, entry]) =>
    (correlationKeys as readonly string[]).includes(key) && isIdentifier(entry));

/** A Workbench path (`/routes/…?invocation=…`, `/advanced/protocol?session=…`): same origin, a shell area, no fragment. */
const isWorkbenchHref = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumHrefLength || !value.startsWith('/') || value.startsWith('//') || hasControlCharacters(value)) return false;
  let url: URL;
  try { url = new URL(value, 'http://workbench.invalid'); }
  catch { return false; }
  return url.origin === 'http://workbench.invalid' && url.hash === '' && `${url.pathname}${url.search}` === value && isWorkbenchShellPath(url.pathname);
};

const isEntry = (value: unknown): value is TraceEntry => {
  if (!hasAllowedKeys(value, entryKeys, optionalEntryKeys)) return false;
  if (!isTraceSource(value.source) || !isCorrelation(value.correlation)) return false;
  if (!safeInteger(value.sequence, 1) || !isIdentifier(value.id) || !isDate(value.occurredAt)) return false;
  if (!isSafeText(value.kind, maximumKindLength) || !identifier.test(value.kind) || !value.kind.includes('.')) return false;
  if (!isSafeText(value.summary, maximumSummaryLength)) return false;
  if (Object.hasOwn(value, 'status') && !(traceStatuses as readonly unknown[]).includes(value.status)) return false;
  if (Object.hasOwn(value, 'durationMs') && !(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 && value.durationMs <= maximumDurationMs)) return false;
  if (Object.hasOwn(value, 'href') && !isWorkbenchHref(value.href)) return false;
  return !Object.hasOwn(value, 'details') || isSafeDetail(value.details as JsonValue);
};

const isGap = (value: unknown): value is TraceReplayGap =>
  exactKeys(value, gapKeys) && value.type === 'trace.gap' && safeInteger(value.requestedAfterSequence) &&
  safeInteger(value.droppedCount, 1) && safeInteger(value.firstAvailableSequence, 1) &&
  value.firstAvailableSequence === value.requestedAfterSequence + value.droppedCount + 1;

const contiguous = (entries: readonly TraceEntry[], afterSequence: number): boolean =>
  entries.every((entry, index) => entry.sequence === afterSequence + index + 1);

/** Decodes one already-snapshotted JSON value as a `TraceEntry`; exported so fixtures and T6 can share the rule. */
export const decodeTraceEntry = (value: unknown): TraceEntry => {
  const detached = strictJsonSnapshot(value, invalid);
  if (!isEntry(detached)) throw invalid();
  return deepFreeze(detached);
};

export const decodeTraceMessage = (value: unknown): TraceMessage => {
  const detached = strictJsonSnapshot(value, invalid);
  if (isEntry(detached) || isGap(detached)) return deepFreeze(detached);
  throw invalid();
};

/** The body of `GET /api/trace?after=<n>`: `TraceReplay` as `TraceHub.replay` returns it. */
export const decodeTraceReplay = (value: unknown, after: number): TraceReplay => {
  const detached = strictJsonSnapshot(value, invalid);
  if (!hasAllowedKeys(detached, ['entries', 'latestSequence'], ['gap']) || !Array.isArray(detached.entries) || !safeInteger(detached.latestSequence)) throw invalid();
  if (!detached.entries.every(isEntry)) throw invalid();
  const entries: readonly TraceEntry[] = detached.entries;
  const gap = Object.hasOwn(detached, 'gap') ? detached.gap : undefined;
  if (gap !== undefined && (!isGap(gap) || gap.requestedAfterSequence !== after)) throw invalid();
  const start = gap === undefined ? after : gap.firstAvailableSequence - 1;
  if (!contiguous(entries, start) || detached.latestSequence < after) throw invalid();
  const last = entries.at(-1);
  const expectedLatest = last?.sequence ?? (gap === undefined ? after : gap.firstAvailableSequence - 1);
  if (detached.latestSequence !== expectedLatest) throw invalid();
  return deepFreeze({ entries, ...(gap === undefined ? {} : { gap }), latestSequence: detached.latestSequence });
};

const refusal = (value: unknown, status: number): TraceClientError => {
  if (!exactKeys(value, ['diagnostic']) || !exactKeys(value.diagnostic, ['code', 'message']) ||
    typeof value.diagnostic.code !== 'string' || !/^AB\d{4}$/u.test(value.diagnostic.code)) return invalid();
  return new TraceClientError(value.diagnostic.code, `Trace route refused the request (${value.diagnostic.code}, HTTP ${String(status)}).`);
};

/** Production `TraceClient` over the foreground session authority. */
export class ForegroundTraceClient implements TraceClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: TraceClientOptions) {
    this.#foreground = options.foreground;
  }

  async replay(after = 0, signal?: AbortSignal): Promise<TraceReplay> {
    if (!safeInteger(after)) throw invalid();
    const response = await this.#response(`/api/trace?after=${String(after)}`, signal);
    let body: JsonValue;
    try {
      body = parseStrictResponseJson(new Uint8Array(await awaitWithAbort(signal, () => response.arrayBuffer())), invalid);
    } catch (error) {
      if (error instanceof TraceClientError || isAbortError(error) || signal?.aborted === true) throw error;
      throw invalid();
    }
    return decodeTraceReplay(body, after);
  }

  async stream(after: number | undefined, onMessage: (message: TraceMessage) => void, signal: AbortSignal): Promise<void> {
    const start = after ?? 0;
    if (!safeInteger(start)) throw invalid();
    let response: Response;
    try {
      response = await this.#response(`/api/trace/stream?after=${String(start)}`, signal);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      throw error;
    }
    let expected = start + 1;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      await readNdjsonResponseFrames(response, (bytes) => {
        if (signal.aborted) return;
        const line = decoder.decode(bytes).trim();
        if (line.length === 0) return;
        let parsed: unknown;
        try { parsed = parseJsonWithoutDuplicateKeys(line); }
        catch { throw invalid(); }
        const message = decodeTraceMessage(parsed);
        if ('sequence' in message) {
          if (message.sequence !== expected) throw invalid();
          expected += 1;
        } else {
          if (message.requestedAfterSequence !== expected - 1) throw invalid();
          expected = message.firstAvailableSequence;
        }
        onMessage(message);
      }, { invalidFrameError: invalid, maxFrameBytes: maximumFrameBytes, signal });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return;
      if (error instanceof TraceClientError) throw error;
      throw invalid();
    }
  }

  async #response(path: string, signal: AbortSignal | undefined): Promise<Response> {
    try {
      const response = await this.#foreground.protectedRequest(path, { signal });
      if (response.ok) return response;
      const bytes = await awaitWithAbort(signal, () => response.arrayBuffer());
      throw refusal(parseStrictResponseJson(new Uint8Array(bytes), invalid), response.status);
    } catch (error) {
      if (error instanceof TraceClientError || isAbortError(error) || signal?.aborted === true) throw error;
      if (error instanceof ForegroundRouteClientError) throw new TraceClientError(error.code, error.message);
      throw invalid();
    }
  }
}

export interface TraceFeedState {
  /** True between a successful replay and the end of its stream. */
  readonly connected: boolean;
  readonly entries: readonly TraceEntry[];
  readonly error?: string;
  /** The oldest retained boundary the server reported; earlier entries are gone. */
  readonly gap?: TraceReplayGap;
  /** False until the first replay settles, so the page can tell "empty" from "loading". */
  readonly loaded: boolean;
}

export interface TraceFeedOptions {
  readonly client: TraceClient;
  readonly onState: (state: TraceFeedState) => void;
  /** Injected so tests do not wait out the real back-off. */
  readonly retryDelay?: (milliseconds: number) => Promise<void>;
}

export interface TraceFeed {
  close(): void;
}

const initialRetryMs = 250;
const maximumRetryMs = 5_000;
const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Replay once, then follow the stream; when the stream ends or fails, back off
 * (250 ms doubling to 5 s) and replay again from the last delivered sequence.
 * A refused replay from a non-zero cursor means the dev server restarted with
 * a fresh hub, so the feed starts over from zero rather than looping. Every
 * state change goes through `onState` with the full merged list.
 */
export const openTraceFeed = (options: TraceFeedOptions): TraceFeed => {
  const retryDelay = options.retryDelay ?? wait;
  let open = true;
  let entries: readonly TraceEntry[] = Object.freeze([]);
  let gap: TraceReplayGap | undefined;
  let error: string | undefined;
  let loaded = false;
  let connected = false;
  let latest = 0;
  let retryMs = initialRetryMs;
  let controller: AbortController | undefined;
  const publish = (): void => {
    if (!open) return;
    options.onState(Object.freeze({ connected, entries, ...(error === undefined ? {} : { error }), ...(gap === undefined ? {} : { gap }), loaded }));
  };
  const receive = (message: TraceMessage): void => {
    if ('sequence' in message) {
      latest = Math.max(latest, message.sequence);
      entries = mergeTraceEntries(entries, [message]);
    } else {
      gap = message;
    }
    publish();
  };
  const failed = (reason: unknown): void => {
    connected = false;
    error = errorMessage(reason, 'The trace could not be read.');
    publish();
  };
  const run = async (): Promise<void> => {
    while (open) {
      const attempt = new AbortController();
      controller = attempt;
      let resetCursor = false;
      try {
        const replay = await options.client.replay(latest);
        if (!open || attempt.signal.aborted) return;
        latest = Math.max(latest, replay.latestSequence);
        entries = mergeTraceEntries(entries, replay.entries);
        if (replay.gap !== undefined) gap = replay.gap;
        error = undefined;
        loaded = true;
        connected = true;
        retryMs = initialRetryMs;
        publish();
        await options.client.stream(latest, (message) => { if (open && !attempt.signal.aborted) receive(message); }, attempt.signal);
        if (!open || attempt.signal.aborted) return;
        connected = false;
        publish();
      } catch (reason) {
        if (!open || attempt.signal.aborted) return;
        resetCursor = latest > 0 && reason instanceof TraceClientError && reason.code !== TRACE_INVALID_RESPONSE_CODE;
        if (resetCursor) {
          latest = 0;
          entries = Object.freeze([]);
          gap = undefined;
        }
        failed(reason);
      }
      if (!resetCursor) {
        await retryDelay(retryMs);
        retryMs = Math.min(retryMs * 2, maximumRetryMs);
      }
    }
  };
  void run();
  return Object.freeze({
    close: () => {
      open = false;
      controller?.abort();
    },
  });
};
