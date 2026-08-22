import type {
  DevLogMessage,
  DevLogRecord,
  DevLogReplay,
  DevLogReplayGap,
} from '../../../agent-bundle/src/dev/dev-log-service.ts';
import { devLogKinds, devLogLevels, devLogProducers, hasControlOrSeparators } from '../../../agent-bundle/src/dev/dev-log-kinds.ts';
import { parseJsonWithoutDuplicateKeys, type JsonValue } from '../../../agent-bundle/src/core/strict-json.ts';
import { isCredentialKey, redactEvalCredentialText } from '../../../agent-bundle/src/eval/credentials.ts';
import { parseStrictResponseJson, strictJsonSnapshot, isAbortError as isAbort, CodedClientError, exactKeys as hasExactKeys, isRecord } from '../client-helpers.ts';
import { awaitWithAbort, ForegroundSessionAuthority, ForegroundTransport } from '../foreground-session.ts';
import { abortableNdjsonStream, readNdjsonByteFrames } from '../ndjson.ts';
import { snapshotStrictJsonValue } from '../strict-json.ts';

export interface LogClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

export interface LogStream {
  close(): void;
  readonly done: Promise<void>;
}

export interface LogStreamOptions {
  readonly afterSequence: number;
  readonly onMessage: (message: DevLogMessage) => void;
  /** One page-generation signal owns both the initial replay and its live stream. */
  readonly signal?: AbortSignal;
}

export class LogClientError extends CodedClientError {
  constructor(code: string, message: string) {
    super('LogClientError', code, message);
  }
}

const maximumLogFrameBytes = 64 * 1024;
const maximumSummaryLength = 2_048;
const safeContextKeys = new Set(['buildId', 'diagnosticCode', 'epochId', 'hookId', 'projectId', 'runId', 'sessionId', 'target']);
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const isDate = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const safeProjectRelativePath = /<project>(?:\/[A-Za-z0-9._@+-]+)*/gu;
const isSafeWireText = (value: unknown, maximum = maximumLogFrameBytes): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || redactEvalCredentialText(value) !== value) return false;
  const withoutProjectPaths = value.replace(safeProjectRelativePath, '');
  return !hasControlOrSeparators(withoutProjectPaths) && !/(?:file:|[A-Za-z]:[\\/]|\\\\)/iu.test(withoutProjectPaths);
};
const isSafeDetailKey = (value: string): boolean =>
  !isCredentialKey(value) && !hasControlOrSeparators(value);
const isSafeDetail = (value: JsonValue): boolean => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value === 'string') return isSafeWireText(value);
  if (Array.isArray(value)) return value.every(isSafeDetail);
  return Object.entries(value).every(([key, entry]) => isSafeDetailKey(key) && isSafeDetail(entry));
};
const isProducer = (value: unknown): value is keyof typeof devLogKinds =>
  typeof value === 'string' && (devLogProducers as readonly string[]).includes(value);
const isLevel = (value: unknown): boolean => typeof value === 'string' && (devLogLevels as readonly string[]).includes(value);
const isContext = (value: unknown): value is Readonly<Record<string, string>> => isRecord(value) && Object.entries(value).every(([key, entry]) =>
  safeContextKeys.has(key) && typeof entry === 'string' && safeIdentifier.test(entry) && isSafeWireText(entry, 256));
const isDevRecord = (value: unknown): value is DevLogRecord => {
  if (!hasExactKeys(value, ['context', 'details', 'kind', 'level', 'occurredAt', 'producer', 'sequence', 'summary']) || !isProducer(value.producer)) return false;
  return safeInteger(value.sequence, 1) && isDate(value.occurredAt) && isLevel(value.level) &&
    typeof value.kind === 'string' && (devLogKinds[value.producer] as readonly string[]).includes(value.kind) &&
    isSafeWireText(value.summary, maximumSummaryLength) && isContext(value.context) && isSafeDetail(value.details as JsonValue);
};
const isGap = (value: unknown): value is DevLogReplayGap => hasExactKeys(value, [
  'earliestAvailableSequence', 'latestDroppedSequence', 'requestedAfterSequence', 'type',
]) && value.type === 'replay.gap' && safeInteger(value.requestedAfterSequence) && safeInteger(value.earliestAvailableSequence, 1) &&
  safeInteger(value.latestDroppedSequence) && value.earliestAvailableSequence === value.latestDroppedSequence + 1 &&
  value.requestedAfterSequence < value.earliestAvailableSequence;
const invalid = (): LogClientError => new LogClientError('AB8093', 'Dev Log route returned an invalid response.');
const snapshot = (value: unknown): JsonValue => strictJsonSnapshot(value, invalid);
const parseResponseJson = (bytes: Uint8Array): JsonValue => parseStrictResponseJson(bytes, invalid);
const parseMessage = (line: string): JsonValue => {
  try { return snapshot(parseJsonWithoutDuplicateKeys(line)); }
  catch { throw invalid(); }
};
const contiguous = (records: readonly DevLogRecord[], afterSequence: number): boolean => records.every((record, index) =>
  record.sequence === afterSequence + index + 1);

const replayFor = (value: unknown, afterSequence: number): DevLogReplay => {
  const detached = snapshot(value);
  if (!hasExactKeys(detached, ['replay']) || !isRecord(detached.replay)) throw invalid();
  const rawReplay = detached.replay;
  if (
    !(hasExactKeys(rawReplay, ['cursor', 'records']) || hasExactKeys(rawReplay, ['cursor', 'gap', 'records'])) ||
    !hasExactKeys(rawReplay.cursor, ['afterSequence']) || !safeInteger(rawReplay.cursor.afterSequence) ||
    rawReplay.cursor.afterSequence < afterSequence || !Array.isArray(rawReplay.records) || !rawReplay.records.every(isDevRecord) ||
    (Object.hasOwn(rawReplay, 'gap') && !isGap(rawReplay.gap))
  ) throw invalid();
  const records = rawReplay.records;
  const rawGap: unknown = Object.hasOwn(rawReplay, 'gap') ? rawReplay.gap : undefined;
  const gap = isGap(rawGap) ? rawGap : undefined;
  if (
    !contiguous(records, gap === undefined ? afterSequence : gap.earliestAvailableSequence - 1) ||
    (gap !== undefined && gap.requestedAfterSequence !== afterSequence) ||
    (records.length > 0 && rawReplay.cursor.afterSequence !== records.at(-1)?.sequence) ||
    (records.length === 0 && rawReplay.cursor.afterSequence !== (gap?.latestDroppedSequence ?? afterSequence))
  ) throw invalid();
  return Object.freeze({
    cursor: Object.freeze({ afterSequence: rawReplay.cursor.afterSequence }),
    ...(gap === undefined ? {} : { gap: Object.freeze({ ...gap }) }),
    records: Object.freeze(records.map((record) => Object.freeze({
      ...record,
      context: Object.freeze({ ...record.context }),
    }))),
  });
};

const messageFor = (line: string): DevLogMessage => {
  const parsed = parseMessage(line);
  if (isDevRecord(parsed) || isGap(parsed)) return parsed;
  throw invalid();
};
const diagnosticMessages = new Map<string, string>([
  ['AB8090', 'Dev Log route path is not valid.'],
  ['AB8091', 'Dev Log cursor is not valid.'],
  ['AB8092', 'Dev Log cursor is ahead of retained history.'],
  ['AB8093', 'Dev Log route returned an invalid response.'],
]);
const diagnosticFor = (value: unknown): LogClientError => {
  if (!hasExactKeys(value, ['diagnostic']) || !hasExactKeys(value.diagnostic, ['code', 'message']) ||
    typeof value.diagnostic.code !== 'string' || typeof value.diagnostic.message !== 'string') return invalid();
  const message = diagnosticMessages.get(value.diagnostic.code);
  return message === undefined ? invalid() : new LogClientError(value.diagnostic.code, message);
};

/** Same-origin cursor client for redacted production logs; it has no raw attachment API. */
export class LogClient {
  readonly #transport: ForegroundTransport;

  constructor(options: LogClientOptions = {}) {
    this.#transport = new ForegroundTransport({
      errorFor: (code, message) => new LogClientError(code, message),
      fallbackCode: 'AB8093',
      ...(options.authority === undefined ? {} : { authority: options.authority }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      label: 'Dev Log',
    });
  }

  async replay(afterSequence = 0, signal?: AbortSignal): Promise<DevLogReplay> {
    if (!safeInteger(afterSequence)) throw invalid();
    const body = await this.#json(`/api/logs/replay?after=${String(afterSequence)}`, { signal });
    return replayFor(body, afterSequence);
  }

  stream(options: LogStreamOptions): LogStream {
    return abortableNdjsonStream(options.signal, (signal) => this.#stream(options, signal));
  }

  async #json(path: string, init: RequestInit): Promise<JsonValue> {
    try {
      const response = await this.#response(path, init);
      const bytes = await awaitWithAbort(init.signal, () => response.arrayBuffer());
      return parseResponseJson(new Uint8Array(bytes));
    } catch (error) {
      if (error instanceof LogClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalid();
    }
  }

  async #response(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await this.#transport.request(path, init);
      if (response.ok) return response;
      const bytes = await awaitWithAbort(init.signal, () => response.arrayBuffer());
      throw diagnosticFor(parseResponseJson(new Uint8Array(bytes)));
    } catch (error) {
      if (error instanceof LogClientError || isAbort(error) || init.signal?.aborted) throw error;
      throw invalid();
    }
  }

  async #stream(options: LogStreamOptions, signal: AbortSignal): Promise<void> {
    let response: Response;
    try { response = await this.#response(`/api/logs/stream?after=${String(options.afterSequence)}`, { signal }); }
    catch (error) {
      if (isAbort(error) || signal.aborted) return;
      throw error;
    }
    if (response.body === null) throw invalid();
    const reader = response.body.getReader();
    const cancelReader = (): void => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancelReader, { once: true });
    if (signal.aborted) cancelReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let expectedSequence = options.afterSequence + 1;
    let receivedMessage = false;
    try {
      await readNdjsonByteFrames(reader, {
        maxFrameBytes: maximumLogFrameBytes,
        onFrame: (bytes) => {
          const line = decoder.decode(bytes).trim();
          if (line.length === 0) return;
          const message = messageFor(line);
          if ('sequence' in message) {
            if (message.sequence !== expectedSequence) throw invalid();
            expectedSequence += 1;
          } else {
            if (receivedMessage || message.requestedAfterSequence !== options.afterSequence) throw invalid();
            expectedSequence = message.earliestAvailableSequence;
          }
          receivedMessage = true;
          options.onMessage(message);
        },
        onIncomplete: () => { throw invalid(); },
        onLimitExceeded: () => { throw invalid(); },
        signal,
      });
    } catch (error) {
      if (isAbort(error) || signal.aborted) return;
      if (error instanceof LogClientError) throw error;
      throw invalid();
    } finally {
      signal.removeEventListener('abort', cancelReader);
      await reader.cancel().catch(() => undefined);
    }
  }
}
